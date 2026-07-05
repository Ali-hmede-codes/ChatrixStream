# ChatrixStream — Frontend Player Review

**Scope:** `public/js/player.js` (1423 lines) and `public/player.html` (78 lines)
**Reviewed at:** `public/js/player.js`, `public/player.html`
**Goal:** Audit the player for **bugs / fixes / improvements** and define the updates required to make it run reliably on **any browser version, any device, any OS**.

---

## 0. Executive Summary

The player is a single‑file IIFE that wraps a native `<video>` element with a Video.js‑compatible shim and supports two playback engines:

| Engine | Selector | Status |
|---|---|---|
| `createHlsWrapper()` (native HLS on Safari/iOS, **hls.js** elsewhere) | `usePipeMode = false` | **Active** (hard‑coded `false` at `player.js:355`) |
| `createMpegtsWrapper()` (**mpegts.js** pipe mode) | `usePipeMode = true` | **Disabled / dead** — `usePipeMode` is forced to `false` |

Overall the architecture is sound and the live‑edge / reconnect / session logic is well thought out. However the codebase carries **a lot of dead code** left over from a removed "auto‑downgrade / catch‑up" feature, and there are **two functional regressions** caused by the Video.js → native‑wrapper migration that were not fully completed:

1. **Bandwidth estimation is broken** in the active HLS path → adaptive quality selection is effectively non‑functional.
2. **Fullscreen state tracking is broken** on desktop/Android → the fullscreen icon never updates after entering fullscreen.

Both are explained in detail below with fixes.

---

## 1. `player.js` — Critical Bugs

### 1.1 Bandwidth estimation never updates in HLS mode  *(High)*
`player.js:264-269`

```js
tech: function() {
    return {
        vhs: null,                 // <-- always null in createHlsWrapper
        el: function() { return videoEl; }
    };
}
```

`bandwidthEstimate` is read in two places, both of which read `tech.vhs.bandwidth`:

- `trackBandwidth()` (`player.js:56-59`)
- the `playing` handler (`player.js:533-536`)

Because `tech().vhs` is `null`, `bandwidthEstimate` is **only** ever set by the Network Information API listener (`player.js:308-313`):

```js
bandwidthEstimate = navigator.connection.downlink * 1000000;
```

`navigator.connection` is **not available on iOS/Safari at all**, and `downlink` is missing or unreliable on many desktop browsers. Result: on iOS/Safari (the most common mobile target) `bandwidthEstimate` stays `null`, so `isLowBandwidth()` / `isVeryLowBandwidth()` fall back to `effectiveType`, and on desktop they always return `false`.

**Impact:** `LIVE_EDGE_*` thresholds, `minSegments`, default quality selection and buffer sizes all degrade to the "fast network" branch on the platforms that need adaptation most.

**Fix:** Expose hls.js stats through the wrapper:

```js
tech: function() {
    return {
        vhs: hlsInstance ? {
            bandwidth: hlsInstance.bandwidthEstimate || (hlsInstance.stats && hlsInstance.stats.frag bufferingSpeed * 8) || null
        } : null,
        el: function() { return videoEl; },
        hls: hlsInstance            // expose for debugging / level API
    };
}
```

(`hlsInstance.bandwidthEstimate` is a documented getter on hls.js ≥ 0.13.)

---

### 1.2 Fullscreen state never updates in HLS mode  *(High)*
`player.js:160-274` vs `player.js:501-506`

`createHlsWrapper` declares `var fullscreenState = false;` (`player.js:162`) and returns it from `isFullscreen()` (`player.js:254`), but it **never attaches any `fullscreenchange` listener**. The listeners that update `fullscreenState` live at `player.js:501-506` — **inside `createMpegtsWrapper`**, which is never instantiated because `usePipeMode` is forced to `false`.

Consequences (non‑iOS desktop/Android, the active code path):

