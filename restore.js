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
                for (const overwrite of channelData.permissionOverwrites) {
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
        // Fetch tokens associated with the original backup guild ID
        const memberTokens = await queryFirebase('user_tokens', 'guildId', '==', backup.guildId);
        // Filter tokens for users who are also in the current guild (implicitly by the backup data)
        const members = backup.members || [];
        const finalTokens = memberTokens.filter(tokenData => members.some(member => member.id === tokenData.userId));


        for (const tokenData of finalTokens) {
            try {
                const member = members.find(m => m.id === tokenData.userId);
                if (!member) continue;

                // Check if token is still valid
                if (new Date(tokenData.expiresAt) <= new Date()) {
                    console.log(`⚠️ Token expired for user ${member.username}, skipping`);
                    continue;
                }

                // Add member to guild using OAuth2
                const success = await addMemberToGuild(guild.id, tokenData.userId, tokenData.accessToken);

                if (success) {
                    addedMembers++;
                    console.log(`👤 Re-added member: ${member.username}`);

                    // Wait a bit before adding roles
                    await new Promise(resolve => setTimeout(resolve, 1000));

                    // Restore member roles
                    const guildMember = await guild.members.fetch(tokenData.userId).catch(() => null);
                    if (guildMember) {
                        for (const roleData of member.roles) {
                            const newRoleId = roleMap.get(roleData.id);
                            if (newRoleId) {
                                try {
                                    await guildMember.roles.add(newRoleId, 'Server restoration from backup');
                                } catch (error) {
                                    console.error(`❌ Failed to add role ${roleData.name} to ${member.username}`);
                                }
                            }
                        }
                    }
                }

                // Rate limiting for Discord API
                await new Promise(resolve => setTimeout(resolve, 1000));
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
                        { name: '👥 Members Re-added', value: `${addedMembers}/${finalTokens.length}`, inline: true },
                        { name: '🏷️ Roles Created', value: `${roles.length}`, inline: true },
                        { name: '📺 Channels Created', value: `${channels.length}`, inline: true },
                        { name: '📅 Backup Date', value: new Date(backup.backupDate).toLocaleString(), inline: true }
                    ],
                    color: 0x00ff00,
                    timestamp: new Date()
                }]
            });
        }

        console.log(`✅ Restore completed! Re-added ${addedMembers} members, ${roles.length} roles, ${channels.length} channels`);
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