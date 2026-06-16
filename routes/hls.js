const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { validateSession } = require('../services/codeGenerator');

const SESSION_CACHE_TTL = 30000;
const sessionCache = new Map();

function getCachedSession(db, sessionToken) {
    const now = Date.now();
    const cached = sessionCache.get(sessionToken);
    if (cached && now - cached.timestamp < SESSION_CACHE_TTL) {
        return cached.result;
    }
    const result = validateSession(db, sessionToken);
    sessionCache.set(sessionToken, { result, timestamp: now });
    // Evict stale entries when cache grows too large
    if (sessionCache.size > 500) {
        for (const [key, val] of sessionCache) {
            if (now - val.timestamp > SESSION_CACHE_TTL) {
                sessionCache.delete(key);
            }
        }
        if (sessionCache.size > 500) {
            const entries = Array.from(sessionCache.entries());
            entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
            const toRemove = entries.slice(0, entries.length - 400);
            for (const [key] of toRemove) {
                sessionCache.delete(key);
            }
        }
    }
    return result;
}

/**
 * Reverse-proxy a request from our Express server to MediaMTX's HLS server.
 * Streams the response back to the client with appropriate headers.
 */
function proxyToMediaMTX(targetUrl, req, res, extraHeaders) {
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
            timeout: 15000
        };

        const proxyReq = requester.request(options, (proxyRes) => {
            if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
                // Follow redirect
                proxyRes.resume();
                proxyToMediaMTX(proxyRes.headers.location, req, res, extraHeaders)
                    .then(resolve).catch(reject);
                return;
            }

            if (proxyRes.statusCode !== 200) {
                proxyRes.resume();
                reject(new Error('MediaMTX returned status ' + proxyRes.statusCode));
                return;
            }

            const headers = Object.assign({}, extraHeaders || {});

            // Forward content type from MediaMTX
            if (proxyRes.headers['content-type']) {
                headers['Content-Type'] = proxyRes.headers['content-type'];
            }
            if (proxyRes.headers['content-length']) {
                headers['Content-Length'] = proxyRes.headers['content-length'];
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

    // CORS preflight for manifest
    router.options('/:channelToken/:quality/index.m3u8', (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'x-session-token');
        res.setHeader('Access-Control-Max-Age', '86400');
        res.sendStatus(204);
    });

    // CORS preflight for segments
    router.options('/:channelToken/:quality/:segmentName', (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'x-session-token');
        res.setHeader('Access-Control-Max-Age', '86400');
        res.sendStatus(204);
    });

    // CORS preflight for warmup
    router.options('/:channelToken/warmup', (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-session-token');
        res.setHeader('Access-Control-Max-Age', '86400');
        res.sendStatus(204);
    });

    // CORS preflight for manifest-ready
    router.options('/:channelToken/manifest-ready/:quality', (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'x-session-token');
        res.setHeader('Access-Control-Max-Age', '86400');
        res.sendStatus(204);
    });

    function validateHlsSession(req) {
        const sessionToken = req.headers['x-session-token'] || req.query.session;
        if (!sessionToken) return { valid: false, error: 'No session token' };

        const session = getCachedSession(db, sessionToken);
        if (!session.valid) return { valid: false, error: session.error };

        const channel = getCachedChannel(req.params.channelToken);
        if (!channel) return { valid: false, error: 'Channel not found' };

        if (session.channel_id !== channel.id) {
            sessionCache.delete(sessionToken);
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

    // Warmup endpoint — ensure MediaMTX path exists before player requests manifest
    router.post('/:channelToken/warmup', async (req, res) => {
        const sessionToken = req.headers['x-session-token'] || req.query.session;
        if (!sessionToken) return res.status(403).json({ error: 'No session token', expired: true });

        const session = getCachedSession(db, sessionToken);
        if (!session.valid) return res.status(403).json({ error: session.error, expired: true });

        const channel = getCachedChannel(req.params.channelToken);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });

        if (session.channel_id !== channel.id) {
            sessionCache.delete(sessionToken);
            return res.status(403).json({ error: 'Session not valid for this channel', expired: true });
        }

        if (channel.link_expires_at && new Date(channel.link_expires_at) < new Date()) {
            channelCache.delete(req.params.channelToken);
            return res.status(403).json({ error: 'Channel link expired', expired: true });
        }

        const available = await mediamtxManager.isAvailable();
        if (!available) {
            return res.status(503).json({ error: 'media_server_not_available' });
        }

        const targetQuality = req.body.quality || req.query.quality;
        const qualities = getQualitiesByChannel.all(channel.id);

        if (targetQuality) {
            const q = qualities.find(x => x.quality_label === targetQuality);
            if (q) {
                try {
                    await mediamtxManager.ensurePath(channel.id, q.quality_label, q.stream_url, q);
                } catch (e) { /* path creation error, still return warming */ }
                return res.json({ warming: true, qualities: [q.quality_label] });
            }
        }

        // Fallback: warm up the first quality only
        if (qualities.length > 0) {
            const sortedQualities = qualities.sort((a, b) => a.sort_order - b.sort_order);
            const q = sortedQualities[0];
            try {
                await mediamtxManager.ensurePath(channel.id, q.quality_label, q.stream_url, q);
            } catch (e) { /* ignore */ }
            return res.json({ warming: true, qualities: [q.quality_label] });
        }

        res.json({ warming: false, qualities: [] });
    });

    // Manifest-ready polling endpoint
    router.get('/:channelToken/manifest-ready/:quality', async (req, res) => {
        const sessionToken = req.headers['x-session-token'] || req.query.session;
        if (!sessionToken) return res.status(403).json({ ready: false, expired: true });

        const session = getCachedSession(db, sessionToken);
        if (!session.valid) return res.status(403).json({ ready: false, expired: true, error: session.error });

        const channel = getCachedChannel(req.params.channelToken);
        if (!channel) return res.status(404).json({ ready: false });

        if (session.channel_id !== channel.id) {
            sessionCache.delete(sessionToken);
            return res.status(403).json({ ready: false, expired: true });
        }

        const quality = getCachedQuality(channel.id, req.params.quality);
        if (!quality) return res.status(404).json({ ready: false });

        if (channel.link_expires_at && new Date(channel.link_expires_at) < new Date()) {
            channelCache.delete(req.params.channelToken);
            return res.status(403).json({ ready: false, expired: true, error: 'Channel link expired' });
        }

        // Ensure the path is registered
        try {
            await mediamtxManager.ensurePath(channel.id, quality.quality_label, quality.stream_url, quality);
        } catch (e) { /* ignore */ }

        // Trigger MediaMTX to start pulling the source (sourceOnDemand needs a reader)
        mediamtxManager.triggerSource(channel.id, quality.quality_label).catch(() => {});

        // Check if MediaMTX has the stream ready
        const ready = await mediamtxManager.isPathReady(channel.id, quality.quality_label);

        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, s-maxage=0, private');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.json({ ready });
    });

    // HLS manifest endpoint — proxy to MediaMTX and rewrite segment URLs
    router.get('/:channelToken/:quality/index.m3u8', async (req, res) => {
        const validation = validateHlsSession(req);
        if (!validation.valid) {
            res.writeHead(403, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache, no-store',
                'Access-Control-Allow-Origin': '*',
                'X-Stream-Error': 'session_expired'
            });
            return res.end(JSON.stringify({ error: validation.error, expired: true }));
        }

        const available = await mediamtxManager.isAvailable();
        if (!available) {
            res.writeHead(503, {
                'Content-Type': 'application/json',
                'Retry-After': '10',
                'Access-Control-Allow-Origin': '*'
            });
            return res.end(JSON.stringify({ error: 'media_server_not_available', message: 'MediaMTX server is not running.' }));
        }

        // Ensure path is registered with MediaMTX
        try {
            await mediamtxManager.ensurePath(
                validation.channel.id,
                validation.quality.quality_label,
                validation.quality.stream_url,
                validation.quality
            );
        } catch (e) {
            res.writeHead(503, {
                'Content-Type': 'application/json',
                'Retry-After': '5',
                'Access-Control-Allow-Origin': '*',
                'X-Stream-Error': 'stream_not_ready'
            });
            return res.end(JSON.stringify({ error: 'stream_not_ready', message: 'Failed to register stream path' }));
        }

        mediamtxManager.recordAccess(validation.channel.id, validation.quality.quality_label);

        // Wait for the path to be ready (source connected, stream available)
        const ready = await mediamtxManager.waitForPathReady(
            validation.channel.id,
            validation.quality.quality_label,
            15000
        );

        if (!ready) {
            res.writeHead(503, {
                'Content-Type': 'application/json',
                'Retry-After': '3',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Expose-Headers': 'Content-Type, Retry-After, X-Stream-Error',
                'X-Stream-Error': 'stream_not_ready'
            });
            return res.end(JSON.stringify({ error: 'stream_not_ready', message: 'Stream is starting up, please retry' }));
        }

        // Proxy the manifest from MediaMTX
        const targetUrl = mediamtxManager.getHlsUrl(validation.channel.id, validation.quality.quality_label);

        try {
            // Fetch manifest content from MediaMTX
            const manifestContent = await fetchFromMediaMTX(targetUrl);
            if (!manifestContent) {
                res.writeHead(503, {
                    'Content-Type': 'application/json',
                    'Retry-After': '3',
                    'Access-Control-Allow-Origin': '*'
                });
                return res.end(JSON.stringify({ error: 'stream_not_ready', message: 'Manifest not available yet' }));
            }

            // Rewrite segment URLs to include session token and go through our proxy
            const rewritten = rewriteManifest(
                manifestContent,
                validation.sessionToken,
                req.params.channelToken,
                validation.quality.quality_label
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
        } catch (e) {
            console.error('HLS: error proxying manifest:', e.message);
            res.writeHead(503, {
                'Content-Type': 'application/json',
                'Retry-After': '3',
                'Access-Control-Allow-Origin': '*',
                'X-Stream-Error': 'stream_not_ready'
            });
            return res.end(JSON.stringify({ error: 'stream_not_ready', message: 'Failed to get stream manifest' }));
        }
    });

    // HLS segment endpoint — proxy to MediaMTX
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

        mediamtxManager.recordAccess(validation.channel.id, validation.quality.quality_label);

        const pathName = mediamtxManager.getPathName(validation.channel.id, validation.quality.quality_label);
        const segmentName = req.params.segmentName;

        // Build the MediaMTX segment URL
        const targetUrl = mediamtxManager.hlsUrl + '/' + pathName + '/' + segmentName;

        try {
            await proxyToMediaMTX(targetUrl, req, res, {
                'Cache-Control': 'public, max-age=60, immutable',
                'Access-Control-Allow-Origin': '*',
                'X-Accel-Buffering': 'no',
                'Connection': 'keep-alive'
            });
        } catch (e) {
            if (!res.headersSent) {
                res.status(404).end();
            }
        }
    });

    return router;
};

