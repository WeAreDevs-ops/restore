const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, SlashCommandBuilder, REST, Routes } = require('discord.js');
const { initializeFirebase, queryFirebase } = require('./firebase');
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
        new SlashCommandBuilder()
            .setName('backup')
            .setDescription('Manually backup current server')
            .setDefaultMemberPermissions('0'), // Only administrators can use this command
        new SlashCommandBuilder()
            .setName('restore')
            .setDescription('Manually restore server from backup')
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
    console.log(`➕ Joined new server: ${guild.name} (${guild.id})`);

    try {
        // First try to restore from previous backup (same owner)
        console.log(`🔄 Checking for existing backup to restore...`);
        const restored = await restoreServer(guild, client);

        if (!restored) {
            console.log(`ℹ️ No existing backup found, creating new backup...`);
            // If no restore happened, create a backup of the current server state
            await backupServer(guild);
        }

        // Send setup message to a suitable channel
        const channel = guild.channels.cache.find(
            ch => ch.type === 0 && // GuildText channel type
            ch.permissionsFor(guild.members.me).has([1 << 10, 1 << 11]) // SendMessages, ViewChannel permissions
        );

        if (channel) {
            await sendAuthorizationEmbed(interaction); // Pass interaction to sendAuthorizationEmbed
        }

    } catch (error) {
        console.error('❌ Error handling new guild:', error);
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

        // Create authorization button with generic OAuth URL (Discord will handle user identification)
        const baseOAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${process.env.OAUTH2_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.OAUTH2_REDIRECT_URI)}&response_type=code&scope=identify%20guilds.join&state=${guild.id}`;

        const authButton = new ButtonBuilder()
            .setLabel('🔐 Authorize Backup Protection')
            .setStyle(ButtonStyle.Link)
            .setURL(baseOAuthUrl);

        const row = new ActionRowBuilder()
            .addComponents(authButton);

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

        if (interaction.commandName === 'backup') {
            // Check if user is server owner or has administrator permissions
            if (interaction.user.id !== interaction.guild.ownerId && !interaction.member.permissions.has('Administrator')) {
                await interaction.reply({
                    content: '❌ **Error:** Only the server owner or administrators can use this command.',
                    ephemeral: true
                });
                return;
            }

            await interaction.deferReply();

            try {
                const success = await backupServer(interaction.guild);

                if (success) {
                    await interaction.editReply({
                        embeds: [{
                            title: '✅ Backup Complete',
                            description: `Successfully backed up **${interaction.guild.name}**\n\nThe backup includes all roles, channels, and member data.`,
                            color: 0x00ff00,
                            timestamp: new Date()
                        }]
                    });
                } else {
                    await interaction.editReply({
                        embeds: [{
                            title: '❌ Backup Failed',
                            description: 'An error occurred during the backup process. Please check the console logs and try again.',
                            color: 0xff0000,
                            timestamp: new Date()
                        }]
                    });
                }
            } catch (error) {
                console.error('❌ Error during manual backup:', error);
                await interaction.editReply({
                    embeds: [{
                        title: '❌ Backup Failed',
                        description: 'An error occurred during the backup process. Please try again or check the console logs.',
                        color: 0xff0000,
                        timestamp: new Date()
                    }]
                });
            }
        }

        if (interaction.commandName === 'restore') {
            // Check if user is server owner or has administrator permissions
            if (interaction.user.id !== interaction.guild.ownerId && !interaction.member.permissions.has('Administrator')) {
                await interaction.reply({
                    content: '❌ **Error:** Only the server owner or administrators can use this command.',
                    ephemeral: true
                });
                return;
            }

            await interaction.deferReply();

            try {
                const restored = await restoreServer(interaction.guild, client);

                if (restored) {
                    await interaction.editReply({
                        embeds: [{
                            title: '✅ Restoration Started',
                            description: 'Server restoration process has been initiated! Check the progress in your server channels.',
                            color: 0x00ff00,
                            timestamp: new Date()
                        }]
                    });
                } else {
                    await interaction.editReply({
                        embeds: [{
                            title: '❌ No Backup Found',
                            description: 'No backup data found for your server owner ID. Make sure you had the bot in a previous server that was backed up.',
                            color: 0xff0000,
                            timestamp: new Date()
                        }]
                    });
                }
            } catch (error) {
                console.error('❌ Error during manual restore:', error);
                await interaction.editReply({
                    embeds: [{
                        title: '❌ Restoration Failed',
                        description: 'An error occurred during the restoration process. Please try again or check the console logs.',
                        color: 0xff0000,
                        timestamp: new Date()
                    }]
                });
            }
        }
    }

    if (interaction.isButton()) {
        // No button interactions needed - direct OAuth links are used
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