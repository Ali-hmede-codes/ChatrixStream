const express = require('express');
const http = require('http');
const { validateSession } = require('../services/codeGenerator');

const STREAM_SESSION_CHECK_MS = 30000;

/**
 * Proxy a request to MediaMTX.
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
        const targetUrl = mediamtxManager.getHlsUrl(channel.id, quality.quality_label);

        try {
            await proxyToMediaMTX(targetUrl, res, {
                'Content-Type': 'application/vnd.apple.mpegurl',
                'Cache-Control': 'no-cache, no-store, no-transform',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*',
                'X-Accel-Buffering': 'no'
            });
        } catch (e) {
            if (!res.headersSent) {
                res.status(503).json({ error: 'stream_not_ready' });
            }
        }

        // Periodically re-validate session for this long-lived stream connection.
        let sessionCheckTimer = setInterval(() => {
            const result = validateSession(db, sessionToken);
            if (!result.valid) {
                console.log('Stream session expired mid-stream for channel', channel.id, '- terminating connection');
                clearInterval(sessionCheckTimer);
                sessionCheckTimer = null;
                res.end();
            }
        }, STREAM_SESSION_CHECK_MS);

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
