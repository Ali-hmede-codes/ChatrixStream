require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const ffmpegStatic = require('ffmpeg-static');
const initDB = require('./db/init');
const { validateSession } = require('./services/codeGenerator');
const { seedAdminUsers } = require('./services/adminUser');
const StreamManager = require('./services/streamManager');
const HlsConverter = require('./services/hlsConverter');
const PipeConverter = require('./services/pipeConverter');
const rateLimiter = require('./middleware/rateLimiter');
const adminRoutes = require('./routes/admin');
const adminLoginRoutes = require('./routes/adminLogin');
const authRoutes = require('./routes/auth');
const streamRoutes = require('./routes/stream');
const hlsRoutes = require('./routes/hls');
const pipeRoutes = require('./routes/pipe');
const sseRoutes = require('./routes/sse');
const matchesRoutes = require('./routes/matches');

const db = initDB(process.env.DB_PATH);
seedAdminUsers(db);
const streamManager = new StreamManager({
    highWaterMark: parseInt(process.env.STREAM_HIGH_WATER_MARK) || 2097152,
    idleTimeout: parseInt(process.env.STREAM_IDLE_TIMEOUT_MS) || 30000,
    reconnectDelay: parseInt(process.env.STREAM_RECONNECT_DELAY_MS) || 2000,
    sourceTimeout: parseInt(process.env.STREAM_SOURCE_TIMEOUT_MS) || 15000
});
const hlsConverter = new HlsConverter({
    tempDir: process.env.HLS_TEMP_DIR || undefined,
    segmentDuration: parseInt(process.env.HLS_SEGMENT_DURATION) || 2,
    listSize: parseInt(process.env.HLS_LIST_SIZE) || 5,
    idleTimeout: parseInt(process.env.HLS_IDLE_TIMEOUT_MS) || 30000,
    idleGrace: parseInt(process.env.HLS_IDLE_GRACE_MS) || 5000,
    restartDelay: parseInt(process.env.HLS_RESTART_DELAY_MS) || 2000,
    maxRetries: parseInt(process.env.HLS_MAX_RETRIES) || 10,
    manifestWaitTimeout: parseInt(process.env.HLS_MANIFEST_WAIT_TIMEOUT_MS) || 15000,
    startupTimeout: parseInt(process.env.HLS_STARTUP_TIMEOUT_MS) || 60000,
    ffmpegPath: process.env.FFMPEG_PATH || ffmpegStatic || 'ffmpeg'
});
const pipeConverter = new PipeConverter({
    idleTimeout: parseInt(process.env.HLS_IDLE_TIMEOUT_MS) || 30000,
    restartDelay: parseInt(process.env.HLS_RESTART_DELAY_MS) || 2000,
    maxRetries: parseInt(process.env.HLS_MAX_RETRIES) || 15,
    ffmpegPath: process.env.FFMPEG_PATH || ffmpegStatic || 'ffmpeg'
});

const app = express();
app.set('trust proxy', 1);

app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ limit: '256kb', extended: true }));

const compression = require('compression');
app.use(compression({
    filter: (req, res) => {
        if (req.headers['x-no-compression']) return false;
        const type = res.getHeader('Content-Type') || '';
        // Never compress HLS manifests, segments, or raw streams
        if (type.includes('mpegurl') || type.includes('video/') || type.includes('octet-stream')) return false;
        // Respect no-transform Cache-Control
        const cc = res.getHeader('Cache-Control') || '';
        if (cc.includes('no-transform')) return false;
        if (type.includes('text/') || type.includes('json')) return true;
        return false;
    },
    threshold: 256
}));

const allowedOrigins = (process.env.CORS_ORIGINS || 'https://stream.chatrix.vip,http://localhost:3000').split(',');
app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin) || allowedOrigins.some(allowed => origin.startsWith(allowed))) callback(null, true);
        else callback(new Error('Not allowed by CORS'));
    },
    credentials: true
}));

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; worker-src 'self' blob: https://cdn.jsdelivr.net; connect-src 'self' blob: https://cdn.jsdelivr.net http: https:; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; media-src 'self' blob: http: https:; img-src 'self' https://cdn.jsdelivr.net https://cdn.kora-api.space; font-src 'self' data: https://cdn.jsdelivr.net https://fonts.gstatic.com");
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next();
});

const rateWindowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000;
const rateMax = parseInt(process.env.RATE_LIMIT_MAX) || 10;

