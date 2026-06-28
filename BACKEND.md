# ChatrixStream — Backend Documentation & Review

> Status: **Review only (no code changes yet).** This file documents the current
> backend architecture and lists the bugs, security issues, and performance
> problems found during the review, prioritized for fixing.
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
  codeGenerator.js         # Tokens, invite codes, session create/validate/redeem
  adminUser.js             # bcrypt + JWT, seeds default admin users
middleware/
  adminAuth.js             # Bearer JWT verification + superAdminOnly gate
  sessionAuth.js           # x-session-token verification (currently unused by routes)
  rateLimiter.js           # Simple per‑IP sliding window
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
| `RATE_LIMIT_WINDOW_MS` | 60000 | server.js (admin limiter) | |
| `RATE_LIMIT_MAX` | 10 | **not used** | dead — limiter hard‑coded to 100000 (see B‑3); when wired, applies to auth/admin endpoints only, **not** stream routes |
| `FFMPEG_PATH` | `ffmpeg` | converters | falls back to `ffmpeg-static` |
| `HLS_TEMP_DIR` | `tmp/hls` | hlsConverter | .env sets `/dev/shm/...` |
| `HLS_SEGMENT_DURATION` | 2 | hlsConverter | |
| `HLS_LIST_SIZE` | 5 | hlsConverter | .env sets 8 |
| `HLS_IDLE_TIMEOUT_MS` | 30000 | hls+pipe converters | shared by both |
| `HLS_*` (rest) | see code | hlsConverter | |
| `STREAM_HIGH_WATER_MARK` | 2MB | streamManager | .env sets 8MB |
| `STREAM_*` (rest) | see code | streamManager | |
| `ADMIN_SECRET` | weak | **not used** | dead — code uses JWT (see B‑1) |
| `JWT_SECRET` | — | adminUser.js | **missing from .env** → hardcoded fallback (S‑1) |
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

## 10. REVIEW: Bugs & Issues Found

Priority legend: **S** = security, **B** = correctness bug, **P** = performance,
**M** = maintenance/quality. Each item has a file:line reference.

### Critical

#### S‑1 — Hardcoded JWT secret fallback (`services/adminUser.js:4`)
```js
const JWT_SECRET = process.env.JWT_SECRET || 'chatrix_jwt_secret_key_2026';
```
`JWT_SECRET` is **not** in `.env`, so the fallback is used in production. Anyone
who reads this source can forge a valid admin JWT and fully take over the
platform. **Fix:** require `JWT_SECRET` at startup (fail fast if missing) and add
a strong value to `.env`.

#### S‑2 — Default admin credentials seeded in source (`services/adminUser.js:37-43`)
Hardcoded usernames/passwords (`superadmin` / `SuperAdmin@2026`, etc.) are
inserted on first run. Anyone with source access knows the live admin login.
**Fix:** seed from env vars or require interactive setup; at minimum force a
password change on first login.

#### S‑3 — 500MB JSON body limit (`server.js:52-53`)
```js
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));
```
Trivial DoS: an attacker can POST a 500MB JSON body to OOM the process. Admin
endpoints only need a few KB. **Fix:** set a small global limit (e.g. `64kb`),
raise only where needed.

#### B‑1 — No Express error‑handling middleware (`server.js`)
There is no `app.use((err, req, res, next) => …)`. The CORS check does
`callback(new Error('Not allowed by CORS'))` (server.js:75); an unhandled error
here returns Express's default HTML error page **with stack trace** instead of
JSON, leaking internals and breaking API clients. **Fix:** add a final error
handler that returns JSON `{ error }` and never sends the stack in production.

#### B‑2 — No `unhandledRejection` / `uncaughtException` handlers (`server.js`)
A single unhandled promise rejection (e.g. from `routes/matches.js` if `fetch`
throws outside the try/catch, or any future async route) can crash or destabilise
the process. **Fix:** add `process.on('unhandledRejection', …)` and
`process.on('uncaughtException', …)` logging + graceful exit.

### High

#### B‑3 — Rate limiting is misconfigured (`server.js:88`)
```js
const adminLimiter = rateLimiter({ windowMs: …, maxRequests: 100000 });
```
`maxRequests` is hard‑coded to `100000`/min, so the `/api/admin/login` limiter is effectively a no-op. The documented `RATE_LIMIT_MAX=10` is never read. At the same time the PROJECT_PLAN suggests `GET /channel/*: 5 req/min` — **that would break live streaming** and must NOT be applied (see note below).

