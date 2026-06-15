(function() {
    const SESSION_KEY = 'chatrix_session';

    let sessionData = null;
    let channelInfo = null;
    let currentQuality = null;
    let vjsPlayer = null;
    let reconnectTimer = null;
    let reconnectBackoff = 2000;
    let maxReconnectBackoff = 15000;
    let sseConnection = null;
    let userUnmuted = false;
    let isWarmingUp = false;
    let consecutiveNetworkErrors = 0;
    let sessionCheckInterval = null;
    let sessionExpired = false;
    let wasPlayingBeforeHidden = false;
    let bandwidthEstimate = null;
    let bufferingDebounceTimer = null;
    let bufferingStartTime = null;
    let totalBufferingTime = 0;
    let lastPlayingTime = null;
    let autoDowngradeDisabled = false;
    let BUFFERING_DEBOUNCE_MS = 1500;
    let BUFFERING_THRESHOLD_MS = 15000;
    let stallCount = 0;
    let lastStallTime = null;
    let bandwidthUpdateInterval = null;
    let maxReconnectAttempts = 10;
    let reconnectAttempts = 0;
    let manifestReadyCheckTimer = null;
    let liveEdgeTrackingInterval = null;
    let isCatchingUp = false;
    let LIVE_EDGE_SOFT_THRESHOLD = 6;
    let LIVE_EDGE_HARD_THRESHOLD = 15;
    let CATCHUP_PLAYBACK_RATE = 1.05;
    let NORMAL_PLAYBACK_RATE = 1.0;

    function trackBandwidth() {
        if (bandwidthUpdateInterval) clearInterval(bandwidthUpdateInterval);
        bandwidthUpdateInterval = setInterval(function() {
            if (!vjsPlayer) return;
            var tech = vjsPlayer.tech({ IWillNotUseThisInPlugins: true });
            if (tech && tech.vhs && tech.vhs.bandwidth) {
                bandwidthEstimate = tech.vhs.bandwidth;
            }
        }, 5000);
    }

    // Note: modifying tech.vhs.options_ at runtime is unreliable across Video.js
    // versions and can cause mid-stream seeks that trigger stalls. The initial
    // VHS config in getVhsConfig() sets appropriate values based on bandwidth
    // at startup. Runtime adaptation now only uses bandwidth for quality
    // auto-downgrade decisions, not for changing internal VHS behavior.
    function adaptToNetworkConditions() {
        // Intentionally empty — runtime VHS option mutation removed to prevent
        // mid-stream liveSyncDurationCount changes that cause sudden seeks/stalls.
    }

    function isLowBandwidth() {
        if (bandwidthEstimate !== null) return bandwidthEstimate < 800000;
        return navigator.connection && navigator.connection.effectiveType &&
            ['slow-2g', '2g', '3g'].indexOf(navigator.connection.effectiveType) !== -1;
    }

    function isVeryLowBandwidth() {
        if (bandwidthEstimate !== null) return bandwidthEstimate < 400000;
        return navigator.connection && navigator.connection.effectiveType &&
            ['slow-2g', '2g'].indexOf(navigator.connection.effectiveType) !== -1;
    }

    function getAvailableQualities() {
        if (!channelInfo || !channelInfo.qualities) return [];
        return channelInfo.qualities.sort(function(a, b) { return a.sort_order - b.sort_order; });
    }

    function getQualityLower(qualityLabel) {
        var sorted = getAvailableQualities();
        // sorted is ascending sort_order: [highest quality, ..., lowest quality]
        // "lower" quality = higher sort_order = later in array
        for (var i = 0; i < sorted.length; i++) {
            if (sorted[i].label === qualityLabel && i + 1 < sorted.length) {
                return sorted[i + 1].label;
            }
        }
        return null;
    }

    function getLowestQuality() {
        var sorted = getAvailableQualities();
        // Last item has highest sort_order = lowest quality
        return sorted.length > 0 ? sorted[sorted.length - 1].label : null;
    }

    function getVhsConfig() {
        var baseConfig = {
            overrideNative: !isIOS() && !isSafari(),
            enableLowInitialPlaylist: true,
            liveSyncOnStall: true,
            usePerformanceCues: true,
            stallEnabled: true,
            handlePartialData: true,
            allowSeeksWithinUnsafeLiveWindow: true
        };

        if (isVeryLowBandwidth()) {
            baseConfig.liveSyncDurationCount = 6;
            baseConfig.liveMaxLatencyDurationCount = 20;
            baseConfig.maxBufferLength = 60;
            baseConfig.maxMaxBufferLength = 120;
            baseConfig.highBufferLength = 60;
            baseConfig.maxBufferSize = 5 * 1000 * 1000;
            baseConfig.backBufferLength = 30;
        } else if (isLowBandwidth()) {
            baseConfig.liveSyncDurationCount = 5;
            baseConfig.liveMaxLatencyDurationCount = 15;
            baseConfig.maxBufferLength = 45;
            baseConfig.maxMaxBufferLength = 90;
            baseConfig.highBufferLength = 45;
            baseConfig.maxBufferSize = 10 * 1000 * 1000;
            baseConfig.backBufferLength = 60;
        } else {
            baseConfig.liveSyncDurationCount = 4;
            baseConfig.liveMaxLatencyDurationCount = 12;
            baseConfig.maxBufferLength = 30;
            baseConfig.maxMaxBufferLength = 60;
            baseConfig.highBufferLength = 30;
            baseConfig.maxBufferSize = 60 * 1000 * 1000;
            baseConfig.backBufferLength = 90;
        }

        return baseConfig;
    }

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
    const videoEl = document.getElementById('video-player');

    function getRedirectUrl() {
        if (channelInfo && channelInfo.channel_token) {
            return '/channel/' + channelInfo.channel_token;
        }
        return '/';
    }

    function isIOS() {
        return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
               (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    }

    function isSafari() {
        return /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    }

    if (navigator.connection) {
        navigator.connection.addEventListener('change', function() {
            bandwidthEstimate = navigator.connection.downlink * 1000000;
        });
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
            } else if (diff > 0) {
                var localExpiryStr = expires.toLocaleString(undefined, {
                    hour: '2-digit',
                    minute: '2-digit',
                    day: 'numeric',
                    month: 'short',
                    timeZoneName: 'short'
                });
                expiryNotice.classList.remove('hidden');
                expiryText.textContent = 'Access expires at ' + localExpiryStr;
            }
        }

        initVideoJS();
        buildQualityButtons(channelInfo.qualities);
        connectSSE();
        startSessionCheck();

        var qualities = channelInfo.qualities || [];
        var sorted = qualities.sort(function(a, b) { return a.sort_order - b.sort_order; });
        var defaultQuality;
        if (isVeryLowBandwidth()) {
            var lowQ = qualities.find(function(q) { return q.label.toLowerCase().includes('low'); });
            defaultQuality = lowQ || sorted[0];
        } else if (isLowBandwidth()) {
            var medQ = qualities.find(function(q) { return q.label.toLowerCase().includes('medium'); });
            var lowQ2 = qualities.find(function(q) { return q.label.toLowerCase().includes('low'); });
            defaultQuality = medQ || lowQ2 || sorted[0];
        } else {
            var highQ = qualities.find(function(q) { return q.label.toLowerCase().includes('high'); });
            defaultQuality = highQ || sorted[0];
        }

        if (!defaultQuality) {
            redirectToLanding('No stream qualities available');
            return;
        }
        startStream(defaultQuality.label);
    }

    function scheduleBufferingDebounce() {
        if (bufferingDebounceTimer) return;
        bufferingDebounceTimer = setTimeout(function() {
            bufferingDebounceTimer = null;
            if (vjsPlayer && vjsPlayer.paused() && currentQuality && !sessionExpired) {
                showLoading('Buffering...');
            }
        }, BUFFERING_DEBOUNCE_MS);
    }

    function cancelBufferingDebounce() {
        if (bufferingDebounceTimer) {
            clearTimeout(bufferingDebounceTimer);
            bufferingDebounceTimer = null;
        }
    }

    function tryAutoDowngrade() {
        if (autoDowngradeDisabled) return;
        if (!currentQuality) return;
        var lowerQuality = getQualityLower(currentQuality);
        if (lowerQuality && lowerQuality !== currentQuality) {
            console.warn('Auto-downgrading from ' + currentQuality + ' to ' + lowerQuality + ' due to buffering');
            autoDowngradeDisabled = true;
            switchQuality(lowerQuality);
            setTimeout(function() { autoDowngradeDisabled = false; }, 60000);
        }
    }

    function initVideoJS() {
        var vhsConfig = getVhsConfig();
        vjsPlayer = videojs(videoEl, {
            controls: false,
            autoplay: false,
            muted: true,
            preload: 'auto',
            liveui: true,
            fluid: false,
            responsive: false,
            fill: true,
            html5: {
                vhs: vhsConfig,
                nativeAudioDescriptions: true
            }
        });

        vjsPlayer.on('playing', function() {
            cancelBufferingDebounce();
            hideLoading();
            consecutiveNetworkErrors = 0;
            reconnectAttempts = 0;
            reconnectBackoff = 2000;
            stallCount = 0;
            var tech = vjsPlayer.tech({ IWillNotUseThisInPlugins: true });
            if (tech && tech.vhs && tech.vhs.bandwidth) {
                bandwidthEstimate = tech.vhs.bandwidth;
            }
            trackBandwidth();
            startLiveEdgeTracking();
            if (vjsPlayer.muted()) {
                unmuteBtn.classList.remove('hidden');
            } else {
                unmuteBtn.classList.add('hidden');
            }
            if (bufferingStartTime) {
                var bufferingDuration = Date.now() - bufferingStartTime;
                totalBufferingTime += bufferingDuration;
                bufferingStartTime = null;
                if (lastPlayingTime) {
                    var playDuration = Date.now() - lastPlayingTime;
                    if (playDuration < BUFFERING_THRESHOLD_MS && bufferingDuration > 4000 && !autoDowngradeDisabled) {
                        tryAutoDowngrade();
                    }
                }
            }
            lastPlayingTime = Date.now();
        });

        vjsPlayer.on('waiting', function() {
            if (!bufferingStartTime) bufferingStartTime = Date.now();
            stallCount++;
            lastStallTime = Date.now();
            scheduleBufferingDebounce();
        });

        vjsPlayer.on('error', function() {
            if (sessionExpired) return;

            var error = vjsPlayer.error();
            if (!error) return;

            var code = error.code;
            var message = error.message || '';

            // First, check if this is a 403 from the XHR response (Video.js often reports as code 4)
            checkSessionExpired().then(function(expired) {
                if (expired) {
                    handleSessionExpired('Session expired');
                    return;
                }

                if (code === 2 || code === 4) {
                    var is403 = message.indexOf('403') !== -1 || message.indexOf('Forbidden') !== -1;
                    if (is403) {
                        handleSessionExpired('Session expired');
                        return;
                    }
                }

                if (code === 2) {
                    consecutiveNetworkErrors++;
                    if (consecutiveNetworkErrors > 3 && !autoDowngradeDisabled) {
                        tryAutoDowngrade();
                    }
                    console.warn('Network error, reconnecting... (attempt ' + consecutiveNetworkErrors + ')');
                    scheduleReconnect();
                } else if (code === 3) {
                    console.warn('Decode error, doing soft source reload...');
                    softResetPlayer();
                    vjsPlayer.reset();
                    startStream(currentQuality);
                } else if (code === 4) {
                    // Check if this is a 503 (stream not ready) — retryable
                    var is503 = message.indexOf('503') !== -1 || message.indexOf('Service Unavailable') !== -1;
                    if (is503) {
                        console.warn('Stream not ready (503), waiting and retrying...');
                        // Use longer delay for 503 — stream is still starting up
                        scheduleReconnect(5000);
                    } else {
                        console.warn('Source error (code 4), reconnecting...');
                        scheduleReconnect();
                    }
                } else {
                    console.error('Unknown error code:', code, message);
                    destroyPlayer();
                    showError('Stream Error', 'An unrecoverable error occurred. Please try again.');
                }
            });
        });

        vjsPlayer.on('stalled', function() {
            if (!bufferingStartTime) bufferingStartTime = Date.now();
            stallCount++;
            lastStallTime = Date.now();
            scheduleBufferingDebounce();
            if (stallCount > 5 && !autoDowngradeDisabled) {
                tryAutoDowngrade();
            }
        });

        vjsPlayer.on('ended', function() {
            if (!sessionExpired && currentQuality) {
                console.warn('Live stream ended unexpectedly, reconnecting...');
                scheduleReconnect();
            }
        });

        vjsPlayer.on('pause', function() {
            if (sessionExpired) return;
            if (!currentQuality) return;
            if (errorOverlay && !errorOverlay.classList.contains('hidden')) return;
            if (loadingOverlay && !loadingOverlay.classList.contains('hidden')) return;

            setTimeout(function() {
                if (vjsPlayer.paused() && currentQuality && !sessionExpired) {
                    resumeIfPaused();
                }
            }, 500);
        });

        vjsPlayer.on('fullscreenchange', handleFullscreenChange);
    }



    function buildQualityButtons(qualities) {
        if (!qualities || qualities.length === 0) return;
        const sorted = qualities.sort((a, b) => a.sort_order - b.sort_order);
        sorted.forEach(q => {
            if (!q.label) return;
            const btn = document.createElement('button');
            var btnText = q.label.toUpperCase();
            if (q.bitrate_info && q.bitrate_info.approxBitrate) {
                btnText += ' (' + q.bitrate_info.approxBitrate + ')';
            }
            btn.textContent = btnText;
            btn.dataset.quality = q.label;
            btn.title = q.bitrate_info ? q.bitrate_info.description : '';
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
        if (manifestReadyCheckTimer) {
            clearTimeout(manifestReadyCheckTimer);
            manifestReadyCheckTimer = null;
        }
        reconnectBackoff = 2000;
        reconnectAttempts = 0;

        document.querySelectorAll('.quality-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.quality === newQuality);
        });

        vjsPlayer.reset();
        vjsPlayer.muted(!userUnmuted);

        // Use startStream which includes manifest-ready polling
        startStream(newQuality);
    }

    function getHlsUrl(quality) {
        return window.location.origin + '/hls/' + channelInfo.channel_token + '/' + quality + '/index.m3u8?session=' + sessionData.session_token;
    }

    function startStream(quality) {
        if (!quality) {
            console.error('startStream called with no quality');
            return;
        }
        currentQuality = quality;
        showLoading('Loading ' + quality.toUpperCase() + ' stream...');

        document.querySelectorAll('.quality-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.quality === quality);
        });

        vjsPlayer.muted(!userUnmuted);

        // Clear any previous manifest-ready polling
        if (manifestReadyCheckTimer) {
            clearTimeout(manifestReadyCheckTimer);
            manifestReadyCheckTimer = null;
        }

        // Determine minSegments based on current network bandwidth
        var minSegments = 3;
        if (isVeryLowBandwidth()) {
            minSegments = 5;
        } else if (isLowBandwidth()) {
            minSegments = 4;
        }

        // Poll manifest-ready endpoint before setting video source
        // This prevents the player from requesting an m3u8 that returns 503
        var manifestPollAttempts = 0;
        var maxManifestPollAttempts = 30; // 30 * 1000ms = 30 seconds max wait
        var manifestPollInterval = 1000;

        function pollManifestReady() {
            if (currentQuality !== quality) return; // Quality changed during polling
            if (sessionExpired) return;

            manifestPollAttempts++;

            fetch('/hls/' + channelInfo.channel_token + '/manifest-ready/' + quality + '?session=' + encodeURIComponent(sessionData.session_token) + '&minSegments=' + minSegments, {
                headers: { 'x-session-token': sessionData.session_token }
            }).then(function(res) {
                if (res.status === 403) {
                    return res.json().then(function(data) {
                        if (data.expired) {
                            handleSessionExpired(data.error || 'Session expired');
                        }
                        return null;
                    });
                }
                return res.json();
            }).then(function(data) {
                if (!data) return;
                if (currentQuality !== quality) return;

                if (data.ready) {
                    // Manifest is ready — now set the source
                    setVideoSource(quality);
                } else if (manifestPollAttempts < maxManifestPollAttempts) {
                    showLoading('Starting ' + quality.toUpperCase() + ' stream... (' + manifestPollAttempts + 's)');
                    manifestReadyCheckTimer = setTimeout(pollManifestReady, manifestPollInterval);
                } else {
                    // Timeout — try setting source anyway, it might work now
                    console.warn('Manifest ready timeout, attempting to play anyway');
                    setVideoSource(quality);
                }
            }).catch(function() {
                // Network error — try setting source anyway
                if (manifestPollAttempts < 3) {
                    manifestReadyCheckTimer = setTimeout(pollManifestReady, manifestPollInterval);
                } else {
                    setVideoSource(quality);
                }
            });
        }

        pollManifestReady();
    }

    function setVideoSource(quality) {
        var hlsUrl = getHlsUrl(quality);

        vjsPlayer.src({
            src: hlsUrl,
            type: 'application/x-mpegURL'
        });

        vjsPlayer.ready(function() {
            vjsPlayer.play().catch(function(err) {
                console.warn('Autoplay blocked:', err);

                if (isIOS() || isSafari()) {
                    showTapToPlay();
                } else {
                    vjsPlayer.muted(true);
                    unmuteBtn.classList.remove('hidden');
                    vjsPlayer.play().catch(function() {});
                }
            });
        });
    }

    function showTapToPlay() {
        tapToPlayOverlay.classList.remove('hidden');
        hideLoading();
    }

    function handleTapToPlay(e) {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }
        if (tapToPlayOverlay.classList.contains('hidden')) return;
        tapToPlayOverlay.classList.add('hidden');

        vjsPlayer.muted(true);
        unmuteBtn.classList.remove('hidden');

        vjsPlayer.play().catch(function() {});
    }

    tapToPlayOverlay.addEventListener('click', handleTapToPlay);
    tapToPlayOverlay.addEventListener('touchend', handleTapToPlay);

    function destroyPlayer() {
        cancelBufferingDebounce();
        stopLiveEdgeTracking();
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        if (manifestReadyCheckTimer) {
            clearTimeout(manifestReadyCheckTimer);
            manifestReadyCheckTimer = null;
        }
        reconnectBackoff = 2000;
        reconnectAttempts = 0;

        if (vjsPlayer) {
            vjsPlayer.playbackRate(NORMAL_PLAYBACK_RATE);
            vjsPlayer.reset();
            vjsPlayer.pause();
        }

        currentQuality = null;
        consecutiveNetworkErrors = 0;
        bufferingStartTime = null;
        totalBufferingTime = 0;
        lastPlayingTime = null;
        isCatchingUp = false;
    }

    function softResetPlayer() {
        cancelBufferingDebounce();
        bufferingStartTime = null;
        isCatchingUp = false;
        if (vjsPlayer) vjsPlayer.playbackRate(NORMAL_PLAYBACK_RATE);
    }

    function startLiveEdgeTracking() {
        if (liveEdgeTrackingInterval) return;
        liveEdgeTrackingInterval = setInterval(function() {
            if (!vjsPlayer || vjsPlayer.paused() || sessionExpired || !currentQuality) return;

            var liveTracker = vjsPlayer.liveTracker;
            var behindLive = 0;

            if (liveTracker && typeof liveTracker.liveCurrentTime === 'function' && typeof liveTracker.seekableEnd === 'function') {
                // Use Video.js liveTracker API
                var seekEnd = liveTracker.seekableEnd();
                var currentTime = vjsPlayer.currentTime();
                if (seekEnd && isFinite(seekEnd) && currentTime && isFinite(currentTime)) {
                    behindLive = seekEnd - currentTime;
                }
            } else {
                // Fallback: use seekable ranges directly
                var seekable = vjsPlayer.seekable();
                if (seekable && seekable.length > 0) {
                    var seekEnd = seekable.end(seekable.length - 1);
                    var currentTime = vjsPlayer.currentTime();
                    if (isFinite(seekEnd) && isFinite(currentTime)) {
                        behindLive = seekEnd - currentTime;
                    }
                }
            }

            if (behindLive <= 0 || !isFinite(behindLive)) {
                // We're at or ahead of live edge
                if (isCatchingUp) {
                    isCatchingUp = false;
                    vjsPlayer.playbackRate(NORMAL_PLAYBACK_RATE);
                }
                return;
            }

            if (behindLive > LIVE_EDGE_HARD_THRESHOLD) {
                // Too far behind — hard seek to live edge
                console.log('Live edge: too far behind (' + behindLive.toFixed(1) + 's), seeking to live edge');
                isCatchingUp = false;
                vjsPlayer.playbackRate(NORMAL_PLAYBACK_RATE);

                if (liveTracker && typeof liveTracker.seekToLiveEdge === 'function') {
                    liveTracker.seekToLiveEdge();
                } else {
                    var seekable = vjsPlayer.seekable();
                    if (seekable && seekable.length > 0) {
                        // Seek to a small offset before the end to avoid edge buffering issues
                        vjsPlayer.currentTime(seekable.end(seekable.length - 1) - 2);
                    }
                }
            } else if (behindLive > LIVE_EDGE_SOFT_THRESHOLD) {
                // Moderately behind — speed up playback to catch up smoothly
                if (!isCatchingUp) {
                    console.log('Live edge: drifting behind (' + behindLive.toFixed(1) + 's), speeding up to catch up');
                    isCatchingUp = true;
                    vjsPlayer.playbackRate(CATCHUP_PLAYBACK_RATE);
                }
            } else {
                // Within acceptable range — normal speed
                if (isCatchingUp) {
                    console.log('Live edge: caught up (' + behindLive.toFixed(1) + 's behind), returning to normal speed');
                    isCatchingUp = false;
                    vjsPlayer.playbackRate(NORMAL_PLAYBACK_RATE);
                }
            }
        }, 3000);
    }

    function stopLiveEdgeTracking() {
        if (liveEdgeTrackingInterval) {
            clearInterval(liveEdgeTrackingInterval);
            liveEdgeTrackingInterval = null;
        }
        isCatchingUp = false;
    }

    function tryUnmute() {
        vjsPlayer.muted(false);
        userUnmuted = true;
        vjsPlayer.play().then(function() {
            unmuteBtn.classList.add('hidden');
        }).catch(function() {
            vjsPlayer.muted(true);
            unmuteBtn.classList.remove('hidden');
            vjsPlayer.play().catch(function() {});
        });
    }

    function handleUnmute(e) {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }
        tryUnmute();
    }

    unmuteBtn.addEventListener('click', handleUnmute);
    unmuteBtn.addEventListener('touchend', handleUnmute);

    videoContainer.addEventListener('click', function(e) {
        if (e.target === videoEl && vjsPlayer.muted()) {
            tryUnmute();
        }
    });

    function scheduleReconnect(overrideDelay) {
        if (reconnectTimer) return;
        if (sessionExpired) return;

        reconnectAttempts++;
        if (reconnectAttempts > maxReconnectAttempts) {
            console.error('Max reconnect attempts reached (' + maxReconnectAttempts + ')');
            destroyPlayer();
            showError('Connection Failed', 'Unable to connect to the stream after ' + maxReconnectAttempts + ' attempts. The stream may be offline.');
            errorBtn.textContent = 'Try Again';
            errorBtn.onclick = function() {
                reconnectAttempts = 0;
                reconnectBackoff = 2000;
                errorOverlay.classList.add('hidden');
                startStream(currentQuality || getAvailableQualities()[0]?.label);
            };
            return;
        }

        checkSessionExpired().then(function(expired) {
            if (expired) {
                handleSessionExpired('Session expired');
                return;
            }

            var delay = overrideDelay || reconnectBackoff;
            softResetPlayer();
            showLoading('Reconnecting... (attempt ' + reconnectAttempts + '/' + maxReconnectAttempts + ')');
            reconnectTimer = setTimeout(function() {
                reconnectTimer = null;
                vjsPlayer.reset();
                startStream(currentQuality);
            }, delay);

            reconnectBackoff = Math.min(reconnectBackoff * 1.3, maxReconnectBackoff);
        });
    }

    function resumeIfPaused() {
        if (sessionExpired) return;
        if (!vjsPlayer.paused()) return;
        if (!currentQuality) return;
        if (errorOverlay && !errorOverlay.classList.contains('hidden')) return;

        vjsPlayer.play().catch(function() {
            if (!vjsPlayer.muted()) {
                vjsPlayer.muted(true);
                unmuteBtn.classList.remove('hidden');
                vjsPlayer.play().catch(function() {});
            }
        });
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
            window.location.href = getRedirectUrl();
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
            }).catch(function() {});
        }, 30000);
    }

    function checkSessionExpired() {
        if (sessionExpired) return Promise.resolve(true);
        if (!sessionData) return Promise.resolve(true);
        return fetch('/api/auth/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_token: sessionData.session_token })
        }).then(function(res) { return res.json(); }).then(function(result) {
            return !result.valid;
        }).catch(function() {
            return false;
        });
    }

    function handleSessionExpired(reason) {
        if (sessionExpired) return;
        sessionExpired = true;

        localStorage.removeItem(SESSION_KEY);
        destroyPlayer();
        showError('Session Expired', reason || 'Your access has expired.');

        if (channelInfo && channelInfo.channel_token) {
            errorBtn.textContent = 'Reconnect';
            errorBtn.onclick = function() {
                window.location.href = getRedirectUrl();
            };
        } else {
            errorBtn.textContent = 'Get New Code';
            errorBtn.onclick = function() {
                window.location.href = getRedirectUrl();
            };
        }

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
    var isNativeFullscreen = false;

    function isAnyFullscreen() {
        return isNativeFullscreen || (vjsPlayer && vjsPlayer.isFullscreen());
    }

    function toggleFullscreen() {
        if (!vjsPlayer) return;

        if (isAnyFullscreen()) {
            isFullscreenTransition = true;
            if (isNativeFullscreen) {
                // Exit native iOS fullscreen
                var tech = vjsPlayer.tech({ IWillNotUseThisInPlugins: true });
                var el = tech ? tech.el() : videoEl;
                if (el && el.webkitExitFullscreen) {
                    el.webkitExitFullscreen();
                } else if (document.webkitExitFullscreen) {
                    document.webkitExitFullscreen();
                }
            } else {
                vjsPlayer.exitFullscreen();
            }
        } else {
            isFullscreenTransition = true;
            // On iOS, try native video fullscreen first (works better with inline HLS)
            var tech = vjsPlayer.tech({ IWillNotUseThisInPlugins: true });
            var el = tech ? tech.el() : videoEl;
            if (el && el.webkitEnterFullscreen) {
                try {
                    el.webkitEnterFullscreen();
                    return;
                } catch (e) {
                    // fallback to video.js fullscreen
                }
            }
            vjsPlayer.requestFullscreen();
        }
    }

    function updateFullscreenIcon() {
        if (isAnyFullscreen()) {
            fullscreenBtn.innerHTML = '&#x2716;';
            fullscreenBtn.title = 'Exit Fullscreen';
        } else {
            fullscreenBtn.innerHTML = '&#x26F6;';
            fullscreenBtn.title = 'Fullscreen';
        }
    }

    function handleFullscreenChange() {
        updateFullscreenIcon();

        var isFullscreen = vjsPlayer ? vjsPlayer.isFullscreen() : false;
        if (!isFullscreen && isFullscreenTransition) {
            isFullscreenTransition = false;
            setTimeout(function() {
                resumeIfPaused();
            }, 300);
        }
    }

    // Listen for webkit fullscreen events on the actual video element (iOS)
    videoEl.addEventListener('webkitbeginfullscreen', function() {
        isFullscreenTransition = true;
        isNativeFullscreen = true;
        updateFullscreenIcon();
    });

    videoEl.addEventListener('webkitendfullscreen', function() {
        isFullscreenTransition = false;
        isNativeFullscreen = false;
        updateFullscreenIcon();
        setTimeout(function() {
            resumeIfPaused();
        }, 300);
    });

    fullscreenBtn.addEventListener('click', toggleFullscreen);

    // Keep document-level as fallback
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);

    videoContainer.addEventListener('dblclick', toggleFullscreen);

    document.addEventListener('visibilitychange', function() {
        if (document.visibilityState === 'hidden') {
            wasPlayingBeforeHidden = !vjsPlayer.paused() && !vjsPlayer.ended();
        } else if (document.visibilityState === 'visible') {
            handleVisibilityRestore();
        }
    });

    window.addEventListener('pageshow', function(event) {
        if (event.persisted) {
            handleVisibilityRestore();
        }
    });

    function seekToLiveEdge() {
        if (!vjsPlayer) return;
        var liveTracker = vjsPlayer.liveTracker;
        if (liveTracker && typeof liveTracker.seekToLiveEdge === 'function') {
            liveTracker.seekToLiveEdge();
        } else {
            var seekable = vjsPlayer.seekable();
            if (seekable && seekable.length > 0) {
                vjsPlayer.currentTime(seekable.end(seekable.length - 1) - 2);
            }
        }
    }

    function handleVisibilityRestore() {
        if (sessionExpired) return;
        if (!currentQuality) return;
        if (errorOverlay && !errorOverlay.classList.contains('hidden')) return;

        setTimeout(function() {
            // Always seek to live edge when returning from background
            // to avoid watching content that's minutes behind
            seekToLiveEdge();

            if (vjsPlayer.paused() && wasPlayingBeforeHidden) {
                vjsPlayer.play().catch(function() {
                    if (!vjsPlayer.muted()) {
                        vjsPlayer.muted(true);
                        unmuteBtn.classList.remove('hidden');
                        vjsPlayer.play().catch(function() {});
                    }
                });
            }

            // Restart live edge tracking in case it was disrupted
            startLiveEdgeTracking();

            if ((isIOS() || isSafari()) && wasPlayingBeforeHidden) {
                var checkTime = vjsPlayer.currentTime();
                setTimeout(function() {
                    if (Math.abs(vjsPlayer.currentTime() - checkTime) < 0.5 && !vjsPlayer.paused()) {
                        console.log('Stream stalled after returning from background, reloading...');
                        reloadCurrentStream();
                    } else if (vjsPlayer.paused() && wasPlayingBeforeHidden) {
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

        checkSessionExpired().then(function(expired) {
            if (expired) {
                handleSessionExpired('Session expired');
                return;
            }

            vjsPlayer.reset();
            startStream(currentQuality);
        });
    }

    init();
})();
