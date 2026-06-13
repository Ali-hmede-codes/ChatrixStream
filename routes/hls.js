const express = require('express');
const fs = require('fs');
const { validateSession } = require('../services/codeGenerator');

module.exports = function(db, hlsConverter) {
    const router = express.Router();

    const getChannelByToken = db.prepare('SELECT * FROM channels WHERE channel_token = ?');
    const getQualityByChannelAndLabel = db.prepare('SELECT * FROM channel_qualities WHERE channel_id = ? AND quality_label = ?');
    const getQualitiesByChannel = db.prepare('SELECT * FROM channel_qualities WHERE channel_id = ? ORDER BY sort_order');

    router.options('/:channelToken/:quality/index.m3u8', (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'x-session-token');
        res.setHeader('Access-Control-Max-Age', '86400');
        res.sendStatus(204);
    });

    router.options('/:channelToken/:quality/:segmentName', (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'x-session-token');
        res.setHeader('Access-Control-Max-Age', '86400');
        res.sendStatus(204);
    });

    router.options('/:channelToken/warmup', (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-session-token');
        res.setHeader('Access-Control-Max-Age', '86400');
        res.sendStatus(204);
    });

    router.options('/:channelToken/manifest-ready', (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'x-session-token');
        res.setHeader('Access-Control-Max-Age', '86400');
        res.sendStatus(204);
    });

    function validateHlsSession(req) {
        const sessionToken = req.headers['x-session-token'] || req.query.session;
        if (!sessionToken) return { valid: false, error: 'No session token' };

        const session = validateSession(db, sessionToken);
        if (!session.valid) return { valid: false, error: session.error };

        const channel = getChannelByToken.get(req.params.channelToken);
        if (!channel) return { valid: false, error: 'Channel not found' };

        if (session.channel_id !== channel.id) return { valid: false, error: 'Session not valid for this channel' };

        if (channel.link_expires_at && new Date(channel.link_expires_at) < new Date()) {
            return { valid: false, error: 'Channel link expired' };
        }

        const quality = getQualityByChannelAndLabel.get(channel.id, req.params.quality);
        if (!quality) return { valid: false, error: 'Quality not found' };

        return { valid: true, sessionToken, channel, quality };
    }

    router.post('/:channelToken/warmup', (req, res) => {
        const sessionToken = req.headers['x-session-token'] || req.query.session;
        if (!sessionToken) return res.status(403).json({ error: 'No session token', expired: true });

        const session = validateSession(db, sessionToken);
        if (!session.valid) return res.status(403).json({ error: session.error, expired: true });

        const channel = getChannelByToken.get(req.params.channelToken);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });

        if (session.channel_id !== channel.id) return res.status(403).json({ error: 'Session not valid for this channel', expired: true });

        if (channel.link_expires_at && new Date(channel.link_expires_at) < new Date()) {
            return res.status(403).json({ error: 'Channel link expired', expired: true });
        }

        if (!hlsConverter.isAvailable()) {
            return res.status(503).json({ error: 'ffmpeg_not_available' });
        }

        const qualities = getQualitiesByChannel.all(channel.id);
        for (const q of qualities) {
            hlsConverter.ensureConversionWarmup(channel.id, q.quality_label, q.stream_url);
        }

        res.json({ warming: true, qualities: qualities.map(q => q.quality_label) });
    });

    router.get('/:channelToken/manifest-ready/:quality', (req, res) => {
        const sessionToken = req.headers['x-session-token'] || req.query.session;
        if (!sessionToken) return res.status(403).json({ ready: false, expired: true });

        const session = validateSession(db, sessionToken);
        if (!session.valid) return res.status(403).json({ ready: false, expired: true, error: session.error });

        const channel = getChannelByToken.get(req.params.channelToken);
        if (!channel) return res.status(404).json({ ready: false });

        if (session.channel_id !== channel.id) return res.status(403).json({ ready: false, expired: true });

        const quality = getQualityByChannelAndLabel.get(channel.id, req.params.quality);
        if (!quality) return res.status(404).json({ ready: false });

        if (channel.link_expires_at && new Date(channel.link_expires_at) < new Date()) {
            return res.status(403).json({ ready: false, expired: true, error: 'Channel link expired' });
        }

        if (hlsConverter.isAvailable()) {
            hlsConverter.ensureConversionWarmup(channel.id, quality.quality_label, quality.stream_url);
        }

        const ready = hlsConverter.isManifestReady(channel.id, quality.quality_label);
        res.json({ ready });
    });

    router.get('/:channelToken/:quality/index.m3u8', async (req, res) => {
        const validation = validateHlsSession(req);
        if (!validation.valid) {
            res.writeHead(403, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache, no-store',
                'Access-Control-Allow-Origin': '*'
            });
            return res.end(JSON.stringify({ error: validation.error, expired: true }));
        }

        if (!hlsConverter.isAvailable()) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'ffmpeg_not_available', message: 'Server ffmpeg is not installed or not found. HLS conversion cannot be performed.' }));
        }

        hlsConverter.ensureConversion(validation.channel.id, validation.quality.quality_label, validation.quality.stream_url);

        const manifest = await hlsConverter.waitForManifest(validation.channel.id, validation.quality.quality_label);
        if (!manifest) {
            res.writeHead(503, {
                'Content-Type': 'application/json',
                'Retry-After': '2',
                'Access-Control-Allow-Origin': '*'
            });
            return res.end(JSON.stringify({ error: 'stream_not_ready', message: 'Stream is starting up, please retry' }));
        }

        const rewritten = hlsConverter.rewriteManifest(
            manifest,
            validation.sessionToken,
            hlsConverter.getDiscontinuityCount(validation.channel.id, validation.quality.quality_label)
        );

        res.writeHead(200, {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Cache-Control': 'no-cache, no-store, no-transform, must-revalidate',
            'Pragma': 'no-cache',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Expose-Headers': 'Content-Type, Retry-After'
        });
        res.end(rewritten);
    });

    router.get('/:channelToken/:quality/:segmentName', (req, res) => {
        const validation = validateHlsSession(req);
        if (!validation.valid) {
            res.writeHead(403, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache, no-store',
                'Access-Control-Allow-Origin': '*'
            });
            return res.end(JSON.stringify({ error: validation.error, expired: true }));
        }

        const segmentPath = hlsConverter.getSegmentPath(validation.channel.id, validation.quality.quality_label, req.params.segmentName);
        if (!segmentPath) {
            return res.status(404).end();
        }

        res.writeHead(200, {
            'Content-Type': 'video/mp2t',
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*'
        });

        const fileStream = fs.createReadStream(segmentPath);
        fileStream.pipe(res);

        fileStream.on('error', () => {
            if (!res.headersSent) {
                res.status(404).end();
            } else {
                res.end();
            }
        });
    });

    return router;
};