**Fix (carefully — keep streams unlimited):**
- Wire `RATE_LIMIT_MAX` so it is actually used.
- Tighten the limiter on **anti‑abuse endpoints only**: `/api/auth/redeem` (invite‑code brute‑force), `/api/auth/direct/:token` (session‑creation spam), `/api/admin/login` (already wired, fix the cap). A separate, looser limiter can cover `/matches/:date`.
- **Do NOT rate‑limit any stream/manifest/segment route.** These endpoints are long‑lived (`/channel`, `/pipe`) or polled every ~2s (`/hls/.../index.m3u8`, `.../:segment`, `/hls/.../manifest-ready/:quality`). Any per‑IP request cap trips instantly and kicks viewers off mid‑stream.
- Viewer access control is already handled by session validation on every request + the 30s mid‑stream re‑validation in `stream.js`/`pipe.js`; that is the right place to enforce limits, not a request counter.

**Why streams must stay unlimited:**
```
HLS viewer every 2s:
  GET .../index.m3u8        ← manifest poll
  GET .../seq_42.ts         ← segment fetch
  GET .../seq_43.ts         ← segment fetch
A 5 req/min limiter would block the viewer after ~6 seconds. ❌
Raw/pipe viewer:
  1 long-lived GET that stays open for the whole session. ❌ can't count as "1 req/min"
```

#### B‑4 — Rate limiter `hits` Map grows unbounded (`middleware/rateLimiter.js`)
Old IPs that never return are never evicted → slow memory leak. **Fix:** periodic
sweep or LRU cap.

#### B‑5 — `pipe.js` session cache lacks oldest‑entry eviction (`routes/pipe.js:16-23`)
Unlike `hls.js` (which has a size‑based oldest eviction fallback at lines 24-32),
`pipe.js` only evicts by TTL. Under a burst of fresh tokens the Map can grow
unbounded. **Fix:** mirror the `hls.js` eviction logic.

#### P‑1 — Synchronous file I/O on HLS hot path (`services/hlsConverter.js`, `routes/hls.js`)
- `getManifest` uses `fs.existsSync` + `fs.readFileSync` (hlsConverter.js:544-549)
  on every manifest request (cached only 500ms).
- `getSegmentData` uses `fs.readFileSync` (hlsConverter.js:721) on cache miss.
With 79+ viewers polling manifest/segments every ~2s, sync reads **block the
event loop** and stall all clients (including raw passthrough ones). **Fix:**
switch to `fs.promises` (async) or a `worker_threads` offload; expand the
in‑memory segment cache.

#### P‑2 — MD5 ETag recomputed on every segment request (`routes/hls.js:308`)
```js
const etag = '"' + crypto.createHash('md5').update(segmentData.data).digest('hex') + '"';
```
Even with the in‑memory segment cache, the ETag is recomputed per request. 79
viewers × 1 segment/2s = ~40 MD5 hashes/s of ~1MB buffers. **Fix:** cache the
ETag alongside the segment in `SegmentLRU` (keyed by segment name) or derive it
from `name + size` instead of full content.

#### B‑6 — `gracefulShutdown` does not stop `StreamManager` (`server.js:177-184`)
Only `hlsConverter` and `pipeConverter` are stopped; raw passthrough streams
(`/channel`) are left dangling. They die on process exit anyway, but clients get
a hard reset instead of a clean end. **Fix:** call `streamManager.stopAll()`.

### Medium

#### B‑7 — Dead redirect branch in `StreamManager` (`services/streamManager.js:54-58`)
`follow-redirects` follows redirects automatically, so the manual 3xx handling
that calls `_scheduleReconnect` is effectively dead — and if it ever fires
(max redirects exceeded), it reconnects to the **same** URL and likely loops.
**Fix:** remove the branch or treat max‑redirects as a hard failure.

#### P‑3 — No TCP `noDelay` on stream responses
PROJECT_PLAN states `noDelay: true`, but `addClient`/`addClient` in
`streamManager.js:172` and `pipeConverter.js:201` never call
`res.socket.setNoDelay(true)`. Nagle's algorithm adds up to ~200ms latency on
small chunks. **Fix:** set `setNoDelay(true)` after `writeHead`.

#### B‑8 — `Accept-Encoding: identity` + `Icy-MetaData: 1` may not match sources
`streamManager.js:39-40` requests icecast metadata but does not parse it; for
non‑icecast sources this is harmless but inconsistent. Low impact.

#### B‑9 — `cleanupExpired` does not prune `channel_viewers` (`server.js:139-168`)
Viewer rows accumulate forever; `viewers_count` grows unbounded and the table
bloats. **Fix:** delete viewers whose channel was deleted (cascade already
handles this) and/or periodically prune stale viewer_id entries.