- `vjsPlayer.isFullscreen()` always returns `false`.
- `isAnyFullscreen()` (`player.js:1260-1262`) returns `false` → `toggleFullscreen()` always takes the **enter** branch; you can never exit via the button (the icon also never flips to ✖).
- `handleFullscreenChange()` (`player.js:1308`) reads `vjsPlayer.isFullscreen()` = `false`, so the "resume after exit" branch runs on every change event.
- `updateFullscreenIcon()` (`player.js:1298`) only ever renders the "enter" glyph (⛶).

iOS is unaffected because it goes through the native `webkitbeginfullscreen` / `webkitendfullscreen` path (`player.js:1321-1334`) which sets `isNativeFullscreen` directly.

**Fix:** Add the same `fullscreenchange` / `webkitfullscreenchange` listeners to `createHlsWrapper` (or, better, move them out of the wrappers into a single shared setup so both engines behave identically):

```js
function bindFullscreenState(getter, setter) {
    var update = function () { setter(!!(document.fullscreenElement || document.webkitFullscreenElement)); };
    document.addEventListener('fullscreenchange', update);
    document.addEventListener('webkitfullscreenchange', update);
}
```

Call it once from `initPlayer()` and have both wrappers read from a shared `fullscreenState`.

---

### 1.3 hls.js `MEDIA_ERROR` recovery has no retry cap  *(High)*
`player.js:212-214`

```js
case Hls.ErrorTypes.MEDIA_ERROR:
    hlsInstance.recoverMediaError();
    break;
```

`recoverMediaError()` is called on every fatal media error with no counter. If the media is genuinely undecodable (codec mismatch, corrupt init segment) this loops forever, hammering the CPU and never surfacing an error to the user.

**Fix:** Track recovery attempts and escalate after 2–3 failures:

```js
case Hls.ErrorTypes.MEDIA_ERROR:
    if (mediaErrorRetries++ < 3) {
        hlsInstance.recoverMediaError();
    } else {
        hlsInstance.destroy();
        videoEl.dispatchEvent(new Event('error'));
    }
    break;
```

Reset `mediaErrorRetries` on a successful `playing` event.

---

### 1.4 403 from hls.js is treated as a generic network error  *(Medium)*
`player.js:208-211`

```js
case Hls.ErrorTypes.NETWORK_ERROR:
    videoEl.dispatchEvent(new Event('error'));
    break;
```

The synthetic error (`player.js:243-245`) is `{ code: 2, message: 'Simulated HLS network error' }`. The `error` handler (`player.js:597-603`) only detects 403 by string‑matching `message` for `'403'` / `'Forbidden'`, which never matches the synthetic message. A token revocation mid‑stream therefore triggers a reconnect storm instead of `handleSessionExpired()`.

It is partially masked by `checkSessionExpired()` being called first (`player.js:591`), so the user *will* eventually be kicked — but only after one wasted reconnect cycle, and only if that fetch succeeds.

**Fix:** Propagate the real HTTP status from hls.js into the synthetic error:

```js
case Hls.ErrorTypes.NETWORK_ERROR:
    var httpCode = (data && data.response && data.response.code) || 0;
    videoEl.dispatchEvent(new CustomEvent('error', { detail: { code: 2, httpCode: httpCode } }));
    break;
```

and in `error()` return `{ code: 2, message: 'HTTP ' + httpCode }` so the existing 403 matcher fires. Or simply call `handleSessionExpired()` directly when `httpCode === 403`.

---

### 1.5 `bandwidthUpdateInterval` is never cleared on destroy  *(Medium)*
`player.js:52-61` vs `destroyPlayer()` `player.js:920-955`

`trackBandwidth()` starts a 5 s `setInterval` and only clears the *previous* one. `destroyPlayer()` never clears it, so after a destroy/recreate cycle (session expiry, max reconnects, manual quality switch edge cases) the interval keeps firing against a destroyed `vjsPlayer`, calling `vjsPlayer.tech()` and logging errors.

**Fix:** Add `if (bandwidthUpdateInterval) { clearInterval(bandwidthUpdateInterval); bandwidthUpdateInterval = null; }` to `destroyPlayer()`.

---

