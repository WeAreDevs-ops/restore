const express = require('express');
const axios = require('axios');
const { backupMemberTokens } = require('./backup');

let app;
let botClient;

function setupOAuth(client) {
    botClient = client;

    if (!app) {
        app = express();
        app.use(express.json());

        // OAuth callback endpoint
        app.get('/callback', async (req, res) => {
            const { code, state } = req.query;

            if (!code || !state) {
                return res.status(400).send('Missing authorization code or state');
            }

            try {
                // Exchange code for access token
                const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
                    client_id: process.env.OAUTH2_CLIENT_ID,
                    client_secret: process.env.OAUTH2_CLIENT_SECRET,
                    grant_type: 'authorization_code',
                    code: code,
                    redirect_uri: process.env.OAUTH2_REDIRECT_URI,
                    scope: 'identify guilds.join'
                }), {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                });

                const tokens = tokenResponse.data;

                // Get user info
                const userResponse = await axios.get('https://discord.com/api/users/@me', {
                    headers: {
                        'Authorization': `Bearer ${tokens.access_token}`
                    }
                });

                const user = userResponse.data;
                const guildId = state; // Guild ID passed as state

                // Get guild info to get owner ID
                const guild = botClient.guilds.cache.get(guildId);
                const ownerId = guild ? guild.ownerId : null;

                // Save tokens to Firebase using the authenticated user's ID
                const success = await backupMemberTokens(guildId, user.id, tokens, ownerId);

                if (success) {
                    // Give user role after successful authorization
                    try {
                        if (process.env.CLAIM_ROLE_ID) {
                            const guild = botClient.guilds.cache.get(guildId);
                            if (guild) {
                                const member = await guild.members.fetch(user.id);
                                const role = guild.roles.cache.get(process.env.CLAIM_ROLE_ID);

                                if (member && role) {
                                    await member.roles.add(role);
                                    console.log(`🎭 Assigned role ${role.name} to user ${user.username} (${user.id})`);
                                } else {
                                    console.log(`⚠️ Could not find member or role for user ${user.id} in guild ${guildId}`);
                                }
                            }
                        }
                    } catch (roleError) {
                        console.error(`❌ Error assigning role to user ${user.id}:`, roleError);
                    }

                    // Send success message to user via DM
                    try {
                        const discordUser = await client.users.fetch(user.id);
                        await discordUser.send({
                            embeds: [{
                                title: '🎭 Role Claimed Successfully!',
                                description: 'You have successfully claimed your role! Check the server to see your new role and perks.',
                                color: 0x00ff00,
                                timestamp: new Date()
                            }]
                        });
                    } catch (dmError) {
                        console.log(`⚠️ Could not send DM to user ${user.id}`);
                    }

                    res.send(`
                        <html>
                            <head>
                                <title>Role Claimed Successfully!</title>
                                <style>
                                    body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #36393f; color: #ffffff; }
                                    .success { background: #43b581; padding: 20px; border-radius: 10px; display: inline-block; }
                                    .icon { font-size: 48px; margin-bottom: 20px; }
                                    .role-info { background: #2f3136; padding: 15px; border-radius: 8px; margin: 20px 0; }
                                </style>
                            </head>
                            <body>
                                <div class="success">
                                    <div class="icon">🎭</div>
                                    <h2>Role Claimed Successfully!</h2>
                                    <div class="role-info">
                                        <strong>✅ Your special role has been assigned!</strong><br>
                                        Check your Discord server to see your new role.
                                    </div>
                                    <p>You can now close this window and return to Discord.</p>
                                </div>
                            </body>
                        </html>
                    `);

                    console.log(`🔐 Successfully stored OAuth2 tokens for user ${user.username} (${user.id}) in guild ${guildId}`);
                } else {
                    res.status(500).send('Failed to save authorization data');
                }

            } catch (error) {
                console.error('❌ OAuth callback error:', error);
                res.status(500).send('Authorization failed. Please try again.');
            }
        });

        // Health check endpoint
        app.get('/health', (req, res) => {
            res.send('OAuth server is running');
        });

        const port = process.env.PORT || 3000;
        app.listen(port, '0.0.0.0', () => {
            console.log(`✅ OAuth server running on port ${port}`);
        });
    }
}

function generateAuthURL(guildId, userId = null) {
    const params = new URLSearchParams({
        client_id: process.env.OAUTH2_CLIENT_ID,
        redirect_uri: process.env.OAUTH2_REDIRECT_URI,
        response_type: 'code',
        scope: 'identify guilds.join',
        state: guildId
    });

    return `https://discord.com/api/oauth2/authorize?${params.toString()}`;
}

module.exports = {
    setupOAuth,
    generateAuthURL
};

