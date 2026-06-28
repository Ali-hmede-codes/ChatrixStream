# ChatrixStream — Backend Documentation & Review

> Status: **All issues in §10 have been fixed.** This file documents the
> backend architecture and the bugs, security issues, and performance problems
> that were found during the review and have since been resolved.
>
> Scope: backend only (`server.js`, `routes/`, `services/`, `middleware/`, `db/`).
> Frontend (`public/`) is intentionally out of scope for this pass.

---

## 1. Overview

ChatrixStream is a Node.js/Express live‑stream **restream** platform. An admin
adds a hidden source stream URL (the link that "can only be opened from one
device") to a channel. The backend opens **one** upstream connection to that
source and fans the bytes out to many viewers (target: 79+ concurrent users per
quality).

Core idea:

```
Source URL (hidden, 1 upstream) ──► Node backend ──► N viewers (fan‑out)
```

Three delivery modes exist (see §4):

| Mode | Route prefix | Engine | Transcode? | Best for |
|------|-------------|--------|-----------|----------|
| Raw MPEG‑TS passthrough | `/channel` | `StreamManager` | No | Max scale, lowest CPU |
| FFmpeg → MPEG‑TS pipe | `/pipe` | `PipeConverter` | Optional | Low latency + transcoding |
| FFmpeg → HLS | `/hls` | `HlsConverter` | Optional | iOS/Safari, HTTP caching |

---

## 2. Tech Stack

- **Runtime:** Node.js (requires ≥18 because `routes/matches.js` uses global `fetch`).
- **Framework:** Express 4.
- **DB:** SQLite via `better-sqlite3` (synchronous, in‑process, WAL mode).
- **Process manager:** PM2 (`ecosystem.config.js`, fork mode, 8GB cap).
- **Stream:** `follow-redirects` for upstream HTTP, Node `PassThrough` for fan‑out.
- **Transcode:** `ffmpeg-static` (bundled) or system `ffmpeg` via `FFMPEG_PATH`.
- **Auth:** Invite code → session token (viewer side); JWT + bcrypt (admin side).

---

## 3. Project Layout (backend only)

```
server.js                  # Express entry: middleware, route wiring, cleanup task
ecosystem.config.js        # PM2 config (fork, 8GB, port 3001)
.env                       # Runtime config (gitignored)
db/
  init.js                  # Schema + migrations + indexes
  database.sqlite          # (WAL + SHM sidecar files)
services/
  streamManager.js         # Raw MPEG‑TS passthrough fan‑out (1 upstream → N clients)
  pipeConverter.js         # FFmpeg stdout → MPEG‑TS fan‑out (+ rolling buffer)
  hlsConverter.js          # FFmpeg → HLS segments on disk (+ in‑memory caches)
  qualityPresets.js        # Shared encoding presets + display bitrate info (single source)
  sessionCache.js           # Shared per‑token session validation cache (TTL + LRU eviction)
  codeGenerator.js         # Tokens, invite codes, session create/validate/redeem
  adminUser.js             # bcrypt + JWT, seeds default admin user
middleware/
  adminAuth.js             # Bearer JWT verification + superAdminOnly gate
  rateLimiter.js           # Per‑IP sliding window with periodic sweep + LRU cap
routes/
  admin.js                 # Admin CRUD: channels, qualities, codes, sessions, users
  adminLogin.js            # POST /api/admin/login → JWT
  auth.js                  # redeem / direct / free-channels / session validate
  stream.js                # Raw passthrough stream endpoint
  hls.js                   # HLS manifest + segment endpoints + warmup
  pipe.js                  # Pipe stream endpoint
  sse.js                   # Server‑Sent Events for session expiry/heartbeat
  matches.js               # Proxy to external matches API
```

---

## 4. Stream Delivery Modes (detailed)

### 4.1 Raw passthrough — `StreamManager` (`services/streamManager.js`)

- `activeStreams: Map<"channelId:qualityLabel", state>`.
- `startStream` opens ONE `follow-redirects` GET to the source, pipes into a
  `PassThrough` (`highWaterMark` from env, default 8MB).
- `addClient` writes headers + adds the `res` to `state.clients`; the
  `passThrough.on('data')` handler writes each chunk to every client.
- Slow clients are dropped when `writableLength > 5MB` (back‑pressure safety).
- Idle (0 clients) → stop upstream after `STREAM_IDLE_TIMEOUT_MS`.
- Auto‑reconnect on source error/end/timeout after `STREAM_RECONNECT_DELAY_MS`.
- This is the **most scalable** path for 79+ users: zero transcoding, 1 upstream.

### 4.2 Pipe — `PipeConverter` (`services/pipeConverter.js`)

- `activeStreams: Map<"channelId:qualityLabel", state>`.
- Spawns **one** FFmpeg per channel+quality that reads the source and writes
  continuous MPEG‑TS to stdout (`pipe:1`).
- FFmpeg stdout data is fanned out to all clients **and** kept in a rolling
  buffer (`recentChunks`, ~3s of data sized from bitrate) so new clients start
  playing immediately without waiting for a keyframe.
- `resend_headers` + `flush_packets` keep new clients able to sync.
- Idle stop, restart, and retry logic mirror StreamManager.
- Reads its input from the internal endpoint
  `http://127.0.0.1:<port>/internal/stream/:channelId/:quality` (i.e. it sits
  on top of `StreamManager`).

### 4.3 HLS — `HlsConverter` (`services/hlsConverter.js`)

- `activeConversions: Map<"channelId:qualityLabel", state>`.
- Spawns **one** FFmpeg per channel+quality that writes `index.m3u8` +
  `seq_<n>.ts` segments to a per‑key temp dir (default `/dev/shm/.../hls`).
- Segment filename pattern `seq_%d.ts`, `delete_segments` + `temp_file` flags,
  `start_number` resumed across restarts, `discontinuity` counters maintained.
- Manifest served via `getManifest` (500ms in‑memory cache) and rewritten per
  client via `rewriteManifest` (injects session token into segment URLs,
  `#EXT-X-START`, discontinuity sequence, etc.).
- Segments served via `getSegmentData`: in‑memory LRU (20 entries) with disk
  fallback; ETag = MD5 of segment bytes for `304` support.
- Watchdog: kills FFmpeg if manifest not updated in 15s; startup timeout;
  manifest readiness gate (≥3 segments) to avoid buffer underrun.
- Best for iOS/Safari and for HTTP caching; higher I/O cost than the other two.

### 4.4 Quality presets

Shared by `hlsConverter.js` and `pipeConverter.js` (duplicated):

| Preset | Video | Bitrate | Resolution | Notes |
|--------|-------|---------|-----------|-------|
| `low` | libx264 ultrafast | 400k | 640x360 | baseline 3.0 |
| `medium` | libx264 veryfast | 1000k | source | main 3.1 |
| `high` | **copy** | source | source | no video transcode (cheap) |

Per‑quality DB overrides (`channel_qualities` columns) take precedence; custom
labels like `480p`/`720p` resolve by height. **`copy` is essentially free CPU** —
important for multi‑channel, see §6.

---

## 5. Authentication & Access Model

Viewer side (`services/codeGenerator.js`, `routes/auth.js`):

1. Admin creates a **channel** (gets `channel_token`, the public link) + source
   **qualities** (hidden URLs) + **invite codes** (`CS-XXXXXXX`).
2. Viewer `POST /api/auth/redeem { code }` → code marked redeemed, a
   `session_token` (`stk-…`, 24 chars) is created, viewer is tracked in
   `channel_viewers`.
3. Free channels (`code_required = 0`) skip the code via
   `POST /api/auth/direct/:channelToken`.
4. Every stream/manifest/segment request sends `x-session-token` (header or
   `?session=`) and is validated per request; long‑lived connections are
   re‑checked every 30s (`stream.js`, `pipe.js`) or via SSE (`sse.js`).
5. Sessions expire at `min(code expiry, channel link expiry)`; background
   `cleanupExpired` runs every 5 min and stops affected streams.

Admin side (`services/adminUser.js`, `middleware/adminAuth.js`, `routes/admin*.js`):

- `POST /api/admin/login` → bcrypt verify → JWT (24h).
- All `/api/admin/*` routes require `Authorization: Bearer <jwt>`.
- `superadmin`‑only routes: user CRUD.
- Default admin users are **seeded on first run** (see issue S‑2).

---

## 6. Multi‑channel / Multi‑account Concurrency

> Your requirement: "ffmpeg can live stream more than 1 channel at the same
> time but different account."

**This already works in the current architecture.** Stream state is keyed by
`"channelId:qualityLabel"` in all three engines:

- `streamManager.js:13` → `_getKey(channelId, qualityLabel)`
- `pipeConverter.js:103` → `_getKey(channelId, qualityLabel)`
- `hlsConverter.js:208` → `_getKey(channelId, qualityLabel)`

Each distinct `channelId:qualityLabel` pair gets its **own** upstream connection
and its **own** FFmpeg process. There is no global single‑stream lock.

```
Channel A (account 1):quality high  → StreamManager[1] + FFmpeg[1] (copy)
Channel B (account 2):quality high  → StreamManager[2] + FFmpeg[2] (copy)
Channel B (account 2):quality low   → StreamManager[3] + FFmpeg[3] (x264)
```

Concurrent, independent, no interference. Each channel's viewers are isolated by
session→channel_id validation.

### CPU caveat (the real constraint)

Transcoding (`libx264`) is CPU‑heavy. Running several `low`/`medium` transcodes
across multiple channels simultaneously can saturate a VPS and cause all streams
to stutter. Recommendations:

- Prefer `high` (video `copy`) wherever the source codec is browser‑compatible
  (H.264/AAC). Copy is near‑zero CPU and scales to many concurrent channels.
- If you must transcode several channels at once, raise `UV_THREADPOOL_SIZE`
  (already 128) and consider pinning transcodes to fewer concurrent presets, or
  use hardware accel (`h264_nvenc`, `h264_qsv`, etc.) by overriding
  `video_codec` per quality.
- Monitor per‑channel FFmpeg via the logs (`HlsConverter ffmpeg:` /
  `PipeConverter ffmpeg:` lines).

No code change is required to enable multi‑channel streaming; it is already
supported. Section 9 lists optional hardening (concurrency caps, per‑channel
limits) you may want later.

---

## 7. Configuration (`.env`)

| Var | Default | Used by | Notes |
|-----|---------|--------|-------|
| `PORT` | 3000 | server.js | ecosystem sets 3001 |
| `DB_PATH` | `./db/database.sqlite` | db/init.js | |
| `DEFAULT_CODE_TTL_HOURS` | 6 | routes/admin.js | only via env, not body |
| `DEFAULT_LINK_EXPIRY_HOURS` | 24 | (unused in code) | **dead** |
| `MAX_CODES_PER_GENERATION` | 100 | routes/admin.js | |
| `RATE_LIMIT_WINDOW_MS` | 60000 | server.js (all limiters) | |
| `RATE_LIMIT_MAX` | 10 | server.js (strict limiter) | ✅ now used — applies to `/api/admin/login`, `/api/auth/redeem`, `/api/auth/direct` only |
| `FFMPEG_PATH` | `ffmpeg` | converters | falls back to `ffmpeg-static` |
| `HLS_TEMP_DIR` | `tmp/hls` | hlsConverter | .env sets `/dev/shm/...` |
| `HLS_SEGMENT_DURATION` | 2 | hlsConverter | |
| `HLS_LIST_SIZE` | 5 | hlsConverter | .env sets 8 |
| `HLS_IDLE_TIMEOUT_MS` | 30000 | hls+pipe converters | shared by both |
| `HLS_*` (rest) | see code | hlsConverter | |
| `STREAM_HIGH_WATER_MARK` | 2MB | streamManager | .env sets 8MB |
| `STREAM_*` (rest) | see code | streamManager | |
| `JWT_SECRET` | — | adminUser.js | ✅ **required** — server exits if missing; set in `.env` |
| `ADMIN_SUPERADMIN_PASSWORD` | — | adminUser.js | ✅ optional — initial superadmin password; if unset, random + logged once |
| `CORS_ORIGINS` | `stream.chatrix.vip,localhost:3000` | server.js | |

---

## 8. API Reference (backend)

### Viewer

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/redeem` | — | Redeem invite code → session token |
| POST | `/api/auth/direct/:channelToken` | — | Free‑channel session |
| GET | `/api/auth/free-channels` | — | List free channels |
| POST | `/api/auth/session` | — | Validate session (auto‑login) |
| GET | `/api/auth/sse/events` | x‑session‑token | SSE heartbeat + expiry |
| GET | `/channel/:channelToken/:quality` | x‑session‑token | Raw MPEG‑TS passthrough |
| GET | `/pipe/:channelToken/:quality` | x‑session‑token | FFmpeg → MPEG‑TS pipe |
| GET | `/hls/:channelToken/:quality/index.m3u8` | x‑session‑token | HLS manifest |
| GET | `/hls/:channelToken/:quality/:segment` | x‑session‑token | HLS `.ts` segment |
| POST | `/hls/:channelToken/warmup` | x‑session‑token | Pre‑start FFmpeg |
| GET | `/hls/:channelToken/manifest-ready/:quality` | x‑session‑token | Poll readiness |
| GET | `/matches/:date` | — | Proxy to external matches API |
| GET | `/internal/stream/:channelId/:quality` | localhost only | Internal source feeder |

### Admin (Bearer JWT)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/admin/login` | → JWT |
| GET | `/api/admin/server-time` | UTC + tz |
| GET/POST/DELETE/PATCH | `/api/admin/channels[/:id]` | Channel CRUD |
| POST | `/api/admin/channels/:id/regenerate-link` | New token, old link dead |
| POST/DELETE/PATCH | `/api/admin/channels/:id/qualities[/:qid]` | Quality CRUD |
| POST | `/api/admin/channels/:id/codes` | Generate codes |
| POST | `/api/admin/channels/:id/regenerate-codes` | Replace all codes |
| GET | `/api/admin/channels/:id/codes` | List codes |
| DELETE | `/api/admin/codes/:code` | Revoke code |
| GET | `/api/admin/channels/:id/sessions` | List active sessions |
| DELETE | `/api/admin/sessions/:token` | Revoke session |
| GET/POST/PATCH/DELETE | `/api/admin/users[/:id]` | Admin user CRUD (superadmin) |
| POST | `/api/admin/users/:id/change-password` | (superadmin) |
| GET | `/api/admin/current-user` | Self |

---

## 9. Database Schema (current)

Defined in `db/init.js`. Tables: `channels`, `channel_qualities`, `invite_codes`,
`sessions`, `admin_users`, `channel_viewers`. Migrations handle adding
`code_required`, nullable `sessions.invite_code_id`, and the per‑quality encoding
columns. Indexes cover token/code/session lookups.

Notable gaps:
- `channel_viewers` rows are never cleaned up (see P‑6).
- No index on `channel_viewers(channel_id, viewer_id)` beyond the unique index —
  fine for lookups, but the table grows unbounded.

---

## 10. REVIEW: Bugs & Issues Found (all resolved)

Priority legend: **S** = security, **B** = correctness bug, **P** = performance,
**M** = maintenance/quality. Each item has a file:line reference and a ✅ fix note.

### Critical

#### S‑1 — Hardcoded JWT secret fallback (`services/adminUser.js`) — ✅ FIXED
The server now **fails fast at startup** if `JWT_SECRET` is missing (no fallback).
`JWT_SECRET` is set in `.env`. Anyone reading the source can no longer forge admin
JWTs.

#### S‑2 — Default admin credentials seeded in source (`services/adminUser.js`) — ✅ FIXED
Only `superadmin` is seeded on first run. The password comes from
`ADMIN_SUPERADMIN_PASSWORD` env var; if unset, a random password is generated and
logged once to the console. Other admin users are created via the admin UI.

#### S‑3 — 500MB JSON body limit (`server.js`) — ✅ FIXED
Reduced to `256kb` globally. Admin/viewer endpoints only need a few KB.

#### B‑1 — No Express error‑handling middleware (`server.js`) — ✅ FIXED
A final JSON error handler (`app.use((err, req, res, next) => …)`) returns
`{ error }` and logs 5xx errors. Stack traces are never sent to clients.

#### B‑2 — No `unhandledRejection` / `uncaughtException` handlers (`server.js`) — ✅ FIXED
Both handlers are registered. Rejections are logged; uncaught exceptions trigger a
graceful shutdown.

### High

#### B‑3 — Rate limiting is misconfigured (`server.js`) — ✅ FIXED
`RATE_LIMIT_MAX` is now wired. A **strict** limiter (`RATE_LIMIT_MAX`, default 10)
covers `/api/admin/login`, `/api/auth/redeem`, `/api/auth/direct`. A **loose**
limiter (300/min) covers `/api/admin/*` CRUD and `/api/matches`. **Stream routes
are never rate‑limited** — they are long‑lived or polled every ~2s.

#### B‑4 — Rate limiter `hits` Map grows unbounded (`middleware/rateLimiter.js`) — ✅ FIXED
Periodic sweep (every `windowMs`) evicts stale IPs; hard cap (`maxIps`, default
10000) with oldest‑entry eviction prevents unbounded growth.

#### B‑5 — `pipe.js` session cache lacks oldest‑entry eviction (`routes/pipe.js`) — ✅ FIXED
`pipe.js`, `hls.js`, and `auth.js` now all use the shared `SessionCache` helper
(`services/sessionCache.js`) which has both TTL and size‑based oldest eviction.

#### P‑1 — Synchronous file I/O on HLS hot path (`services/hlsConverter.js`) — ✅ FIXED
`getManifest`, `getSegmentData`, and `isManifestReady` are now **async** using
`fs.promises`. The segment LRU cache was expanded from 20 to 40 entries
(configurable via `segmentCacheSize` option).

#### P‑2 — MD5 ETag recomputed on every segment request (`routes/hls.js`) — ✅ FIXED
The ETag is now computed **once** when a segment is first read from disk and cached
alongside the segment data in the `SegmentLRU`. Per‑request MD5 hashing is
eliminated.

#### B‑6 — `gracefulShutdown` does not stop `StreamManager` (`server.js`) — ✅ FIXED
`streamManager.stopAll()` is now called alongside `hlsConverter.stopAll()` and
`pipeConverter.stopAll()`. (`StreamManager.stopAll()` was added.)

### Medium

#### B‑7 — Dead redirect branch in `StreamManager` (`services/streamManager.js`) — ✅ FIXED
The dead 3xx branch was removed. `follow-redirects` follows redirects
automatically; any non‑200 is treated as an error and triggers reconnect.

#### P‑3 — No TCP `noDelay` on stream responses — ✅ FIXED
`res.socket.setNoDelay(true)` is called after `writeHead` in both
`streamManager.js` and `pipeConverter.js`, reducing latency by disabling Nagle's
algorithm.

#### B‑8 — `Accept-Encoding: identity` + `Icy-MetaData: 1` may not match sources — ✅ FIXED
The unused `Icy-MetaData: 1` header was removed (metadata was never parsed).
`Accept-Encoding: identity` is kept (correct for raw byte streams).

#### B‑9 — `cleanupExpired` does not prune `channel_viewers` (`server.js`) — ✅ FIXED
`cleanupExpired` now deletes `channel_viewers` rows for channels that no longer
exist.

#### B‑10 — `routes/matches.js` fetch has no timeout/cache (`routes/matches.js`) — ✅ FIXED
Added an 8s `AbortController` timeout and a 60s response cache.

#### M‑1 — Three duplicated session caches with different TTLs — ✅ FIXED
All three now use the shared `SessionCache` class (`services/sessionCache.js`)
with configurable TTL and max size + oldest‑entry eviction.

#### M‑2 — Duplicated quality presets — ✅ FIXED
Encoding presets live in a single module (`services/qualityPresets.js`), imported
by `hlsConverter.js` and `pipeConverter.js`. Display/bitrate‑info logic
(`deriveBitrateInfo`) is also shared and used by `routes/auth.js`.

#### M‑3 — `sessionAuth.js` middleware is unused — ✅ FIXED
Removed. Session validation is inlined per route (now via `SessionCache`).

#### M‑4 — Dead/contradictory config — ✅ FIXED
`ADMIN_SECRET` and `DEFAULT_LINK_EXPIRY_HOURS` removed from `.env`.
`RATE_LIMIT_MAX` is now actually used. Added `ADMIN_SUPERADMIN_PASSWORD` (optional).

### Low

#### B‑11 — `stopAllStreamsForChannel` key parsing (`services/streamManager.js`) — ✅ FIXED
Now iterates `state.channelId` (type‑safe `String()` comparison) instead of
re‑parsing the key string with `split(':')`.

#### B‑12 — `localize_admin.js` at repo root — ✅ CONFIRMED NEEDED
This is a standalone dev build script that injects localization into the admin
frontend JS. It is not imported by the server. Kept as a useful utility.

#### P‑4 — `agent: false` on upstream (`services/streamManager.js`) — ✅ FIXED
Now uses shared keep‑alive agents (`http.Agent` / `https.Agent` with
`keepAlive: true, maxSockets: 64`) for upstream connection pooling on reconnects.

---

## 11. Performance Recommendations for 79+ Users

1. ✅ **Default viewers to raw passthrough (`/channel`) or `copy`‑based pipe/HLS.**
   These paths scale linearly with near‑zero CPU. Reserve transcoded presets for
   users who explicitly need lower bitrate. (No change needed — already the `high`
   default preset = video `copy`.)
2. ✅ **P‑1/P‑2 fixed** — sync I/O replaced with `fs.promises`; ETag cached with
   segment. These were the most likely cause of "stops" and stutters under load.
3. **Put a reverse proxy (nginx) in front** for TLS termination, static caching,
   and `proxy_buffering off` for stream endpoints (already implied by
   `X-Accel-Buffering: no`). Ensure `trust proxy` setting matches your hop count
   (currently `1`).
4. ✅ **HLS temp dir on tmpfs** — already configured (`/dev/shm/...`). Segment LRU
   expanded from 20 → 40 entries (configurable via `segmentCacheSize`).
5. **Backpressure** — the 5MB `maxBuffer` drop is a blunt instrument. For 79+
   users consider honoring `res.write() === false` + `passthrough.pause()` to
   apply real backpressure instead of dropping clients.
6. **Connection limits** — add a per‑channel and global max‑clients guard so a
   runaway client count can't exhaust memory.
7. **Observability** — expose active stream/client counts (admin endpoint) and
   log periodic stats; this is the fastest way to find the "stops" root cause.

---

## 12. Fix Status

All items below have been implemented and verified (syntax check + module load
test on all backend files):

1. ✅ **S‑1, S‑2, S‑3** — JWT secret required at startup; admin seeded from env;
   body limit reduced to 256kb.
2. ✅ **B‑1, B‑2** — JSON error handler + `unhandledRejection` /
   `uncaughtException` handlers.
3. ✅ **B‑3, B‑4, B‑5** — `RATE_LIMIT_MAX` wired; strict limiter on auth/login
   only (never stream routes); rate limiter sweep + LRU cap; shared session cache.
4. ✅ **P‑1, P‑2** — async HLS I/O (`fs.promises`); ETag cached with segment;
   segment LRU expanded to 40.
5. ✅ **B‑6, P‑3** — `streamManager.stopAll()` in graceful shutdown; TCP
   `noDelay` on stream responses.
6. ✅ **B‑7, B‑8, B‑9, B‑10** — dead redirect branch removed; `Icy-MetaData`
   header removed; `channel_viewers` pruned; matches fetch timeout + cache.
7. ✅ **M‑1 … M‑4** — shared `SessionCache` + `qualityPresets` modules;
   `sessionAuth.js` removed; `.env` dead vars removed.
8. ✅ **B‑11, B‑12, P‑4** — type‑safe channel stop; `localize_admin.js` confirmed
   needed; keep‑alive agents for upstream.

No public API or database schema was changed. The only behavioral note: on a
**fresh** database, only `superadmin` is seeded (was previously 5 users); create
additional admins via the admin UI. Existing databases are unaffected.

---

## 13. Open Questions for You

1. Which delivery mode do your viewers actually use today — `/channel`,
   `/pipe`, or `/hls`? (Prioritize that mode's fixes first.)
2. Is the source codec H.264/AAC? If yes, we can default everything to `copy`
   and remove most transcoding CPU cost, which makes multi‑channel trivial.
3. What is the VPS CPU/RAM? Determines how many concurrent transcodes are safe.
4. Is `nginx` in front (1 hop) or are there more proxies? Affects `trust proxy`.
