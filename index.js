
const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, SlashCommandBuilder, REST, Routes } = require('discord.js');
const { initializeFirebase } = require('./firebase');
const { backupServer } = require('./backup');
const { restoreServer } = require('./restore');
const { setupOAuth, generateAuthURL } = require('./oauth');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildModeration
    ],
    partials: [Partials.Channel, Partials.GuildMember]
});

// Initialize Firebase
initializeFirebase();

// Setup OAuth2 server
setupOAuth(client);

client.once('ready', async () => {
    console.log(`✅ Bot is ready! Logged in as ${client.user.tag}`);
    console.log(`📊 Serving ${client.guilds.cache.size} servers`);
    
    // Register slash commands
    const commands = [
        new SlashCommandBuilder()
            .setName('setup-backup')
            .setDescription('Setup backup authorization for server members')
            .setDefaultMemberPermissions('0'), // Only administrators can use this command
    ];

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

    try {
        console.log('🔄 Registering slash commands...');
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('✅ Successfully registered slash commands.');
    } catch (error) {
        console.error('❌ Error registering slash commands:', error);
    }
});

client.on('guildCreate', async (guild) => {
    console.log(`🆕 Joined new server: ${guild.name} (${guild.id})`);
    
    try {
        // Check if this is a restore scenario (we have backup data for a similar server)
        await restoreServer(guild, client);
        
        // Always create a new backup after joining
        await backupServer(guild);
        
        console.log(`ℹ️ Server owner can use /setup-backup command to display authorization embed`);
        
    } catch (error) {
        console.error('❌ Error handling guild join:', error);
    }
});

// Function to send authorization embed
async function sendAuthorizationEmbed(interaction) {
    try {
        const guild = interaction.guild;

        const embed = new EmbedBuilder()
            .setTitle('🔐 Server Backup Protection')
            .setDescription(
                '**Protect yourself from server raids and deletions!**\n\n' +
                'This bot automatically backs up server data and can restore everything if the server gets compromised.\n\n' +
                '**To enable automatic restoration:**\n' +
                '• Click the "Authorize" button below\n' +
                '• Complete the Discord authorization\n' +
                '• You\'ll be automatically re-added to any new server if this one is deleted\n\n' +
                '**What gets backed up:**\n' +
                '✅ All roles and permissions\n' +
                '✅ All channels and categories\n' +
                '✅ Server settings and layout\n' +
                '✅ Member roles and permissions\n\n' +
                '*Your authorization is completely secure and follows Discord\'s official OAuth2 standards.*'
            )
            .setColor(0x5865F2)
            .setThumbnail(guild.iconURL() || null)
            .setFooter({ text: 'Backup Bot • Secure • Automatic' })
            .setTimestamp();

        const button = new ButtonBuilder()
            .setCustomId('authorize_backup')
            .setLabel('🔐 Authorize Backup Protection')
            .setStyle(ButtonStyle.Primary);

        const row = new ActionRowBuilder().addComponents(button);

        await interaction.reply({
            embeds: [embed],
            components: [row]
        });

        console.log(`📨 Sent authorization embed to ${guild.name} via slash command`);
    } catch (error) {
        console.error('❌ Error sending authorization embed:', error);
        await interaction.reply({
            content: '❌ **Error:** Failed to send authorization embed. Please try again.',
            ephemeral: true
        });
    }
}

client.on('guildDelete', (guild) => {
    console.log(`❌ Left/banned from server: ${guild.name} (${guild.id})`);
    // The backup data remains in Firebase for potential restore
});

client.on('guildUnavailable', (guild) => {
    console.log(`⚠️ Server became unavailable: ${guild.name} (${guild.id})`);
    // Server might be temporarily down or deleted
});

client.on('interactionCreate', async (interaction) => {
    if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'setup-backup') {
            // Check if user is server owner or has administrator permissions
            if (interaction.user.id !== interaction.guild.ownerId && !interaction.member.permissions.has('Administrator')) {
                await interaction.reply({
                    content: '❌ **Error:** Only the server owner or administrators can use this command.',
                    ephemeral: true
                });
                return;
            }
            
            // Send the authorization embed
            await sendAuthorizationEmbed(interaction);
        }
    }
    
    if (interaction.isButton()) {
        if (interaction.customId === 'authorize_backup') {
            const modal = new ModalBuilder()
                .setCustomId('verification_modal')
                .setTitle('🔐 Backup Authorization');

            const userIdInput = new TextInputBuilder()
                .setCustomId('user_id')
                .setLabel('Your Discord User ID')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('Enter your Discord User ID')
                .setValue(interaction.user.id)
                .setRequired(true);

            const row = new ActionRowBuilder().addComponents(userIdInput);
            modal.addComponents(row);

            await interaction.showModal(modal);
        }
    }
    
    if (interaction.isModalSubmit()) {
        if (interaction.customId === 'verification_modal') {
            const userId = interaction.fields.getTextInputValue('user_id');
            const guildId = interaction.guild.id;
            
            // Verify the user ID matches the person submitting
            if (userId !== interaction.user.id) {
                await interaction.reply({
                    content: '❌ **Error:** The User ID must match your own Discord account.',
                    ephemeral: true
                });
                return;
            }
            
            // Generate OAuth2 URL for this user
            const oauthUrl = generateAuthURL(userId, guildId);
            
            const embed = new EmbedBuilder()
                .setTitle('🔐 Complete Your Authorization')
                .setDescription(
                    '**Click the link below to complete your backup authorization:**\n\n' +
                    `[🔗 **Authorize Backup Protection**](${oauthUrl})\n\n` +
                    '**What happens next:**\n' +
                    '1. You\'ll be redirected to Discord\'s official authorization page\n' +
                    '2. Click "Authorize" to grant the bot permission to re-add you\n' +
                    '3. You\'ll receive a confirmation message\n' +
                    '4. You\'re now protected from server raids!\n\n' +
                    '*This authorization is secure and follows Discord\'s official OAuth2 standards.*'
                )
                .setColor(0x00FF00)
                .setFooter({ text: 'This link is unique to you and expires in 10 minutes' })
                .setTimestamp();
            
            await interaction.reply({
                embeds: [embed],
                ephemeral: true
            });
        }
    }
});

// Error handling
client.on('error', (error) => {
    console.error('❌ Discord client error:', error);
});

process.on('unhandledRejection', (error) => {
    console.error('❌ Unhandled promise rejection:', error);
});

// Login to Discord
client.login(process.env.DISCORD_TOKEN);
