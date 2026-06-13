const express = require('express');
const { validateSession } = require('../services/codeGenerator');

const STREAM_SESSION_CHECK_MS = 30000;

module.exports = function(db, streamManager) {
    const router = express.Router();

    const getChannelByToken = db.prepare('SELECT * FROM channels WHERE channel_token = ?');
    const getQualityByChannelAndLabel = db.prepare('SELECT * FROM channel_qualities WHERE channel_id = ? AND quality_label = ?');

    router.options('/:channelToken/:quality', (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'x-session-token');
        res.setHeader('Access-Control-Max-Age', '86400');
        res.sendStatus(204);
    });

    router.get('/:channelToken/:quality', (req, res) => {
        const sessionToken = req.headers['x-session-token'] || req.query.session;
        if (!sessionToken) {
            return res.status(403).json({ error: 'No session token' });
        }

        const session = validateSession(db, sessionToken);
        if (!session.valid) {
            return res.status(403).json({ error: session.error });
        }

        const channel = getChannelByToken.get(req.params.channelToken);
        if (!channel) {
            return res.status(404).json({ error: 'Channel not found' });
        }

        if (session.channel_id !== channel.id) {
            return res.status(403).json({ error: 'Session not valid for this channel' });
        }

        if (channel.link_expires_at && new Date(channel.link_expires_at) < new Date()) {
            return res.status(403).json({ error: 'Channel link expired' });
        }

        const quality = getQualityByChannelAndLabel.get(channel.id, req.params.quality);
        if (!quality) {
            return res.status(404).json({ error: 'Quality not found' });
        }

        streamManager.addClient(channel.id, quality.quality_label, quality.stream_url, res);

        // Periodically re-validate session for this long-lived stream connection.
        // If the session or channel link expires mid-stream, kill the connection.
        let sessionCheckTimer = setInterval(() => {
            const result = validateSession(db, sessionToken);
            if (!result.valid) {
                console.log('Stream session expired mid-stream for channel', channel.id, '- terminating connection');
                clearInterval(sessionCheckTimer);
                sessionCheckTimer = null;
                streamManager.removeClient(channel.id, quality.quality_label, res);
                res.end();
            }
        }, STREAM_SESSION_CHECK_MS);

        req.on('close', () => {
            if (sessionCheckTimer) {
                clearInterval(sessionCheckTimer);
                sessionCheckTimer = null;
            }
            streamManager.removeClient(channel.id, quality.quality_label, res);
        });
    });

    return router;
};
