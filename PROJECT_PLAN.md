# ChatrixStream — Live Stream Restream Platform

## Overview

A secure, high-performance live stream restreaming platform. The server watches the source stream like a real viewer and restreams it to authorized users. **No accounts, no signup, no login** — just enter a code and watch. Sessions persist across browser restarts.

**Core Concept — 3 Independent Layers per Channel:**

```
CHANNEL (source streams — saved, permanent)
   │
   ├── PUBLIC LINK (endpoint URL — can expire, can be regenerated independently)
   │     Example: stream.chatrix.vip/channel/aB3xK9mR2
   │     Admin can: generate new link, set expiration, regenerate link
   │
   └── INVITE CODES (one-time use — can expire, can be regenerated independently)
         Example: CS-A7X9K2M4
         Admin can: generate N codes, regenerate all codes, set code expiration
```

**Regenerating the link does NOT affect codes. Regenerating codes does NOT affect the link. They are independent.**

**Architecture Flow:**
```
Source Stream URL → Node.js Backend (fetch & restream) → /channel/:token/:quality → User Browser (with session token)
```

**Example:**
```
Admin creates channel "Champions League":
  Source URLs (hidden from users):
    SD:  http://ugeen.live:8080/.../3019
    HD:  http://ugeen.live:8080/.../3020
    4K:  http://ugeen.live:8080/.../3021

  Public link (users see this):
    stream.chatrix.vip/channel/aB3xK9mR2   ← expires in 12 hours
    Admin can regenerate → stream.chatrix.vip/channel/Xp7mW3nK9   ← old link dead, new link active

  Invite codes (users enter this):
    CS-A7X9K2M4   ← one-time use, expires in 6 hours
    CS-B4M8P3NQ   ← one-time use, expires in 6 hours
    Admin can regenerate → old codes dead, new batch generated
```

---

## Domain
`stream.chatrix.vip`

---

## Tech Stack

| Layer     | Technology                     |
|-----------|--------------------------------|
| Backend   | Node.js + Express              |
| Database  | SQLite (better-sqlite3)        |
| Frontend  | HTML / CSS / Vanilla JS        |
| Stream    | MPEG-TS over HTTP → PassThrough pipe proxy |
| Player    | mpegts.js (MPEG-TS browser playback) |
| Auth      | Invite code → Session token (persistent) |

---

## Stream Type

Source streams return **MPEG-TS over HTTP** (continuous H.264/AAC). Each quality is a separate URL. Perfect for PassThrough pipe — zero transcoding.

---

## Architecture Details

### How Qualities Work in the Same Player

**One channel = multiple source stream URLs = one player with quality switcher.**

All qualities of the same channel share:
- Same `channel_token` (same public link)
- Same invite codes (one code gives access to ALL qualities)
- Same session token (one session lets you watch SD, HD, or 4K)

Each quality is a SEPARATE source stream URL that the backend proxies independently:

```
User visits: stream.chatrix.vip/player/aB3xK9mR2

         Player UI (single page)
         ┌───────────────────────────────────────┐
         │  ┌─────────────────────────────────┐   │
         │  │          VIDEO PLAYER            │   │
         │  │     (mpegts.js renders here)     │   │
         │  └─────────────────────────────────┘   │
         │                                         │
         │  Quality: [SD]  [HD]  [4K]              │
         │  Currently watching: SD                  │
         └───────────────────────────────────────┘

Behind the scenes:
         User session: stk-a8Bf3Km9R2xP (valid for ALL qualities)

         Clicking [SD] → GET /channel/aB3xK9mR2/sd  (X-Session-Token: stk-xxx)
         Clicking [HD] → GET /channel/aB3xK9mR2/hd  (X-Session-Token: stk-xxx)
         Clicking [4K] → GET /channel/aB3xK9mR2/4k  (X-Session-Token: stk-xxx)

         Each request validated separately — session checked on EVERY request
```

