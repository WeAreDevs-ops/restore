const { getFromFirebase, queryFirebase } = require('./firebase');
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const axios = require('axios');

async function restoreServer(guild, client) {
    console.log(`🔄 Checking for restore data for new server: ${guild.name} (${guild.id})`);

    try {
        // Look for backup data from servers with the same owner
        const backups = await queryFirebase('server_backups', 'ownerId', '==', guild.ownerId);

        if (backups.length === 0) {
            console.log(`ℹ️ No backup data found for owner ${guild.ownerId}`);
            return false;
        }

        // Use the most recent backup
        const backup = backups.sort((a, b) => new Date(b.backupDate) - new Date(a.backupDate))[0];

        console.log(`📋 Found backup from ${backup.guildName} (${new Date(backup.backupDate).toLocaleString()})`);
        console.log(`🔄 Starting restore process...`);

        // Step 1: Restore roles
        const roleMap = new Map();

        // Ensure roles array exists and is valid
        const roles = backup.roles || [];
        for (const roleData of roles.sort((a, b) => a.position - b.position)) {
            try {
                const role = await guild.roles.create({
                    name: roleData.name,
                    color: roleData.color,
                    permissions: roleData.permissions,
                    hoist: roleData.hoist,
                    mentionable: roleData.mentionable,
                    reason: 'Server restoration from backup'
                });

                roleMap.set(roleData.id, role.id);
                console.log(`➕ Created role: ${roleData.name}`);

                // Rate limiting
                await new Promise(resolve => setTimeout(resolve, 100));
            } catch (error) {
                console.error(`❌ Failed to create role ${roleData.name}:`, error.message);
            }
        }

        // Step 2: Restore channels
        const channelMap = new Map();

        // Create categories first
        const channels = backup.channels || [];
        const categories = channels.filter(ch => ch.type === ChannelType.GuildCategory);
        for (const categoryData of categories) {
            try {
                const category = await guild.channels.create({
                    name: categoryData.name,
                    type: ChannelType.GuildCategory,
                    position: categoryData.position,
                    reason: 'Server restoration from backup'
                });

                channelMap.set(categoryData.id, category.id);
                console.log(`📁 Created category: ${categoryData.name}`);

                await new Promise(resolve => setTimeout(resolve, 100));
            } catch (error) {
                console.error(`❌ Failed to create category ${categoryData.name}:`, error.message);
            }
        }

        // Create other channels
        const otherChannels = channels.filter(ch => ch.type !== ChannelType.GuildCategory);
        for (const channelData of otherChannels) {
            try {
                const channelOptions = {
                    name: channelData.name,
                    type: channelData.type,
                    position: channelData.position,
                    parent: channelMap.get(channelData.parentId) || null,
                    reason: 'Server restoration from backup'
                };

                // Add type-specific options
                if (channelData.type === ChannelType.GuildText) {
                    channelOptions.topic = channelData.topic;
                    channelOptions.nsfw = channelData.nsfw;
                    channelOptions.rateLimitPerUser = channelData.rateLimitPerUser;
                } else if (channelData.type === ChannelType.GuildVoice) {
                    channelOptions.bitrate = channelData.bitrate;
                    channelOptions.userLimit = channelData.userLimit;
                }

                const channel = await guild.channels.create(channelOptions);
                channelMap.set(channelData.id, channel.id);

                // Restore permission overwrites
                const permissionOverwrites = channelData.permissionOverwrites || [];
                for (const overwrite of permissionOverwrites) {
                    try {
                        let targetId = overwrite.id;

                        // Map role IDs to new role IDs
                        if (overwrite.type === 0 && roleMap.has(overwrite.id)) {
                            targetId = roleMap.get(overwrite.id);
                        }

                        await channel.permissionOverwrites.create(targetId, {
                            allow: overwrite.allow,
                            deny: overwrite.deny
                        });
                    } catch (error) {
                        console.error(`❌ Failed to set permissions for ${channel.name}:`, error.message);
                    }
                }

                console.log(`📺 Created channel: ${channelData.name}`);
                await new Promise(resolve => setTimeout(resolve, 100));
            } catch (error) {
                console.error(`❌ Failed to create channel ${channelData.name}:`, error.message);
            }
        }

        // Step 3: Re-add members using OAuth2 tokens
        let addedMembers = 0;
        let attemptedMembers = 0;
        
        const members = backup.members || [];
        const finalTokens = [];
        
        // Try to find tokens for each member
        for (const member of members) {
            // Try multiple approaches to find tokens
            let tokenData = null;
            
            // 1. Try with original guild ID and user ID
            const originalKey = `${backup.guildId}_${member.id}`;
            tokenData = await getFromFirebase('user_tokens', originalKey);
            
            if (!tokenData) {
                // 2. Try user-based key
                const userKey = `user_${member.id}`;
                tokenData = await getFromFirebase('user_tokens', userKey);
            }
            
            if (!tokenData) {
                // 3. Try owner-based key
                const ownerKey = `owner_${backup.ownerId}_${member.id}`;
                tokenData = await getFromFirebase('user_tokens', ownerKey);
            }
            
            if (!tokenData) {
                // 4. Query by user ID
                const userTokens = await queryFirebase('user_tokens', 'userId', '==', member.id);
                if (userTokens.length > 0) {
                    // Use the most recent token for this user
                    tokenData = userTokens.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
                }
            }
            
            if (!tokenData) {
                // 5. Query by owner ID (for cross-server restoration)
                const ownerTokens = await queryFirebase('user_tokens', 'ownerId', '==', backup.ownerId);
                const userOwnerToken = ownerTokens.find(token => token.userId === member.id);
                if (userOwnerToken) {
                    tokenData = userOwnerToken;
                }
            }
            
            if (tokenData) {
                finalTokens.push(tokenData);
                console.log(`🔍 Found token for user ${member.username} (${member.id})`);
            } else {
                console.log(`❌ No token found for user ${member.username} (${member.id})`);
            }
        }

        console.log(`🔍 Found ${finalTokens.length} tokens for ${members.length} backed up members`);

        for (const tokenData of finalTokens) {
            try {
                const member = members.find(m => m.id === tokenData.userId);
                if (!member) continue;

                attemptedMembers++;
                console.log(`🔄 Attempting to restore member: ${member.username} (${tokenData.userId})`);

                // Check if token is still valid (with some buffer time)
                const tokenExpiry = new Date(tokenData.expiresAt);
                const now = new Date();
                const bufferTime = 5 * 60 * 1000; // 5 minutes buffer
                
                if (tokenExpiry <= new Date(now.getTime() + bufferTime)) {
                    console.log(`⚠️ Token expired or expiring soon for user ${member.username}, skipping`);
                    continue;
                }

                // Add member to guild using OAuth2
                const success = await addMemberToGuild(guild.id, tokenData.userId, tokenData.accessToken);

                if (success) {
                    addedMembers++;
                    console.log(`✅ Successfully re-added member: ${member.username}`);

                    // Wait a bit before adding roles
                    await new Promise(resolve => setTimeout(resolve, 2000));

                    // Restore member roles
                    try {
                        const guildMember = await guild.members.fetch(tokenData.userId);
                        if (guildMember && member.roles) {
                            for (const roleData of member.roles) {
                                const newRoleId = roleMap.get(roleData.id);
                                if (newRoleId) {
                                    try {
                                        await guildMember.roles.add(newRoleId, 'Server restoration from backup');
                                        console.log(`✅ Added role ${roleData.name} to ${member.username}`);
                                        await new Promise(resolve => setTimeout(resolve, 500));
                                    } catch (error) {
                                        console.error(`❌ Failed to add role ${roleData.name} to ${member.username}:`, error.message);
                                    }
                                }
                            }
                        }
                    } catch (error) {
                        console.error(`❌ Failed to fetch member after adding: ${error.message}`);
                    }
                } else {
                    console.log(`❌ Failed to add member: ${member.username}`);
                }

                // Rate limiting for Discord API
                await new Promise(resolve => setTimeout(resolve, 2000));
            } catch (error) {
                console.error(`❌ Failed to re-add member ${tokenData.userId}:`, error.message);
            }
        }

        // Send completion message to a suitable channel
        const generalChannel = guild.channels.cache.find(
            ch => ch.type === ChannelType.GuildText &&
            (ch.name.includes('general') || ch.name.includes('admin') || ch.position === 0)
        );

        if (generalChannel) {
            await generalChannel.send({
                embeds: [{
                    title: '🔄 Server Restoration Complete',
                    description: `Successfully restored server from backup of **${backup.guildName}**`,
                    fields: [
                        { name: '👥 Members Re-added', value: `${addedMembers}/${attemptedMembers} attempted (${finalTokens.length} tokens found)`, inline: true },
                        { name: '🏷️ Roles Created', value: `${roles.length}`, inline: true },
                        { name: '📺 Channels Created', value: `${channels.length}`, inline: true },
                        { name: '📅 Backup Date', value: new Date(backup.backupDate).toLocaleString(), inline: true }
                    ],
                    color: 0x00ff00,
                    timestamp: new Date()
                }]
            });
        }

        console.log(`✅ Restore completed! Re-added ${addedMembers}/${attemptedMembers} members (${finalTokens.length} tokens found), ${roles.length} roles, ${channels.length} channels`);
        return true;

    } catch (error) {
        console.error('❌ Error during server restoration:', error);
        return false;
    }
}

async function addMemberToGuild(guildId, userId, accessToken) {
    try {
        const response = await axios.put(
            `https://discord.com/api/v10/guilds/${guildId}/members/${userId}`,
            {
                access_token: accessToken
            },
            {
                headers: {
                    'Authorization': `Bot ${process.env.DISCORD_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        return response.status === 201 || response.status === 204;
    } catch (error) {
        if (error.response?.status === 403) {
            console.log(`⚠️ Missing permissions to add user ${userId}`);
        } else if (error.response?.status === 404) {
            console.log(`⚠️ User ${userId} not found or token invalid`);
        } else {
            console.error(`❌ Error adding member ${userId}:`, error.message);
        }
        return false;
    }
}

module.exports = {
    restoreServer,
    addMemberToGuild
};