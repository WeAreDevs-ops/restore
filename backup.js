const { saveToFirebase } = require('./firebase');
const { ChannelType, PermissionFlagsBits } = require('discord.js');

async function backupServer(guild) {
    console.log(`📦 Starting member backup for server: ${guild.name} (${guild.id})`);

    try {
        // Fetch all members
        const members = await guild.members.fetch();
        const memberData = [];

        members.forEach(member => {
            if (!member.user.bot) {
                memberData.push({
                    id: member.id,
                    username: member.user.username,
                    displayName: member.displayName,
                    joinedAt: member.joinedAt
                });
            }
        });

        // Create backup object with only member data
        const backupData = {
            guildId: guild.id,
            guildName: guild.name,
            ownerId: guild.ownerId,
            icon: guild.iconURL(),
            banner: guild.bannerURL(),
            description: guild.description,
            members: memberData,
            backupDate: new Date().toISOString(),
            memberCount: memberData.length
        };

        // Save to Firebase
        const success = await saveToFirebase('server_backups', guild.id, backupData);

        if (success) {
            console.log(`✅ Member backup completed for ${guild.name}. Saved ${memberData.length} members`);
        } else {
            console.log(`❌ Member backup failed for ${guild.name}`);
        }

        return success;

    } catch (error) {
        console.error('❌ Error during member backup:', error);
        return false;
    }
}

async function backupMemberTokens(guildId, userId, tokens, ownerId = null) {
    try {
        const tokenData = {
            userId: userId,
            guildId: guildId,
            ownerId: ownerId, // Store owner ID for cross-server restoration
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            tokenType: tokens.token_type,
            scope: tokens.scope,
            expiresAt: new Date(Date.now() + (tokens.expires_in * 1000)).toISOString(),
            createdAt: new Date().toISOString()
        };

        // Store with multiple keys for better retrieval
        const keys = [
            `${guildId}_${userId}`, // Original key
            `user_${userId}`, // User-based key
            `owner_${ownerId}_${userId}` // Owner-based key for cross-server restoration
        ];

        let allSuccess = true;
        for (const key of keys) {
            const success = await saveToFirebase('user_tokens', key, tokenData);
            if (!success) allSuccess = false;
        }

        if (allSuccess) {
            console.log(`🔐 Saved OAuth2 tokens for user ${userId} in guild ${guildId} with multiple reference keys`);
        }

        return allSuccess;
    } catch (error) {
        console.error('❌ Error saving member tokens:', error);
        return false;
    }
}

module.exports = {
    backupServer,
    backupMemberTokens
};