/**
 * Fetch content from MediaMTX as a string.
 */
function fetchFromMediaMTX(url) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const isHttps = parsedUrl.protocol === 'https:';
        const requester = isHttps ? require('https') : http;

        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers: {
                'Accept': '*/*',
                'User-Agent': 'ChatrixStream/1.0'
            },
            timeout: 10000
        };

        const req = requester.request(options, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                fetchFromMediaMTX(res.headers.location).then(resolve).catch(reject);
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                resolve(null);
                return;
            }
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve(data));
        });

        req.on('error', (err) => reject(err));
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('fetch timeout'));
        });
        req.end();
    });
}

/**
 * Rewrite the HLS manifest so that segment URLs go through our
 * authenticated proxy instead of directly to MediaMTX.
 *
 * MediaMTX segment URLs look like: seg0.ts, seg1.ts, etc.
 * We rewrite them to: /hls/{channelToken}/{quality}/seg0.ts?session=...&_s=...
 */
function rewriteManifest(manifestContent, sessionToken, channelToken, qualityLabel) {
    const lines = manifestContent.split('\n').flatMap(line => {
        // Remove PLAYLIST-TYPE (LIVE value confuses some players)
        if (line.startsWith('#EXT-X-PLAYLIST-TYPE')) {
            return [];
        }
        // Remove ENDLIST — this is a live stream
        if (line.startsWith('#EXT-X-ENDLIST')) {
            return [];
        }
        // Rewrite segment URLs to go through our proxy
        // MediaMTX uses segment names like: seg0.ts, seg1.ts, stream0.ts, stream1.ts, etc.
        if (line.match(/^seg\d+\.ts/) || line.match(/^stream\d+\.ts/) || line.match(/^segment\d+\.ts/)) {
            if (!line.includes('?session=')) {
                return [line + '?session=' + sessionToken + '&_s=' + Date.now()];
            }
            return [line];
        }
        return [line];
    }).filter(line => line !== null);

    // Ensure INDEPENDENT-SEGMENTS tag is present
    const hasIndependentSegments = lines.some(l => l.startsWith('#EXT-X-INDEPENDENT-SEGMENTS'));
    if (!hasIndependentSegments) {
        const versionIdx = lines.findIndex(l => l.startsWith('#EXT-X-VERSION'));
        const insertIdx = versionIdx !== -1 ? versionIdx + 1 : 1;
        lines.splice(insertIdx, 0, '#EXT-X-INDEPENDENT-SEGMENTS');
    }

    // Add live edge start offset for mobile players
    const indIdx = lines.findIndex(l => l.startsWith('#EXT-X-INDEPENDENT-SEGMENTS'));
    const startOffsetIdx = indIdx !== -1 ? indIdx + 1 : 2;
    const hasStartOffset = lines.some(l => l.startsWith('#EXT-X-START'));
    if (!hasStartOffset) {
        lines.splice(startOffsetIdx, 0, '#EXT-X-START:TIME-OFFSET=-6.0');
    }

    return lines.join('\n');
}
