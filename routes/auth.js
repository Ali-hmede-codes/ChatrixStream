const express = require('express');
const { redeemInviteCode, validateSession } = require('../services/codeGenerator');

module.exports = function(db) {
    const router = express.Router();

    const getQualitiesByChannel = db.prepare('SELECT quality_label as label, sort_order FROM channel_qualities WHERE channel_id = ? ORDER BY sort_order');

    router.post('/redeem', (req, res) => {
        const { code } = req.body;
        if (!code) return res.status(400).json({ error: 'Code is required' });

        const result = redeemInviteCode(db, code);

        if (result.error) {
            const statusMap = {
                'Code not found': 404,
                'Code already redeemed': 403,
                'Code expired': 403,
                'Channel not found': 404,
                'Channel link expired': 403
            };
            const errorMessages = {
                'Code not found': 'Invalid code',
                'Code already redeemed': 'Code already used',
                'Code expired': 'Code expired',
                'Channel not found': 'Invalid code',
                'Channel link expired': 'Channel link expired'
            };
            return res.status(statusMap[result.error] || 403).json({ error: errorMessages[result.error] || result.error });
        }

        const qualities = getQualitiesByChannel.all(result.channel_id);
        res.json({
            session_token: result.session_token,
            channel_token: result.channel_token,
            channel_name: result.channel_name,
            qualities,
            expires_at: result.expires_at
        });
    });

    router.post('/session', (req, res) => {
        const { session_token } = req.body;
        if (!session_token) return res.json({ valid: false, error: 'No session token provided' });

        const result = validateSession(db, session_token);

        if (!result.valid) {
            return res.json({ valid: false, error: result.error });
        }

        const qualities = getQualitiesByChannel.all(result.channel_id);
        res.json({
            valid: true,
            channel_token: result.channel_token,
            channel_name: result.channel_name,
            qualities,
            expires_at: result.expires_at
        });
    });

    return router;
};
