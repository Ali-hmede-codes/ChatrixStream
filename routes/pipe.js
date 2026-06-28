const express = require('express');
const SessionCache = require('../services/sessionCache');

const SESSION_CHECK_MS = 30000;

module.exports = function(db, pipeConverter) {
    const router = express.Router();

    const sessionCache = new SessionCache(db, 30000, 500);

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
            return res.status(403).json({ error: 'No session token', expired: true });
        }

        const session = sessionCache.get(sessionToken);
        if (!session.valid) {
            return res.status(403).json({ error: session.error, expired: true });
        }

        const channel = getChannelByToken.get(req.params.channelToken);
        if (!channel) {
            return res.status(404).json({ error: 'Channel not found' });
        }

        if (session.channel_id !== channel.id) {
            sessionCache.invalidate(sessionToken);
            return res.status(403).json({ error: 'Session not valid for this channel', expired: true });
        }

        if (channel.link_expires_at && new Date(channel.link_expires_at) < new Date()) {
            return res.status(403).json({ error: 'Channel link expired', expired: true });
        }

        const quality = getQualityByChannelAndLabel.get(channel.id, req.params.quality);
        if (!quality) {
            return res.status(404).json({ error: 'Quality not found' });
        }

        if (!pipeConverter.isAvailable()) {
            return res.status(503).json({ error: 'ffmpeg_not_available' });
        }

        // Connect this client to the pipe stream
        const internalStreamUrl = `http://127.0.0.1:${req.socket.localPort}/internal/stream/${channel.id}/${quality.quality_label}`;
        pipeConverter.addClient(channel.id, quality.quality_label, internalStreamUrl, quality, res);

        // Periodically re-validate session for this long-lived connection.
        // If the session expires mid-stream, terminate the connection.
        let sessionCheckTimer = setInterval(() => {
            const result = sessionCache.get(sessionToken);
            if (!result.valid) {
                console.log('Pipe: session expired mid-stream for channel', channel.id);
                clearInterval(sessionCheckTimer);
                sessionCheckTimer = null;
                pipeConverter.removeClient(channel.id, quality.quality_label, res);
                res.end();
            }
        }, SESSION_CHECK_MS);

        req.on('close', () => {
            if (sessionCheckTimer) {
                clearInterval(sessionCheckTimer);
                sessionCheckTimer = null;
            }
            pipeConverter.removeClient(channel.id, quality.quality_label, res);
        });
    });

    return router;
};
