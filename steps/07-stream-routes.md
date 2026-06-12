# Step 07 — Stream Routes

## What you build
The stream proxy endpoint that pipes MPEG-TS video to authenticated users. This is the core streaming route.

## Depends on
Step 03 (services: streamManager) + Step 04 (middleware: sessionAuth)

## Files to create

### 1. `routes/stream.js`

Express Router with the stream pipe endpoint and player page serving.

**Router setup:**
```
const express = require('express');
const router = express.Router();
const StreamManager = require('../services/streamManager');
```

#### Endpoints:

**GET `/channel/:channelToken/:quality`** — Stream proxy endpoint

This is the most critical route. It:
1. Validates the session token (via middleware or inline)
2. Looks up the channel by `channelToken`
3. Looks up the quality's source stream URL
4. Validates everything
5. Pipes the stream to the response via StreamManager

**Implementation details:**

```
router.get('/channel/:channelToken/:quality', async (req, res) => {
    // 1. Get session token from header or query param
    const sessionToken = req.headers['x-session-token'] || req.query.session;
    if (!sessionToken) {
        return res.status(403).json({ error: 'No session token' });
    }

    // 2. Validate session
    const session = validateSession(db, sessionToken);
    if (!session.valid) {
        return res.status(403).json({ error: session.error });
    }

    // 3. Look up channel by token
    const channel = db.prepare('SELECT * FROM channels WHERE channel_token = ?').get(req.params.channelToken);
    if (!channel) {
        return res.status(404).json({ error: 'Channel not found' });
    }

    // 4. Verify session belongs to this channel
    if (session.channel_id !== channel.id) {
        return res.status(403).json({ error: 'Session not valid for this channel' });
    }

    // 5. Check channel link not expired
    if (channel.link_expires_at && new Date(channel.link_expires_at) < new Date()) {
        return res.status(403).json({ error: 'Channel link expired' });
    }

    // 6. Look up quality
    const quality = db.prepare('SELECT * FROM channel_qualities WHERE channel_id = ? AND quality_label = ?').get(channel.id, req.params.quality);
    if (!quality) {
        return res.status(404).json({ error: 'Quality not found' });
    }

    // 7. Set stream response headers
    res.writeHead(200, {
        'Content-Type': 'video/mp2t',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Transfer-Encoding': 'chunked',
        'X-Content-Type-Options': 'nosniff',
        'Connection': 'keep-alive'
    });

    // 8. Add client to StreamManager → pipes stream to res
    streamManager.addClient(channel.id, quality.quality_label, quality.stream_url, res);

    // 9. Handle client disconnect
    req.on('close', () => {
        streamManager.removeClient(channel.id, quality.quality_label, res);
    });
});
```

**Security checks performed (on EVERY request):**
1. Session token present? → No: 403
2. Session valid (exists, not expired)? → No: 403
3. Channel exists? → No: 404
4. Session belongs to this channel? → No: 403
5. Channel link not expired? → No: 403
6. Quality exists for this channel? → No: 404
7. All pass → pipe stream

**Headers set:**
- `Content-Type: video/mp2t` — tells browser/mpegts.js it's MPEG-TS
- `Cache-Control: no-cache, no-store, must-revalidate` — no caching of live stream
- `Transfer-Encoding: chunked` — no Content-Length (infinite stream)
- `X-Content-Type-Options: nosniff` — security, prevent MIME sniffing
- `Connection: keep-alive` — keep connection open for streaming

**GET `/player/:channelToken`** — Serve player HTML page

- Serves `public/player.html` as static file
- The player.html reads `channelToken` from URL and handles everything client-side
- No backend logic needed — Express static file serving handles this

**Code structure:**
```
module.exports = function(db, streamManager, validateSession) {
    const router = express.Router();

    router.get('/channel/:channelToken/:quality', (req, res) => { ... });

    return router;
};
```

**Note:** The `/player/:channelToken` route will be handled by Express static middleware serving `public/player.html`. The frontend JS in player.html reads the channelToken from the URL path and constructs stream URLs client-side.

## Verify

Start the server temporarily:
```bash
cd E:\ChatrixStream
node -e "
require('dotenv').config();
const initDB = require('./db/init');
const db = initDB(process.env.DB_PATH);
const { generateChannelToken, generateInviteCodes, redeemInviteCode } = require('./services/codeGenerator');
const StreamManager = require('./services/streamManager');

// Setup test channel with a real stream URL
const token = generateChannelToken();
db.prepare('INSERT INTO channels (name, channel_token) VALUES (?, ?)').run('StreamTest', token);
const channel = db.prepare('SELECT * FROM channels WHERE channel_token = ?').get(token);
db.prepare('INSERT INTO channel_qualities (channel_id, quality_label, stream_url, sort_order) VALUES (?, ?, ?, ?)').run(channel.id, 'sd', 'http://ugeen.live:8080/Ugeen_VIP9sfo1g/GGzZy1/3019', 0);

// Generate code and redeem
const codes = generateInviteCodes(db, channel.id, 1, 6);
const result = redeemInviteCode(db, codes[0].code);
console.log('Session:', result);

// Test StreamManager directly
const sm = new StreamManager({ highWaterMark: 1048576 });
sm.startStream(channel.id, 'sd', 'http://ugeen.live:8080/Ugeen_VIP9sfo1g/GGzZy1/3019');
console.log('Stream started, active:', sm.activeStreams.size);

// Stop after 5 seconds
setTimeout(() => {
    sm.stopStream(channel.id, 'sd');
    console.log('Stream stopped, active:', sm.activeStreams.size);
    db.prepare('DELETE FROM channels WHERE name = ?').run('StreamTest');
    db.close();
}, 5000);
"
```

Should show: session created, stream started (activeStreams.size = 1), then after 5s stream stopped (activeStreams.size = 0).

## Next step
→ `steps/08-server.md`
