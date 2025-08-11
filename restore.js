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
        console.log(`🔄 Starting member restoration process...`);

        // Re-add members using OAuth2 tokens
        let addedMembers = 0;
        let attemptedMembers = 0;
        
        const members = backup.members || [];
        const finalTokens = [];
        
        console.log(`🔍 Batch retrieving tokens for ${members.length} members...`);
        
        // Batch retrieve tokens using different strategies
        const memberIds = members.map(m => m.id);
        
        // 1. Get all owner-based tokens in one query
        const ownerTokens = await queryFirebase('user_tokens', 'ownerId', '==', backup.ownerId);
        const ownerTokenMap = new Map();
        ownerTokens.forEach(token => {
            if (memberIds.includes(token.userId)) {
                ownerTokenMap.set(token.userId, token);
            }
        });
        
        // 2. Batch get original guild tokens
        const originalTokenPromises = members.map(member => 
            getFromFirebase('user_tokens', `${backup.guildId}_${member.id}`)
        );
        const originalTokens = await Promise.all(originalTokenPromises);
        
        // 3. Batch get user-based tokens
        const userTokenPromises = members.map(member => 
            getFromFirebase('user_tokens', `user_${member.id}`)
        );
        const userTokens = await Promise.all(userTokenPromises);
        
        // 4. Batch get owner-based tokens
        const ownerKeyPromises = members.map(member => 
            getFromFirebase('user_tokens', `owner_${backup.ownerId}_${member.id}`)
        );
        const ownerKeyTokens = await Promise.all(ownerKeyPromises);
        
        // Process results and create final token list
        for (let i = 0; i < members.length; i++) {
            const member = members[i];
            let tokenData = null;
            
            // Prioritize tokens: original > user-based > owner-key > owner-query
            tokenData = originalTokens[i] || userTokens[i] || ownerKeyTokens[i] || ownerTokenMap.get(member.id);
            
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
                    title: '👥 Member Restoration Complete',
                    description: `Successfully restored members from backup of **${backup.guildName}**`,
                    fields: [
                        { name: '👥 Members Re-added', value: `${addedMembers}/${attemptedMembers} attempted (${finalTokens.length} tokens found)`, inline: true },
                        { name: '📅 Backup Date', value: new Date(backup.backupDate).toLocaleString(), inline: true }
                    ],
                    color: 0x00ff00,
                    timestamp: new Date()
                }]
            });
        }

        console.log(`✅ Member restoration completed! Re-added ${addedMembers}/${attemptedMembers} members (${finalTokens.length} tokens found)`);
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