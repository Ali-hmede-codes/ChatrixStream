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

    function isLowBandwidth() {
        if (bandwidthEstimate !== null) return bandwidthEstimate < 500000;
        return navigator.connection && navigator.connection.effectiveType &&
            ['slow-2g', '2g'].indexOf(navigator.connection.effectiveType) !== -1;
    }

    function getVhsConfig() {
        var baseConfig = {
            overrideNative: !isIOS() && !isSafari(),
            enableLowInitialPlaylist: true,
            liveSyncOnStall: true,
            usePerformanceCues: true,
            stallEnabled: true,
            handlePartialData: true
        };

        if (isLowBandwidth()) {
            baseConfig.liveSyncDurationCount = 5;
            baseConfig.liveMaxLatencyDurationCount = 12;
            baseConfig.maxBufferLength = 15;
            baseConfig.maxMaxBufferLength = 30;
            baseConfig.maxBufferSize = 3 * 1000 * 1000;
            baseConfig.backBufferLength = 30;
            baseConfig.experimentalBufferBasedHlsSelector = true;
            baseConfig.experimentalLeastPixelRatioSelector = true;
        } else {
            baseConfig.liveSyncDurationCount = 3;
            baseConfig.liveMaxLatencyDurationCount = 9;
            baseConfig.maxBufferLength = 30;
            baseConfig.maxMaxBufferLength = 60;
            baseConfig.maxBufferSize = 60 * 1000 * 1000;
            baseConfig.backBufferLength = 90;
            baseConfig.experimentalBufferBasedHlsSelector = true;
            baseConfig.experimentalLeastPixelRatioSelector = true;
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

        prewarmAllQualities();

        var defaultQuality;
        if (isLowBandwidth()) {
            var lowQ = channelInfo.qualities.find(function(q) { return q.label.toLowerCase().includes('low'); });
            defaultQuality = lowQ || channelInfo.qualities.sort(function(a, b) { return a.sort_order - b.sort_order; })[0];
        } else {
            var highQ = channelInfo.qualities.find(function(q) { return q.label.toLowerCase().includes('high'); });
            defaultQuality = highQ || channelInfo.qualities.sort(function(a, b) { return b.sort_order - a.sort_order; })[0];
        }
        startStream(defaultQuality.label);
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
            hideLoading();
            consecutiveNetworkErrors = 0;
            var tech = vjsPlayer.tech({ IWillNotUseThisInPlugins: true });
            if (tech && tech.vhs && tech.vhs.bandwidth) {
                bandwidthEstimate = tech.vhs.bandwidth;
            }
            if (vjsPlayer.muted()) {
                unmuteBtn.classList.remove('hidden');
            } else {
                unmuteBtn.classList.add('hidden');
            }
        });

        vjsPlayer.on('waiting', function() {
            showLoading('Buffering...');
        });

        vjsPlayer.on('error', function() {
            if (sessionExpired) return;

            var error = vjsPlayer.error();
            if (!error) return;

            var code = error.code;
            var message = error.message || '';

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
                    console.warn('Decode error, doing full source reload...');
                    vjsPlayer.reset();
                    startStream(currentQuality);
                } else if (code === 4) {
                    console.warn('Source error, reconnecting...');
                    scheduleReconnect();
                } else {
                    console.error('Unknown error code:', code, message);
                    destroyPlayer();
                    showError('Stream Error', 'An unrecoverable error occurred. Please try again.');
                }
            });
        });

        vjsPlayer.on('stalled', function() {
            showLoading('Buffering...');
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

    function prewarmAllQualities() {
        if (!channelInfo || !channelInfo.qualities) return;

        fetch('/hls/' + channelInfo.channel_token + '/warmup?session=' + encodeURIComponent(sessionData.session_token), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-session-token': sessionData.session_token
            }
        }).then(function(res) {
            if (res.status === 403) {
                return res.json().then(function(data) {
                    if (data.expired) {
                        handleSessionExpired(data.error || 'Session expired');
                    }
                });
            }
        }).catch(function() {
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
        reconnectBackoff = 2000;

        document.querySelectorAll('.quality-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.quality === newQuality);
        });

        currentQuality = newQuality;
        showLoading('Loading ' + newQuality.toUpperCase() + ' stream...');

        vjsPlayer.reset();
        vjsPlayer.muted(!userUnmuted);

        var hlsUrl = getHlsUrl(newQuality);
        vjsPlayer.src({
            src: hlsUrl,
            type: 'application/x-mpegURL'
        });

        vjsPlayer.play().catch(function() {});
    }

    function getHlsUrl(quality) {
        return window.location.origin + '/hls/' + channelInfo.channel_token + '/' + quality + '/index.m3u8?session=' + sessionData.session_token;
    }

    function startStream(quality) {
        currentQuality = quality;
        showLoading('Loading ' + quality.toUpperCase() + ' stream...');

        document.querySelectorAll('.quality-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.quality === quality);
        });

        vjsPlayer.muted(!userUnmuted);

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

    tapToPlayOverlay.addEventListener('click', function() {
        tapToPlayOverlay.classList.add('hidden');

        vjsPlayer.muted(true);
        unmuteBtn.classList.remove('hidden');

        vjsPlayer.play().catch(function() {});
    });

    function destroyPlayer() {
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        reconnectBackoff = 2000;

        if (vjsPlayer) {
            vjsPlayer.reset();
            vjsPlayer.pause();
        }

        currentQuality = null;
        consecutiveNetworkErrors = 0;
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

    unmuteBtn.addEventListener('click', tryUnmute);

    videoContainer.addEventListener('click', function(e) {
        if (e.target === videoEl && vjsPlayer.muted()) {
            tryUnmute();
        }
    });

    function scheduleReconnect() {
        if (reconnectTimer) return;
        if (sessionExpired) return;

        checkSessionExpired().then(function(expired) {
            if (expired) {
                handleSessionExpired('Session expired');
                return;
            }

            destroyPlayer();
            showLoading('Reconnecting...');
            reconnectTimer = setTimeout(function() {
                reconnectTimer = null;
                startStream(currentQuality);
            }, reconnectBackoff);

            reconnectBackoff = Math.min(reconnectBackoff * 1.5, maxReconnectBackoff);
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

    function handleVisibilityRestore() {
        if (sessionExpired) return;
        if (!currentQuality) return;
        if (errorOverlay && !errorOverlay.classList.contains('hidden')) return;

        setTimeout(function() {
            if (vjsPlayer.paused() && wasPlayingBeforeHidden) {
                vjsPlayer.play().catch(function() {
                    if (!vjsPlayer.muted()) {
                        vjsPlayer.muted(true);
                        unmuteBtn.classList.remove('hidden');
                        vjsPlayer.play().catch(function() {});
                    }
                });
            }

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
