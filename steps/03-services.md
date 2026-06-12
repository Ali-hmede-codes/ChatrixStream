# Step 03 — Services (codeGenerator + streamManager)

## What you build
Two service modules: invite code/session token generator, and stream proxy manager.

## Depends on
Step 02 (database initialized)

## Files to create

### 1. `services/codeGenerator.js`

**Functions to implement:**

#### `generateChannelToken()`
- Returns: random 10-char string from `[a-zA-Z0-9]`
- Use `crypto.randomBytes(8)` → convert to base62 (a-zA-Z0-9) → take first 10 chars
- Must be unique — check DB before returning (if collision, regenerate)

#### `generateInviteCode()`
- Returns: `CS-` prefix + 7 chars from `[A-Z2-9]` (no 0/O/1/I/L — avoid ambiguity)
- Character set: `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (29 chars)
- Use `crypto.randomInt(29)` for each character (cryptographically secure)
- 29^7 = 172,498,763 combinations

#### `generateSessionToken()`
- Returns: `stk-` prefix + 24 chars from `[a-zA-Z0-9]`
- Use `crypto.randomBytes(18)` → convert to base62 → take first 24 chars

#### `generateInviteCodes(db, channelId, count, ttlHours)`
- Generates `count` invite codes for channel `channelId`
- Each code gets `expires_at = now() + ttlHours`
- Inserts all codes into `invite_codes` table using a prepared statement
- Returns array of generated codes: `[{ code: "CS-...", expires_at: "..." }, ...]`
- Uses `db.prepare()` + `stmt.run()` in a loop (or transaction for batch)

#### `redeemInviteCode(db, code)`
- Looks up code in `invite_codes` table
- Checks: code exists, `redeemed = 0`, `expires_at > now()`, channel exists, channel `link_expires_at > now()` or NULL
- If valid: marks `redeemed = 1`, creates session in `sessions` table (expires_at = code's expires_at)
- Returns: `{ session_token, channel_id, channel_token, channel_name, expires_at }` or `{ error: "..." }`
- Must be atomic — wrap in `db.transaction()` (redeem + create session in one transaction)

#### `validateSession(db, sessionToken)`
- Looks up session_token in `sessions` table
- Checks: session exists, `expires_at > now()`, channel exists, channel `link_expires_at > now()` or NULL
- If valid: returns `{ valid: true, channel_token, channel_name, expires_at, channel_id }`
- If invalid: returns `{ valid: false, error: "..." }`

**Code structure:**
```
const crypto = require('crypto');
const CHARSET_UPPER = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CHARSET_MIXED = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function generateChannelToken() { ... }
function generateInviteCode() { ... }
function generateSessionToken() { ... }
function generateInviteCodes(db, channelId, count, ttlHours) { ... }
function redeemInviteCode(db, code) { ... }
function validateSession(db, sessionToken) { ... }

module.exports = {
    generateChannelToken,
    generateInviteCode,
    generateSessionToken,
    generateInviteCodes,
    redeemInviteCode,
    validateSession
};
```

### 2. `services/streamManager.js`

**Class `StreamManager` — manages all active stream proxies**

**Internal state:**
```
activeStreams: Map<string, StreamState>
// key = "channelId:qualityLabel" (e.g., "5:hd")
// StreamState = { sourceResponse, passThrough, clients: Set<res>, idleTimer, streamUrl }
```

**Methods:**

#### `startStream(channelId, qualityLabel, streamUrl)`
- Check if stream already active for this key → if yes, return existing
- Use `follow-redirects` `http.get()` or `https.get()` to fetch `streamUrl`
- Create `PassThrough` stream with `highWaterMark: STREAM_HIGH_WATER_MARK` (from env)
- Pipe source response → passThrough
- Store in `activeStreams` Map
- On source `error` event → schedule reconnect after `STREAM_RECONNECT_DELAY_MS`
- On source `end` event → schedule reconnect (live streams shouldn't end)
- Return the passThrough stream

#### `addClient(channelId, qualityLabel, streamUrl, res)`
- Get or start stream for this key
- Pipe passThrough → res
- Add res to `clients` Set
- Clear idle timer (stream is active)
- Set response headers: `Content-Type: video/mp2t`, `Cache-Control: no-cache`, no `Content-Length`
- On res `close` event → remove from clients Set, unpipe, check idle

#### `removeClient(channelId, qualityLabel, res)`
- Remove res from clients Set
- Unpipe passThrough from res
- If clients.size === 0 → start idle timer (`STREAM_IDLE_TIMEOUT_MS`)

#### `stopStream(channelId, qualityLabel)`
- Get stream state from Map
- Destroy source response
- Destroy passThrough
- End all client responses in clients Set
- Clear idle timer
- Remove from Map

#### `stopAllStreamsForChannel(channelId)`
- Find all keys in Map that start with `${channelId}:`
- Call `stopStream` for each

#### `reconnectStream(channelId, qualityLabel, streamUrl)`
- Stop current stream
- Wait `STREAM_RECONNECT_DELAY_MS`
- Start new stream with same URL
- Re-pipe to existing clients (if any survived)

**Constructor:**
```
constructor(options = {})
    this.activeStreams = new Map();
    this.highWaterMark = options.highWaterMark || 1048576;
    this.idleTimeout = options.idleTimeout || 30000;
    this.reconnectDelay = options.reconnectDelay || 3000;
```

**Code structure:**
```
const { PassThrough } = require('stream');
const http = require('http');
const https = require('https');
const { followRedirects } = require('follow-redirects');

class StreamManager { ... }

module.exports = StreamManager;
```

## Verify

Test codeGenerator:
```bash
node -e "
require('dotenv').config();
const initDB = require('./db/init');
const { generateChannelToken, generateInviteCode, generateSessionToken, generateInviteCodes } = require('./services/codeGenerator');
const db = initDB(process.env.DB_PATH);

// Test token generation
console.log('Channel token:', generateChannelToken());
console.log('Invite code:', generateInviteCode());
console.log('Session token:', generateSessionToken());

// Test batch code generation
db.prepare('INSERT INTO channels (name, channel_token, code_ttl_hours) VALUES (?, ?, ?)').run('Test', generateChannelToken(), 6);
const codes = generateInviteCodes(db, 1, 5, 6);
console.log('Generated codes:', codes);

// Cleanup test
db.prepare('DELETE FROM channels WHERE name = ?').run('Test');
db.close();
"
```

Should print channel token, invite code, session token, and 5 generated codes.

## Next step
→ `steps/04-middleware.md`
