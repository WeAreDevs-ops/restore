
const { saveToFirebase } = require('./firebase');
const { ChannelType, PermissionFlagsBits } = require('discord.js');

async function backupServer(guild) {
    console.log(`📦 Starting backup for server: ${guild.name} (${guild.id})`);
    
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
                    roles: member.roles.cache.filter(role => role.id !== guild.id).map(role => ({
                        id: role.id,
                        name: role.name,
                        color: role.color,
                        permissions: role.permissions.toArray(),
                        position: role.position
                    })),
                    joinedAt: member.joinedAt,
                    permissions: member.permissions.toArray()
                });
            }
        });
        
        // Backup roles
        const roles = guild.roles.cache
            .filter(role => role.id !== guild.id && !role.managed)
            .map(role => ({
                id: role.id,
                name: role.name,
                color: role.color,
                permissions: role.permissions.toArray(),
                position: role.position,
                hoist: role.hoist,
                mentionable: role.mentionable
            }));
        
        // Backup channels
        const channels = guild.channels.cache.map(channel => {
            const channelData = {
                id: channel.id,
                name: channel.name,
                type: channel.type,
                position: channel.position,
                parentId: channel.parentId,
                permissionOverwrites: []
            };
            
            // Add type-specific data
            if (channel.type === ChannelType.GuildText) {
                channelData.topic = channel.topic;
                channelData.nsfw = channel.nsfw;
                channelData.rateLimitPerUser = channel.rateLimitPerUser;
            } else if (channel.type === ChannelType.GuildVoice) {
                channelData.bitrate = channel.bitrate;
                channelData.userLimit = channel.userLimit;
            }
            
            // Backup permission overwrites
            channel.permissionOverwrites.cache.forEach(overwrite => {
                channelData.permissionOverwrites.push({
                    id: overwrite.id,
                    type: overwrite.type,
                    allow: overwrite.allow.toArray(),
                    deny: overwrite.deny.toArray()
                });
            });
            
            return channelData;
        });
        
        // Create backup object
        const backupData = {
            guildId: guild.id,
            guildName: guild.name,
            ownerId: guild.ownerId,
            icon: guild.iconURL(),
            banner: guild.bannerURL(),
            description: guild.description,
            members: memberData,
            roles: roles,
            channels: channels,
            backupDate: new Date().toISOString(),
            memberCount: memberData.length
        };
        
        // Save to Firebase
        const success = await saveToFirebase('server_backups', guild.id, backupData);
        
        if (success) {
            console.log(`✅ Backup completed for ${guild.name}. Saved ${memberData.length} members, ${roles.length} roles, ${channels.length} channels`);
        } else {
            console.log(`❌ Backup failed for ${guild.name}`);
        }
        
        return success;
        
    } catch (error) {
        console.error('❌ Error during server backup:', error);
        return false;
    }
}

async function backupMemberTokens(guildId, userId, tokens) {
    try {
        const tokenData = {
            userId: userId,
            guildId: guildId,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            tokenType: tokens.token_type,
            scope: tokens.scope,
            expiresAt: new Date(Date.now() + (tokens.expires_in * 1000)).toISOString(),
            createdAt: new Date().toISOString()
        };
        
        const success = await saveToFirebase('user_tokens', `${guildId}_${userId}`, tokenData);
        
        if (success) {
            console.log(`🔐 Saved OAuth2 tokens for user ${userId} in guild ${guildId}`);
        }
        
        return success;
    } catch (error) {
        console.error('❌ Error saving member tokens:', error);
        return false;
    }
}

module.exports = {
    backupServer,
    backupMemberTokens
};