### 1.6 `getAvailableQualities()` mutates shared state  *(Low–Medium)*
`player.js:137-140`

```js
return channelInfo.qualities.sort(function(a, b) { return a.sort_order - b.sort_order; });
```

`Array.prototype.sort` mutates the source array. `channelInfo.qualities` is the authoritative payload from the server and is also used directly in `init()` (`player.js:387`) with its own `.sort()` call. Repeated reads through `getAvailableQualities()` repeatedly re‑sort the same array (idempotent here, but fragile), and the dual sort makes the data model order ambiguous.

**Fix:** Return a sorted copy: `return channelInfo.qualities.slice().sort(...)`.

---

### 1.7 `seekToLiveEdge()` / live tracker reference is always `null`  *(Low)*
`player.js:966-982`, `player.js:270`, `player.js:498`

Both wrappers set `liveTracker: null`, so `seekToLiveEdge()` always falls through to the `seekable`/`buffered` branch. That branch works, but the `liveTracker` code is dead and misleading. Either implement a minimal live‑tracker shim or delete the branch.

---

### 1.8 SSE `JSON.parse` is unguarded  *(Low)*
`player.js:1173-1182`

```js
sseConnection.addEventListener('session_expired', function(e) {
    var data = JSON.parse(e.data);   // throws if e.data is malformed/empty
    ...
});
```

A single malformed SSE frame kills the listener (the `EventSource` itself survives, but the handler throws and the message is lost). Wrap in `try/catch`.

---

## 2. `player.js` — Dead / Vestigial Code (safe to remove)

The "auto‑downgrade + catch‑up playback rate" feature was removed (see comment `player.js:425`), but its scaffolding remains. Confirmed by grep — these symbols are **assigned but never read for decisions**, or **never called**:

| Symbol | Location | Why dead |
|---|---|---|
| `isCatchingUp` | `player.js:34,132,954,960,1052` | Set to `false` in 4 places; **never set to `true`** → the `if (vjsPlayer && isCatchingUp)` branch (`player.js:132`) is unreachable |
| `CATCHUP_PLAYBACK_RATE`, `NORMAL_PLAYBACK_RATE` | `player.js:37-38` | Only used in the unreachable catch‑up branch and `destroyPlayer`/`softResetPlayer` resets |
| `autoDowngradeDisabled` | `player.js:23,111` | Never set to `true`; `isCellularOrStruggling` check is a tautology |
| `isWarmingUp` | `player.js:13` | Declared, never used |
| `lastStallTime` | `player.js:27,576,636` | Written, never read |
| `stallCount` | `player.js:26,532,573,635` | Incremented/reset, never read |
| `totalBufferingTime` | `player.js:21,548,952` | Accumulated, never reported |
| `lastPlayingTime` | `player.js:22,551,953` | Written, never read |
| `consecutiveNetworkErrors` | `player.js:14,606,845` | Incremented, reset, never gates any decision |
| `getQualityLower()` | `player.js:142-152` | Never called (auto‑downgrade removed) |
| `getLowestQuality()` | `player.js:154-158` | Never called |
| `startBufferHealthMonitor()` / `stopBufferHealthMonitor()` | `player.js:1039-1045` | Empty stubs; `stopBufferHealthMonitor` never called |
| `adaptToNetworkConditions()` | `player.js:68-71` | Empty stub, never called |
| Entire `createMpegtsWrapper()` + `setVideoSource` pipe branch + `mpegtsPlayerInstance` | `player.js:429-509, 802-873` | `usePipeMode` is hard‑forced `false` (`player.js:355`) |

**Recommendation:** Delete the pipe‑mode wrapper, the mpegts.js `<script>` tag in `player.html`, and all the dead adaptivity variables. This removes ~250 lines and one external dependency. If pipe mode is ever needed again, restore it from git — don't keep it dormant and untested.

---

## 3. `player.js` — Updates to work on **any version / device / OS**

These are the changes that turn "works on the developer's machine" into "works everywhere".

### 3.1 Pin and validate external library versions
`player.html:73-74`

