const express = require('express');
const fs = require('fs');
const { validateSession } = require('../services/codeGenerator');

module.exports = function(db, hlsConverter) {
    const router = express.Router();

    const getChannelByToken = db.prepare('SELECT * FROM channels WHERE channel_token = ?');
    const getQualityByChannelAndLabel = db.prepare('SELECT * FROM channel_qualities WHERE channel_id = ? AND quality_label = ?');

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

    router.get('/:channelToken/:quality/index.m3u8', (req, res) => {
        const validation = validateHlsSession(req);
        if (!validation.valid) {
            res.writeHead(403, { 'Content-Type': 'application/vnd.apple.mpegurl' });
            return res.end('#EXTM3U\n#EXT-X-VERSION:3\n');
        }

        if (!hlsConverter.isAvailable()) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'ffmpeg not available', message: 'Server ffmpeg is not installed or not found. HLS conversion cannot be performed.' }));
        }

        hlsConverter.ensureConversion(validation.channel.id, validation.quality.quality_label, validation.quality.stream_url);

        const manifest = hlsConverter.getManifest(validation.channel.id, validation.quality.quality_label);
        if (!manifest) {
            res.writeHead(503, { 'Content-Type': 'application/vnd.apple.mpegurl' });
            return res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n');
        }

        const rewritten = hlsConverter.rewriteManifest(manifest, validation.sessionToken);

        res.writeHead(200, {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Cache-Control': 'no-cache, no-store, no-transform',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(rewritten);
    });

    router.get('/:channelToken/:quality/:segmentName', (req, res) => {
        const validation = validateHlsSession(req);
        if (!validation.valid) {
            return res.status(403).end();
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
