# Replace FFmpeg with MediaMTX

## Why MediaMTX?
- **Zero-dependency single binary** — no FFmpeg installation, no `ffmpeg-static` npm package
- **Native HLS remuxing** — automatically converts RTSP/RTMP/HLS sources to HLS segments (no FFmpeg process needed for remux)
- **On-demand streaming** — `sourceOnDemand` pulls from source only when viewers connect, auto-closes when idle
- **Control API** — dynamically add/remove paths at runtime via REST API (no config file editing)
- **Protocol translation** — RTSP/RTMP/HLS/WebRTC/SRT all work automatically
- **Handles reconnection** — built-in source reconnection, no manual retry logic needed

## What Changes

### Removable Code
| File | What Gets Removed |
|------|-------------------|
| `services/hlsConverter.js` | **Entire file** — MediaMTX handles HLS segment generation |
| `services/pipeConverter.js` | **Entire file** — MediaMTX handles MPEG-TS streaming |
| `services/streamManager.js` | **Entire file** — MediaMTX proxies source streams |
| `package.json` | Remove `ffmpeg-static` dependency |

### Modified Code
| File | Changes |
|------|---------|
| `server.js` | Remove FFmpeg/HLS/Pipe/Stream imports and initialization; add MediaMTX service; update route wiring |
| `routes/hls.js` | Rewrite to proxy HLS requests to MediaMTX's HLS server (port 8888) |
| `routes/pipe.js` | Rewrite to proxy MPEG-TS requests to MediaMTX |
| `routes/stream.js` | Rewrite to proxy to MediaMTX RTSP/RTMP endpoint |
| `routes/admin.js` | Update stream management to use MediaMTX API |
| `.env` | Replace FFmpeg vars with MediaMTX connection vars |
| `ecosystem.config.js` | Add MediaMTX as a parallel process or document sidecar usage |

### New Code
| File | Purpose |
|------|---------|
| `services/mediamtxManager.js` | Manages MediaMTX via its Control API: dynamically add/remove stream paths |
| `mediamtx.yml` | MediaMTX configuration file |

## Architecture After Migration

```
Before (current):
  Source URL → Node.js → spawn(FFmpeg) → HLS segments on disk → Node.js serves .m3u8/.ts
  Source URL → Node.js → spawn(FFmpeg) → MPEG-TS pipe → Node.js fans out to clients

After (MediaMTX):
  Source URL → MediaMTX (sidecar) → HLS on :8888 → Node.js reverse-proxies to :8888
  Source URL → MediaMTX (sidecar) → RTSP on :8554 → Node.js reverse-proxies (if needed)
```

**Key insight**: MediaMTX handles ALL stream processing. Node.js only does:
1. Authentication (session validation)
2. Reverse-proxy to MediaMTX's HLS endpoint
3. Dynamic path management via MediaMTX's Control API

## Detailed Task Breakdown

### Task 1: Install and Configure MediaMTX
- Download MediaMTX binary for Windows
- Create `mediamtx.yml` with:
  - API enabled on `:9997`
  - HLS enabled on `:8888` with `mpegts` variant (compatibility mode)
  - RTSP on `:8554`
  - `sourceOnDemand: true` for auto-start/stop
  - No authentication (Node.js handles auth before proxying)
- Test with a sample stream URL

### Task 2: Create `services/mediamtxManager.js`
- API client for MediaMTX Control API (`http://localhost:9997`)
- Methods:
  - `addPath(pathName, sourceUrl)` — creates a dynamic path pointing to the source
  - `removePath(pathName)` — removes a dynamic path
  - `pathExists(pathName)` — checks if path is registered
  - `isPathReady(pathName)` — checks if path has an active source
- Path naming convention: `{channelId}_{qualityLabel}` (e.g. `1_high`)
- Auto-cleanup: remove paths when no viewers for `idleTimeout`