```html
<script src="https://cdn.jsdelivr.net/npm/mpegts.js@1.7.3/dist/mpegts.js"></script>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
```

- `hls.js@1` is a **floating major** — jsDelivr serves whatever `1.x` is latest, so a future minor release can ship breaking changes silently. Pin to a concrete version (e.g. `hls.js@1.5.20`) and add `integrity=`/`crossorigin="anonymous"` SRI attributes.
- If pipe mode is removed (§2), drop the `mpegts.js` tag entirely (~150 KB saved).
- Add a runtime guard so the page fails gracefully instead of `ReferenceError` if the CDN is blocked:

```js
if (typeof Hls === 'undefined' && !videoEl.canPlayType('application/vnd.apple.mpegurl')) {
    showError('Player failed to load', 'Streaming library could not be loaded. Check your network/ad blocker.');
    return;
}
```

### 3.2 Robust engine selection matrix
The current detection (`player.js:194, 299-306`) is mostly right but has gaps. Replace with an explicit capability matrix:

| Condition | Engine |
|---|---|
| iOS / iPadOS (any browser — all use WKWebView) | Native HLS (`videoEl.src = m3u8`) |
| macOS Safari | Native HLS |
| Android / Windows / Linux Chrome, Edge, Firefox | hls.js (MSE) |
| Any browser where `Hls.isSupported()` is false but `canPlayType('vnd.apple.mpegurl')` | Native HLS fallback |
| No MSE and no native HLS | Error UI with "unsupported browser" message |

Implementation:

```js
function pickEngine() {
    if (isIOS() || isSafari() || videoEl.canPlayType('application/vnd.apple.mpegurl') === 'probably') {
        return 'native';
    }
    if (typeof Hls !== 'undefined' && Hls.isSupported()) return 'hlsjs';
    return 'unsupported';
}
```

Also detect `isIOS()` more robustly for iPadOS 13+ (which reports as macOS):

```js
function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
           (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ||
           (navigator.userAgentData && navigator.userAgentData.platform === 'iOS');
}
```

### 3.3 Fix `maxTouchPoints` threshold
`player.js:95`

```js
navigator.maxTouchPoints && navigator.maxTouchPoints > 2
```

`> 2` misses touch devices that report 1 or 2 touch points. Use `> 0` (or `> 1` to avoid desktop trackpad false positives on some Chrome builds).

### 3.4 Bandwidth detection that works without `navigator.connection`
Because `navigator.connection` is missing on iOS/Safari and unreliable on desktop (see §1.1), implement a layered estimator:

1. hls.js `bandwidthEstimate` (primary, via the §1.1 fix).
2. For native HLS (iOS/Safari), measure segment download time yourself via `performance.now()` around `fetch()` of a segment, or use the `webkitVideoDecodedByteCount` polling trick (increment per second → bits/s).
3. Fall back to `navigator.connection.downlink` / `effectiveType` where present.
4. Final fallback: assume "low" on cellular UA, "high" otherwise.

This makes `isLowBandwidth()` / `isVeryLowBandwidth()` meaningful on every platform.

### 3.5 hls.js config tuned for low latency and broad compat
`player.js:197-203`

```js
hlsInstance = new Hls({
    maxBufferLength: isStruggling ? 20 : 40,
    maxMaxBufferLength: 80,
    liveSyncDurationCount: 3,
    liveMaxLatencyDurationCount: 15,
    enableWorker: true
});
```

Add for universal stability:

- `lowLatencyMode: true` — enables LL‑HLS parts when the origin supports them, no penalty when it doesn't.
- `backBufferLength: 30` — bounded back buffer so long sessions don't grow memory unbounded (critical on mobile).
- `liveDurationInfinity: true` — avoids `Infinity` duration issues on some Chromecast/WebRTC targets.
- `fragLoadingMaxRetry: 4`, `manifestLoadingMaxRetry: 2`, `levelLoadingMaxRetry: 4` — explicit retry caps so a flaky CDN doesn't hang forever.
- `enableSoftwareAES: true` — keep software fallback for encrypted segments on devices without hardware AES.
- `preferManagedMediaSource: true` — required for iOS 17.1+ Managed Media Source if you ever enable hls.js on iOS.
- Provide a worker fallback: `enableWorker: true` but wrap in try/catch; if `Hls.DefaultConfig.loader` worker creation throws, recreate with `enableWorker: false`. Some older Android WebViews (4.4–5) silently break on workers.

