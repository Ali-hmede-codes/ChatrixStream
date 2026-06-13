(function() {
    const SESSION_KEY = 'chatrix_session';

    let sessionData = null;
    let channelInfo = null;
    let currentQuality = null;
    let hlsPlayer = null;
    let reconnectTimer = null;
    let reconnectBackoff = 2000;
    let maxReconnectBackoff = 15000;
    let sseConnection = null;
    let useNativeHls = false;
    let nativeRetryCount = 0;
    let maxNativeRetries = 30;
    let userUnmuted = false;
    let isWarmingUp = false;
    let tapToPlayPending = false;
    let pendingQuality = null;
    let iosStreamGeneration = 0;
    let wasPlayingBeforeHidden = false;
    let isQualitySwitching = false;
    let consecutiveMediaErrors = 0;
    let sessionCheckInterval = null;
    let sessionExpired = false;

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
    const tapToPlayOverlay = document.getElementById('tap-to-play-overlay');

    function isIOS() {
        return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
               (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    }

    function isSafari() {
        return /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    }

    function shouldUseNativeHls() {
        if (isIOS()) return true;
        var v = document.createElement('video');
        return v.canPlayType('application/vnd.apple.mpegurl') === 'probably' ||
               v.canPlayType('application/x-mpegURL') === 'probably';
    }

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
        startSessionCheck();

        // Pre-warm all qualities: start FFmpeg processes for all qualities
        // so quality switching is instant
        prewarmAllQualities();

        const defaultQuality = channelInfo.qualities.sort((a, b) => a.sort_order - b.sort_order)[0];
        startStream(defaultQuality.label);
    }

    function prewarmAllQualities() {
        if (!channelInfo || !channelInfo.qualities) return;

        // Use the warmup endpoint to start FFmpeg for all qualities at once
        fetch('/hls/' + channelInfo.channel_token + '/warmup?session=' + encodeURIComponent(sessionData.session_token), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-session-token': sessionData.session_token
            }
        }).catch(function() {
            // Fallback: warm up each quality individually via manifest requests
            channelInfo.qualities.forEach(function(q) {
                fetch(getHlsUrl(q.label), {
                    headers: { 'x-session-token': sessionData.session_token }
                }).catch(function() {});
            });
        });

        isWarmingUp = true;
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

        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        reconnectBackoff = 2000;

        document.querySelectorAll('.quality-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.quality === newQuality);
        });

        currentQuality = newQuality;
        showLoading('Loading ' + newQuality.toUpperCase() + ' stream...');

        if (useNativeHls) {
            if (currentNativeCleanup) {
                currentNativeCleanup();
                currentNativeCleanup = null;
            }
            nativeRetryCount = 0;
            nativeHasPlayed = false;
            isQualitySwitching = true;
            // User clicked a quality button = user gesture context preserved.
            // Call startNativeStreamDirect directly so play() is called
            // synchronously within the click handler (required by iOS).
            // Pre-warming ensures manifest is likely ready already.
            // If manifest is NOT ready, the error handler will quickly
            // fall back to startIOSStream for proper manifest polling.
            startNativeStreamDirect(newQuality, true);
        } else if (hlsPlayer) {
            // Full destroy + recreate to reset audio decoder pipeline.
            // Just calling loadSource() can leave stale audio codec state
            // from the previous quality, causing pitch distortion (deep voice).
            hlsPlayer.destroy();
            hlsPlayer = null;
            startStream(newQuality);
        }
    }

    var nativeHasPlayed = false;
    var currentNativeCleanup = null;

    function destroyPlayer() {
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        if (currentNativeCleanup) {
            currentNativeCleanup();
            currentNativeCleanup = null;
        }
        nativeRetryCount = 0;
        reconnectBackoff = 2000;

        if (hlsPlayer) {
            hlsPlayer.destroy();
            hlsPlayer = null;
        }

        // Always clear video source and reset, regardless of player type
        videoEl.removeAttribute('src');
        videoEl.load();
        videoEl.pause();

        // Clear currentQuality so auto-resume mechanisms don't try to restart
        currentQuality = null;
    }

    function tryUnmute() {
        videoEl.muted = false;
        userUnmuted = true;
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

    // Tap-to-play handler for iOS
    // CRITICAL: Must call startNativeStreamDirect synchronously here.
    // iOS Safari requires play() to be in the user's tap gesture context.
    // Any async operation between the tap and play() breaks the gesture chain
    // and causes iOS to block playback.
    tapToPlayOverlay.addEventListener('click', function() {
        tapToPlayOverlay.classList.add('hidden');
        tapToPlayPending = false;
        if (pendingQuality) {
            var q = pendingQuality;
            pendingQuality = null;
            startNativeStreamDirect(q, true);
        }
    });

    function getHlsUrl(quality) {
        return window.location.origin + '/hls/' + channelInfo.channel_token + '/' + quality + '/index.m3u8?session=' + sessionData.session_token;
    }

    function startStream(quality) {
        currentQuality = quality;
        showLoading('Loading ' + quality.toUpperCase() + ' stream...');

        if (shouldUseNativeHls()) {
            useNativeHls = true;
            nativeRetryCount = 0;
            startNativeStream(quality);

        } else if (typeof Hls !== 'undefined' && Hls.isSupported()) {
            useNativeHls = false;

            var hlsUrl = getHlsUrl(quality);

            hlsPlayer = new Hls({
                liveSyncDurationCount: 3,
                liveMaxLatencyDurationCount: 9,
                liveDurationInfinity: true,
                liveSyncOnStall: true,
                maxBufferLength: 30,
                maxMaxBufferLength: 60,
                maxBufferSize: 60 * 1000 * 1000,
                maxBufferHole: 0.5,
                lowLatencyMode: false,
                enableWorker: true,
                backBufferLength: 90,
                progressive: true,
                startLevel: -1,
                manifestLoadingRetryDelay: 1000,
                manifestLoadingMaxRetry: 15,
                manifestLoadingMaxRetryTimeout: 60000,
                levelLoadingRetryDelay: 1000,
                levelLoadingMaxRetry: 15,
                levelLoadingMaxRetryTimeout: 60000,
                fragLoadingRetryDelay: 1000,
                fragLoadingMaxRetry: 10,
                fragLoadingMaxRetryTimeout: 60000,
                xhrSetup: function(xhr, url) {
                    xhr.setRequestHeader('x-session-token', sessionData.session_token);
                }
            });

            videoEl.muted = !userUnmuted;
            hlsPlayer.loadSource(hlsUrl);
            hlsPlayer.attachMedia(videoEl);

            hlsPlayer.on(Hls.Events.MANIFEST_PARSED, function() {
                videoEl.play().catch(function() {});
            });

            hlsPlayer.on(Hls.Events.ERROR, function(event, data) {
                console.error('HLS error:', data.type, data.details, data);

                // Check if the error is a 403 (session/channel expired) - stop retrying
                if (data.details === 'manifestLoadError' || data.details === 'levelLoadError' || data.details === 'fragLoadError') {
                    var response = data.response || data.context && data.context.response;
                    if (response && (response.code === 403 || response.status === 403)) {
                        console.warn('HLS 403 error - session expired, stopping player');
                        handleSessionExpired('Session expired');
                        return;
                    }
                }

                // Also check via sessionExpired flag
                if (sessionExpired) return;

                if (data.fatal) {
                    switch (data.type) {
                        case Hls.ErrorTypes.NETWORK_ERROR:
                            consecutiveMediaErrors = 0;
                            console.warn('Fatal network error, reconnecting with backoff...');
                            scheduleReconnect();
                            break;
                        case Hls.ErrorTypes.MEDIA_ERROR:
                            consecutiveMediaErrors++;
                            if (consecutiveMediaErrors <= 1) {
                                // First attempt: try quick recovery
                                console.warn('Fatal media error, attempting recovery...');
                                hlsPlayer.recoverMediaError();
                            } else {
                                // Repeated media errors = audio decoder stuck with wrong pitch.
                                // recoverMediaError() doesn't fully reset the audio pipeline.
                                // Do a full source reload to reinitialize everything.
                                console.warn('Repeated media error (' + consecutiveMediaErrors + '), doing full source reload...');
                                consecutiveMediaErrors = 0;
                                destroyPlayer();
                                startStream(currentQuality);
                            }
                            break;
                        default:
                            consecutiveMediaErrors = 0;
                            console.error('Fatal error, cannot recover');
                            destroyPlayer();
                            showError('Stream Error', 'An unrecoverable error occurred. Please try again.');
                            break;
                    }
                } else {
                    // Non-fatal: reset counter on successful operation
                    if (data.details !== 'manifestLoadError' && data.details !== 'levelLoadError') {
                        consecutiveMediaErrors = 0;
                    }
                    if (data.details === 'manifestLoadError' || data.details === 'levelLoadError') {
                        showLoading('Stream starting, waiting...');
                    }
                }
            });

            videoEl.addEventListener('playing', function() {
                hideLoading();
                if (videoEl.muted) {
                    unmuteBtn.classList.remove('hidden');
                }
            }, { once: false });

            videoEl.addEventListener('waiting', function() {
                showLoading('Buffering...');
            });

        } else if (canPlayHlsNatively()) {
            useNativeHls = true;
            nativeRetryCount = 0;
            startNativeStream(quality);

        } else {
            showError('Unsupported', 'Your browser does not support HLS playback.');
        }
    }

    function startNativeStream(quality) {
        // On iOS, we need to check manifest readiness BEFORE showing the
        // tap-to-play overlay, so that when the user taps, we can call
        // play() synchronously without any async delay (preserving gesture context).
        if (isIOS() || isSafari()) {
            startIOSStream(quality);
        } else {
            startNativeStreamDirect(quality);
        }
    }

    async function startIOSStream(quality) {
        var generation = ++iosStreamGeneration;

        if (currentNativeCleanup) {
            currentNativeCleanup();
            currentNativeCleanup = null;
        }

        nativeHasPlayed = false;
        pendingQuality = quality;

        showLoading('Preparing stream...');

        // Check manifest readiness BEFORE showing tap-to-play overlay.
        // CRITICAL for iOS: The manifest must be verified BEFORE the user taps,
        // so that when they do tap, we can call play() SYNCHRONOUSLY without
        // any async delay. iOS Safari requires play() to be called within the
        // same synchronous execution context as the user's tap gesture. Any
        // await/setTimeout between the tap and play() breaks the gesture chain,
        // causing iOS to block playback entirely.
        var maxAttempts = 30;
        var attempt = 0;
        var checkInterval = 1500;

        while (attempt < maxAttempts) {
            attempt++;
            try {
                var readyResp = await fetch(
                    '/hls/' + channelInfo.channel_token + '/manifest-ready/' + quality + '?session=' + encodeURIComponent(sessionData.session_token),
                    { headers: { 'x-session-token': sessionData.session_token } }
                );
                var readyData = await readyResp.json();

                if (readyData.ready) {
                    break;
                }
            } catch (e) {
                // Network error, keep trying
            }

            // Check if a newer stream request superseded us
            if (generation !== iosStreamGeneration) return;

            if (attempt >= maxAttempts) {
                showError('Stream Error', 'Stream failed to start. Please try again.');
                errorBtn.textContent = 'Retry';
                errorBtn.onclick = function() {
                    errorOverlay.classList.add('hidden');
                    errorBtn.textContent = 'Get New Code';
                    errorBtn.onclick = function() { window.location.href = '/'; };
                    startStream(currentQuality);
                };
                return;
            }

            showLoading('Preparing stream... (' + attempt + '/' + maxAttempts + ')');
            await new Promise(function(resolve) { setTimeout(resolve, checkInterval); });
        }

        // Check if superseded by a newer request
        if (generation !== iosStreamGeneration) return;

        // Manifest is ready. Show tap-to-play overlay.
        // When the user taps, startNativeStreamDirect will be called
        // synchronously, preserving the iOS user gesture context for play().
        tapToPlayOverlay.classList.remove('hidden');
        tapToPlayPending = true;
        hideLoading();
    }

    function startNativeStreamDirect(quality, manifestIsReady) {
        if (currentNativeCleanup) {
            currentNativeCleanup();
            currentNativeCleanup = null;
        }

        var hlsUrl = getHlsUrl(quality);

        videoEl.muted = !userUnmuted;
        nativeHasPlayed = false;
        if (manifestIsReady) {
            showLoading('Starting playback...');
        } else {
            showLoading('Loading ' + quality.toUpperCase() + ' stream...');
        }

        videoEl.src = hlsUrl;

        var playPromise = videoEl.play();
        if (playPromise !== undefined) {
            playPromise.then(function() {
                tapToPlayOverlay.classList.add('hidden');
                tapToPlayPending = false;
                if (!videoEl.muted) {
                    unmuteBtn.classList.add('hidden');
                }
            }).catch(function(err) {
                // Autoplay was blocked - show tap-to-play on iOS
                if (isIOS() || isSafari()) {
                    tapToPlayOverlay.classList.remove('hidden');
                    tapToPlayPending = true;
                    pendingQuality = quality;
                    hideLoading();
                } else {
                    if (userUnmuted) {
                        videoEl.muted = true;
                        unmuteBtn.classList.remove('hidden');
                        videoEl.play().catch(function() {});
                    } else {
                        unmuteBtn.classList.remove('hidden');
                    }
                }
            });
        }

        var loadingHidden = false;
        var nativeStallCount = 0;
        var maxNativeStalls = 5;

        function tryHideLoading() {
            if (!loadingHidden) {
                loadingHidden = true;
                hideLoading();
                nativeHasPlayed = true;
                nativeStallCount = 0;
                isQualitySwitching = false;
                tapToPlayOverlay.classList.add('hidden');
                tapToPlayPending = false;
                if (videoEl.muted) {
                    unmuteBtn.classList.remove('hidden');
                }
            }
        }

        function onCanPlay() { tryHideLoading(); }
        function onPlaying() { tryHideLoading(); }
        function onTimeUpdate() {
            if (videoEl.currentTime > 0) tryHideLoading();
        }
        function onWaiting() {
            if (!nativeHasPlayed) showLoading('Buffering...');
        }
        function onStalled() {
            // Don't count stalls during fullscreen transitions
            if (isFullscreenTransition) return;
            nativeStallCount++;
            if (nativeStallCount > maxNativeStalls && nativeHasPlayed) {
                console.warn('Native HLS stalled too many times, reconnecting...');
                reconnectNativeStream(quality);
            } else if (!nativeHasPlayed) {
                showLoading('Buffering...');
            }
        }
        function onEnded() {
            if (nativeHasPlayed) {
                console.warn('Native HLS live stream ended unexpectedly, reconnecting...');
                reconnectNativeStream(quality);
            }
        }
        function onError() {
            nativeRetryCount++;

            // If this error is from a quality switch on iOS/Safari,
            // skip the long retry loop and immediately fall back to
            // startIOSStream which properly polls for manifest readiness.
            // This avoids the "1/30 ... 30/30" retry countdown UX.
            if (isQualitySwitching && (isIOS() || isSafari())) {
                isQualitySwitching = false;
                nativeRetryCount = 0;
                currentNativeCleanup();
                currentNativeCleanup = null;
                videoEl.removeAttribute('src');
                videoEl.load();
                console.log('Quality switch failed, falling back to manifest polling...');
                startIOSStream(quality);
                return;
            }

            if (nativeRetryCount <= maxNativeRetries) {
                console.warn('Native HLS error, retrying... (' + nativeRetryCount + '/' + maxNativeRetries + ')');
                currentNativeCleanup();
                currentNativeCleanup = null;
                showLoading('Stream starting...');
                var delay = Math.min(2000 * nativeRetryCount, 30000);
                reconnectTimer = setTimeout(function() {
                    reconnectTimer = null;
                    videoEl.removeAttribute('src');
                    videoEl.load();
                    // On iOS, use startIOSStream which checks manifest
                    // and shows tap-to-play (preserving gesture context)
                    if (isIOS() || isSafari()) {
                        startIOSStream(quality);
                    } else {
                        startNativeStreamDirect(quality);
                    }
                }, delay);
            } else {
                showError('Stream Error', 'Failed to start the stream. Please try again later.');
                errorBtn.textContent = 'Retry';
                errorBtn.onclick = function() {
                    errorOverlay.classList.add('hidden');
                    errorBtn.textContent = 'Get New Code';
                    errorBtn.onclick = function() { window.location.href = '/'; };
                    startStream(currentQuality);
                };
            }
        }

        videoEl.addEventListener('canplay', onCanPlay);
        videoEl.addEventListener('canplaythrough', onCanPlay);
        videoEl.addEventListener('loadeddata', onCanPlay);
        videoEl.addEventListener('playing', onPlaying);
        videoEl.addEventListener('timeupdate', onTimeUpdate);
        videoEl.addEventListener('waiting', onWaiting);
        videoEl.addEventListener('stalled', onStalled);
        videoEl.addEventListener('ended', onEnded);
        videoEl.addEventListener('error', onError);

        currentNativeCleanup = function() {
            videoEl.removeEventListener('canplay', onCanPlay);
            videoEl.removeEventListener('canplaythrough', onCanPlay);
            videoEl.removeEventListener('loadeddata', onCanPlay);
            videoEl.removeEventListener('playing', onPlaying);
            videoEl.removeEventListener('timeupdate', onTimeUpdate);
            videoEl.removeEventListener('waiting', onWaiting);
            videoEl.removeEventListener('stalled', onStalled);
            videoEl.removeEventListener('ended', onEnded);
            videoEl.removeEventListener('error', onError);
        };
    }

    function reconnectNativeStream(quality) {
        if (currentNativeCleanup) {
            currentNativeCleanup();
            currentNativeCleanup = null;
        }
        showLoading('Reconnecting...');
        videoEl.removeAttribute('src');
        videoEl.load();
        reconnectTimer = setTimeout(function() {
            reconnectTimer = null;
            if (isIOS() || isSafari()) {
                startIOSStream(quality);
            } else {
                startNativeStreamDirect(quality);
            }
        }, 3000);
    }

    function scheduleReconnect() {
        if (reconnectTimer) return;
        if (sessionExpired) return;

        destroyPlayer();
        showLoading('Reconnecting...');
        reconnectTimer = setTimeout(function() {
            reconnectTimer = null;
            startStream(currentQuality);
        }, reconnectBackoff);

        reconnectBackoff = Math.min(reconnectBackoff * 1.5, maxReconnectBackoff);
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
        tapToPlayOverlay.classList.add('hidden');
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
            handleSessionExpired(data.error || 'Your access has expired. Please enter a new invite code.');
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
                if (sessionData && !sessionExpired) connectSSE();
            }, 5000);
        };
    }

    function startSessionCheck() {
        // Independent periodic session validation (fallback if SSE drops)
        // Checks every 30 seconds if the session is still valid
        if (sessionCheckInterval) clearInterval(sessionCheckInterval);
        sessionCheckInterval = setInterval(function() {
            if (!sessionData || sessionExpired) return;
            fetch('/api/auth/session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_token: sessionData.session_token })
            }).then(function(res) { return res.json(); }).then(function(result) {
                if (!result.valid) {
                    handleSessionExpired(result.error || 'Session expired');
                }
            }).catch(function() {
                // Network error - don't kill the session, SSE will handle it
            });
        }, 30000);
    }

    function handleSessionExpired(reason) {
        if (sessionExpired) return; // Already handled
        sessionExpired = true;

        localStorage.removeItem(SESSION_KEY);
        destroyPlayer();
        showError('Session Expired', reason || 'Your access has expired. Please enter a new invite code.');
        errorBtn.onclick = function() {
            window.location.href = '/';
        };

        if (sseConnection) {
            sseConnection.close();
            sseConnection = null;
        }
        if (sessionCheckInterval) {
            clearInterval(sessionCheckInterval);
            sessionCheckInterval = null;
        }
    }

    var isFullscreenTransition = false;

    function toggleFullscreen() {
        if (document.fullscreenElement || document.webkitFullscreenElement) {
            isFullscreenTransition = true;
            if (document.exitFullscreen) {
                document.exitFullscreen();
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            }
        } else if (videoEl.webkitEnterFullscreen) {
            // iOS-specific: puts the video element itself fullscreen
            // Exiting this always pauses the video on iOS
            isFullscreenTransition = true;
            videoEl.webkitEnterFullscreen();
        } else if (videoContainer.requestFullscreen) {
            videoContainer.requestFullscreen();
        } else if (videoContainer.webkitRequestFullscreen) {
            videoContainer.webkitRequestFullscreen();
        }
    }

    function updateFullscreenIcon() {
        if (document.fullscreenElement || document.webkitFullscreenElement) {
            fullscreenBtn.innerHTML = '&#x2716;';
            fullscreenBtn.title = 'Exit Fullscreen';
        } else {
            fullscreenBtn.innerHTML = '&#x26F6;';
            fullscreenBtn.title = 'Fullscreen';
        }
    }

    function handleFullscreenChange() {
        updateFullscreenIcon();

        // When exiting fullscreen, resume playback if it was paused by the browser
        var isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
        if (!isFullscreen && isFullscreenTransition) {
            isFullscreenTransition = false;
            // Give the browser a moment to settle after fullscreen exit
            setTimeout(function() {
                resumeIfPaused();
            }, 300);
        }
    }

    function resumeIfPaused() {
        if (sessionExpired) return;
        if (!videoEl.paused) return;
        if (!currentQuality) return;
        if (errorOverlay && !errorOverlay.classList.contains('hidden')) return;

        console.log('Video paused unexpectedly, attempting to resume...');
        var playPromise = videoEl.play();
        if (playPromise !== undefined) {
            playPromise.catch(function() {
                // Autoplay blocked (iOS) - try muted
                if (!videoEl.muted) {
                    videoEl.muted = true;
                    unmuteBtn.classList.remove('hidden');
                    videoEl.play().catch(function() {});
                }
            });
        }
    }

    // Handle iOS video-element fullscreen exit (webkitEndFullscreen)
    videoEl.addEventListener('webkitendfullscreen', function() {
        isFullscreenTransition = false;
        setTimeout(function() {
            resumeIfPaused();
        }, 300);
    });

    // Also handle the pause event - resume if it wasn't user-initiated
    videoEl.addEventListener('pause', function() {
        if (sessionExpired) return;
        // Don't auto-resume if we're destroying the player or in error state
        if (!currentQuality) return;
        if (errorOverlay && !errorOverlay.classList.contains('hidden')) return;
        if (loadingOverlay && !loadingOverlay.classList.contains('hidden')) return;

        // Small delay to distinguish user-initiated pause from browser-initiated
        setTimeout(function() {
            // If still paused and not in a loading/error state, try to resume
            if (videoEl.paused && currentQuality) {
                resumeIfPaused();
            }
        }, 500);
    });

    fullscreenBtn.addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);

    videoContainer.addEventListener('dblclick', toggleFullscreen);

    // Handle page visibility changes (Safari/iOS background and reopen)
    // When Safari sends the page to the background, the video gets paused
    // and the audio pipeline can die. When the user returns, we need to
    // detect stalled playback and reload the source to re-initialize audio.
    document.addEventListener('visibilitychange', function() {
        if (document.visibilityState === 'hidden') {
            wasPlayingBeforeHidden = !videoEl.paused && !videoEl.ended;
        } else if (document.visibilityState === 'visible') {
            handleVisibilityRestore();
        }
    });

    // Handle Safari back-forward cache restoration
    window.addEventListener('pageshow', function(event) {
        if (event.persisted) {
            handleVisibilityRestore();
        }
    });

    function handleVisibilityRestore() {
        if (sessionExpired) return;
        if (!currentQuality) return;
        if (errorOverlay && !errorOverlay.classList.contains('hidden')) return;

        setTimeout(function() {
            if (videoEl.paused && wasPlayingBeforeHidden) {
                // Video was paused while in background, try to resume
                var playPromise = videoEl.play();
                if (playPromise !== undefined) {
                    playPromise.catch(function() {
                        // Autoplay blocked after background - try muted
                        if (!videoEl.muted) {
                            videoEl.muted = true;
                            unmuteBtn.classList.remove('hidden');
                            videoEl.play().catch(function() {});
                        }
                    });
                }
            }

            // On iOS/Safari, after returning from background the audio pipeline
            // or stream connection can be dead even if video appears to play.
            // Check if the stream is actually progressing.
            if ((isIOS() || isSafari()) && wasPlayingBeforeHidden) {
                var checkTime = videoEl.currentTime;
                setTimeout(function() {
                    // If time hasn't advanced in 3 seconds, the stream is stale
                    // and likely has no audio. Reload the source to fix it.
                    if (Math.abs(videoEl.currentTime - checkTime) < 0.5 && !videoEl.paused) {
                        console.log('Stream stalled after returning from background, reloading...');
                        reloadCurrentStream();
                    } else if (videoEl.paused && wasPlayingBeforeHidden) {
                        // Video didn't resume - reload source entirely
                        console.log('Video did not resume after background, reloading...');
                        reloadCurrentStream();
                    }
                }, 3000);
            }
        }, 500);
    }

    function reloadCurrentStream() {
        if (sessionExpired) return;
        if (!currentQuality) return;

        if (useNativeHls) {
            if (currentNativeCleanup) {
                currentNativeCleanup();
                currentNativeCleanup = null;
            }
            nativeRetryCount = 0;
            nativeHasPlayed = false;
            isQualitySwitching = false;

            // Reload the video source entirely to re-initialize
            // the audio/video pipeline after background restore
            startNativeStreamDirect(currentQuality);
        } else if (hlsPlayer) {
            // Full destroy + recreate to reset audio/video pipeline after
            // background restore or stale stream detection.
            // loadSource() alone can leave stale audio codec state.
            hlsPlayer.destroy();
            hlsPlayer = null;
            startStream(currentQuality);
        }
    }

    init();
})();