**Quality switch flow (seamless):**
```
1. User watching SD → mpegts.js connected to /channel/aB3xK9mR2/sd
2. User clicks HD button
3. Frontend destroys current mpegts.js player instance
4. Frontend creates new mpegts.js player instance
5. New instance fetches /channel/aB3xK9mR2/hd with same session token
6. Backend validates session → pipes HD stream
7. ~2-3 seconds buffer fill → HD plays seamlessly
```

### Stream Restream (High Performance)

Backend fetches each quality once, fans out via PassThrough:

```
Channel "Champions League" (internal ID: 5)
Session token: stk-a8Bf3Km9R2xP (valid for ALL qualities)

Quality: SD → http://ugeen.live:8080/.../3019
     [1 upstream connection] → PassThrough Hub → 50 users watching SD

Quality: HD → http://ugeen.live:8080/.../3020
     [1 upstream connection] → PassThrough Hub → 100 users watching HD

Quality: 4K → http://ugeen.live:8080/.../3021
     [1 upstream connection] → PassThrough Hub → 20 users watching 4K

When user switches from SD → HD:
     User disconnects from SD PassThrough (1 less client on SD hub)
     User connects to HD PassThrough (1 more client on HD hub)
     Same session token used for both — no re-authentication needed
```

- **1 upstream per quality** — not per user
- PassThrough near-zero overhead, no transcoding
- `highWaterMark: 1MB` buffers, `noDelay: true`, chunked transfer
- Idle quality streams auto-stop after 30s with no viewers
- When new viewer connects to idle quality → restart upstream

### Invite Code → Session Token Flow

**One code = one session = one user. Session persists in localStorage across browser restarts.**

```
FIRST VISIT:
  User enters code CS-A7X9K2M4
  → POST /api/auth/redeem
  → Code marked redeemed, session token generated (stk-a8Bf3Km9R2xP)
  → Stored in localStorage: { session_token, channel_token }
  → Redirected to /player/aB3xK9mR2
  → Stream plays at /channel/aB3xK9mR2/sd with X-Session-Token header

BROWSER CLOSED & REOPENED:
  User visits stream.chatrix.vip
  → localStorage still has session_token
  → POST /api/auth/session validates token
  → If valid: auto-redirect to /player/aB3xK9mR2 (no code input)
  → If expired: clear localStorage, show code input page

QUALITY SWITCH:
  User clicks HD in player
  → Destroy current mpegts.js player
  → Create new mpegts.js player for HD
  → New fetch: /channel/aB3xK9mR2/hd with same session token
  → Backend validates session (same check as before)
  → ~2-3s buffer → HD stream plays
```

### Channel System — Admin Workflow

This is the core admin experience. **Everything revolves around channels.**

```
┌─────────────────────────────────────────────────────────┐
│                    CHANNEL: "Champions League"           │
│                                                         │
│  SOURCE STREAMS (admin-only, hidden from users):        │
│    ├── SD  → http://ugeen.live:8080/.../3019            │
│    ├── HD  → http://ugeen.live:8080/.../3020            │
│    └── 4K  → http://ugeen.live:8080/.../3021            │
│                                                         │
│  PUBLIC LINK:                                           │
│    stream.chatrix.vip/channel/aB3xK9mR2                 │
│    Expires: 2026-06-13 04:00                            │
│    [Regenerate Link] → new token, old link dies          │
│                                                         │
│  INVITE CODES:                                          │
│    CS-A7X9K2M4  (redeemed, session active, expires 06:00)│
│    CS-B4M8P3NQ  (unused, expires 06:00)                 │
│    CS-C2D5F6HJ  (unused, expires 06:00)                 │
│    [Generate 10 New Codes]  [Regenerate All Codes]       │
│                                                         │
│  [Delete Channel] → removes everything                  │
└─────────────────────────────────────────────────────────┘
```

**Independent Operations:**

| Action                  | What it does                          | What it DOESN'T affect    |
|-------------------------|----------------------------------------|---------------------------|
| Regenerate Link         | New channel_token, old link invalid    | Source URLs, invite codes |
| Regenerate Codes        | New codes, old codes + sessions dead   | Source URLs, public link  |
| Add/Remove Quality      | Adds/removes a stream URL option       | Link, codes               |
| Delete Channel          | Removes EVERYTHING (cascade)           | Nothing survives          |
| Change Code TTL         | Future codes use new TTL               | Existing codes unchanged  |
| Change Link Expiration  | Updates link expiry time               | Codes                     |

