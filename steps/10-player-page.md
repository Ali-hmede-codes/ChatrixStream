# Step 10 — Player Page (mpegts.js + quality switcher)

## What you build
The video player page with mpegts.js for MPEG-TS playback, quality switcher (SD/HD/4K), and session-based stream access.

## Depends on
Step 09 (landing page with localStorage session)

## Files to create

### 1. `public/player.html`
### 2. `public/js/player.js`

## Additional dependency

mpegts.js needs to be loaded from CDN or installed locally. Use CDN for simplicity:

```html
<script src="https://cdn.jsdelivr.net/npm/mpegts.js@1.7.3/dist/mpegts.min.js"></script>
```

---

### `public/player.html`

**Structure:**
```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ChatrixStream — Player</title>
    <link rel="stylesheet" href="/css/style.css">
</head>
<body>
    <div id="player-app">
        <!-- Error overlay (session expired, stream failed) -->
        <div id="error-overlay" class="hidden">
            <div class="error-content">
                <h2 id="error-title">Session Expired</h2>
                <p id="error-desc">Your access has expired. Please enter a new invite code.</p>
                <button id="error-btn" onclick="window.location.href='/'">Get New Code</button>
            </div>
        </div>

        <!-- Loading overlay (buffer fill, quality switch) -->
        <div id="loading-overlay" class="hidden">
            <div class="spinner"></div>
            <p id="loading-text">Connecting to stream...</p>
        </div>

        <!-- Video container -->
        <div id="video-container">
            <video id="video-player" autoplay muted></video>

            <!-- Quality selector (overlay on video) -->
            <div id="quality-bar">
                <span id="channel-name"></span>
                <div id="quality-buttons"></div>
            </div>

            <!-- Session expiry notice -->
            <div id="expiry-notice" class="hidden">
                <span id="expiry-text"></span>
            </div>
        </div>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/mpegts.js@1.7.3/dist/mpegts.min.js"></script>
    <script src="/js/player.js"></script>
</body>
</html>
```

---

### `public/js/player.js`

**This is the most complex frontend file. It handles:**
1. Reading session from localStorage
2. Validating session via API
3. Getting channel info (name, qualities)
4. Creating mpegts.js player instance
5. Quality switching (destroy old player, create new one)
6. Error handling (session expired, stream failed)
7. Auto-reconnect on stream error

**Implementation:**

