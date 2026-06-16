const express = require('express');
const { validateSession } = require('../services/codeGenerator');

const SESSION_CACHE_TTL = 30000;
const sessionCache = new Map();
const SESSION_CHECK_MS = 30000;

function getCachedSession(db, sessionToken) {
    const now = Date.now();
    const cached = sessionCache.get(sessionToken);
    if (cached && now - cached.timestamp < SESSION_CACHE_TTL) {
        return cached.result;
    }
    const result = validateSession(db, sessionToken);
    sessionCache.set(sessionToken, { result, timestamp: now });
    if (sessionCache.size > 500) {
        for (const [key, val] of sessionCache) {
            if (now - val.timestamp > SESSION_CACHE_TTL) {
                sessionCache.delete(key);
            }
        }
    }
    return result;
}

module.exports = function(db, pipeConverter) {
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
            return res.status(403).json({ error: 'No session token', expired: true });
        }

        const session = getCachedSession(db, sessionToken);
        if (!session.valid) {
            return res.status(403).json({ error: session.error, expired: true });
        }

        const channel = getChannelByToken.get(req.params.channelToken);
        if (!channel) {
            return res.status(404).json({ error: 'Channel not found' });
        }

        if (session.channel_id !== channel.id) {
            sessionCache.delete(sessionToken);
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
        pipeConverter.addClient(channel.id, quality.quality_label, quality.stream_url, quality, res);

        // Periodically re-validate session for this long-lived connection.
        // If the session expires mid-stream, terminate the connection.
        let sessionCheckTimer = setInterval(() => {
            const result = getCachedSession(db, sessionToken);
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
