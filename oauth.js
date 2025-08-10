
const express = require('express');
const axios = require('axios');
const { backupMemberTokens } = require('./backup');

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
            // Parse state to get user and guild ID
            const [userId, guildId] = state.split('_');
            
            if (!userId || !guildId) {
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
            
            // Ensure the user ID matches
            if (user.id !== userId) {
                return res.status(403).send('User ID mismatch');
            }
            
            // Save tokens to Firebase
            const success = await backupMemberTokens(guildId, userId, tokens);
            
            if (success) {
                // Send success message to user via DM
                try {
                    const discordUser = await client.users.fetch(userId);
                    await discordUser.send({
                        embeds: [{
                            title: '✅ Authorization Successful',
                            description: 'You have successfully authorized the backup bot. You will be automatically re-added to any new server if this one is compromised.',
                            color: 0x00ff00,
                            timestamp: new Date()
                        }]
                    });
                } catch (dmError) {
                    console.log(`⚠️ Could not send DM to user ${userId}`);
                }
                
                res.send(`
                    <html>
                        <head>
                            <title>Authorization Successful</title>
                            <style>
                                body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #36393f; color: #ffffff; }
                                .success { background: #43b581; padding: 20px; border-radius: 10px; display: inline-block; }
                                .icon { font-size: 48px; margin-bottom: 20px; }
                            </style>
                        </head>
                        <body>
                            <div class="success">
                                <div class="icon">✅</div>
                                <h2>Authorization Successful!</h2>
                                <p>You have been successfully registered with the backup system.</p>
                                <p>You can now close this window and return to Discord.</p>
                            </div>
                        </body>
                    </html>
                `);
                
                console.log(`🔐 Successfully stored OAuth2 tokens for user ${user.username} (${userId}) in guild ${guildId}`);
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