```javascript
(function() {
    const SESSION_KEY = 'chatrix_session';

    // State
    let sessionData = null;    // { session_token, channel_token }
    let channelInfo = null;    // { channel_name, qualities, expires_at }
    let currentQuality = null; // currently watching quality label
    let mpegtsPlayer = null;   // current mpegts.js player instance
    let reconnectTimer = null;

    // DOM
    const videoEl = document.getElementById('video-player');
    const errorOverlay = document.getElementById('error-overlay');
    const errorTitle = document.getElementById('error-title');
    const errorDesc = document.getElementById('error-desc');
    const errorBtn = document.getElementById('error-btn');
    const loadingOverlay = document.getElementById('loading-overlay');
    const loadingText = document.getElementById('loading-text');
    const channelName = document.getElementById('channel-name');
    const qualityButtons = document.getElementById('quality-buttons');
    const expiryNotice = document.getElementById('expiry-notice');
    const expiryText = document.getElementById('expiry-text');

    // Init on page load
    async function init() {
        // 1. Get session from localStorage
        const stored = localStorage.getItem(SESSION_KEY);
        if (!stored) {
            redirectToLanding('No session found');
            return;
        }

        sessionData = JSON.parse(stored);

        // 2. Validate session
        showLoading('Validating session...');
        try {
            const res = await fetch('/api/auth/session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_token: sessionData.session_token })
            });
            const result = await res.json();

            if (!result.valid) {
                localStorage.removeItem(SESSION_KEY);
                redirectToLanding(result.error || 'Session expired');
                return;
            }

            channelInfo = result;
        } catch (e) {
            redirectToLanding('Connection error');
            return;
        }

        // 3. Also check URL matches session's channel
        const urlToken = window.location.pathname.split('/player/')[1];
        if (urlToken && urlToken !== channelInfo.channel_token) {
            // Session belongs to different channel → redirect
            localStorage.removeItem(SESSION_KEY);
            redirectToLanding('Wrong channel');
            return;
        }

        // 4. Setup UI
        channelName.textContent = channelInfo.channel_name;

        // Show expiry notice if session expires within 30 minutes
        if (channelInfo.expires_at) {
            const expires = new Date(channelInfo.expires_at);
            const now = new Date();
            const diff = expires - now;
            if (diff < 30 * 60 * 1000 && diff > 0) {
                expiryNotice.classList.remove('hidden');
                expiryText.textContent = 'Access expires in ' + Math.ceil(diff / 60000) + ' minutes';
            }
        }

        // 5. Build quality buttons
        buildQualityButtons(channelInfo.qualities);

        // 6. Start streaming (default: first quality = lowest/safest)
        const defaultQuality = channelInfo.qualities.sort((a, b) => a.sort_order - b.sort_order)[0];
        startStream(defaultQuality.label);
    }

    // Build quality switcher buttons
    function buildQualityButtons(qualities) {
        const sorted = qualities.sort((a, b) => a.sort_order - b.sort_order);
        sorted.forEach(q => {
            const btn = document.createElement('button');
            btn.textContent = q.label.toUpperCase();
            btn.dataset.quality = q.label;
            btn.className = 'quality-btn';
            btn.addEventListener('click', () => switchQuality(q.label));
            qualityButtons.appendChild(btn);
        });
    }

    // Switch quality
    function switchQuality(newQuality) {
        if (newQuality === currentQuality) return;

        // Destroy current player
        if (mpegtsPlayer) {
            mpegtsPlayer.pause();
            mpegtsPlayer.unload();
            mpegtsPlayer.detachMediaElement();
            mpegtsPlayer.destroy();
            mpegtsPlayer = null;
        }

        // Update active button
        document.querySelectorAll('.quality-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.quality === newQuality);
        });

        // Start new stream
        startStream(newQuality);
    }

    // Start stream with mpegts.js
    function startStream(quality) {
        currentQuality = quality;

        // Construct stream URL
        const streamUrl = `/channel/${channelInfo.channel_token}/${quality}?session=${sessionData.session_token}`;

        showLoading(`Loading ${quality.toUpperCase()} stream...`);

        if (mpegtsjs.isSupported()) {
            mpegtsPlayer = mpegtsjs.createPlayer({
                type: 'mpegts',
                url: streamUrl,
                isLive: true
            }, {
                enableWorker: true,
                enableStashBuffer: false,
                stashInitialSize: 128,
                lazyLoad: false,
                lazyLoadMaxDuration: 3 * 60,
                autoCleanupSourceBuffer: true,
                autoCleanupMaxBackwardDuration: 3 * 60,
                autoCleanupMinBackwardDuration: 2 * 60
            });

            mpegtsPlayer.attachMediaElement(videoEl);
            mpegtsPlayer.load();
            mpegtsPlayer.play();

            mpegtsPlayer.on(mpegtsjs.Events.ERROR, (errorType, errorDetail, errorInfo) => {
                console.error('mpegts error:', errorType, errorDetail);
                // Auto-reconnect after 3s
                if (!reconnectTimer) {
                    reconnectTimer = setTimeout(() => {
                        reconnectTimer = null;
                        reconnectStream();
                    }, 3000);
                }
            });

            mpegtsPlayer.on(mpegtsjs.Events.LOADING_COMPLETE, () => {
                // Stream ended (shouldn't happen for live stream)
                reconnectStream();
            });

            // Hide loading when video starts playing
            videoEl.addEventListener('playing', () => {
                hideLoading();
            }, { once: true });

        } else {
            showError('Unsupported', 'Your browser does not support MPEG-TS playback.');
        }
    }

    // Reconnect stream
    function reconnectStream() {
        if (mpegtsPlayer) {
            mpegtsPlayer.pause();
            mpegtsPlayer.unload();
            mpegtsPlayer.detachMediaElement();
            mpegtsPlayer.destroy();
            mpegtsPlayer = null;
        }
        startStream(currentQuality);
    }

    // Show/hide overlays
    function showLoading(text) {
        loadingOverlay.classList.remove('hidden');
        loadingText.textContent = text;
    }

    function hideLoading() {
        loadingOverlay.classList.add('hidden');
    }

    function showError(title, desc) {
        errorOverlay.classList.remove('hidden');
        loadingOverlay.classList.add('hidden');
        errorTitle.textContent = title;
        errorDesc.textContent = desc;
    }

    function redirectToLanding(reason) {
        showError('Access Denied', reason);
        errorBtn.onclick = () => {
            localStorage.removeItem(SESSION_KEY);
            window.location.href = '/';
        };
    }

    // Init
    init();
})();
```

