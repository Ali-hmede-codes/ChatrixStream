const express = require('express');
const http = require('http');
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

/**
 * Proxy a request to MediaMTX's HLS endpoint.
 * This replaces the old FFmpeg-based MPEG-TS pipe with a simpler
 * reverse-proxy to MediaMTX, which handles all stream processing.
 */
function proxyToMediaMTX(targetUrl, res, extraHeaders) {
    return new Promise((resolve, reject) => {
        const url = new URL(targetUrl);
        const isHttps = url.protocol === 'https:';
        const requester = isHttps ? require('https') : http;

        const options = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + url.search,
            method: 'GET',
            headers: {
                'Accept': '*/*',
                'User-Agent': 'ChatrixStream-Proxy/1.0'
            },
            timeout: 30000
        };

        const proxyReq = requester.request(options, (proxyRes) => {
            if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
                proxyRes.resume();
                proxyToMediaMTX(proxyRes.headers.location, res, extraHeaders)
                    .then(resolve).catch(reject);
                return;
            }

            if (proxyRes.statusCode !== 200) {
                proxyRes.resume();
                reject(new Error('MediaMTX returned status ' + proxyRes.statusCode));
                return;
            }

            const headers = Object.assign({}, extraHeaders || {});
            if (proxyRes.headers['content-type']) {
                headers['Content-Type'] = proxyRes.headers['content-type'];
            }

            res.writeHead(200, headers);
            proxyRes.pipe(res);
            proxyRes.on('end', () => resolve());
            proxyRes.on('error', (err) => reject(err));
        });

        proxyReq.on('error', (err) => reject(err));
        proxyReq.on('timeout', () => {
            proxyReq.destroy();
            reject(new Error('MediaMTX proxy timeout'));
        });

        proxyReq.end();
    });
}

module.exports = function(db, mediamtxManager) {
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

    router.get('/:channelToken/:quality', async (req, res) => {
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

        const available = await mediamtxManager.isAvailable();
        if (!available) {
            return res.status(503).json({ error: 'media_server_not_available' });
        }

        // Ensure the path is registered with MediaMTX
        try {
            await mediamtxManager.ensurePath(channel.id, quality.quality_label, quality.stream_url, quality);
        } catch (e) {
            return res.status(503).json({ error: 'stream_not_ready', message: 'Failed to register stream path' });
        }

        mediamtxManager.recordAccess(channel.id, quality.quality_label);

        // Wait for the stream to be ready
        const ready = await mediamtxManager.waitForPathReady(channel.id, quality.quality_label, 15000);
        if (!ready) {
            return res.status(503).json({ error: 'stream_not_ready', message: 'Stream is starting up' });
        }

        // Proxy the HLS manifest from MediaMTX
        // The pipe route now serves the same HLS content — the frontend mpegts.js
        // player can consume HLS directly
        const targetUrl = mediamtxManager.getHlsUrl(channel.id, quality.quality_label);

        try {
            await proxyToMediaMTX(targetUrl, res, {
                'Content-Type': 'application/vnd.apple.mpegurl',
                'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
                'Pragma': 'no-cache',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Expose-Headers': 'X-Stream-Type, Content-Type',
                'X-Accel-Buffering': 'no',
                'X-Stream-Type': 'pipe'
            });
        } catch (e) {
            if (!res.headersSent) {
                res.status(503).json({ error: 'stream_not_ready', message: 'Failed to get stream' });
            }
        }

        // Periodically re-validate session for this long-lived connection
        let sessionCheckTimer = setInterval(() => {
            const result = getCachedSession(db, sessionToken);
            if (!result.valid) {
                console.log('Pipe: session expired mid-stream for channel', channel.id);
                clearInterval(sessionCheckTimer);
                sessionCheckTimer = null;
                res.end();
            }
        }, SESSION_CHECK_MS);

        req.on('close', () => {
            if (sessionCheckTimer) {
                clearInterval(sessionCheckTimer);
                sessionCheckTimer = null;
            }
            mediamtxManager.recordAccess(channel.id, quality.quality_label);
        });
    });

    return router;
};
