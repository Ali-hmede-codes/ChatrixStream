const { spawn } = require('child_process');

function isM3U8(url) {
    if (!url) return false;
    try {
        const parsed = new URL(url);
        return parsed.pathname.endsWith('.m3u8') || parsed.pathname.includes('.m3u8');
    } catch (e) {
        return false;
    }
}

const QUALITY_PRESETS = {
    low: {
        videoCodec: 'libx264',
        videoBitrate: '400k',
        videoMaxRate: '500k',
        videoBufSize: '800k',
        videoPreset: 'ultrafast',
        videoTune: 'zerolatency',
        videoProfile: 'baseline',
        videoLevel: '3.0',
        videoResolution: '640x360',
        audioBitrate: '48k',
        audioChannels: '1',
        audioRate: '44100',
        copyVideo: false
    },
    medium: {
        videoCodec: 'libx264',
        videoBitrate: '1000k',
        videoMaxRate: '1200k',
        videoBufSize: '2000k',
        videoPreset: 'veryfast',
        videoTune: 'zerolatency',
        videoProfile: 'main',
        videoLevel: '3.1',
        videoResolution: null,
        audioBitrate: '64k',
        audioChannels: '2',
        audioRate: '48000',
        copyVideo: false
    },
    high: {
        videoCodec: 'copy',
        videoBitrate: null,
        videoMaxRate: null,
        videoBufSize: null,
        videoPreset: null,
        videoTune: null,
        videoProfile: null,
        videoLevel: null,
        videoResolution: null,
        audioBitrate: '128k',
        audioChannels: '2',
        audioRate: '48000',
        copyVideo: true
    }
};

class PipeConverter {
    constructor(options = {}) {
        this.activeStreams = new Map();
        this.ffmpegPath = options.ffmpegPath || 'ffmpeg';
        this.idleTimeout = options.idleTimeout || 30000;
        this.restartDelay = options.restartDelay || 3000;
        this.maxRetries = options.maxRetries || 15;
        this.rollingBufferSize = options.rollingBufferSize || 4 * 1024 * 1024;
        this.ffmpegAvailable = false;
        this.qualityPresets = options.qualityPresets || QUALITY_PRESETS;
        this.streamManager = options.streamManager;
        this._checkFfmpeg();
    }

    _checkFfmpeg(pathToTest) {
        pathToTest = pathToTest || this.ffmpegPath;
        try {
            const proc = spawn(pathToTest, ['-version']);
            let errorOccurred = false;

            proc.on('error', () => {
                errorOccurred = true;
                if (pathToTest !== 'ffmpeg') {
                    this._checkFfmpeg('ffmpeg');
                } else {
                    this.ffmpegAvailable = false;
                    console.warn('PipeConverter: ffmpeg is not available.');
                }
            });

            proc.on('close', (code) => {
                if (errorOccurred) return;
                if (code === 0) {
                    this.ffmpegAvailable = true;
                    this.ffmpegPath = pathToTest;
                    console.log('PipeConverter: ffmpeg is available at', this.ffmpegPath);
                } else if (pathToTest !== 'ffmpeg') {
                    this._checkFfmpeg('ffmpeg');
                } else {
                    this.ffmpegAvailable = false;
                    console.warn('PipeConverter: ffmpeg is not available.');
                }
            });
        } catch (e) {
            if (pathToTest !== 'ffmpeg') this._checkFfmpeg('ffmpeg');
            else this.ffmpegAvailable = false;
        }
    }

    isAvailable() {
        return this.ffmpegAvailable;
    }

    _getKey(channelId, qualityLabel) {
        return channelId + ':' + qualityLabel;
    }