### Task 3: Rewrite `routes/hls.js`
- Validate session (keep existing logic)
- Call `mediamtxManager.addPath()` or ensure path exists
- Reverse-proxy `index.m3u8` requests to `http://localhost:8888/{pathName}/index.m3u8`
- Reverse-proxy segment `.ts` requests to `http://localhost:8888/{pathName}/...`
- Keep manifest rewriting for session tokens in segment URLs
- Keep manifest-ready polling (check if MediaMTX has started serving the path)

### Task 4: Rewrite `routes/pipe.js`
- Validate session (keep existing logic)
- Reverse-proxy to MediaMTX's RTSP or MPEG-TS endpoint
- OR: Simplify — just redirect to MediaMTX's HLS endpoint (mpegts.js can consume HLS too)

### Task 5: Rewrite `routes/stream.js`
- Validate session (keep existing logic)
- Reverse-proxy to MediaMTX RTSP endpoint
- OR: Simplify — just redirect to MediaMTX's HLS endpoint

### Task 6: Update `server.js`
- Remove: `ffmpeg-static`, `HlsConverter`, `PipeConverter`, `StreamManager` imports/init
- Add: `MediaMTXManager` import and initialization
- Update route wiring to pass `mediamtxManager` instead of old services
- Update `cleanupExpired()` to call `mediamtxManager.removePath()` instead of old service methods
- Update `gracefulShutdown()` to clean up MediaMTX paths

### Task 7: Update Admin Routes
- Replace stream start/stop commands with MediaMTX path management
- Keep admin UI unchanged (it doesn't know about FFmpeg)

### Task 8: Update Frontend Player
- `player.js`: No changes needed for HLS mode — same `.m3u8` URL structure
- `player.js`: For pipe mode, mpegts.js can consume MediaMTX's HLS endpoint directly OR use MediaMTX's MPEG-TS over WebSocket
- Consider simplifying: remove pipe mode distinction, just use HLS everywhere (MediaMTX handles it efficiently)

### Task 9: Update `.env` and `ecosystem.config.js`
- Remove: `FFMPEG_PATH`, `HLS_TEMP_DIR`, `HLS_SEGMENT_DURATION`, `HLS_LIST_SIZE`, `HLS_IDLE_TIMEOUT_MS`, `HLS_RESTART_DELAY_MS`, `HLS_MAX_RETRIES`, `HLS_MANIFEST_WAIT_TIMEOUT_MS`, `HLS_STARTUP_TIMEOUT_MS`, `STREAM_*`
- Add: `MEDIAMTX_API_URL=http://localhost:9997`, `MEDIAMTX_HLS_URL=http://localhost:8888`
- Update `ecosystem.config.js` to start MediaMTX alongside Node.js

### Task 10: Remove Old Code & Dependencies
- Delete `services/hlsConverter.js`
- Delete `services/pipeConverter.js`
- Delete `services/streamManager.js`
- Remove `ffmpeg-static` from `package.json`
- Remove `tmp/hls` directory (no longer needed)
- Run `npm prune`

## Important Considerations

### What We Lose
1. **Transcoding** (low/medium quality presets) — MediaMTX only does remuxing (copy), not transcoding. If you need lower-quality versions, you'd still need FFmpeg for that specific task. **Recommendation**: Drop transcoding entirely; serve the source stream as-is.
2. **In-process management** — MediaMTX is a separate process. This is actually an advantage (crash isolation).

### What We Gain
1. **Zero FFmpeg errors** — no process spawning, no stderr parsing, no retry logic
2. **Built-in reconnection** — MediaMTX auto-reconnects to sources
3. **Built-in idle timeout** — `sourceOnDemand` + `sourceOnDemandCloseAfter`
4. **Protocol flexibility** — WebRTC, RTMP, SRT all available for free
5. **Simpler codebase** — ~1200 lines of FFmpeg management code removed
6. **No temp files** — MediaMTX handles segment management internally

### Risk Mitigation
- MediaMTX binary must be deployed alongside the Node.js app
- On Windows, the binary is `mediamtx.exe` (~30MB)
- If MediaMTX crashes, all streams go down (same as FFmpeg process dying now)
- Can use PM2 or Windows Service to auto-restart MediaMTX