### 3.6 Autoplay policy compliance
`player.js:883-895` handles `NotAllowedError`, but the iOS branch shows `tap-to-play` while the non‑iOS branch forces mute + retry. Refine:

- Always try **muted autoplay first** (`vjsPlayer.muted(true)` is already set), then attempt unmute on first user gesture. This matches the HTML `autoplay muted` attributes and is the most broadly accepted pattern.
- Listen for the **first** `touchend` / `click` / `keydown` on `document` (one‑shot) to call `tryUnmute()`, so the user doesn't have to find the unmute button.
- On Android Chrome, `play()` can reject with `AbortError` (not just `NotAllowedError`) when called too rapidly — debounce `play()` calls (≥250 ms apart).

### 3.7 `fetch` hardening
Every `fetch` (`/api/auth/session`, `/hls/.../manifest-ready/...`) has no timeout and no abort. A hung backend hangs the UI. Wrap with `AbortController`:

```js
function fetchWithTimeout(url, opts, ms) {
    var c = new AbortController();
    var t = setTimeout(function() { c.abort(); }, ms || 8000);
    return fetch(url, Object.assign({}, opts, { signal: c.signal }))
        .then(function(r) { clearTimeout(t); return r; })
        .catch(function(e) { clearTimeout(t); throw e; });
}
```

Use it for session validation and manifest‑ready polling (the latter is the highest risk — it polls every 1 s for up to 30 s).

### 3.8 Visibility / background resume per‑platform
`player.js:1374-1405` already special‑cases iOS/Safari (clean reload) vs others (seek‑to‑live). Add:

- **Android Chrome** often pauses video in background and resumes with a frozen decoder; after `visibilitychange`, also call `vjsPlayer.play()` then `seekToLiveEdge()` and tolerate one `AbortError`.
- **macOS Safari** tab switch can detach the SourceBuffer; detect via `buffered.length === 0` after resume and do a soft reload (like iOS).
- Replace the magic `500 ms` / `300 ms` `setTimeout` delays with `requestAnimationFrame` + a single rAF, which is more reliable across throttled background tabs.

### 3.9 Memory hygiene for long sessions
Long live sessions (hours) leak memory on mobile without explicit cleanup:

- Clear `bandwidthUpdateInterval` and `liveEdgeTrackingInterval` in `destroyPlayer()` (§1.5).
- Set hls.js `backBufferLength` (§3.5) and `autoCleanupSourceBuffer: true`-equivalent (already on for mpegts; add for hls via `backBufferLength`).
- On `visibilitychange` → hidden, optionally `vjsPlayer.pause()` to release the decoder on low‑end devices, resuming on visible (already partially done).

### 3.10 Reconnect backoff improvements
`player.js:1086-1122`

- Add jitter to `reconnectBackoff` to avoid thundering‑herd when many viewers reconnect after a streamer blip:

```js
var jitter = Math.random() * 500;
reconnectTimer = setTimeout(reconnect, delay + jitter);
```
- Cap `consecutiveNetworkErrors` and surface "stream appears offline" after N failures rather than only at the hard `maxReconnectAttempts` limit.
- Reset `reconnectAttempts` on a *sustained* playing state (e.g. 5 s of playback), not on the first `playing` event — a single `playing` can fire during a stutter.

