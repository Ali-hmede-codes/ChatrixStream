const express = require('express');
const { validateSession } = require('../services/codeGenerator');

module.exports = function(db) {
    const router = express.Router();

    const CHECK_INTERVAL_MS = 15000;

    router.get('/events', (req, res) => {
        const sessionToken = req.headers['x-session-token'] || req.query.session;
        if (!sessionToken) {
            return res.status(403).json({ error: 'No session token' });
        }

        const session = validateSession(db, sessionToken);
        if (!session.valid) {
            return res.status(403).json({ error: session.error });
        }

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });

        res.write(`event: connected\ndata: {"channel_token":"${session.channel_token}","channel_name":"${session.channel_name}","expires_at":"${session.expires_at}"}\n\n`);

        let checkTimer = null;

        function checkSession() {
            const result = validateSession(db, sessionToken);
            if (!result.valid) {
                res.write(`event: session_expired\ndata: {"error":"${result.error}"}\n\n`);
                cleanup();
                res.end();
                return;
            }

            const expires = new Date(result.expires_at);
            const now = new Date();
            const remainingMs = expires - now;

            if (remainingMs < 5 * 60 * 1000 && remainingMs > 0) {
                res.write(`event: expiring_soon\ndata: {"remaining_minutes":${Math.ceil(remainingMs / 60000)}}\n\n`);
            }

            res.write(`event: heartbeat\ndata: {"ts":${Date.now()}}\n\n`);

            if (remainingMs <= CHECK_INTERVAL_MS + 1000) {
                const finalCheck = Math.max(remainingMs, 1000);
                checkTimer = setTimeout(checkSession, finalCheck);
            } else {
                checkTimer = setTimeout(checkSession, CHECK_INTERVAL_MS);
            }
        }

        checkTimer = setTimeout(checkSession, CHECK_INTERVAL_MS);

        function cleanup() {
            if (checkTimer) {
                clearTimeout(checkTimer);
                checkTimer = null;
            }
        }

        req.on('close', () => {
            cleanup();
        });

        res.on('close', () => {
            cleanup();
        });
    });

    return router;
};
