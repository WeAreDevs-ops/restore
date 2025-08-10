
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { initializeFirebase } = require('./firebase');
const { backupServer } = require('./backup');
const { restoreServer } = require('./restore');
const { setupOAuth } = require('./oauth');

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

client.once('ready', () => {
    console.log(`✅ Bot is ready! Logged in as ${client.user.tag}`);
    console.log(`📊 Serving ${client.guilds.cache.size} servers`);
});

client.on('guildCreate', async (guild) => {
    console.log(`🆕 Joined new server: ${guild.name} (${guild.id})`);
    
    try {
        // Check if this is a restore scenario (we have backup data for a similar server)
        await restoreServer(guild, client);
        
        // Always create a new backup after joining
        await backupServer(guild);
        
    } catch (error) {
        console.error('❌ Error handling guild join:', error);
    }
});

client.on('guildDelete', (guild) => {
    console.log(`❌ Left/banned from server: ${guild.name} (${guild.id})`);
    // The backup data remains in Firebase for potential restore
});

client.on('guildUnavailable', (guild) => {
    console.log(`⚠️ Server became unavailable: ${guild.name} (${guild.id})`);
    // Server might be temporarily down or deleted
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isModalSubmit()) return;
    
    if (interaction.customId === 'verification_modal') {
        const userId = interaction.fields.getTextInputValue('user_id');
        const guildId = interaction.guild.id;
        
        // Generate OAuth2 URL for this user
        const baseUrl = process.env.OAUTH2_REDIRECT_URI.replace('/oauth/discord', '');
        const oauthUrl = `${baseUrl}/oauth/discord?state=${userId}_${guildId}`;
        
        await interaction.reply({
            content: `🔐 **Verification Required**\n\nTo enable automatic restoration in case this server is compromised, please authorize the bot:\n\n[Click here to authorize](${oauthUrl})\n\n*This allows the bot to re-add you to a new server if this one is deleted.*`,
            ephemeral: true
        });
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
