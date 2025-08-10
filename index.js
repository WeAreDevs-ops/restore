
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
            const userId = interaction.user.id;
            const guildId = interaction.guild.id;
            
            // Generate OAuth2 URL for this user - this will directly open Discord's authorization popup
            const oauthUrl = generateAuthURL(userId, guildId);
            
            // Reply with the direct OAuth URL - Discord will handle opening the authorization popup
            await interaction.reply({
                content: `🔐 **Opening Discord Authorization...**\n\n[Click here to authorize](${oauthUrl})`,
                ephemeral: true
            });
            
            console.log(`🔗 Generated OAuth2 URL for ${interaction.user.username} (${userId}) in guild ${guildId}`);
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