**Additional CSS for player (add to `public/css/style.css`):**

```css
/* Player page */
#player-app {
    min-height: 100vh;
    background: #000;
}

#video-container {
    position: relative;
    width: 100%;
    max-width: 100vw;
    height: 100vh;
    overflow: hidden;
}

#video-player {
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: #000;
}

#quality-bar {
    position: absolute;
    bottom: 60px;
    right: 16px;
    display: flex;
    align-items: center;
    gap: 12px;
    background: rgba(0, 0, 0, 0.7);
    padding: 8px 16px;
    border-radius: var(--radius);
    z-index: 10;
}

#channel-name {
    color: var(--text-primary);
    font-weight: 600;
    font-size: 0.9rem;
}

.quality-btn {
    padding: 4px 12px;
    font-size: 0.8rem;
    background: var(--bg-secondary);
    color: var(--text-secondary);
    border: 1px solid var(--border);
    border-radius: 4px;
    cursor: pointer;
    font-weight: 600;
}

.quality-btn.active {
    background: var(--accent);
    color: white;
    border-color: var(--accent);
}

.quality-btn:hover {
    background: var(--accent-hover);
    color: white;
}

#expiry-notice {
    position: absolute;
    top: 16px;
    right: 16px;
    background: rgba(231, 76, 60, 0.8);
    color: white;
    padding: 8px 16px;
    border-radius: var(--radius);
    font-size: 0.85rem;
    z-index: 10;
}

#error-overlay, #loading-overlay {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.85);
    z-index: 20;
}

.error-content {
    text-align: center;
}

.error-content h2 {
    font-size: 1.5rem;
    color: var(--error);
    margin-bottom: 8px;
}

.error-content p {
    color: var(--text-secondary);
    margin-bottom: 24px;
}

#error-btn {
    padding: 12px 24px;
    background: var(--accent);
    color: white;
    border: none;
    border-radius: var(--radius);
    cursor: pointer;
    font-size: 1rem;
}
```

## Verify

1. Start server: `node server.js`
2. Create a test channel + code via admin API:
```bash
curl.exe -s -X POST -H "X-Admin-Secret: ChatrixAdmin2026SecretKey32Chars!" -H "Content-Type: application/json" -d "{\"name\":\"TestChannel\",\"code_ttl_hours\":6}" http://localhost:3000/api/admin/channels
```
3. Add quality:
```bash
# Replace CHANNEL_ID with the id from step 2
curl.exe -s -X POST -H "X-Admin-Secret: ChatrixAdmin2026SecretKey32Chars!" -H "Content-Type: application/json" -d "{\"quality_label\":\"sd\",\"stream_url\":\"http://ugeen.live:8080/Ugeen_VIP9sfo1g/GGzZy1/3019\"}" http://localhost:3000/api/admin/channels/CHANNEL_ID/qualities
```
4. Generate code:
```bash
curl.exe -s -X POST -H "X-Admin-Secret: ChatrixAdmin2026SecretKey32Chars!" -H "Content-Type: application/json" -d "{\"count\":1}" http://localhost:3000/api/admin/channels/CHANNEL_ID/codes
```
5. Open `http://localhost:3000` in browser → enter the code → should redirect to player → stream should start playing
6. Quality switcher should show "SD" button (active) → click it stays on SD (only one quality for now)
7. Close browser → reopen → should auto-login to player

## Next step
→ `steps/11-admin-dashboard.md`