---

## SECURITY (100%)

### Layer 1: Stream Access — No stream without authentication

```
Every single stream request MUST pass through this validation:

GET /channel/aB3xK9mR2/hd  X-Session-Token: stk-xxx

Backend validation checklist (EVERY request):
  1. session_token exists in database?           → If no: 403 Forbidden
  2. session_token not expired?                  → If no: 403 Forbidden
  3. session_token belongs to this channel?      → If no: 403 Forbidden
  4. channel_token (aB3xK9mR2) exists?          → If no: 404 Not Found
  5. channel link not expired?                   → If no: 403 Forbidden
  6. quality "hd" exists for this channel?       → If no: 404 Not Found

All 6 checks pass → pipe stream. Any fail → block + return error JSON.
```

**No bypass possible:**
- No direct URL to source stream — backend proxies everything
- Source URLs stored only in database (admin-only access)
- Stream endpoint never reveals, redirects, or leaks the source URL
- Even if user guesses `/channel/fakeToken/hd` → validation fails → 403

### Layer 2: Invite Codes — One-time, cryptographically random

```
Code format: CS-A7X9K2M4
  CS- prefix + 7 chars from [A-Z2-9] (no 0/O/1/I/L to avoid confusion)
  29 possible chars × 7 positions = 29^7 = 172,498,763 combinations
  Brute-force at 10 req/min → 345 years to try all codes

Code lifecycle:
  Created → stored in DB with expires_at
  Redeemed → marked redeemed=1, can NEVER be reused
  Expired → deleted by background cleanup task every 5 minutes

One code = one session = one user. After redemption:
  - Code itself is dead (redeemed=1, can't generate another session)
  - Session token replaces it for ongoing access
  - Session token also expires (inherits code's expires_at)
```

### Layer 3: Session Tokens — Persistent, cryptographically random

```
Session format: stk-a8Bf3Km9R2xP4Nq7Wv1L
  stk- prefix + 24 chars from [a-zA-Z0-9] = 62 chars
  62^24 = astronomical number (impossible to brute-force)
  Stored ONLY in user's localStorage — never in URL, never in cookies

Session validation on EVERY request:
  - Session exists in DB? No → block
  - Session expired? No → block
  - Session belongs to requested channel? No → block
  - Channel link expired? No → block

Session lifecycle:
  Created → when invite code redeemed
  Active → validated on every stream request
  Expired → deleted by background cleanup
  Revoked → admin can manually revoke (user loses access immediately)
```

### Layer 4: Link Tokens — Regenerable, expiring

```
Channel token format: aB3xK9mR2
  10 chars from [a-zA-Z0-9] = 62 chars
  62^10 = 839 trillion combinations

Link regeneration:
  Admin clicks "Regenerate Link"
  → Old token deleted from DB
  → New token generated
  → Old URL instantly dead (all requests to old token → 404)
  → Users with existing sessions still work (session validated by channel_id, not token)
  → But users need the new link to reach the player page
  → Admin shares the new link to users

Link expiration:
  Admin sets link_expires_at
  → After that time, all requests to this channel → 403
  → All sessions for this channel → invalid
  → All codes for this channel → invalid
```

### Layer 5: Network Security

```
Rate limiting:
  - POST /api/auth/redeem: 10 requests per IP per minute
  - POST /api/auth/session: 10 requests per IP per minute
  - GET /channel/*: 5 requests per IP per minute (prevent stream abuse)
  - Admin endpoints: 20 requests per IP per minute

CORS:
  - Only allow requests from stream.chatrix.vip
  - No wildcard origins
  - Block all cross-origin stream requests

Headers (security):
  - X-Content-Type-Options: nosniff
  - X-Frame-Options: DENY (prevent iframe embedding)
  - Content-Security-Policy: default-src 'self'
  - Strict-Transport-Security: max-age=31536000 (HTTPS only)

Source URL isolation:
  - Source URLs stored ONLY in `channel_qualities` table
  - Never included in any API response to users
  - Never logged in user-facing error messages
  - Backend fetches source URL internally only
  - No redirect to source URL ever occurs
```

