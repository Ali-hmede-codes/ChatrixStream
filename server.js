require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const initDB = require('./db/init');
const { seedAdminUsers } = require('./services/adminUser');
const MediaMTXManager = require('./services/mediamtxManager');
const FFmpegBridge = require('./services/ffmpegBridge');
const rateLimiter = require('./middleware/rateLimiter');
const adminRoutes = require('./routes/admin');
const adminLoginRoutes = require('./routes/adminLogin');
const authRoutes = require('./routes/auth');
const streamRoutes = require('./routes/stream');
const hlsRoutes = require('./routes/hls');
const pipeRoutes = require('./routes/pipe');
const sseRoutes = require('./routes/sse');

const db = initDB(process.env.DB_PATH);
seedAdminUsers(db);

const ffmpegBridge = new FFmpegBridge({
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
    rtspHost: (process.env.MEDIAMTX_RTSP_URL || 'rtsp://localhost:8554').replace('rtsp://', '').split(':')[0] || 'localhost',
    rtspPort: parseInt((process.env.MEDIAMTX_RTSP_URL || 'rtsp://localhost:8554').replace('rtsp://', '').split(':')[1]) || 8554,
    restartDelay: parseInt(process.env.FFMPEG_RESTART_DELAY_MS) || 3000,
    maxRestartAttempts: parseInt(process.env.FFMPEG_MAX_RESTART_ATTEMPTS) || 5
});

const mediamtxManager = new MediaMTXManager({
    apiUrl: process.env.MEDIAMTX_API_URL || 'http://localhost:9997',
    hlsUrl: process.env.MEDIAMTX_HLS_URL || 'http://localhost:8888',
    rtspUrl: process.env.MEDIAMTX_RTSP_URL || 'rtsp://localhost:8554',
    idleTimeout: parseInt(process.env.MEDIAMTX_IDLE_TIMEOUT_MS) || 120000,
    startupTimeout: parseInt(process.env.MEDIAMTX_STARTUP_TIMEOUT_MS) || 45000,
    ffmpegBridge: ffmpegBridge
});

ffmpegBridge.isFFmpegAvailable().then(function(available) {
    if (available) {
        console.log('FFmpegBridge: ffmpeg is available');
    } else {
        console.warn('FFmpegBridge: ffmpeg is NOT available — HTTP source streams will not work. Install ffmpeg and add it to PATH.');
    }
});

const app = express();

app.use(express.json());

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
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; worker-src 'self' blob: https://cdn.jsdelivr.net; connect-src 'self' blob: https://cdn.jsdelivr.net http: https:; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; media-src 'self' blob: http: https:; img-src 'self' https://cdn.jsdelivr.net; font-src 'self' data: https://cdn.jsdelivr.net https://fonts.gstatic.com");
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next();
});

const adminLimiter = rateLimiter({ windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000, maxRequests: 20 });

app.use('/api/admin/login', adminLimiter, adminLoginRoutes(db));
app.use('/api/admin', adminLimiter, adminRoutes(db, mediamtxManager));
app.use('/api/auth', authRoutes(db));
app.use('/api/auth/sse', sseRoutes(db));
app.use('/channel', streamRoutes(db, mediamtxManager));
app.use('/hls', hlsRoutes(db, mediamtxManager));
app.use('/pipe', pipeRoutes(db, mediamtxManager));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/favicon.ico', (req, res) => {
    res.redirect(301, '/favicon.svg');
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
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

function cleanupExpired() {
    const now = new Date().toISOString();

    const expiredSessions = db.prepare('SELECT channel_id FROM sessions WHERE expires_at < ?').all(now);
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
    db.prepare('DELETE FROM invite_codes WHERE expires_at < ?').run(now);

    const expiredChannels = db.prepare('SELECT id FROM channels WHERE link_expires_at IS NOT NULL AND link_expires_at < ?').all(now);
    for (const ch of expiredChannels) {
        mediamtxManager.removeAllForChannel(ch.id);
        db.prepare('UPDATE sessions SET expires_at = ? WHERE channel_id = ? AND expires_at > ?').run(now, ch.id, now);
    }

    for (const es of expiredSessions) {
        const channelId = es.channel_id;
        const isExpiredChannel = expiredChannels.some(c => c.id === channelId);
        if (!isExpiredChannel) {
            const remainingValid = db.prepare('SELECT COUNT(*) as cnt FROM sessions WHERE channel_id = ? AND expires_at > ?').get(channelId, now);
            if (remainingValid.cnt === 0) {
                mediamtxManager.removeAllForChannel(channelId);
            }
        }
    }

    console.log('Cleanup: removed expired records at ' + now);
}

setInterval(cleanupExpired, 5 * 60 * 1000);

const PORT = parseInt(process.env.PORT) || 3000;
const server = app.listen(PORT, () => {
    console.log(`ChatrixStream server running on port ${PORT}`);
});

function gracefulShutdown() {
    console.log('Shutting down...');
    ffmpegBridge.destroy();
    mediamtxManager.destroy();
    mediamtxManager.removeAll().catch(() => {});
    server.close(() => {
        process.exit(0);
    });
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
