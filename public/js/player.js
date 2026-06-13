(function() {
    const SESSION_KEY = 'chatrix_session';

    let sessionData = null;
    let channelInfo = null;
    let currentQuality = null;
    let hlsPlayer = null;
    let reconnectTimer = null;
    let reconnectBackoff = 3000;
    let maxReconnectBackoff = 30000;
    let sseConnection = null;
    let useNativeHls = false;
    let nativeRetryCount = 0;
    let maxNativeRetries = 30;

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

        destroyPlayer();

        document.querySelectorAll('.quality-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.quality === newQuality);
        });

        startStream(newQuality);
    }

    function destroyPlayer() {
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        nativeRetryCount = 0;
        reconnectBackoff = 3000;

        if (hlsPlayer) {
            hlsPlayer.destroy();
            hlsPlayer = null;
        }

        if (useNativeHls) {
            videoEl.removeAttribute('src');
            videoEl.load();
        }

        videoEl.pause();
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

    function getHlsUrl(quality) {
        return window.location.origin + '/hls/' + channelInfo.channel_token + '/' + quality + '/index.m3u8?session=' + sessionData.session_token;
    }

    function startStream(quality) {
        currentQuality = quality;
        showLoading('Loading ' + quality.toUpperCase() + ' stream...');

        if (typeof Hls !== 'undefined' && Hls.isSupported()) {
            useNativeHls = false;

            var hlsUrl = getHlsUrl(quality);

            hlsPlayer = new Hls({
                liveSyncDurationCount: 3,
                liveMaxLatencyDurationCount: 6,
                liveDurationInfinity: true,
                maxBufferLength: 30,
                maxMaxBufferLength: 60,
                maxBufferSize: 60 * 1000 * 1000,
                maxBufferHole: 0.5,
                lowLatencyMode: true,
                enableWorker: true,
                backBufferLength: 90,
                progressive: true,
                lowLatencyMaxDrift: 0,
                manifestLoadingRetryDelay: 2000,
                manifestLoadingMaxRetry: 10,
                manifestLoadingMaxRetryTimeout: 60000,
                levelLoadingRetryDelay: 2000,
                levelLoadingMaxRetry: 10,
                levelLoadingMaxRetryTimeout: 60000,
                xhrSetup: function(xhr, url) {
                    xhr.setRequestHeader('x-session-token', sessionData.session_token);
                }
            });

            videoEl.muted = true;
            hlsPlayer.loadSource(hlsUrl);
            hlsPlayer.attachMedia(videoEl);

            hlsPlayer.on(Hls.Events.MANIFEST_PARSED, function() {
                videoEl.play().catch(function() {});
            });

            hlsPlayer.on(Hls.Events.ERROR, function(event, data) {
                console.error('HLS error:', data.type, data.details, data);

                if (data.fatal) {
                    switch (data.type) {
                        case Hls.ErrorTypes.NETWORK_ERROR:
                            if (data.details === 'manifestLoadError' && data.response && data.response.code === 503) {
                                console.warn('Stream not ready (503), will auto-retry...');
                                hlsPlayer.startLoad(2000);
                                return;
                            }
                            console.warn('Fatal network error, reconnecting with backoff...');
                            scheduleReconnect();
                            break;
                        case Hls.ErrorTypes.MEDIA_ERROR:
                            console.warn('Fatal media error, attempting recovery...');
                            hlsPlayer.recoverMediaError();
                            break;
                        default:
                            console.error('Fatal error, cannot recover');
                            destroyPlayer();
                            showError('Stream Error', 'An unrecoverable error occurred. Please try again.');
                            break;
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
        var hlsUrl = getHlsUrl(quality);

        videoEl.muted = true;
        showLoading('Loading ' + quality.toUpperCase() + ' stream...');

        fetch(hlsUrl, { headers: { 'x-session-token': sessionData.session_token } }).then(function(resp) {
            if (resp.status === 503) {
                return resp.json().then(function(body) {
                    if (body.error === 'ffmpeg_not_available') {
                        showError('Server Error', 'ffmpeg is not installed on the server. HLS stream conversion is unavailable. Please contact the server administrator.');
                        return;
                    }
                    throw { streamNotReady: true };
                }).catch(function(err) {
                    if (err && err.streamNotReady) {
                        nativeRetryCount++;
                        if (nativeRetryCount <= maxNativeRetries) {
                            console.warn('Stream not ready (503), retrying... (' + nativeRetryCount + '/' + maxNativeRetries + ')');
                            var delay = Math.min(2000 * nativeRetryCount, 30000);
                            reconnectTimer = setTimeout(function() {
                                reconnectTimer = null;
                                startNativeStream(quality);
                            }, delay);
                            return;
                        }
                        showError('Stream Error', 'The stream failed to start after multiple attempts. Please try again later.');
                        return;
                    }
                    showError('Stream Error', 'Failed to load the HLS stream (HTTP 503).');
                    return;
                });
            }
            if (!resp.ok) {
                showError('Stream Error', 'Failed to load the HLS stream (HTTP ' + resp.status + ').');
                return;
            }

            nativeRetryCount = 0;
            videoEl.src = hlsUrl;
            videoEl.play();

            videoEl.addEventListener('loadeddata', function onLoaded() {
                hideLoading();
                if (videoEl.muted) {
                    unmuteBtn.classList.remove('hidden');
                }
                videoEl.removeEventListener('loadeddata', onLoaded);
            });

            videoEl.addEventListener('error', function onError() {
                nativeRetryCount++;
                if (nativeRetryCount <= maxNativeRetries) {
                    console.warn('Native HLS error, retrying... (' + nativeRetryCount + '/' + maxNativeRetries + ')');
                    var delay = Math.min(2000 * nativeRetryCount, 30000);
                    reconnectTimer = setTimeout(function() {
                        reconnectTimer = null;
                        videoEl.removeAttribute('src');
                        videoEl.load();
                        startNativeStream(quality);
                    }, delay);
                } else {
                    showError('Stream Error', 'Failed to load the stream. The server may need ffmpeg installed for HLS conversion.');
                }
                videoEl.removeEventListener('error', onError);
            });

            videoEl.addEventListener('waiting', function() {
                showLoading('Buffering...');
            });

            videoEl.addEventListener('playing', function onPlaying() {
                hideLoading();
                if (videoEl.muted) {
                    unmuteBtn.classList.remove('hidden');
                }
                videoEl.removeEventListener('playing', onPlaying);
            });
        }).catch(function(err) {
            if (err && err.streamNotReady) return;
            showError('Network Error', 'Could not reach the server for HLS stream: ' + err.message);
        });
    }

    function scheduleReconnect() {
        if (reconnectTimer) return;

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
            destroyPlayer();
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
        if (document.fullscreenElement || document.webkitFullscreenElement) {
            if (document.exitFullscreen) {
                document.exitFullscreen();
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            }
        } else if (videoEl.webkitEnterFullscreen) {
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

    fullscreenBtn.addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', updateFullscreenIcon);
    document.addEventListener('webkitfullscreenchange', updateFullscreenIcon);

    videoContainer.addEventListener('dblclick', toggleFullscreen);

    init();
})();