    _resolvePreset(qualityLabel, qualityConfig) {
        const baseKey = (qualityConfig && qualityConfig.preset_key) || qualityLabel.toLowerCase().trim();
        if (this.qualityPresets[baseKey]) {
            return this._applyOverrides(this.qualityPresets[baseKey], qualityConfig);
        }
        for (const key of Object.keys(this.qualityPresets)) {
            if (baseKey.includes(key)) {
                return this._applyOverrides(this.qualityPresets[key], qualityConfig);
            }
        }
        const resMatch = baseKey.match(/(\d+)p/);
        if (resMatch) {
            const h = parseInt(resMatch[1]);
            if (h <= 360) return this._applyOverrides(this.qualityPresets.low, qualityConfig);
            if (h <= 720) return this._applyOverrides(this.qualityPresets.medium, qualityConfig);
        }
        return this._applyOverrides(this.qualityPresets.high, qualityConfig);
    }

    _applyOverrides(base, cfg) {
        if (!cfg) return base;
        const r = Object.assign({}, base);
        if (cfg.video_codec != null) { r.videoCodec = cfg.video_codec; r.copyVideo = cfg.video_codec === 'copy'; }
        if (cfg.video_bitrate != null) r.videoBitrate = cfg.video_bitrate;
        if (cfg.video_maxrate != null) r.videoMaxRate = cfg.video_maxrate;
        if (cfg.video_bufsize != null) r.videoBufSize = cfg.video_bufsize;
        if (cfg.video_preset != null) r.videoPreset = cfg.video_preset;
        if (cfg.video_profile != null) r.videoProfile = cfg.video_profile;
        if (cfg.video_level != null) r.videoLevel = cfg.video_level;
        if (cfg.video_resolution != null) r.videoResolution = cfg.video_resolution;
        if (cfg.audio_bitrate != null) r.audioBitrate = cfg.audio_bitrate;
        if (cfg.audio_channels != null) r.audioChannels = String(cfg.audio_channels);
        if (cfg.audio_rate != null) r.audioRate = String(cfg.audio_rate);
        return r;
    }

    ensureStream(channelId, qualityLabel, streamUrl, qualityConfig) {
        const key = this._getKey(channelId, qualityLabel);
        let state = this.activeStreams.get(key);
        if (state) {
            state.lastAccess = Date.now();
            this._scheduleIdleCheck(key);
            return state;
        }

        const preset = this._resolvePreset(qualityLabel, qualityConfig);
        
        // Parse bitrates to compute rolling buffer size (target: ~3 seconds of data)
        const parseBitrate = (str) => {
            if (!str) return 0;
            const match = str.match(/^(\d+)(k|m)?/i);
            if (!match) return 0;
            const num = parseInt(match[1]);
            const unit = (match[2] || '').toLowerCase();
            if (unit === 'm') return num * 1000000;
            if (unit === 'k') return num * 1000;
            return num;
        };

        const vBitrate = parseBitrate(preset.videoBitrate) || 1000000;
        const aBitrate = parseBitrate(preset.audioBitrate) || 128000;
        const totalBitrateBps = vBitrate + aBitrate;
        // 3 seconds buffer size in bytes, with a minimum of 256KB to ensure safe startup
        const dynamicRollingBufferSize = Math.max(256 * 1024, Math.ceil((totalBitrateBps / 8) * 3));

        state = {
            ffmpegProcess: null,
            clients: new Set(),
            channelId,
            qualityLabel,
            streamUrl,
            qualityConfig,
            lastAccess: Date.now(),
            idleTimer: null,
            restartTimer: null,
            retryCount: 0,
            restarting: false,
            started: false,
            ready: false,
            // Rolling buffer: stores recent MPEG-TS data so new clients
            // can start playing immediately without waiting for a keyframe
            recentChunks: [],
            recentChunksSize: 0,
            rollingBufferSize: dynamicRollingBufferSize
        };

        this.activeStreams.set(key, state);
        this._startFfmpeg(key);
        return state;
    }