### 3.11 Accessibility
- Add `aria-label` to `#fullscreen-btn`, `#unmute-btn`, `#live-badge`, `.quality-btn` (currently only `title`, which doesn't work for screen readers on touch).
- Make `#video-container` focusable and bind `keydown` (Space = play/pause, `f` = fullscreen, `m` = mute) — currently keyboard users cannot operate the player at all.
- Ensure focus order: video → unmute → quality buttons → fullscreen.
- The `dblclick` → fullscreen handler (`player.js:1356`) doesn't work on touch; add a double‑tap detector (two `touchend` within 300 ms).

### 3.12 Error overlay for "unsupported browser"
There is no UI path for the case where neither hls.js nor native HLS is available (very old Android WebView < 4.4). Add a terminal `showError('Browser not supported', ...)` reached from the `pickEngine()` matrix in §3.2.

---

## 4. `player.html` — Review

The HTML is short (78 lines) and mostly fine. Issues:

### 4.1 Vestigial Video.js classes  *(Low)*
`player.html:45`

```html
<video id="video-player" class="video-js vjs-default-skin" autoplay muted playsinline webkit-playsinline></video>
```

Video.js is **not loaded** (no `<script>` for it), and `player.js:520` immediately strips these classes:

```js
videoEl.classList.remove('video-js', 'vjs-default-skin');
```

Remove `class="video-js vjs-default-skin"` from the HTML and the `classList.remove` line from JS. Keep `autoplay muted playsinline webkit-playsinline`.

### 4.2 Floating / unpinned CDN versions  *(High — see §3.1)*
`player.html:73-74` — pin `hls.js`, add SRI, drop `mpegts.js` if pipe mode is removed.

### 4.3 Missing mobile/PWA meta tags  *(Medium)*
Add for a native‑app feel on phones:

```html
<meta name="theme-color" content="#050508">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="format-detection" content="telephone=no">
```

`viewport-fit=cover` is already set (good, needed for iPhone notch safe areas), but no CSS uses `env(safe-area-inset-*)` — the quality bar / expiry notice can collide with the notch/home indicator. Add:

```css
#quality-bar { right: calc(16px + env(safe-area-inset-right)); }
#expiry-notice { top: calc(16px + env(safe-area-inset-top)); right: calc(16px + env(safe-area-inset-right)); }
```

### 4.4 `user-scalable=no` is an accessibility violation  *(Low)*
`player.html:7` — `user-scalable=no, maximum-scale=1.0` prevents pinch‑zoom and is flagged by Lighthouse/a11y audits. Unless video‑zoom UX is required, remove these two tokens. Most mobile browsers now ignore it anyway.

### 4.5 Font mismatch  *(Low)*
`style.css:20` sets `font-family: 'Outfit', ...`, but `player.html:13` only loads **Cairo**:

```html
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@800;900&display=swap" rel="stylesheet">
```

So the player page renders in the system fallback. Either load `'Outfit'` (used by the rest of the app) or change the CSS to use `'Cairo'` for the player page. Also: loading a font over the network delays first paint; consider `font-display: swap` (already via `&display=swap`) and a `<link rel="preload">`.

### 4.6 No poster / no `preload`  *(Low)*
Before the first frame decodes the user sees a black box. Add `poster="/poster.svg"` (or a channel‑specific frame) and `preload="metadata"` to reduce wasted bandwidth when the user lands but never plays.

### 4.7 `webkit-playsinline` is deprecated  *(Trivial)*
Keep for old iOS (< 10) compat, but it's superseded by `playsinline`. Fine as‑is; just be aware.

### 4.8 Button has no accessible name  *(Low)*
`#fullscreen-btn` and `#unmute-btn` rely on `title` and an SVG with no `aria-label`. Add `aria-label="Fullscreen"` / `aria-label="Unmute"` and `role="button"`.

### 4.9 SVG icons are presentational  *(Trivial)*
Add `aria-hidden="true"` to the inline `<svg>`s so screen readers skip them (the button label carries the meaning).

### 4.10 Order of overlays vs video in DOM  *(Trivial)*
The `<video>` is declared **before** the watermark / unmute / quality bar, which is fine, but `#tap-to-play-overlay` sits above the video in source order while `#error-overlay` / `#loading-overlay` are above it. z‑index in CSS already controls stacking (`#tap-to-play-overlay` z=25, overlays z=20). Verify the unmute button (z=15) is below tap‑to‑play (z=25) so it doesn't show *over* the tap overlay on iOS — currently both can be visible simultaneously in some autoplay‑blocked states.

---

## 5. Prioritised Action Plan

| # | Item | Severity | Effort | File(s) |
|---|---|---|---|---|
| 1 | Expose hls.js bandwidth via `tech().vhs` | High | S | `player.js:264` |
| 2 | Bind `fullscreenchange` in HLS wrapper (fix icon/exit) | High | S | `player.js:160-274` |
| 3 | Cap hls.js `MEDIA_ERROR` recovery | High | S | `player.js:212` |
| 4 | Pin `hls.js` version + SRI, remove unused `mpegts.js` | High | S | `player.html:73-74` |
| 5 | Propagate hls.js HTTP 403 → session expiry | Medium | S | `player.js:208` |
| 6 | Clear `bandwidthUpdateInterval` in `destroyPlayer` | Medium | S | `player.js:920` |
| 7 | `getAvailableQualities()` — non‑mutating sort | Medium | S | `player.js:137` |
| 8 | `fetchWithTimeout` for session + manifest polling | Medium | M | `player.js` (all `fetch`) |
| 9 | Layered bandwidth estimator (no `navigator.connection` dep) | Medium | M | `player.js:73-97` |
| 10 | hls.js config: `lowLatencyMode`, `backBufferLength`, retry caps, worker fallback | Medium | S | `player.js:197` |
| 11 | Mobile/PWA meta tags + safe‑area insets | Medium | S | `player.html:6-7`, `style.css` |
| 12 | Autoplay: muted‑first + one‑shot gesture unmute + play debounce | Medium | M | `player.js:883` |
| 13 | Delete dead code (§2) | Low | M | `player.js` |
| 14 | Accessibility: `aria-label`, keyboard, double‑tap | Low | M | both |
| 15 | Reconnect jitter + sustained‑playback reset | Low | S | `player.js:1086` |
| 16 | Guard SSE `JSON.parse` | Low | S | `player.js:1173` |
| 17 | `maxTouchPoints > 0` | Low | S | `player.js:95` |
| 18 | Remove vestigial `video-js` classes | Low | S | `player.html:45`, `player.js:520` |
| 19 | Font consistency (`Outfit` vs `Cairo`) | Low | S | `player.html:13` / `style.css:20` |
| 20 | `poster` + `preload="metadata"` | Low | S | `player.html:45` |

Severity: **High** = functional regression affecting real users · **Medium** = robustness/compat gap · **Low** = hygiene/a11y.
Effort: **S** < 30 min · **M** = a few hours.

---

## 6. Quick "smoke test" matrix to validate after fixes

| Device / OS | Browser | Engine expected | Key check |
|---|---|---|---|
| iPhone (iOS 16, 17, 18) | Safari | Native HLS | Autoplay muted, tap‑to‑play, native fullscreen, no `navigator.connection` → adaptation still works |
| iPad (iPadOS 17, desktop mode) | Safari | Native HLS | `isIOS()` true via `MacIntel + maxTouchPoints` |
| Android 12/14 | Chrome | hls.js | Bandwidth adapts, fullscreen icon toggles, worker on |
| Android (old WebView 5) | in‑app | hls.js no‑worker | Worker fallback path, no crash |
| Windows 11 | Chrome / Edge / Firefox | hls.js | Fullscreen exit works, 403 → session expired |
| macOS | Safari 17 | Native HLS | Background resume (clean reload) |
| macOS | Chrome | hls.js | LL‑HLS, backBuffer bounded |
| Desktop | Screen reader + keyboard | — | All controls reachable/operable |
| Any | Ad‑blocker blocking jsDelivr | — | Graceful error UI, no `ReferenceError` |

---

*End of review. Apply items 1–4 first; they resolve the two active regressions (bandwidth + fullscreen) and remove the biggest external risk (floating CDN version).*
