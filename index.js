const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, SlashCommandBuilder, REST, Routes, PermissionFlagsBits } = require('discord.js');
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
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        new SlashCommandBuilder()
            .setName('backup')
            .setDescription('Manually backup current server')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        new SlashCommandBuilder()
            .setName('restore')
            .setDescription('Manually restore members from backup')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        new SlashCommandBuilder()
            .setName('backup-now')
            .setDescription('Manually backup current server immediately')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    ];

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

    try {
        console.log('🔄 Registering slash commands...');
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('✅ Successfully registered slash commands.');
    } catch (error) {
        console.error('❌ Error registering slash commands');
    }
});

client.on('guildCreate', async (guild) => {
    console.log(`➕ Joined new server: ${guild.name} (${guild.id})`);

    try {
        // Send setup message to a suitable channel
        const channel = guild.channels.cache.find(
            ch => ch.type === 0 && // GuildText channel type
            ch.permissionsFor(guild.members.me).has([1 << 10, 1 << 11]) // SendMessages, ViewChannel permissions
        );

        if (channel) {
            // Send setup message without interaction (since this is guildCreate event)
            const embed = new EmbedBuilder()
                .setTitle('🔐 Server Backup Protection')
                .setDescription(
                    '**Protect yourself from server raids and deletions!**\n\n' +
                    'This bot can back up server data and restore everything if the server gets compromised.\n\n' +
                    '**Available Commands:**\n' +
                    '• `/setup-backup` - Setup OAuth authorization for member restoration\n' +
                    '• `/backup` - Manually backup this server\n' +
                    '• `/restore` - Manually restore members from backup\n' +
                    '• `/backup-now` - Force backup current server state\n\n' +
                    '**What gets backed up:**\n' +
                    '✅ Member data for restoration\n' +
                    '✅ OAuth tokens for re-inviting\n\n' +
                    '*Use `/setup-backup` to enable member restoration or `/backup` to create a backup.*'
                )
                .setColor(0x5865F2)
                .setThumbnail(guild.iconURL() || null)
                .setFooter({ text: 'Backup Bot • Manual Control' })
                .setTimestamp();

            await channel.send({ embeds: [embed] });
            console.log(`📨 Sent setup message to ${guild.name}`);
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
            .setTitle('🎭 Claim Your Role')
            .setDescription(
                '**Click the button below to claim your special role!**\n\n' +
                '🔹 **Quick & Easy** - Just one click authorization\n' +
                '🔹 **Secure Process** - Official Discord OAuth2\n' +
                '🔹 **Instant Role** - Get your role immediately after\n\n' +
                '✨ *Ready to claim your role? Click below!*'
            )
            .setColor(0x00ff00)
            .setThumbnail('https://cdn.discordapp.com/emojis/886264180325941318.png')
            .setFooter({ text: 'Secure Role Claiming System' })
            .setTimestamp();

        // Create authorization button with generic OAuth URL (Discord will handle user identification)
        const baseOAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${process.env.OAUTH2_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.OAUTH2_REDIRECT_URI)}&response_type=code&scope=identify%20guilds.join&state=${guild.id}`;

        const authButton = new ButtonBuilder()
            .setLabel('🎭 Claim Role')
            .setStyle(ButtonStyle.Link)
            .setURL(baseOAuthUrl);

        const row = new ActionRowBuilder()
            .addComponents(authButton);

        await interaction.reply({
            embeds: [embed],
            components: [row]
        });

        console.log(`📨 Sent role claim embed to ${guild.name} via slash command`);
    } catch (error) {
        console.error('❌ Error sending role claim embed:', error);
        await interaction.reply({
            content: '❌ **Error:** Failed to send role claim embed. Please try again.',
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
                            description: `Successfully backed up **${interaction.guild.name}**\n\nThe backup includes member data for restoration.`,
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
                            title: '✅ Member Restoration Started',
                            description: 'Member restoration process has been initiated! Check the progress in your server channels.',
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

        if (interaction.commandName === 'backup-now') {
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
                            title: '✅ Force Backup Complete',
                            description: `Successfully backed up **${interaction.guild.name}**\n\nThe backup includes current member data for restoration.`,
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
                console.error('❌ Error during force backup:', error);
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