    addClient(channelId, qualityLabel, streamUrl, qualityConfig, res) {
        const state = this.ensureStream(channelId, qualityLabel, streamUrl, qualityConfig);

        res.writeHead(200, {
            'Content-Type': 'video/mp2t',
            'Cache-Control': 'no-cache, no-store, no-transform',
            'Connection': 'keep-alive',
            'Transfer-Encoding': 'chunked',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Expose-Headers': 'X-Stream-Type, Content-Type',
            'X-Accel-Buffering': 'no',
            'X-Stream-Type': 'pipe'
        });

        // Send rolling buffer so new client gets initial data immediately.
        // This contains recent MPEG-TS packets including PAT/PMT headers
        // and at least one keyframe (forced every 2s by FFmpeg).
        for (const chunk of state.recentChunks) {
            if (!res.destroyed) res.write(chunk);
        }

        state.clients.add(res);

        // Cancel idle timer since we have an active client
        if (state.idleTimer) {
            clearTimeout(state.idleTimer);
            state.idleTimer = null;
        }

        res.on('close', () => this.removeClient(channelId, qualityLabel, res));
        res.on('error', () => this.removeClient(channelId, qualityLabel, res));
    }

    removeClient(channelId, qualityLabel, res) {
        const key = this._getKey(channelId, qualityLabel);
        const state = this.activeStreams.get(key);
        if (!state) return;

        state.clients.delete(res);

        if (state.clients.size === 0) {
            this._scheduleIdleCheck(key);
        }
    }

