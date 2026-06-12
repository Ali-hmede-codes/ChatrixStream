(function() {
    const SESSION_KEY = 'chatrix_session';

    let sessionData = null;
    let channelInfo = null;
    let currentQuality = null;
    let mpegtsPlayer = null;
    let reconnectTimer = null;
    let sseConnection = null;
    let useNativeHls = false;

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
    const fullscreenBtn = document.getElementById('fullscreen-btn');
    const videoContainer = document.getElementById('video-container');
    const unmuteBtn = document.getElementById('unmute-btn');

    function canPlayHlsNatively() {
        var v = document.createElement('video');
        return v.canPlayType('application/vnd.apple.mpegurl') !== '' ||
               v.canPlayType('application/x-mpegURL') !== '';
    }

    async function init() {
        const stored = localStorage.getItem(SESSION_KEY);
        if (!stored) {
            redirectToLanding('No session found');
            return;
        }

        sessionData = JSON.parse(stored);

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

        const urlToken = window.location.pathname.split('/player/')[1];
        if (urlToken && urlToken !== channelInfo.channel_token) {
            localStorage.removeItem(SESSION_KEY);
            redirectToLanding('Wrong channel');
            return;
        }

        channelName.textContent = channelInfo.channel_name;

        if (channelInfo.expires_at) {
            const expires = new Date(channelInfo.expires_at);
            const now = new Date();
            const diff = expires - now;
            if (diff < 30 * 60 * 1000 && diff > 0) {
                expiryNotice.classList.remove('hidden');
                expiryText.textContent = 'Access expires in ' + Math.ceil(diff / 60000) + ' minutes';
            }
        }

        buildQualityButtons(channelInfo.qualities);

        connectSSE();

        const defaultQuality = channelInfo.qualities.sort((a, b) => a.sort_order - b.sort_order)[0];
        startStream(defaultQuality.label);
    }

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

    function switchQuality(newQuality) {
        if (newQuality === currentQuality) return;

        if (mpegtsPlayer) {
            mpegtsPlayer.pause();
            mpegtsPlayer.unload();
            mpegtsPlayer.detachMediaElement();
            mpegtsPlayer.destroy();
            mpegtsPlayer = null;
        }

        if (useNativeHls) {
            videoEl.removeAttribute('src');
            videoEl.load();
        }

        document.querySelectorAll('.quality-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.quality === newQuality);
        });

        startStream(newQuality);
    }

    function tryUnmute() {
        videoEl.muted = false;
        var playPromise = videoEl.play();
        if (playPromise !== undefined) {
            playPromise.then(function() {
                unmuteBtn.classList.add('hidden');
            }).catch(function() {
                videoEl.muted = true;
                unmuteBtn.classList.remove('hidden');
                videoEl.play();
            });
        } else {
            if (!videoEl.muted) {
                unmuteBtn.classList.add('hidden');
            }
        }
    }

    unmuteBtn.addEventListener('click', tryUnmute);

    videoContainer.addEventListener('click', function(e) {
        if (e.target === videoEl && videoEl.muted) {
            tryUnmute();
        }
    });

    function startStream(quality) {
        currentQuality = quality;

        showLoading('Loading ' + quality.toUpperCase() + ' stream...');

        if (mpegts.isSupported()) {
            useNativeHls = false;

            var streamUrl = window.location.origin + '/channel/' + channelInfo.channel_token + '/' + quality + '?session=' + sessionData.session_token;

            mpegtsPlayer = mpegts.createPlayer({
                type: 'mpegts',
                url: streamUrl,
                isLive: true
            }, {
                enableWorker: true,
                enableStashBuffer: true,
                stashInitialSize: 1024 * 384,
                lazyLoad: true,
                lazyLoadMaxDuration: 3 * 60,
                lazyLoadRecoverDuration: 30,
                autoCleanupSourceBuffer: true,
                autoCleanupMaxBackwardDuration: 3 * 60,
                autoCleanupMinBackwardDuration: 2 * 60,
                liveBufferLatencyChasing: true,
                liveBufferLatencyChasingOnPaused: true,
                liveSyncMaxLatency: 12,
                liveMaxLatencyDuration: 30
            });

            mpegtsPlayer.attachMediaElement(videoEl);
            mpegtsPlayer.load();
            mpegtsPlayer.play();

            mpegtsPlayer.on(mpegts.Events.ERROR, function(errorType, errorDetail, errorInfo) {
                console.error('mpegts error:', errorType, errorDetail, errorInfo);
                if (errorType === mpegts.ErrorTypes.NETWORK_ERROR) {
                    if (!reconnectTimer) {
                        reconnectTimer = setTimeout(function() {
                            reconnectTimer = null;
                            reconnectStream();
                        }, 5000);
                    }
                } else if (errorType === mpegts.ErrorTypes.MEDIA_ERROR) {
                    console.warn('Media error, attempting recovery...');
                }
            });

            videoEl.addEventListener('playing', function() {
                hideLoading();
                if (videoEl.muted) {
                    tryUnmute();
                }
            }, { once: false });

        } else if (canPlayHlsNatively()) {
            useNativeHls = true;

            var hlsUrl = window.location.origin + '/hls/' + channelInfo.channel_token + '/' + quality + '/index.m3u8?session=' + sessionData.session_token;
            videoEl.src = hlsUrl;
            videoEl.play();

            videoEl.addEventListener('loadeddata', function onLoaded() {
                hideLoading();
                if (videoEl.muted) {
                    tryUnmute();
                }
                videoEl.removeEventListener('loadeddata', onLoaded);
            });

            videoEl.addEventListener('error', function onError() {
                showError('Stream Error', 'Failed to load the stream. The server may need ffmpeg installed for HLS conversion.');
                videoEl.removeEventListener('error', onError);
            });

            videoEl.addEventListener('waiting', function() {
                showLoading('Buffering...');
            });

            videoEl.addEventListener('playing', function onPlaying() {
                hideLoading();
                videoEl.removeEventListener('playing', onPlaying);
            });

        } else {
            showError('Unsupported', 'Your browser does not support MPEG-TS or HLS playback.');
        }
    }

    function reconnectStream() {
        if (mpegtsPlayer) {
            mpegtsPlayer.pause();
            mpegtsPlayer.unload();
            mpegtsPlayer.detachMediaElement();
            mpegtsPlayer.destroy();
            mpegtsPlayer = null;
        }

        if (useNativeHls) {
            videoEl.removeAttribute('src');
            videoEl.load();
        }

        startStream(currentQuality);
    }

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
        errorBtn.onclick = function() {
            localStorage.removeItem(SESSION_KEY);
            window.location.href = '/';
        };
    }

    function connectSSE() {
        if (sseConnection) {
            sseConnection.close();
            sseConnection = null;
        }

        var sseUrl = '/api/auth/sse/events?session=' + encodeURIComponent(sessionData.session_token);
        sseConnection = new EventSource(sseUrl);

        sseConnection.addEventListener('session_expired', function(e) {
            var data = JSON.parse(e.data);
            localStorage.removeItem(SESSION_KEY);
            if (mpegtsPlayer) {
                mpegtsPlayer.pause();
                mpegtsPlayer.unload();
                mpegtsPlayer.detachMediaElement();
                mpegtsPlayer.destroy();
                mpegtsPlayer = null;
            }
            if (useNativeHls) {
                videoEl.removeAttribute('src');
                videoEl.load();
            }
            showError('Session Expired', data.error || 'Your access has expired. Please enter a new invite code.');
            errorBtn.onclick = function() {
                window.location.href = '/';
            };
            sseConnection.close();
            sseConnection = null;
        });

        sseConnection.addEventListener('expiring_soon', function(e) {
            var data = JSON.parse(e.data);
            expiryNotice.classList.remove('hidden');
            expiryText.textContent = 'Access expires in ' + data.remaining_minutes + ' minutes';
        });

        sseConnection.addEventListener('heartbeat', function() {});

        sseConnection.onerror = function() {
            if (sseConnection) {
                sseConnection.close();
                sseConnection = null;
            }
            setTimeout(function() {
                if (sessionData) connectSSE();
            }, 5000);
        };
    }

    function toggleFullscreen() {
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            videoContainer.requestFullscreen();
        }
    }

    function updateFullscreenIcon() {
        if (document.fullscreenElement) {
            fullscreenBtn.innerHTML = '&#x2716;';
            fullscreenBtn.title = 'Exit Fullscreen';
        } else {
            fullscreenBtn.innerHTML = '&#x26F6;';
            fullscreenBtn.title = 'Fullscreen';
        }
    }

    fullscreenBtn.addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', updateFullscreenIcon);

    videoContainer.addEventListener('dblclick', toggleFullscreen);

    init();
})();