### Layer 6: Admin Authentication

```
All admin endpoints require: X-Admin-Secret header
  - ADMIN_SECRET stored in .env (environment variable, never in code)
  - Must be strong: minimum 32 characters
  - Checked on EVERY admin request
  - Wrong secret → 401 Unauthorized, no details leaked
```

---

## PERFORMANCE (100%)

### Stream Performance

```
Architecture: Source → 1 upstream per quality → PassThrough Hub → N clients

Why this is maximum performance:

1. SINGLE UPSTREAM CONNECTION per quality
   - Backend opens 1 HTTP GET to source per quality
   - Not 1 per user, not 1 per request
   - Even with 200+ users → only 3 upstream connections (SD+HD+4K)
   - Source server sees only 3 viewers (the backend), not 200

2. PASSTHROUGH FAN-OUT (zero-copy)
   - Node.js PassThrough stream = direct memory buffer copy
   - No decoding, no encoding, no transcoding
   - No CPU processing on stream data at all
   - Data flows: source → buffer → pipe → client response
   - Each client gets a pipe from the SAME PassThrough buffer

3. LARGE BUFFER SIZES
   - highWaterMark: 1MB (1048576 bytes) per PassThrough
   - Prevents buffer underflow with many concurrent readers
   - Handles network jitter and burst traffic

4. TCP OPTIMIZATIONS
   - noDelay: true on all sockets (disable Nagle algorithm)
   - Immediate packet transmission, no 200ms delay
   - Critical for real-time streaming

5. CHUNKED TRANSFER ENCODING
   - No Content-Length header (stream is infinite/live)
   - Transfer-Encoding: chunked
   - Browser receives data continuously as it arrives

6. IDLE STREAM STOP
   - Quality stream with 0 viewers → stop upstream after 30s
   - Save bandwidth on unused qualities
   - Restart instantly when new viewer connects (~2-3s buffer fill)

7. AUTO-RECONNECT
   - Source stream fails → reconnect after 3s
   - Existing clients kept alive (PassThrough buffer sustains briefly)
   - Seamless recovery without user noticing

8. MPEG-TS FORMAT
   - Continuous binary stream, no segment files
   - No HLS playlist parsing, no segment downloads
   - mpegts.js directly consumes the stream via MediaSource API
   - Low latency: ~3-5 seconds behind live
```

### Database Performance

```
SQLite with better-sqlite3:
  - Synchronous, in-process database → zero network overhead
  - All queries run in same thread as Express server
  - No database connection pool needed
  - WAL mode enabled → concurrent reads while writing
  - Indexed lookups for session/token validation: <1ms each
  - 200+ concurrent users → 200+ session validations per stream start
  - Each validation: 1 indexed query → sub-millisecond

Indexes covering all hot paths:
  - sessions.session_token → unique index, exact match lookup
  - channels.channel_token → unique index, exact match lookup
  - invite_codes.code → unique index, exact match lookup
  - channel_qualities.channel_id → fast join for quality lookup

Prepared statements:
  - All queries pre-compiled at startup
  - No query parsing overhead on each request
  - Session validation query runs in <0.1ms
```

### Server Performance (200+ users)

```
Concurrency model:
  - Node.js event loop handles all I/O
  - Stream piping is pure I/O, no CPU work
  - 200+ concurrent stream connections = 200+ pipe operations
  - Each pipe: PassThrough.read() → response.write()
  - Zero CPU per client after initial validation

Memory per client:
  - PassThrough buffer: 1MB per quality (shared across all clients)
  - Per-client overhead: ~50KB (HTTP response object + socket buffer)
  - 200 clients × 50KB = 10MB total overhead
  - Server memory for 200+ users: ~15-20MB (trivial)

Network:
  - Each quality stream: ~2-4 Mbps (SD), ~5-8 Mbps (HD), ~15-25 Mbps (4K)
  - 200 users on HD: 200 × 8 Mbps = 1.6 Gbps OUTPUT from server
  - 1 upstream on HD: 8 Mbps INPUT to server
  - Server needs: ~2 Gbps outbound bandwidth for 200 HD users
  - Input bandwidth: only ~50 Mbps total (3 qualities × ~15 Mbps max)

Validation overhead:
  - Session validation: 1 SQLite indexed lookup per stream start
  - ~0.1ms per validation
  - 200 validations at once: 20ms total (trivial)
  - No bottleneck on authentication
```