    _startFfmpeg(key) {
        const state = this.activeStreams.get(key);
        if (!state) return;

        const useStreamManager = this.streamManager && !isM3U8(state.streamUrl);

        if (state.ffmpegProcess) {
            try {
                if (useStreamManager) {
                    this.streamManager.unregisterConsumer(state.channelId, state.qualityLabel, state.ffmpegProcess.stdin);
                }
                state.ffmpegProcess.stdout.destroy();
                state.ffmpegProcess.stderr.destroy();
                state.ffmpegProcess.kill('SIGKILL');
            } catch (e) { /* ignore */ }
            state.ffmpegProcess = null;
        }

        state.started = true;
        state.ready = false;

        // Clear rolling buffer on restart — old timestamps would confuse new clients
        state.recentChunks = [];
        state.recentChunksSize = 0;

        const preset = this._resolvePreset(state.qualityLabel, state.qualityConfig);
        const args = [];

        args.push('-nostdin');
        args.push('-threads', '0');
        args.push('-thread_queue_size', '512');
        args.push('-user_agent', 'VLC/3.0.21 Vetinari');
        args.push('-fflags', '+genpts+discardcorrupt+flush_packets');
        args.push('-analyzeduration', '1000000');
        args.push('-probesize', '1000000');

        if (useStreamManager) {
            args.push('-avoid_negative_ts', 'make_zero');
            args.push('-max_delay', '0');
            args.push('-i', 'pipe:0');
        } else {
            const parsedUrl = new URL(state.streamUrl);
            // Auth header for sources behind Basic auth
            if (parsedUrl.username || parsedUrl.password) {
                const auth = Buffer.from(parsedUrl.username + ':' + parsedUrl.password).toString('base64');
                args.push('-headers', 'Authorization: Basic ' + auth + '\r\n');
            }

            const cleanUrl = new URL(state.streamUrl);
            cleanUrl.username = '';
            cleanUrl.password = '';
            const urlStr = cleanUrl.toString();

            args.push('-rw_timeout', '15000000');
            args.push('-reconnect', '1');
            args.push('-reconnect_at_eof', '1');
            args.push('-reconnect_streamed', '1');
            args.push('-reconnect_delay_max', '30');
            args.push('-reconnect_on_network_error', '1');
            args.push('-reconnect_on_http_error', '4xx,5xx');
            args.push('-avoid_negative_ts', 'make_zero');
            args.push('-max_delay', '0');
            args.push('-i', urlStr);
        }

        if (preset.copyVideo) {
            args.push('-c:v', 'copy');
            args.push('-threads:v', '1');
        } else {
            args.push('-c:v', preset.videoCodec);
            args.push('-threads:v', '0');
            if (preset.videoPreset) args.push('-preset', preset.videoPreset);
            if (preset.videoTune) args.push('-tune', preset.videoTune);
            if (preset.videoProfile) args.push('-profile:v', preset.videoProfile);
            if (preset.videoLevel) args.push('-level', preset.videoLevel);
            if (preset.videoBitrate) args.push('-b:v', preset.videoBitrate);
            if (preset.videoMaxRate) args.push('-maxrate', preset.videoMaxRate);
            if (preset.videoBufSize) args.push('-bufsize', preset.videoBufSize);
            if (preset.videoResolution) {
                const parts = preset.videoResolution.split('x');
                args.push('-vf', 'scale=' + parts[0] + ':' + parts[1] + ':force_original_aspect_ratio=decrease,pad=' + parts[0] + ':' + parts[1] + ':(ow-iw)/2:(oh-ih)/2');
            }
            args.push('-force_key_frames', 'expr:gte(t,n_forced*2)');
            args.push('-sc_threshold', '0');
        }

        args.push('-c:a', 'aac');
        args.push('-threads:a', '0');
        args.push('-af', 'aresample=async=1000');
        args.push('-ar', String(preset.audioRate));
        args.push('-ac', String(preset.audioChannels));
        args.push('-b:a', preset.audioBitrate);

        // Output as continuous MPEG-TS to stdout (no files, no segments)
        // resend_headers: resends PAT/PMT tables periodically so new clients can sync
        // flush_packets: flushes data immediately to minimize latency
        args.push('-mpegts_flags', '+resend_headers');
        args.push('-flush_packets', '1');
        args.push('-f', 'mpegts');
        args.push('pipe:1');

        console.log('PipeConverter: starting ffmpeg for', key, 'video:', preset.copyVideo ? 'copy' : preset.videoBitrate, 'audio:', preset.audioBitrate, 'useStreamManager:', useStreamManager);

        const proc = spawn(this.ffmpegPath, args, { stdio: [useStreamManager ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
        state.ffmpegProcess = proc;

        if (useStreamManager) {
            proc.stdin.on('error', (err) => {
                console.warn(`PipeConverter: ffmpeg stdin error for ${key}:`, err.message);
            });
            this.streamManager.registerConsumer(state.channelId, state.qualityLabel, state.streamUrl, proc.stdin);
        }

        // Fan out FFmpeg stdout data to all connected clients + rolling buffer
        proc.stdout.on('data', (chunk) => {
            if (!state.ready) {
                state.ready = true;
                state.retryCount = 0;
                console.log('PipeConverter: stream ready for', key);
            }

            // Store in rolling buffer for new client catch-up
            state.recentChunks.push(chunk);
            state.recentChunksSize += chunk.length;
            while (state.recentChunksSize > state.rollingBufferSize && state.recentChunks.length > 1) {
                const removed = state.recentChunks.shift();
                state.recentChunksSize -= removed.length;
            }

            // Write to every connected client
            const maxBuffer = 5 * 1024 * 1024; // 5MB limit
            for (const client of state.clients) {
                if (!client.destroyed && !client.writableEnded) {
                    client.write(chunk);
                    if (client.writableLength > maxBuffer) {
                        console.log(`PipeConverter: Client fell too far behind (${client.writableLength} bytes buffered), dropping connection`);
                        client.destroy();
                    }
                }
            }
        });

        // Log meaningful FFmpeg messages, skip noisy progress lines
        proc.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (!msg) return;
            if (msg.startsWith('frame=') || msg.startsWith('  lib') || msg.startsWith('  configuration:') || msg.startsWith('  built with') || msg.startsWith('size=')) return;
            if (msg.includes('Error') || msg.includes('error') || msg.includes('Invalid') || msg.includes('failed') || msg.includes('Connection') || msg.includes('timeout') || msg.includes('Opening') || msg.includes('Output') || msg.includes('Input') || msg.includes('Stream ') || msg.includes('Duration')) {
                console.log('PipeConverter ffmpeg:', msg.substring(0, 500));
            }
        });

        proc.on('error', (err) => {
            console.error('PipeConverter: ffmpeg spawn error:', err.message);
            state.ffmpegProcess = null;
            if (useStreamManager) {
                this.streamManager.unregisterConsumer(state.channelId, state.qualityLabel, proc.stdin);
            }
            this._scheduleRestart(key);
        });

        proc.on('close', (code, signal) => {
            console.log('PipeConverter: ffmpeg exited code', code, 'signal', signal, 'for', key);
            state.ffmpegProcess = null;
            if (useStreamManager) {
                this.streamManager.unregisterConsumer(state.channelId, state.qualityLabel, proc.stdin);
            }
            if (this.activeStreams.has(key) && !state.restarting) {
                this._scheduleRestart(key);
            }
        });
    }

    _scheduleRestart(key) {
        const state = this.activeStreams.get(key);
        if (!state) return;
        if (state.restartTimer) return;

        state.retryCount++;
        if (state.retryCount > this.maxRetries) {
            console.log('PipeConverter: max retries exceeded for', key, ', stopping');
            this.stopStream(state.channelId, state.qualityLabel);
            return;
        }

        state.restarting = true;
        state.restartTimer = setTimeout(() => {
            state.restartTimer = null;
            state.restarting = false;
            if (this.activeStreams.has(key)) {
                console.log('PipeConverter: restarting ffmpeg for', key, '(retry', state.retryCount, '/', this.maxRetries, ')');
                this._startFfmpeg(key);
            }
        }, this.restartDelay);
    }

    _scheduleIdleCheck(key) {
        const state = this.activeStreams.get(key);
        if (!state) return;
        if (state.idleTimer) clearTimeout(state.idleTimer);

        state.idleTimer = setTimeout(() => {
            state.idleTimer = null;
            if (state.clients.size === 0) {
                console.log('PipeConverter: stream idle, stopping', key);
                this.stopStream(state.channelId, state.qualityLabel);
            }
        }, this.idleTimeout);
    }

    stopStream(channelId, qualityLabel) {
        const key = this._getKey(channelId, qualityLabel);
        const state = this.activeStreams.get(key);
        if (!state) return;

        if (state.idleTimer) clearTimeout(state.idleTimer);
        if (state.restartTimer) clearTimeout(state.restartTimer);

        if (state.ffmpegProcess) {
            try {
                const useStreamManager = this.streamManager && !isM3U8(state.streamUrl);
                if (useStreamManager) {
                    this.streamManager.unregisterConsumer(state.channelId, state.qualityLabel, state.ffmpegProcess.stdin);
                }
                state.ffmpegProcess.stdout.destroy();
                state.ffmpegProcess.stderr.destroy();
                state.ffmpegProcess.kill('SIGKILL');
            } catch (e) { /* ignore */ }
            state.ffmpegProcess = null;
        }

        for (const client of state.clients) {
            try { client.end(); } catch (e) { /* ignore */ }
        }

        state.clients.clear();
        state.recentChunks = [];
        state.recentChunksSize = 0;

        this.activeStreams.delete(key);
        console.log('PipeConverter: stopped stream', key);
    }

    stopAllForChannel(channelId) {
        const keysToStop = [];
        for (const key of this.activeStreams.keys()) {
            if (key.startsWith(channelId + ':')) {
                keysToStop.push(key);
            }
        }
        for (const key of keysToStop) {
            const state = this.activeStreams.get(key);
            if (state) this.stopStream(state.channelId, state.qualityLabel);
        }
    }

    stopAll() {
        const keysToStop = Array.from(this.activeStreams.keys());
        for (const key of keysToStop) {
            const state = this.activeStreams.get(key);
            if (state) this.stopStream(state.channelId, state.qualityLabel);
        }
    }
}

module.exports = PipeConverter;