#### B‑10 — `routes/matches.js` fetch has no timeout/cache (`routes/matches.js:13`)
Global `fetch` with no `AbortController`/timeout can hang a request handler; every
call hits the external API. **Fix:** add timeout + short‑lived response cache.

#### M‑1 — Three duplicated session caches with different TTLs
`routes/auth.js` (15s), `routes/hls.js` (30s), `routes/pipe.js` (30s) each
reimplement `getCachedSession` with subtly different eviction. **Fix:** extract
one shared cache helper in `services/`.

#### M‑2 — Duplicated quality presets
`QUALITY_PRESETS` is copy‑pasted across `hlsConverter.js` and `pipeConverter.js`
(and again, differently, in `routes/auth.js`). Drift risk. **Fix:** single source
in `services/`.

#### M‑3 — `sessionAuth.js` middleware is unused
No route imports it; session checks are inlined per route. Either wire it in or
remove it to reduce confusion.

#### M‑4 — Dead/contradictory config
`ADMIN_SECRET`, `DEFAULT_LINK_EXPIRY_HOURS`, `RATE_LIMIT_MAX` are referenced by
docs/`.env` but not by code. PROJECT_PLAN still describes `X-Admin-Secret` auth
while the code uses Bearer JWT. **Fix:** sync docs and `.env` with reality.

### Low

#### B‑11 — `stopAllStreamsForChannel` key parsing (`services/streamManager.js:237`)
`key.split(':')[1]` would break if a quality label ever contained `:`. Unlikely
today, but fragile. **Fix:** store `(channelId, qualityLabel)` tuples instead
of re‑parsing the string key.

#### B‑12 — `localize_admin.js` at repo root
Unreviewed top‑level script not referenced by the server. Confirm whether it is
needed; if not, remove to reduce surface area.

#### P‑4 — `agent: false` on upstream (`services/streamManager.js:43`)
Disables keep‑alive connection pooling for upstream reconnects. Fine for single
streams; minor overhead on rapid reconnect loops.

---

## 11. Performance Recommendations for 79+ Users

1. **Default viewers to raw passthrough (`/channel`) or `copy`‑based pipe/HLS.**
   These paths scale linearly with near‑zero CPU. Reserve transcoded presets for
   users who explicitly need lower bitrate.
2. **Fix P‑1/P‑2 first** — sync I/O and MD5 are the most likely cause of "stops"
   and stutters under load, because they block the single event loop that also
   serves every other viewer.
3. **Put a reverse proxy (nginx) in front** for TLS termination, static caching,
   and `proxy_buffering off` for stream endpoints (already implied by
   `X-Accel-Buffering: no`). Ensure `trust proxy` setting matches your hop count
   (currently `1`).
4. **HLS temp dir on tmpfs** — already configured (`/dev/shm/...`). Keep it;
   avoids disk I/O for segments. Increase `SegmentLRU` size (currently 20) to
   cover more concurrent segment requests.
5. **Backpressure** — the 5MB `maxBuffer` drop is a blunt instrument. For 79+
   users consider honoring `res.write() === false` + `passthrough.pause()` to
   apply real backpressure instead of dropping clients.
6. **Connection limits** — add a per‑channel and global max‑clients guard so a
   runaway client count can't exhaust memory.
7. **Observability** — expose active stream/client counts (admin endpoint) and
   log periodic stats; this is the fastest way to find the "stops" root cause.

---

## 12. Recommended Fix Order

1. **S‑1, S‑2, S‑3** — secrets + body limit (security blockers).
2. **B‑1, B‑2** — error handler + global rejection handler (stability).
3. **B‑3, B‑4, B‑5** — fix anti‑abuse rate limiting (auth/admin login only — **never** on stream routes) + cache leaks.
4. **P‑1, P‑2** — async HLS I/O + ETag cache (the "stops" under 79+ users).
5. **B‑6, P‑3** — clean shutdown + `noDelay`.
6. **B‑7, B‑9, B‑10** — correctness cleanups.
7. **M‑1 … M‑4** — dedup + doc/config sync.

Each item is isolated and can be applied incrementally without changing the
public API or the database schema.

---

## 13. Open Questions for You

1. Which delivery mode do your viewers actually use today — `/channel`,
   `/pipe`, or `/hls`? (Prioritize that mode's fixes first.)
2. Is the source codec H.264/AAC? If yes, we can default everything to `copy`
   and remove most transcoding CPU cost, which makes multi‑channel trivial.
3. What is the VPS CPU/RAM? Determines how many concurrent transcodes are safe.
4. Is `nginx` in front (1 hop) or are there more proxies? Affects `trust proxy`.