---

## Database Schema (SQLite)

### Channels (stores source streams + link info)
```sql
CREATE TABLE channels (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    channel_token   TEXT NOT NULL UNIQUE,         -- public link token, can be regenerated
    code_ttl_hours  INTEGER DEFAULT 6,            -- default TTL for invite codes
    link_expires_at DATETIME,                     -- public link expiration (NULL = never)
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Channel Qualities (source stream URLs — hidden from users)
```sql
CREATE TABLE channel_qualities (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id      INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    quality_label   TEXT NOT NULL,                -- 'sd', 'hd', '4k', or custom
    stream_url      TEXT NOT NULL,                -- real stream URL (hidden)
    sort_order      INTEGER DEFAULT 0,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Invite Codes (one-time use, expiring)
```sql
CREATE TABLE invite_codes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    code            TEXT NOT NULL UNIQUE,
    channel_id      INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    redeemed        INTEGER DEFAULT 0,            -- 0=unused, 1=redeemed
    expires_at      DATETIME NOT NULL,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Sessions (persistent access after code redemption)
```sql
CREATE TABLE sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_token   TEXT NOT NULL UNIQUE,
    channel_id      INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    invite_code_id  INTEGER NOT NULL REFERENCES invite_codes(id) ON DELETE CASCADE,
    expires_at      DATETIME NOT NULL,            -- same as invite code expires_at
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**Indexes:**
```sql
CREATE UNIQUE INDEX idx_channels_token ON channels(channel_token);
CREATE INDEX idx_channel_qualities_channel ON channel_qualities(channel_id);
CREATE INDEX idx_invite_codes_code ON invite_codes(code);
CREATE INDEX idx_invite_codes_channel ON invite_codes(channel_id);
CREATE INDEX idx_invite_codes_expires ON invite_codes(expires_at);
CREATE INDEX idx_sessions_token ON sessions(session_token);
CREATE INDEX idx_sessions_channel ON sessions(channel_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
```

**Cascade behavior:**
- Delete channel → deletes ALL: qualities, codes, sessions
- Delete invite code → deletes its session
- Regenerate link → old token invalid, sessions still work against channel_id (not token)
- Regenerate codes → old codes + their sessions all deleted

---

## API Endpoints

### Admin APIs (require `X-Admin-Secret` header)

#### Channel Management

| Method | Path                                    | Description                                    |
|--------|-----------------------------------------|------------------------------------------------|
| POST   | `/api/admin/channels`                   | Create channel (name, code_ttl, link_expire)   |
| GET    | `/api/admin/channels`                   | List all channels (with qualities, codes count)|
| DELETE | `/api/admin/channels/:id`               | Delete channel → cascade: qualities, codes, sessions all gone |
| PATCH  | `/api/admin/channels/:id`               | Update: name, code_ttl, link_expire            |
| POST   | `/api/admin/channels/:id/regenerate-link`| **Regenerate public link** — new token, old link invalid. Codes & sessions unaffected |

#### Quality Management (per channel)

| Method | Path                                    | Description                                    |
|--------|-----------------------------------------|------------------------------------------------|
| POST   | `/api/admin/channels/:id/qualities`     | Add quality (label, stream_url, sort_order)    |
| DELETE | `/api/admin/channels/:id/qualities/:qid`| Remove quality                                 |
| PATCH  | `/api/admin/channels/:id/qualities/:qid`| Update quality (label, stream_url)             |

#### Invite Code Management (per channel)

| Method | Path                                    | Description                                    |
|--------|-----------------------------------------|------------------------------------------------|
| POST   | `/api/admin/channels/:id/codes`         | Generate N codes (with custom TTL optional)    |
| POST   | `/api/admin/channels/:id/regenerate-codes`| **Regenerate all codes** — old codes + sessions deleted, N new codes created |
| GET    | `/api/admin/channels/:id/codes`         | List all codes (with status: unused/redeemed/expired) |
| DELETE | `/api/admin/codes/:code`                | Revoke single code + its session               |

#### Session Management

| Method | Path                                    | Description                                    |
|--------|-----------------------------------------|------------------------------------------------|
| GET    | `/api/admin/channels/:id/sessions`      | List active sessions for channel               |
| DELETE | `/api/admin/sessions/:token`            | Revoke session (user loses access immediately) |

**Auth:** `X-Admin-Secret` header must match `ADMIN_SECRET` env var.

**Formats:**
- Invite code: `CS-XXXXXXX` (e.g., `CS-A7X9K2M4`)
- Session token: `stk-` + 24 chars (e.g., `stk-a8Bf3Km9R2xP4Nq7Wv1L`)
- Channel token: 10 chars random (e.g., `aB3xK9mR2`)

### User APIs (no accounts)

| Method | Path                                     | Description                                    |
|--------|------------------------------------------|------------------------------------------------|
| POST   | `/api/auth/redeem`                       | Redeem invite code → get session token         |
| POST   | `/api/auth/session`                      | Validate session (for auto-login on return)    |
| GET    | `/channel/:channelToken/:quality`        | Stream pipe (requires X-Session-Token)         |
| GET    | `/player/:channelToken`                  | Player page                                    |
| GET    | `/`                                      | Landing (auto-login or code input)             |

**`POST /api/auth/redeem`**
- Body: `{ "code": "CS-A7X9K2M4" }`
- Validates: code exists, not redeemed, not expired, channel link not expired
- Marks code `redeemed = 1`, creates session token
- Returns: `{ session_token, channel_token, channel_name, qualities: ["sd","hd","4k"], expires_at }`

**`POST /api/auth/session`**
- Body: `{ "session_token": "stk-..." }`
- Validates: session exists, not expired, channel link not expired
- Returns: `{ valid, channel_token, channel_name, qualities, expires_at }`

**`GET /channel/:channelToken/:quality`**
- Requires `X-Session-Token` header
- Validates: session valid, belongs to channel, channel link not expired, quality exists
- Pipes MPEG-TS stream
- Invalid → 403 JSON

---

## Project Structure

```
ChatrixStream/
├── package.json
├── .env
├── server.js
├── db/
│   ├── init.js
│   └── database.sqlite
├── routes/
│   ├── admin.js
│   ├── auth.js
│   └── stream.js
├── services/
│   ├── streamManager.js
│   └── codeGenerator.js
├── middleware/
│   ├── adminAuth.js
│   ├── sessionAuth.js
│   └── rateLimiter.js
├── public/
│   ├── index.html
│   ├── player.html
│   ├── css/
│   │   └── style.css
│   └── js/
│   │   ├── app.js
│   │   └── player.js
│   └── admin/
│       ├── admin.html
│       ├── css/
│       │   └── admin.css
│       └── js/
│       │   └── admin.js
```

---

## Stream Manager (`services/streamManager.js`)

```
class StreamManager {
    activeStreams: Map<"channelId:qualityLabel", StreamState>

    startStream(channelId, qualityLabel, streamUrl)
        HTTP GET streamUrl → PassThrough(1MB) → store in Map
        Auto-reconnect on error after 3s

    addClient(channelId, qualityLabel, res)
        Get or start stream → pipe to res → track client
        Clear idle timer on new client

    stopStream(channelId, qualityLabel)
        Destroy source + PassThrough → end all clients for this quality

    stopAllStreamsForChannel(channelId)
        Stop every quality stream for this channel

    handleIdle(channelId, qualityLabel)
        All clients gone → 30s timer → stop upstream
        New client arrives → restart upstream
}
```

---

## Frontend Pages

### Landing (`/` — index.html)
- **Auto-login:** checks localStorage → validates session → auto-redirect to player
- **Code entry:** input + "Watch" button → redeem code → store session → redirect
- If session expired → clear localStorage → show code input
- No signup, no login

### Player (`/player/:channelToken` — player.html)
- mpegts.js video player
- **Quality switcher** (gear icon): SD / HD / 4K — default SD
- Switch = disconnect current → connect to new quality endpoint
- Session token in `X-Session-Token` header
- Error: session expired → redirect to landing, clear localStorage
- Mobile responsive

### Admin Dashboard (`/admin` — admin.html)
- Protected by admin secret (localStorage)

**Per-channel UI:**
```
┌─────────────────────────────────────────────────────────┐
│  CHANNEL: Champions League                              │
│                                                         │
│  PUBLIC LINK:                                           │
│    stream.chatrix.vip/channel/aB3xK9mR2                 │
│    Expires: 2026-06-13 04:00   [Change Expiration]      │
│    [Regenerate Link] ← new token, old link dead          │
│                                                         │
│  QUALITIES:                                             │
│    SD  → http://ugeen.live:8080/.../3019  [Edit] [Del]  │
│    HD  → http://ugeen.live:8080/.../3020  [Edit] [Del]  │
│    4K  → http://ugeen.live:8080/.../3021  [Edit] [Del]  │
│    [+ Add Quality]                                      │
│                                                         │
│  INVITE CODES:                                          │
│    CS-A7X9K2M4  ● redeemed  (session active)            │
│    CS-B4M8P3NQ  ● unused                               │
│    CS-C2D5F6HJ  ● unused                               │
│    TTL: 6 hours                                         │
│    [Generate 10 New Codes]  [Regenerate All Codes]       │
│                                                         │
│  ACTIVE SESSIONS: 1                                     │
│    stk-a8Bf3...  expires 06:00  [Revoke]                │
│                                                         │
│  [Delete Channel]                                       │
└─────────────────────────────────────────────────────────┘
```

---

## Environment Variables (.env)

```
PORT=3000
ADMIN_SECRET=change-this-to-a-strong-secret
DB_PATH=./db/database.sqlite
DEFAULT_CODE_TTL_HOURS=6
DEFAULT_LINK_EXPIRY_HOURS=24
MAX_CODES_PER_GENERATION=100
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=10
STREAM_HIGH_WATER_MARK=1048576
STREAM_IDLE_TIMEOUT_MS=30000
STREAM_RECONNECT_DELAY_MS=3000
```

---

## Key Implementation Notes

1. **Channel = source streams** — admin saves real URLs, they stay hidden
2. **Public link = channel_token** — can expire, can be regenerated independently
3. **Invite codes = access keys** — one-time, expire, can be regenerated independently
4. **Regenerating link ≠ regenerating codes** — two separate operations
5. **Regenerating link** → old URL dead, new URL active, codes/sessions still work (validated by channel_id)
6. **Regenerating codes** → old codes + sessions all dead, new codes generated, link unchanged
7. **Session persists** — localStorage, survives browser restart, auto-login on return
8. **1 upstream per quality** — not per user, not per channel
9. **PassThrough fan-out** — zero-overhead piping to 200+ users per quality
10. **Quality switch** — disconnect one quality, connect another
11. **Idle auto-stop** — no viewers for 30s → stop upstream for that quality
12. **MPEG-TS confirmed** — works with mpegts.js
13. **Cascade delete** — channel deletion removes everything
14. **Expired cleanup** — background task every 5 min
15. **Rate limiting** — 10 req/min per IP

---

## Implementation Order

1. Initialize project + install deps
2. Database schema (`db/init.js`)
3. Code generator + session token generator (`services/codeGenerator.js`)
4. Stream manager (`services/streamManager.js`)
5. Middleware (`adminAuth.js`, `sessionAuth.js`, `rateLimiter.js`)
6. Admin routes (`routes/admin.js`)
7. Auth routes (`routes/auth.js`)
8. Stream routes (`routes/stream.js`)
9. Server entry (`server.js`)
10. Landing page with auto-login
11. Player page with quality switcher
12. Admin dashboard
13. Cleanup background task
14. Testing & optimization
