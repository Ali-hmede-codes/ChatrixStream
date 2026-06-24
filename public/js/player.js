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
    let stallTimestamps = [];
    let bandwidthUpdateInterval = null;
    let maxReconnectAttempts = 10;
    let reconnectAttempts = 0;
    let manifestReadyCheckTimer = null;
    let liveEdgeTrackingInterval = null;
    let isCatchingUp = false;
    let LIVE_EDGE_SOFT_THRESHOLD = 3;
    let LIVE_EDGE_HARD_THRESHOLD = 10;
    let CATCHUP_PLAYBACK_RATE = 1.08;
    let NORMAL_PLAYBACK_RATE = 1.0;

    var usePipeMode = false;
    var mpegtsPlayerInstance = null;

    function getViewerId() {
        let viewerId = localStorage.getItem('chatrix_viewer_id');
        if (!viewerId) {
            viewerId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : 'vid-' + Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
            localStorage.setItem('chatrix_viewer_id', viewerId);
        }
        return viewerId;
    }

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

    function isCellularConnection() {
        if (navigator.connection) {
            if (navigator.connection.type === 'cellular') {
                return true;
            }
            if (['slow-2g', '2g', '3g'].indexOf(navigator.connection.effectiveType) !== -1) {
                return true;
            }
        }
        var isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
                       (navigator.maxTouchPoints && navigator.maxTouchPoints > 2);
        return isMobile;
    }

    function getRecentStallCount() {
        var now = Date.now();
        stallTimestamps = stallTimestamps.filter(function(ts) {
            return now - ts < 60000;
        });
        return stallTimestamps.length;
    }

    function isCellularOrStruggling() {
        if (isCellularConnection()) {
            return true;
        }
        if (getRecentStallCount() >= 2 || autoDowngradeDisabled) {
            return true;
        }
        return false;
    }

    function updateLiveEdgeThresholds() {
        if (isVeryLowBandwidth()) {
            LIVE_EDGE_SOFT_THRESHOLD = 12;
            LIVE_EDGE_HARD_THRESHOLD = 30;
            CATCHUP_PLAYBACK_RATE = 1.03;
        } else if (isLowBandwidth() || isCellularOrStruggling()) {
            LIVE_EDGE_SOFT_THRESHOLD = 8;
            LIVE_EDGE_HARD_THRESHOLD = 20;
            CATCHUP_PLAYBACK_RATE = 1.05;
        } else {
            LIVE_EDGE_SOFT_THRESHOLD = 3;
            LIVE_EDGE_HARD_THRESHOLD = 10;
            CATCHUP_PLAYBACK_RATE = 1.08;
        }

        if (vjsPlayer && isCatchingUp) {
            vjsPlayer.playbackRate(CATCHUP_PLAYBACK_RATE);
        }
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

    function createHlsWrapper() {
        var eventMap = {};
        var fullscreenState = false;
        var hlsInstance = null;

        var wrapper = {
            play: function() { return videoEl.play(); },
            pause: function() { videoEl.pause(); },
            paused: function() { return videoEl.paused; },
            ended: function() { return videoEl.ended; },
            muted: function(val) {
                if (val !== undefined) { videoEl.muted = val; return wrapper; }
                return videoEl.muted;
            },
            currentTime: function(val) {
                if (val !== undefined) { videoEl.currentTime = val; return wrapper; }
                return videoEl.currentTime;
            },
            seekable: function() { return videoEl.seekable; },
            buffered: function() { return videoEl.buffered; },
            playbackRate: function(val) {
                if (val !== undefined) { videoEl.playbackRate = val; return wrapper; }
                return videoEl.playbackRate;
            },
            src: function(val) {
                if (val !== undefined) {
                    var url = typeof val === 'string' ? val : (val && val.src ? val.src : null);
                    if (!url) return wrapper;

                    if (hlsInstance) {
                        hlsInstance.destroy();
                        hlsInstance = null;
                    }

                    if (typeof Hls !== 'undefined' && Hls.isSupported() && !isSafari() && !isIOS()) {
                        // hls.js (Android / Windows / non-Safari desktop)
                        var isStruggling = isLowBandwidth() || isVeryLowBandwidth() || isCellularOrStruggling();
                        hlsInstance = new Hls({
                            maxBufferLength: isStruggling ? 20 : 40,
                            maxMaxBufferLength: 80,
                            liveSyncDurationCount: 5, // Starts further back for 10-15s buffer
                            liveMaxLatencyDurationCount: 15, // Allows more latency before forcing a seek
                            enableWorker: true
                        });

                        hlsInstance.on(Hls.Events.ERROR, function(event, data) {
                            if (data.fatal) {
                                console.error('HLS error:', data);
                                switch(data.type) {
                                    case Hls.ErrorTypes.NETWORK_ERROR:
                                        videoEl.dispatchEvent(new Event('error'));
                                        break;
                                    case Hls.ErrorTypes.MEDIA_ERROR:
                                        hlsInstance.recoverMediaError();
                                        break;
                                    default:
                                        hlsInstance.destroy();
                                        videoEl.dispatchEvent(new Event('error'));
                                        break;
                                }
                            }
                        });

                        hlsInstance.loadSource(url);
                        hlsInstance.attachMedia(videoEl);
                    } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
                        // Native HLS (iOS / Safari)
                        videoEl.src = url;
                    }
                    return wrapper;
                }
                return videoEl.src;
            },
            reset: function() {
                if (hlsInstance) {
                    hlsInstance.destroy();
                    hlsInstance = null;
                }
                videoEl.removeAttribute('src');
                try { videoEl.load(); } catch(e) {}
            },
            error: function() {
                var e = videoEl.error;
                if (!e && hlsInstance) {
                    return { code: 2, message: 'Simulated HLS network error' };
                }
                if (!e) return null;
                return { code: e.code, message: e.message || '' };
            },
            on: function(event, fn) {
                videoEl.addEventListener(event, fn);
                return wrapper;
            },
            ready: function(fn) { setTimeout(fn, 0); },
            isFullscreen: function() { return fullscreenState; },
            requestFullscreen: function() {
                var container = document.getElementById('video-container');
                if (container.requestFullscreen) container.requestFullscreen();
                else if (container.webkitRequestFullscreen) container.webkitRequestFullscreen();
            },
            exitFullscreen: function() {
                if (document.exitFullscreen) document.exitFullscreen();
                else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
            },
            tech: function() {
                return {
                    vhs: null,
                    el: function() { return videoEl; }
                };
            },
            liveTracker: null
        };

        return wrapper;
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
            updateLiveEdgeThresholds();
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
                body: JSON.stringify({ session_token: sessionData.session_token, viewer_id: getViewerId() })
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

        // Force HLS mode for all devices to ensure stability.
        usePipeMode = false;
        console.log('Player mode: hls (native or hls.js)');

        if (channelInfo.expires_at) {
            const expires = new Date(channelInfo.expires_at);
            if (expires.getFullYear() < 9000) {
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
        }

        initPlayer();
        updateLiveEdgeThresholds();
        buildQualityButtons(channelInfo.qualities);
        connectSSE();
        startSessionCheck();

        var qualities = channelInfo.qualities || [];
        var sorted = qualities.sort(function(a, b) { return a.sort_order - b.sort_order; });
        var defaultQuality;
        if (isVeryLowBandwidth()) {
            var lowQ = qualities.find(function(q) { return q.label.toLowerCase().includes('low'); });
            defaultQuality = lowQ || sorted[0];
        } else if (isLowBandwidth() || isCellularConnection()) {
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

    // tryAutoDowngrade logic removed. Quality shifts are strictly manual to prevent reset glitches.

    // Creates a wrapper around the native <video> element that mimics
    // the Video.js player API so all existing code works transparently
    function createMpegtsWrapper() {
        var eventMap = {};
        var fullscreenState = false;

        var wrapper = {
            play: function() { return videoEl.play(); },
            pause: function() { videoEl.pause(); },
            paused: function() { return videoEl.paused; },
            ended: function() { return videoEl.ended; },
            muted: function(val) {
                if (val !== undefined) { videoEl.muted = val; return wrapper; }
                return videoEl.muted;
            },
            currentTime: function(val) {
                if (val !== undefined) { videoEl.currentTime = val; return wrapper; }
                return videoEl.currentTime;
            },
            seekable: function() { return videoEl.seekable; },
            buffered: function() { return videoEl.buffered; },
            playbackRate: function(val) {
                if (val !== undefined) { videoEl.playbackRate = val; return wrapper; }
                return videoEl.playbackRate;
            },
            src: function() { /* handled by setVideoSource */ },
            reset: function() {
                if (mpegtsPlayerInstance) {
                    try { mpegtsPlayerInstance.pause(); } catch(e) {}
                    try { mpegtsPlayerInstance.unload(); } catch(e) {}
                    try { mpegtsPlayerInstance.detachMediaElement(); } catch(e) {}
                    try { mpegtsPlayerInstance.destroy(); } catch(e) {}
                    mpegtsPlayerInstance = null;
                }
                videoEl.removeAttribute('src');
                try { videoEl.load(); } catch(e) {}
            },
            error: function() {
                var e = videoEl.error;
                if (!e) return null;
                return { code: e.code, message: e.message || '' };
            },
            on: function(event, fn) {
                if (!eventMap[event]) eventMap[event] = [];
                eventMap[event].push(fn);
                videoEl.addEventListener(event, fn);
                return wrapper;
            },
            ready: function(fn) { setTimeout(fn, 0); },
            isFullscreen: function() { return fullscreenState; },
            requestFullscreen: function() {
                var container = document.getElementById('video-container');
                if (container.requestFullscreen) container.requestFullscreen();
                else if (container.webkitRequestFullscreen) container.webkitRequestFullscreen();
            },
            exitFullscreen: function() {
                if (document.exitFullscreen) document.exitFullscreen();
                else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
            },
            tech: function() {
                return {
                    vhs: mpegtsPlayerInstance ? { bandwidth: wrapper._getBandwidth() } : null,
                    el: function() { return videoEl; }
                };
            },
            _getBandwidth: function() {
                if (mpegtsPlayerInstance && mpegtsPlayerInstance.statisticsInfo) {
                    return (mpegtsPlayerInstance.statisticsInfo.speed || 0) * 8 * 1024;
                }
                return null;
            },
            liveTracker: null
        };

        document.addEventListener('fullscreenchange', function() {
            fullscreenState = !!document.fullscreenElement;
        });
        document.addEventListener('webkitfullscreenchange', function() {
            fullscreenState = !!(document.webkitFullscreenElement || document.fullscreenElement);
        });

        return wrapper;
    }

    function initPlayer() {
        if (usePipeMode) {
            // Pipe mode: use native <video> + mpegts.js, no Video.js needed
            vjsPlayer = createMpegtsWrapper();
        } else {
            // HLS mode: use native <video> with HLS natively supported by Safari, or hls.js for Android
            vjsPlayer = createHlsWrapper();
        }

        videoEl.classList.remove('video-js', 'vjs-default-skin');
        videoEl.style.width = '100%';
        videoEl.style.height = '100%';
        videoEl.style.objectFit = 'contain';
        videoEl.style.backgroundColor = '#000';

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
            updateLiveEdgeThresholds();
            trackBandwidth();
            startLiveEdgeTracking();
            startBufferHealthMonitor();
            if (vjsPlayer.muted()) {
                unmuteBtn.classList.remove('hidden');
            } else {
                unmuteBtn.classList.add('hidden');
            }
            if (bufferingStartTime) {
                var bufferingDuration = Date.now() - bufferingStartTime;
                totalBufferingTime += bufferingDuration;
                bufferingStartTime = null;
            }
            lastPlayingTime = Date.now();

            // iOS/Safari safe live edge sync on play/resume
            if (isIOS() || isSafari()) {
                setTimeout(function() {
                    var seekable = vjsPlayer.seekable();
                    if (seekable && seekable.length > 0) {
                        var seekEnd = seekable.end(seekable.length - 1);
                        var currentTime = vjsPlayer.currentTime();
                        var behindLive = seekEnd - currentTime;
                        // If behind by more than 8 seconds, seek to safe live target (5s behind live)
                        if (behindLive > 8 && isFinite(seekEnd) && isFinite(currentTime)) {
                            console.log('Safari play/resume: behind live by ' + behindLive.toFixed(1) + 's, seeking to safe live edge');
                            vjsPlayer.currentTime(Math.max(0, seekEnd - 5));
                        }
                    }
                }, 300);
            }
        });

        vjsPlayer.on('waiting', function() {
            if (!bufferingStartTime) bufferingStartTime = Date.now();
            stallCount++;
            var now = Date.now();
            stallTimestamps.push(now);
            lastStallTime = now;
            updateLiveEdgeThresholds();
            scheduleBufferingDebounce();
        });

        vjsPlayer.on('error', function() {
            if (sessionExpired) return;

            var error = vjsPlayer.error();
            if (!error) return;

            var code = error.code;
            var message = error.message || '';

            // First, check if this is a 403 from the XHR response
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
            // Auto downgrade disabled
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
        return window.location.origin + '/hls/' + channelInfo.channel_token + '/' + quality + '/index.m3u8?session=' + sessionData.session_token + '&_cb=' + Date.now();
    }

    function getPipeUrl(quality) {
        return window.location.origin + '/pipe/' + channelInfo.channel_token + '/' + quality + '?session=' + sessionData.session_token;
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

        // Pipe mode: skip manifest polling, connect directly
        if (usePipeMode) {
            setVideoSource(quality);
            return;
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
        if (usePipeMode) {
            // Pipe mode: use mpegts.js to connect to the pipe stream
            var pipeUrl = getPipeUrl(quality);

            // Cleanup previous mpegts instance
            if (mpegtsPlayerInstance) {
                try { mpegtsPlayerInstance.pause(); } catch(e) {}
                try { mpegtsPlayerInstance.unload(); } catch(e) {}
                try { mpegtsPlayerInstance.detachMediaElement(); } catch(e) {}
                try { mpegtsPlayerInstance.destroy(); } catch(e) {}
                mpegtsPlayerInstance = null;
            }

            var isStruggling = isLowBandwidth() || isVeryLowBandwidth() || isCellularOrStruggling();
            mpegtsPlayerInstance = mpegts.createPlayer({
                type: 'mpegts',
                isLive: true,
                url: pipeUrl
            }, {
                enableWorker: true,
                enableStashBuffer: true,
                stashInitialSize: isStruggling ? 128 * 1024 : 16 * 1024,
                lazyLoadMaxDuration: 3 * 60,
                liveBufferLatencyChasing: false,
                autoCleanupSourceBuffer: true,
                autoCleanupMaxBackwardDuration: 20,
                autoCleanupMinBackwardDuration: 10,
                fixAudioTimestampGap: true
            });

            // mpegts.js error handling
            mpegtsPlayerInstance.on(mpegts.Events.ERROR, function(errorType, errorDetail, errorInfo) {
                console.error('mpegts error:', errorType, errorDetail, errorInfo);
                if (sessionExpired) return;

                if (errorType === mpegts.ErrorTypes.NETWORK_ERROR) {
                    checkSessionExpired().then(function(expired) {
                        if (expired) {
                            handleSessionExpired('Session expired');
                            return;
                        }
                        consecutiveNetworkErrors++;
                        console.warn('Pipe: network error, reconnecting... (attempt ' + consecutiveNetworkErrors + ')');
                        scheduleReconnect();
                    });
                } else if (errorType === mpegts.ErrorTypes.MEDIA_ERROR) {
                    console.warn('Pipe: media error, reloading...');
                    softResetPlayer();
                    vjsPlayer.reset();
                    startStream(currentQuality);
                }
            });

            mpegtsPlayerInstance.on(mpegts.Events.LOADING_COMPLETE, function() {
                if (!sessionExpired && currentQuality) {
                    console.warn('Pipe: stream ended, reconnecting...');
                    scheduleReconnect();
                }
            });

            mpegtsPlayerInstance.attachMediaElement(videoEl);
            mpegtsPlayerInstance.load();

            videoEl.play().catch(function(err) {
                console.warn('Autoplay blocked:', err);
                videoEl.muted = true;
                unmuteBtn.classList.remove('hidden');
                videoEl.play().catch(function() {});
            });
            return;
        }

        // HLS mode: use Video.js source
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

        // Cleanup mpegts.js instance if in pipe mode
        if (mpegtsPlayerInstance) {
            try { mpegtsPlayerInstance.pause(); } catch(e) {}
            try { mpegtsPlayerInstance.unload(); } catch(e) {}
            try { mpegtsPlayerInstance.detachMediaElement(); } catch(e) {}
            try { mpegtsPlayerInstance.destroy(); } catch(e) {}
            mpegtsPlayerInstance = null;
        }

        if (vjsPlayer) {
            vjsPlayer.playbackRate(NORMAL_PLAYBACK_RATE);
            vjsPlayer.reset();
            if (!usePipeMode) vjsPlayer.pause();
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

    function seekToLiveEdge() {
        if (!vjsPlayer) return;
        var liveTracker = vjsPlayer.liveTracker;
        if (liveTracker && typeof liveTracker.seekToLiveEdge === 'function') {
            liveTracker.seekToLiveEdge();
        } else {
            var seekable = vjsPlayer.seekable();
            if (seekable && seekable.length > 0) {
                // Seek to safe target: 5s behind absolute live
                vjsPlayer.currentTime(Math.max(0, seekable.end(seekable.length - 1) - 5));
            } else {
                var buffered = vjsPlayer.buffered();
                if (buffered && buffered.length > 0) {
                    // Seek to safe target: 5s behind absolute live
                    vjsPlayer.currentTime(Math.max(0, buffered.end(buffered.length - 1) - 5));
                }
            }
        }
    }

    function startLiveEdgeTracking() {
        if (liveEdgeTrackingInterval) return;
        liveEdgeTrackingInterval = setInterval(function() {
            if (!vjsPlayer || vjsPlayer.paused() || sessionExpired || !currentQuality) return;

            var behindLive = 0;
            var liveTracker = vjsPlayer.liveTracker;

            if (liveTracker && typeof liveTracker.liveCurrentTime === 'function' && typeof liveTracker.seekableEnd === 'function') {
                var seekEnd = liveTracker.seekableEnd();
                var currentTime = vjsPlayer.currentTime();
                if (seekEnd && isFinite(seekEnd) && currentTime && isFinite(currentTime)) {
                    behindLive = seekEnd - currentTime;
                }
            } else {
                var seekable = vjsPlayer.seekable();
                var currentTime = vjsPlayer.currentTime();
                if (seekable && seekable.length > 0) {
                    var seekEnd = seekable.end(seekable.length - 1);
                    if (isFinite(seekEnd) && isFinite(currentTime)) {
                        behindLive = seekEnd - currentTime;
                    }
                } else {
                    var buffered = vjsPlayer.buffered();
                    if (buffered && buffered.length > 0) {
                        var bufferedEnd = buffered.end(buffered.length - 1);
                        if (isFinite(bufferedEnd) && isFinite(currentTime)) {
                            behindLive = bufferedEnd - currentTime;
                        }
                    }
                }
            }

            const liveBadge = document.getElementById('live-badge');
            const liveBadgeText = document.getElementById('live-badge-text');

            if (liveBadge) {
                liveBadge.classList.remove('hidden');

                // Green/Live zone is 0 to 6 seconds behind absolute live
                var isSync = behindLive <= 6;

                if (isSync || behindLive <= 0 || !isFinite(behindLive)) {
                    liveBadge.className = 'live-badge live-badge-sync';
                    liveBadgeText.textContent = 'LIVE';
                } else {
                    liveBadge.className = 'live-badge live-badge-behind';
                    // Show latency relative to the safe target (5s behind absolute live)
                    var displayBehind = Math.max(1, Math.round(behindLive - 5));
                    liveBadgeText.textContent = 'GO LIVE (-' + displayBehind + 's)';
                }
            }
        }, 1000);
    }

    function startBufferHealthMonitor() {
        // Auto-seeking disabled to prevent loop stalls
    }

    function stopBufferHealthMonitor() {
        // Auto-seeking disabled
    }

    function stopLiveEdgeTracking() {
        if (liveEdgeTrackingInterval) {
            clearInterval(liveEdgeTrackingInterval);
            liveEdgeTrackingInterval = null;
        }
        isCatchingUp = false;
        const liveBadge = document.getElementById('live-badge');
        if (liveBadge) liveBadge.classList.add('hidden');
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
                body: JSON.stringify({ session_token: sessionData.session_token, viewer_id: getViewerId() })
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
            body: JSON.stringify({ session_token: sessionData.session_token, viewer_id: getViewerId() })
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

    const liveBadgeEl = document.getElementById('live-badge');
    if (liveBadgeEl) {
        liveBadgeEl.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            seekToLiveEdge();
        });
        liveBadgeEl.addEventListener('touchend', function(e) {
            e.preventDefault();
            e.stopPropagation();
            seekToLiveEdge();
        });
    }

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

    // seekToLiveEdge definition moved higher up

    function handleVisibilityRestore() {
        if (sessionExpired) return;
        if (!currentQuality) return;
        if (errorOverlay && !errorOverlay.classList.contains('hidden')) return;

        setTimeout(function() {
            if (isIOS() || isSafari()) {
                // On iOS/Safari, native HLS handles background recovery best by doing a clean reload
                if (wasPlayingBeforeHidden) {
                    console.log('Visibility restore (iOS/Safari): doing clean stream reload');
                    reloadCurrentStream();
                }
                return;
            }

            // Always seek to live edge when returning from background (for non-iOS/Safari)
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