function setupOAuth(client) {
    const app = express();

    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // OAuth2 redirect endpoint
    app.get('/oauth/discord', async (req, res) => {
        const { code, state } = req.query;

        if (!code) {
            return res.status(400).send('Authorization code not provided');
        }

        if (!state) {
            return res.status(400).send('State parameter missing');
        }

        try {
            // Parse state - now just contains guild ID since Discord provides user info via OAuth
            const guildId = state;

            if (!guildId) {
                return res.status(400).send('Invalid state parameter');
            }

            // Exchange code for access token
            const tokenResponse = await axios.post('https://discord.com/api/v10/oauth2/token', 
                new URLSearchParams({
                    client_id: process.env.OAUTH2_CLIENT_ID,
                    client_secret: process.env.OAUTH2_CLIENT_SECRET,
                    grant_type: 'authorization_code',
                    code: code,
                    redirect_uri: process.env.OAUTH2_REDIRECT_URI,
                    scope: 'identify guilds.join'
                }),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                }
            );

            const tokens = tokenResponse.data;

            // Verify the user identity
            const userResponse = await axios.get('https://discord.com/api/v10/users/@me', {
                headers: {
                    'Authorization': `${tokens.token_type} ${tokens.access_token}`
                }
            });

            const user = userResponse.data;

            // Get guild info to find the owner
            const guild = client.guilds.cache.get(guildId);
            const ownerId = guild ? guild.ownerId : null;

            // Save tokens to Firebase using the authenticated user's ID
            const success = await backupMemberTokens(guildId, user.id, tokens, ownerId);

            if (success) {
                // Give user role after successful authorization
                try {
                    if (process.env.CLAIM_ROLE_ID) {
                        const guild = client.guilds.cache.get(guildId);
                        if (guild) {
                            const member = await guild.members.fetch(user.id);
                            const role = guild.roles.cache.get(process.env.CLAIM_ROLE_ID);

                            if (member && role) {
                                await member.roles.add(role);
                                console.log(`🎭 Assigned role ${role.name} to user ${user.username} (${user.id})`);
                            } else {
                                console.log(`⚠️ Could not find member or role for user ${user.id} in guild ${guildId}`);
                            }
                        }
                    }
                } catch (roleError) {
                    console.error(`❌ Error assigning role to user ${user.id}:`, roleError);
                }

                // Send success message to user via DM
                try {
                    const discordUser = await client.users.fetch(user.id);
                    await discordUser.send({
                        embeds: [{
                            title: '🎭 Role Claimed Successfully!',
                            description: 'You have successfully claimed your role! Check the server to see your new role and perks.',
                            color: 0x00ff00,
                            timestamp: new Date()
                        }]
                    });
                } catch (dmError) {
                    console.log(`⚠️ Could not send DM to user ${user.id}`);
                }

                res.send(`
                    <html>
                        <head>
                            <title>Role Claimed Successfully!</title>
                            <style>
                                body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #36393f; color: #ffffff; }
                                .success { background: #43b581; padding: 20px; border-radius: 10px; display: inline-block; }
                                .icon { font-size: 48px; margin-bottom: 20px; }
                                .role-info { background: #2f3136; padding: 15px; border-radius: 8px; margin: 20px 0; }
                            </style>
                        </head>
                        <body>
                            <div class="success">
                                <div class="icon">🎭</div>
                                <h2>Role Claimed Successfully!</h2>
                                <div class="role-info">
                                    <strong>✅ Your special role has been assigned!</strong><br>
                                    Check your Discord server to see your new role.
                                </div>
                                <p>You can now close this window and return to Discord.</p>
                            </div>
                        </body>
                    </html>
                `);

                console.log(`🔐 Successfully stored OAuth2 tokens for user ${user.username} (${user.id}) in guild ${guildId}`);
            } else {
                res.status(500).send('Failed to save authorization data');
            }

        } catch (error) {
            console.error('❌ OAuth2 error:', error.response?.data || error.message);
            res.status(500).send('Authorization failed');
        }
    });

    // Health check endpoint
    app.get('/health', (req, res) => {
        res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // Start the OAuth2 server
    const port = process.env.PORT || 5000;
    app.listen(port, '0.0.0.0', () => {
        console.log(`🌐 OAuth2 server running on port ${port}`);
        console.log(`🔗 Redirect URI: ${process.env.OAUTH2_REDIRECT_URI}`);
    });

    return app;
}

// Function to generate OAuth2 authorization URL
function generateAuthURL(userId, guildId) {
    const params = new URLSearchParams({
        client_id: process.env.OAUTH2_CLIENT_ID,
        redirect_uri: process.env.OAUTH2_REDIRECT_URI,
        response_type: 'code',
        scope: 'identify guilds.join',
        state: `${userId}_${guildId}`
    });

    return `https://discord.com/api/oauth2/authorize?${params.toString()}`;
}

module.exports = {
    setupOAuth,
    generateAuthURL
};