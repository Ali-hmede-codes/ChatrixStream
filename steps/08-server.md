# Step 08 — Server Entry Point

## What you build
The main `server.js` file that ties everything together: Express app, routes, middleware, static files, security headers, background cleanup task.

## Depends on
All previous steps (01-07)

## Files to create

### 1. `server.js`

**Full implementation structure:**

```
require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const initDB = require('./db/init');
const { validateSession } = require('./services/codeGenerator');
const StreamManager = require('./services/streamManager');
const adminAuth = require('./middleware/adminAuth');
const rateLimiter = require('./middleware/rateLimiter');
const adminRoutes = require('./routes/admin');
const authRoutes = require('./routes/auth');
const streamRoutes = require('./routes/stream');

// Initialize
const db = initDB(process.env.DB_PATH);
const streamManager = new StreamManager({
    highWaterMark: parseInt(process.env.STREAM_HIGH_WATER_MARK) || 1048576,
    idleTimeout: parseInt(process.env.STREAM_IDLE_TIMEOUT_MS) || 30000,
    reconnectDelay: parseInt(process.env.STREAM_RECONNECT_DELAY_MS) || 3000
});

const app = express();

// === GLOBAL MIDDLEWARE ===
app.use(express.json());
app.use(cors({ origin: 'https://stream.chatrix.vip', credentials: true }));

// Security headers (every response)
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'");
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next();
});

// === RATE LIMITING ===
const redeemLimiter = rateLimiter({ windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS), maxRequests: parseInt(process.env.RATE_LIMIT_MAX) });
const streamLimiter = rateLimiter({ windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS), maxRequests: 5 });
const adminLimiter = rateLimiter({ windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS), maxRequests: 20 });

// === ROUTES ===

// Admin routes (protected by adminAuth + rate limiter)
app.use('/api/admin', adminLimiter, adminRoutes(db, streamManager));

// Auth routes (rate limited)
app.use('/api/auth/redeem', redeemLimiter, authRoutes(db));
app.use('/api/auth/session', redeemLimiter, authRoutes(db));

// Stream route (rate limited)
app.use('/channel', streamLimiter, streamRoutes(db, streamManager, validateSession));

// === STATIC FILES ===
app.use(express.static(path.join(__dirname, 'public')));

// Landing page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Player page
app.get('/player/:channelToken', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'player.html'));
});

// Admin page
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin', 'admin.html'));
});

// === BACKGROUND CLEANUP TASK ===
// Run every 5 minutes: delete expired invite_codes, sessions, channels
function cleanupExpired() {
    const now = new Date().toISOString();

    // Delete expired sessions
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);

    // Delete expired invite codes
    db.prepare('DELETE FROM invite_codes WHERE expires_at < ?').run(now);

    // Delete expired channels (cascade: qualities, codes, sessions)
    const expiredChannels = db.prepare('SELECT id FROM channels WHERE link_expires_at < ?').all(now);
    for (const ch of expiredChannels) {
        streamManager.stopAllStreamsForChannel(ch.id);
        db.prepare('DELETE FROM channels WHERE id = ?').run(ch.id);
    }

    console.log(`Cleanup: removed expired records at ${now}`);
}

setInterval(cleanupExpired, 5 * 60 * 1000);   // every 5 minutes

// === START SERVER ===
const PORT = parseInt(process.env.PORT) || 3000;
app.listen(PORT, () => {
    console.log(`ChatrixStream server running on port ${PORT}`);
});
```

**Important notes:**
- `authRoutes` module should export a router that handles both `/redeem` and `/session` internally, or you mount them separately. Adjust based on how you structured `routes/auth.js`
- The cors origin should be `https://stream.chatrix.vip` for production. For local dev, also allow `http://localhost:3000`
- The cleanup task runs every 5 minutes and handles all expired records
- `streamManager` is shared across admin routes (for stopping streams on delete) and stream routes (for piping)

**CORS for local development:**
For testing on localhost, you may need to temporarily allow `http://localhost:3000` as well. Add this:
```
const allowedOrigins = ['https://stream.chatrix.vip', 'http://localhost:3000'];
app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) callback(null, true);
        else callback(new Error('Not allowed by CORS'));
    },
    credentials: true
}));
```

## Verify

```bash
cd E:\ChatrixStream
node server.js
```

Should print: `ChatrixStream server running on port 3000`

Then test:
```bash
curl.exe -s http://localhost:3000/ | Select-Object -First 5
```
Should return HTML (or 404 if landing page not yet created — that's OK, we build frontend next).

Test admin endpoint (should require auth):
```bash
curl.exe -s http://localhost:3000/api/admin/channels
```
Should return 401 Unauthorized.

Test with auth:
```bash
curl.exe -s -H "X-Admin-Secret: ChatrixAdmin2026SecretKey32Chars!" http://localhost:3000/api/admin/channels
```
Should return empty array `[]`.

Kill the server after testing.

## Next step
→ `steps/09-landing-page.md`