// Strict limiter for anti-abuse endpoints (brute-force / session-creation spam).
const strictLimiter = rateLimiter({ windowMs: rateWindowMs, maxRequests: rateMax });
// Loose limiter for authenticated admin CRUD and matches proxy.
const looseLimiter = rateLimiter({ windowMs: rateWindowMs, maxRequests: 300 });

app.use('/api/admin/login', strictLimiter, adminLoginRoutes(db));
app.use('/api/admin', looseLimiter, adminRoutes(db, streamManager, hlsConverter, pipeConverter));

// Anti-abuse limiters on session-creation endpoints only.
// Stream routes (/channel, /pipe, /hls) are intentionally NOT rate-limited —
// they are long-lived or polled every ~2s; any per-IP cap would kick viewers off mid-stream.
app.use('/api/auth/redeem', strictLimiter);
app.use('/api/auth/direct', strictLimiter);
app.use('/api/auth', authRoutes(db));
app.use('/api/auth/sse', sseRoutes(db));
app.use('/api/matches', looseLimiter, matchesRoutes);

app.get('/internal/stream/:channelId/:quality', (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
        return res.status(403).send('Forbidden');
    }
    const channelId = req.params.channelId;
    const qualityLabel = req.params.quality;
    const quality = db.prepare('SELECT stream_url FROM channel_qualities WHERE channel_id = ? AND quality_label = ?').get(channelId, qualityLabel);
    if (!quality) return res.status(404).send('Not found');
    
    streamManager.addClient(channelId, qualityLabel, quality.stream_url, res);
});

app.use('/channel', streamRoutes(db, streamManager));
app.use('/hls', hlsRoutes(db, hlsConverter));
app.use('/pipe', pipeRoutes(db, pipeConverter));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/favicon.ico', (req, res) => {
    res.redirect(301, '/favicon.svg');
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/matches', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'matches.html'));
});

app.get('/player/:channelToken', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'player.html'));
});

app.get('/channel/:channelToken', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin', 'admin.html'));
});

// Final error handler — returns JSON (never a stack-trace HTML page).
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || 500;
    if (status >= 500) console.error('Unhandled error:', err);
    res.status(status).json({ error: err.message || 'Internal server error' });
});

function cleanupExpired() {
  try {
    const now = new Date().toISOString();

    const expiredSessions = db.prepare('SELECT channel_id FROM sessions WHERE expires_at < ?').all(now);
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
    db.prepare('DELETE FROM invite_codes WHERE expires_at < ?').run(now);
    // Prune viewer tracking rows for channels that no longer exist (defensive — cascade should handle this).
    db.prepare('DELETE FROM channel_viewers WHERE channel_id NOT IN (SELECT id FROM channels)').run();

    const expiredChannels = db.prepare('SELECT id FROM channels WHERE link_expires_at IS NOT NULL AND link_expires_at < ?').all(now);
    for (const ch of expiredChannels) {
        streamManager.stopAllStreamsForChannel(ch.id);
        hlsConverter.stopAllForChannel(ch.id);
        pipeConverter.stopAllForChannel(ch.id);
        db.prepare('UPDATE sessions SET expires_at = ? WHERE channel_id = ? AND expires_at > ?').run(now, ch.id, now);
    }

    for (const es of expiredSessions) {
        const channelId = es.channel_id;
        const isExpiredChannel = expiredChannels.some(c => c.id === channelId);
        if (!isExpiredChannel) {
            const remainingValid = db.prepare('SELECT COUNT(*) as cnt FROM sessions WHERE channel_id = ? AND expires_at > ?').get(channelId, now);
            if (remainingValid.cnt === 0) {
                streamManager.stopAllStreamsForChannel(channelId);
                hlsConverter.stopAllForChannel(channelId);
                pipeConverter.stopAllForChannel(channelId);
            }
        }
    }

    console.log('Cleanup: removed expired records at ' + now);
  } catch (e) {
    console.error('Cleanup error (non-fatal):', e.message);
  }
}

setInterval(cleanupExpired, 5 * 60 * 1000);

const PORT = parseInt(process.env.PORT) || 3000;
const server = app.listen(PORT, () => {
    console.log(`ChatrixStream server running on port ${PORT}`);
});

function gracefulShutdown() {
    console.log('Shutting down...');
    streamManager.stopAll();
    hlsConverter.stopAll();
    pipeConverter.stopAll();
    server.close(() => {
        process.exit(0);
    });
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    gracefulShutdown();
});
