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
const rateLimiter = require('./middleware/rateLimiter');
const adminRoutes = require('./routes/admin');
const adminLoginRoutes = require('./routes/adminLogin');
const authRoutes = require('./routes/auth');
const streamRoutes = require('./routes/stream');
const hlsRoutes = require('./routes/hls');
const sseRoutes = require('./routes/sse');

const db = initDB(process.env.DB_PATH);
seedAdminUsers(db);
const streamManager = new StreamManager({
    highWaterMark: parseInt(process.env.STREAM_HIGH_WATER_MARK) || 1048576,
    idleTimeout: parseInt(process.env.STREAM_IDLE_TIMEOUT_MS) || 30000,
    reconnectDelay: parseInt(process.env.STREAM_RECONNECT_DELAY_MS) || 3000,
    sourceTimeout: parseInt(process.env.STREAM_SOURCE_TIMEOUT_MS) || 10000
});
const hlsConverter = new HlsConverter({
    tempDir: process.env.HLS_TEMP_DIR || undefined,
    segmentDuration: parseInt(process.env.HLS_SEGMENT_DURATION) || 2,
    listSize: parseInt(process.env.HLS_LIST_SIZE) || 6,
    idleTimeout: parseInt(process.env.HLS_IDLE_TIMEOUT_MS) || 30000,
    restartDelay: parseInt(process.env.HLS_RESTART_DELAY_MS) || 3000,
    ffmpegPath: process.env.FFMPEG_PATH || ffmpegStatic || 'ffmpeg'
});

const app = express();

app.use(express.json());

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
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; worker-src 'self' blob: https://cdn.jsdelivr.net; connect-src 'self' blob: https://cdn.jsdelivr.net http: https:; style-src 'self' 'unsafe-inline'; media-src 'self' blob: http: https:; img-src 'self'; font-src 'self'");
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next();
});

const redeemLimiter = rateLimiter({ windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000, maxRequests: parseInt(process.env.RATE_LIMIT_MAX) || 10 });
const streamLimiter = rateLimiter({ windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000, maxRequests: parseInt(process.env.RATE_LIMIT_STREAM_MAX) || 30 });
const adminLimiter = rateLimiter({ windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000, maxRequests: 20 });

app.use('/api/admin/login', adminLimiter, adminLoginRoutes(db));
app.use('/api/admin', adminLimiter, adminRoutes(db, streamManager));
app.use('/api/auth', redeemLimiter, authRoutes(db));
app.use('/api/auth/sse', sseRoutes(db));
app.use('/channel', streamLimiter, streamRoutes(db, streamManager));
app.use('/hls', streamLimiter, hlsRoutes(db, hlsConverter));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/player/:channelToken', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'player.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin', 'admin.html'));
});

function cleanupExpired() {
    const now = new Date().toISOString();

    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
    db.prepare('DELETE FROM invite_codes WHERE expires_at < ?').run(now);

    const expiredChannels = db.prepare('SELECT id FROM channels WHERE link_expires_at < ?').all(now);
    for (const ch of expiredChannels) {
        streamManager.stopAllStreamsForChannel(ch.id);
        hlsConverter.stopAllForChannel(ch.id);
        db.prepare('DELETE FROM channels WHERE id = ?').run(ch.id);
    }

    console.log(`Cleanup: removed expired records at ${now}`);
}

setInterval(cleanupExpired, 5 * 60 * 1000);

const PORT = parseInt(process.env.PORT) || 3000;
const server = app.listen(PORT, () => {
    console.log(`ChatrixStream server running on port ${PORT}`);
});

function gracefulShutdown() {
    console.log('Shutting down...');
    hlsConverter.stopAll();
    server.close(() => {
        process.exit(0);
    });
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
