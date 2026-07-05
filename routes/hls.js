const express = require('express');
const SessionCache = require('../services/sessionCache');

module.exports = function(db, hlsConverter) {
    const router = express.Router();

    const sessionCache = new SessionCache(db, 30000, 500);

    const channelCache = new Map();
    const CHANNEL_CACHE_TTL = 60000;

    function getCachedChannel(token) {
        const now = Date.now();
        const cached = channelCache.get(token);
        if (cached && now - cached.timestamp < CHANNEL_CACHE_TTL) {
            return cached.result;
        }
        const result = getChannelByToken.get(token);
        channelCache.set(token, { result, timestamp: now });
        return result;
    }

    const qualityCache = new Map();
    const QUALITY_CACHE_TTL = 60000;

    function getCachedQuality(channelId, qualityLabel) {
        const key = channelId + ':' + qualityLabel;
        const now = Date.now();
        const cached = qualityCache.get(key);
        if (cached && now - cached.timestamp < QUALITY_CACHE_TTL) {
            return cached.result;
        }
        const result = getQualityByChannelAndLabel.get(channelId, qualityLabel);
        qualityCache.set(key, { result, timestamp: now });
        return result;
    }

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

        const session = sessionCache.get(sessionToken);
        if (!session.valid) return { valid: false, error: session.error };

        const channel = getCachedChannel(req.params.channelToken);
        if (!channel) return { valid: false, error: 'Channel not found' };

        if (session.channel_id !== channel.id) {
            sessionCache.invalidate(sessionToken);
            return { valid: false, error: 'Session not valid for this channel' };
        }

        if (channel.link_expires_at && new Date(channel.link_expires_at) < new Date()) {
            channelCache.delete(req.params.channelToken);
            return { valid: false, error: 'Channel link expired' };
        }

        const quality = getCachedQuality(channel.id, req.params.quality);
        if (!quality) return { valid: false, error: 'Quality not found' };

        return { valid: true, sessionToken, channel, quality };
    }

    router.post('/:channelToken/warmup', (req, res) => {
        const sessionToken = req.headers['x-session-token'] || req.query.session;
        if (!sessionToken) return res.status(403).json({ error: 'No session token', expired: true });

        const session = sessionCache.get(sessionToken);
        if (!session.valid) return res.status(403).json({ error: session.error, expired: true });

        const channel = getCachedChannel(req.params.channelToken);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });

        if (session.channel_id !== channel.id) {
            sessionCache.invalidate(sessionToken);
            return res.status(403).json({ error: 'Session not valid for this channel', expired: true });
        }

        if (channel.link_expires_at && new Date(channel.link_expires_at) < new Date()) {
            channelCache.delete(req.params.channelToken);
            return res.status(403).json({ error: 'Channel link expired', expired: true });
        }

        if (!hlsConverter.isAvailable()) {
            return res.status(503).json({ error: 'ffmpeg_not_available' });
        }

        const targetQuality = req.body.quality || req.query.quality;
        const qualities = getQualitiesByChannel.all(channel.id);
        
        if (targetQuality) {
            const q = qualities.find(x => x.quality_label === targetQuality);
            if (q) {
                const internalStreamUrl = `http://127.0.0.1:${req.socket.localPort}/internal/stream/${channel.id}/${q.quality_label}`;
                hlsConverter.ensureConversionWarmup(channel.id, q.quality_label, internalStreamUrl, q);
                return res.json({ warming: true, qualities: [q.quality_label] });
            }
        }

        // Fallback: only warm up the first quality to avoid CPU saturation
        if (qualities.length > 0) {
            const sortedQualities = qualities.sort((a, b) => a.sort_order - b.sort_order);
            const q = sortedQualities[0];
            const internalStreamUrl = `http://127.0.0.1:${req.socket.localPort}/internal/stream/${channel.id}/${q.quality_label}`;
            hlsConverter.ensureConversionWarmup(channel.id, q.quality_label, internalStreamUrl, q);
            return res.json({ warming: true, qualities: [q.quality_label] });
        }

        res.json({ warming: false, qualities: [] });
    });

    router.get('/:channelToken/manifest-ready/:quality', async (req, res) => {
        const sessionToken = req.headers['x-session-token'] || req.query.session;
        if (!sessionToken) return res.status(403).json({ ready: false, expired: true });

        const session = sessionCache.get(sessionToken);
        if (!session.valid) return res.status(403).json({ ready: false, expired: true, error: session.error });

        const channel = getCachedChannel(req.params.channelToken);
        if (!channel) return res.status(404).json({ ready: false });

        if (session.channel_id !== channel.id) {
            sessionCache.invalidate(sessionToken);
            return res.status(403).json({ ready: false, expired: true });
        }

        const quality = getCachedQuality(channel.id, req.params.quality);
        if (!quality) return res.status(404).json({ ready: false });

        if (channel.link_expires_at && new Date(channel.link_expires_at) < new Date()) {
            channelCache.delete(req.params.channelToken);
            return res.status(403).json({ ready: false, expired: true, error: 'Channel link expired' });
        }

        if (hlsConverter.isAvailable()) {
            const internalStreamUrl = `http://127.0.0.1:${req.socket.localPort}/internal/stream/${channel.id}/${quality.quality_label}`;
            hlsConverter.ensureConversionWarmup(channel.id, quality.quality_label, internalStreamUrl, quality);
        }

        const minSegments = parseInt(req.query.minSegments, 10) || 3;
        const ready = await hlsConverter.isManifestReady(channel.id, quality.quality_label, minSegments);
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, s-maxage=0, private');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.json({ ready });
    });

    router.get('/:channelToken/:quality/index.m3u8', async (req, res) => {
        const validation = validateHlsSession(req);
        if (!validation.valid) {
            // Return 403 with JSON + special header so player can detect session expiry
            // Also include proper CORS and cache headers
            res.writeHead(403, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache, no-store',
                'Access-Control-Allow-Origin': '*',
                'X-Stream-Error': 'session_expired'
            });
            return res.end(JSON.stringify({ error: validation.error, expired: true }));
        }

        if (!hlsConverter.isAvailable()) {
            res.writeHead(503, {
                'Content-Type': 'application/json',
                'Retry-After': '10',
                'Access-Control-Allow-Origin': '*'
            });
            return res.end(JSON.stringify({ error: 'ffmpeg_not_available', message: 'Server ffmpeg is not installed or not found. HLS conversion cannot be performed.' }));
        }

        const internalStreamUrl = `http://127.0.0.1:${req.socket.localPort}/internal/stream/${validation.channel.id}/${validation.quality.quality_label}`;
        hlsConverter.ensureConversion(validation.channel.id, validation.quality.quality_label, internalStreamUrl, validation.quality);

        const manifest = await hlsConverter.waitForManifest(validation.channel.id, validation.quality.quality_label);
        if (!manifest) {
            res.writeHead(503, {
                'Content-Type': 'application/json',
                'Retry-After': '3',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Expose-Headers': 'Content-Type, Retry-After, X-Stream-Error',
                'X-Stream-Error': 'stream_not_ready',
                'Cache-Control': 'no-store, no-cache, must-revalidate'
            });
            return res.end(JSON.stringify({ error: 'stream_not_ready', message: 'Stream is starting up, please retry' }));
        }

        const rewritten = hlsConverter.rewriteManifest(
            manifest,
            validation.sessionToken,
            hlsConverter.getDiscontinuityCount(validation.channel.id, validation.quality.quality_label),
            hlsConverter.getStreamSessionId(validation.channel.id, validation.quality.quality_label),
            hlsConverter.getStartNumber(validation.channel.id, validation.quality.quality_label)
        );

        res.writeHead(200, {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0, s-maxage=0, private',
            'Pragma': 'no-cache',
            'Expires': '0',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Expose-Headers': 'Content-Type, Retry-After'
        });
        res.end(rewritten);
    });

    router.get('/:channelToken/:quality/:segmentName', async (req, res) => {
        const validation = validateHlsSession(req);
        if (!validation.valid) {
            res.writeHead(403, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache, no-store',
                'Access-Control-Allow-Origin': '*'
            });
            return res.end(JSON.stringify({ error: validation.error, expired: true }));
        }

        const channelId = validation.channel.id;
        const qualityLabel = validation.quality.quality_label;
        const segmentName = req.params.segmentName;

        // Try to get segment data from in-memory cache first, then disk
        let segmentData = await hlsConverter.getSegmentData(channelId, qualityLabel, segmentName);

        // If segment not found, wait and retry up to 10 times (1 second total).
        // Uses short 100ms intervals so segments are found ASAP after FFmpeg
        // writes them to disk, minimizing the stall window for the player.
        if (!segmentData) {
            for (let retry = 0; retry < 10; retry++) {
                await new Promise(resolve => setTimeout(resolve, 100));
                segmentData = await hlsConverter.getSegmentData(channelId, qualityLabel, segmentName);
                if (segmentData) break;
            }
        }

        if (!segmentData) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, s-maxage=0');
            return res.status(404).end();
        }

        // ETag is pre-computed and cached with the segment (no per-request MD5 hash)
        const etag = segmentData.etag;

        // Check If-None-Match for conditional requests
        if (req.headers['if-none-match'] === etag) {
            return res.status(304).end();
        }

        res.writeHead(200, {
            'Content-Type': 'video/mp2t',
            'Content-Length': segmentData.size,
            'Cache-Control': 'public, max-age=60, immutable',
            'ETag': etag,
            'Access-Control-Allow-Origin': '*',
            'X-Accel-Buffering': 'no',
            'Connection': 'keep-alive'
        });

        res.end(segmentData.data);
    });

    return router;
};
