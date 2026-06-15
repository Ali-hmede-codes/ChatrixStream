const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

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
        videoResolution: '480x360',
        audioBitrate: '48k',
        audioChannels: '1',
        audioRate: '44100',
        segmentDuration: 2,
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
        segmentDuration: 2,
        copyVideo: false
    },
    high: {
        videoCodec: 'libx264',
        videoBitrate: '2500k',
        videoMaxRate: '3000k',
        videoBufSize: '5000k',
        videoPreset: 'superfast',
        videoTune: 'zerolatency',
        videoProfile: 'high',
        videoLevel: '4.1',
        videoResolution: null,
        audioBitrate: '128k',
        audioChannels: '2',
        audioRate: '48000',
        segmentDuration: 2,
        copyVideo: false
    }
};

class HlsConverter {
    constructor(options = {}) {
        this.activeConversions = new Map();
        this.tempDir = options.tempDir || path.join(process.cwd(), 'tmp', 'hls');
        this.segmentDuration = options.segmentDuration || 2;
        this.listSize = options.listSize || 25;
        this.idleTimeout = options.idleTimeout || 30000;
        this.idleGrace = options.idleGrace || 5000;
        this.restartDelay = options.restartDelay || 3000;
        this.maxRetries = options.maxRetries || 5;
        this.manifestWaitTimeout = options.manifestWaitTimeout || 15000;
        this.startupTimeout = options.startupTimeout || 60000;
        this.ffmpegPath = options.ffmpegPath || 'ffmpeg';
        this.ffmpegAvailable = false;
        this.qualityPresets = options.qualityPresets || QUALITY_PRESETS;

        this._cleanTempDir();
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
        this._checkFfmpeg();
    }

    _resolvePreset(qualityLabel, qualityConfig) {
        const baseKey = (qualityConfig && qualityConfig.preset_key) || qualityLabel.toLowerCase().trim();
        if (this.qualityPresets[baseKey]) {
            const base = this.qualityPresets[baseKey];
            return this._applyOverrides(base, qualityConfig);
        }
        for (const key of Object.keys(this.qualityPresets)) {
            if (baseKey.includes(key)) {
                const base = this.qualityPresets[key];
                return this._applyOverrides(base, qualityConfig);
            }
        }
        const resolutionMatch = baseKey.match(/(\d+)p/);
        if (resolutionMatch) {
            const height = parseInt(resolutionMatch[1]);
            if (height <= 360) return this._applyOverrides(this.qualityPresets.low, qualityConfig);
            if (height <= 720) return this._applyOverrides(this.qualityPresets.medium, qualityConfig);
        }
        return this._applyOverrides(this.qualityPresets.high, qualityConfig);
    }

    _applyOverrides(basePreset, qualityConfig) {
        if (!qualityConfig) return basePreset;
        const result = Object.assign({}, basePreset);
        if (qualityConfig.video_codec !== null && qualityConfig.video_codec !== undefined) {
            result.videoCodec = qualityConfig.video_codec;
            result.copyVideo = qualityConfig.video_codec === 'copy';
        }
        if (qualityConfig.video_bitrate != null) result.videoBitrate = qualityConfig.video_bitrate;
        if (qualityConfig.video_maxrate != null) result.videoMaxRate = qualityConfig.video_maxrate;
        if (qualityConfig.video_bufsize != null) result.videoBufSize = qualityConfig.video_bufsize;
        if (qualityConfig.video_preset != null) result.videoPreset = qualityConfig.video_preset;
        if (qualityConfig.video_profile != null) result.videoProfile = qualityConfig.video_profile;
        if (qualityConfig.video_level != null) result.videoLevel = qualityConfig.video_level;
        if (qualityConfig.video_resolution != null) result.videoResolution = qualityConfig.video_resolution;
        if (qualityConfig.audio_bitrate != null) result.audioBitrate = qualityConfig.audio_bitrate;
        if (qualityConfig.audio_channels != null) result.audioChannels = String(qualityConfig.audio_channels);
        if (qualityConfig.audio_rate != null) result.audioRate = String(qualityConfig.audio_rate);
        if (qualityConfig.segment_duration != null) result.segmentDuration = qualityConfig.segment_duration;
        return result;
    }

    _cleanTempDir() {
        if (fs.existsSync(this.tempDir)) {
            for (const entry of fs.readdirSync(this.tempDir)) {
                const fullPath = path.join(this.tempDir, entry);
                try {
                    if (fs.statSync(fullPath).isDirectory()) {
                        fs.rmSync(fullPath, { recursive: true, force: true });
                    } else {
                        fs.unlinkSync(fullPath);
                    }
                } catch (e) { /* ignore */ }
            }
        }
    }

    _checkFfmpeg(pathToTest = this.ffmpegPath) {
        try {
            const proc = spawn(pathToTest, ['-version']);
            let errorOccurred = false;

            proc.on('error', (err) => {
                errorOccurred = true;
                console.warn(`HlsConverter: ffmpeg check failed at path "${pathToTest}":`, err.message);
                this._handleFfmpegFailure(pathToTest);
            });

            proc.on('close', (code) => {
                if (errorOccurred) return;

                if (code === 0) {
                    this.ffmpegAvailable = true;
                    this.ffmpegPath = pathToTest;
                    console.log('HlsConverter: ffmpeg is available at', this.ffmpegPath);
                } else {
                    console.warn(`HlsConverter: ffmpeg at "${pathToTest}" exited with code ${code}.`);
                    this._handleFfmpegFailure(pathToTest);
                }
            });
        } catch (e) {
            console.warn(`HlsConverter: spawn threw error for "${pathToTest}":`, e.message);
            this._handleFfmpegFailure(pathToTest);
        }
    }

    _handleFfmpegFailure(failedPath) {
        if (failedPath !== 'ffmpeg') {
            console.log('HlsConverter: Retrying ffmpeg check with system default "ffmpeg"...');
            this._checkFfmpeg('ffmpeg');
        } else {
            this.ffmpegAvailable = false;
            console.warn('HlsConverter: ffmpeg is not available. iOS Safari HLS playback will not work.');
        }
    }

    isAvailable() {
        return this.ffmpegAvailable;
    }

    _getKey(channelId, qualityLabel) {
        return channelId + ':' + qualityLabel;
    }

    _getDir(key) {
        const safeKey = key.replace(/[:/\\]/g, '_');
        return path.join(this.tempDir, safeKey);
    }

    ensureConversion(channelId, qualityLabel, streamUrl, qualityConfig) {
        const key = this._getKey(channelId, qualityLabel);
        const existing = this.activeConversions.get(key);
        if (existing) {
            this._recordAccess(key);
            return existing;
        }

        const dir = this._getDir(key);
        if (fs.existsSync(dir)) {
            for (const f of fs.readdirSync(dir)) {
                try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* ignore */ }
            }
        } else {
            fs.mkdirSync(dir, { recursive: true });
        }

        const state = {
            ffmpegProcess: null,
            dir,
            channelId,
            qualityLabel,
            streamUrl,
            qualityConfig,
            lastAccess: Date.now(),
            idleTimer: null,
            startupTimer: null,
            restartTimer: null,
            restarting: false,
            retryCount: 0,
            manifestReady: false,
            discontinuityCount: 0,
            streamSessionId: Date.now(),
            startNumber: 0,
            started: false
        };

        this.activeConversions.set(key, state);
        this._startFfmpeg(key);

        state.startupTimer = setTimeout(() => {
            if (this.activeConversions.has(key) && !state.manifestReady) {
                console.log('HlsConverter: startup timeout, no manifest produced for', key);
                this.stopConversion(state.channelId, state.qualityLabel);
            }
        }, this.startupTimeout);

        return state;
    }

    ensureConversionWarmup(channelId, qualityLabel, streamUrl, qualityConfig) {
        const key = this._getKey(channelId, qualityLabel);
        const existing = this.activeConversions.get(key);
        if (existing) {
            this._recordAccess(key);
            return;
        }
        this.ensureConversion(channelId, qualityLabel, streamUrl, qualityConfig);
    }

    isManifestReady(channelId, qualityLabel, minSegments = 3) {
        const key = this._getKey(channelId, qualityLabel);
        const state = this.activeConversions.get(key);
        if (!state) return false;
        const manifestPath = path.join(state.dir, 'index.m3u8');
        if (!fs.existsSync(manifestPath)) return false;
        try {
            const content = fs.readFileSync(manifestPath, 'utf8');
            const segmentCount = (content.match(/#EXTINF:/g) || []).length;
            return segmentCount >= minSegments;
        } catch (e) {
            return false;
        }
    }

    _startFfmpeg(key) {
        const state = this.activeConversions.get(key);
        if (!state) return;

        if (state.ffmpegProcess) {
            try { state.ffmpegProcess.kill(); } catch (e) { /* ignore */ }
            state.ffmpegProcess = null;
        }

        if (state.started) {
            state.discontinuityCount++;
        }
        state.started = true;

        let startNumber = 0;
        if (state.restarting || state.retryCount > 0) {
            try {
                if (fs.existsSync(state.dir)) {
                    const files = fs.readdirSync(state.dir);
                    let maxSegmentNum = -1;
                    for (const file of files) {
                        const match = file.match(/^seq_(\d+)\.ts$/);
                        if (match) {
                            const num = parseInt(match[1], 10);
                            if (num > maxSegmentNum) {
                                maxSegmentNum = num;
                            }
                        }
                    }
                    if (maxSegmentNum >= 0) {
                        startNumber = maxSegmentNum + 1;
                    }
                }
            } catch (e) {
                console.error('HlsConverter: failed to calculate start_number', e);
            }
        }
        state.startNumber = startNumber;

        const preset = this._resolvePreset(state.qualityLabel, state.qualityConfig);
        const parsedUrl = new URL(state.streamUrl);
        const args = [];

        if (parsedUrl.username || parsedUrl.password) {
            const auth = Buffer.from(parsedUrl.username + ':' + parsedUrl.password).toString('base64');
            args.push('-headers', 'Authorization: Basic ' + auth + '\r\n');
        }

        const cleanUrl = new URL(state.streamUrl);
        cleanUrl.username = '';
        cleanUrl.password = '';
        const urlWithoutCreds = cleanUrl.toString();

        args.push('-nostdin');
        args.push('-user_agent', 'VLC/3.0.21 Vetinari');
        args.push('-fflags', '+genpts+discardcorrupt+flush_packets');
        args.push('-analyzeduration', '5000000');
        args.push('-probesize', '5000000');
        args.push('-timeout', '15000000');
        args.push('-reconnect', '1');
        args.push('-reconnect_streamed', '1');
        args.push('-reconnect_delay_max', '10');
        args.push('-reconnect_on_network_error', '1');
        args.push('-reconnect_on_http_error', '4xx,5xx');
        args.push('-avoid_negative_ts', 'make_zero');
        args.push('-max_delay', '0');
        args.push('-i', urlWithoutCreds);

        if (preset.copyVideo) {
            args.push('-c:v', 'copy');
        } else {
            args.push('-c:v', preset.videoCodec);
            if (preset.videoPreset) args.push('-preset', preset.videoPreset);
            if (preset.videoTune) args.push('-tune', preset.videoTune);
            if (preset.videoProfile) args.push('-profile:v', preset.videoProfile);
            if (preset.videoLevel) args.push('-level', preset.videoLevel);
            if (preset.videoBitrate) args.push('-b:v', preset.videoBitrate);
            if (preset.videoMaxRate) args.push('-maxrate', preset.videoMaxRate);
            if (preset.videoBufSize) args.push('-bufsize', preset.videoBufSize);
            if (preset.videoResolution) {
                args.push('-vf', 'scale=' + preset.videoResolution.split('x')[0] + ':' + preset.videoResolution.split('x')[1] + ':force_original_aspect_ratio=decrease,pad=' + preset.videoResolution.split('x')[0] + ':' + preset.videoResolution.split('x')[1] + ':(ow-iw)/2:(oh-ih)/2');
            }
            // Force keyframes at segment boundaries so every segment starts with an I-frame.
            // Without this, the player may need to wait for the next keyframe to render,
            // causing visible stalls between segments.
            const segDur = preset.segmentDuration || this.segmentDuration;
            args.push('-force_key_frames', 'expr:gte(t,n_forced*' + segDur + ')');
            args.push('-sc_threshold', '0');
        }

        args.push('-c:a', 'aac');
        args.push('-af', 'aresample=async=50:first_pts=0');
        args.push('-ar', String(preset.audioRate));
        args.push('-ac', String(preset.audioChannels));
        args.push('-b:a', preset.audioBitrate);
        args.push('-mpegts_flags', '+resend_headers');
        args.push('-f', 'hls');

        const segDuration = preset.segmentDuration || this.segmentDuration;
        args.push('-hls_time', String(segDuration));
        args.push('-hls_list_size', String(this.listSize));
        if (startNumber > 0) {
            args.push('-start_number', String(startNumber));
        }
        // temp_file: write segments to .tmp then rename, so player never reads a half-written segment
        // Removed split_by_time: it forced splits at exact time boundaries regardless of keyframes,
        // producing segments that don't start with I-frames and causing decode stalls
        args.push('-hls_flags', 'delete_segments+program_date_time+omit_endlist+independent_segments+temp_file');
        // Keep 4 extra segments on disk after they leave the playlist, so slow players
        // don't get 404s for segments they're still trying to download
        args.push('-hls_delete_threshold', '4');

        const manifestPath = path.join(state.dir, 'index.m3u8').replace(/\\/g, '/');
        const segmentPattern = path.join(state.dir, 'seq_%d.ts').replace(/\\/g, '/');

        args.push('-hls_segment_filename', segmentPattern);
        args.push(manifestPath);

        console.log('HlsConverter: starting ffmpeg for', key, 'preset:', state.qualityLabel.toLowerCase().trim() || 'high', 'video:', preset.copyVideo ? 'copy' : preset.videoBitrate, 'audio:', preset.audioBitrate);

        const proc = spawn(this.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        state.ffmpegProcess = proc;
        state.manifestReady = false;

        proc.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (!msg) return;
            // Skip noisy progress/library info lines
            if (msg.startsWith('frame=') || msg.startsWith('  lib') || msg.startsWith('  configuration:') || msg.startsWith('  built with') || msg.startsWith('size=')) return;
            // Log meaningful messages: errors, warnings, connection issues
            if (msg.includes('Error') || msg.includes('error') || msg.includes('Invalid') || msg.includes('failed') || msg.includes('Connection') || msg.includes('timeout') || msg.includes('403') || msg.includes('404') || msg.includes('refused') || msg.includes('Opening') || msg.includes('Output') || msg.includes('Input') || msg.includes('Stream ') || msg.includes('Duration')) {
                console.log('HlsConverter ffmpeg:', msg.substring(0, 500));
            }
        });

        proc.on('error', (err) => {
            console.error('HlsConverter: ffmpeg spawn error:', err.message);
            state.ffmpegProcess = null;
            this._scheduleRestart(key);
        });

        proc.on('close', (code, signal) => {
            console.log('HlsConverter: ffmpeg exited with code', code, 'signal', signal, 'for', key);
            state.ffmpegProcess = null;
            if (this.activeConversions.has(key) && !state.restarting) {
                this._scheduleRestart(key);
            }
        });
    }

    _scheduleRestart(key) {
        const state = this.activeConversions.get(key);
        if (!state) return;

        if (state.restartTimer) return;

        state.retryCount++;
        if (state.retryCount > this.maxRetries) {
            console.log('HlsConverter: max retries exceeded for', key, ', stopping');
            this.stopConversion(state.channelId, state.qualityLabel);
            return;
        }

        state.restarting = true;
        state.restartTimer = setTimeout(() => {
            state.restartTimer = null;
            state.restarting = false;
            if (this.activeConversions.has(key)) {
                console.log('HlsConverter: restarting ffmpeg for', key, '(retry', state.retryCount, '/', this.maxRetries, ')');
                this._startFfmpeg(key);
            }
        }, this.restartDelay);
    }

    _recordAccess(key) {
        const state = this.activeConversions.get(key);
        if (!state) return;
        state.lastAccess = Date.now();
        if (state.manifestReady) {
            this._scheduleIdleCheck(key);
        }
    }

    _scheduleIdleCheck(key) {
        const state = this.activeConversions.get(key);
        if (!state) return;

        if (state.idleTimer) clearTimeout(state.idleTimer);

        const checkInterval = this.idleTimeout + this.idleGrace;

        state.idleTimer = setTimeout(() => {
            state.idleTimer = null;
            const now = Date.now();
            if (now - state.lastAccess > this.idleTimeout) {
                console.log('HlsConverter: stream idle, stopping', key);
                this.stopConversion(state.channelId, state.qualityLabel);
            } else {
                this._scheduleIdleCheck(key);
            }
        }, checkInterval);
    }

    getManifest(channelId, qualityLabel) {
        const key = this._getKey(channelId, qualityLabel);
        const state = this.activeConversions.get(key);
        if (!state) return null;

        this._recordAccess(key);

        const manifestPath = path.join(state.dir, 'index.m3u8');
        if (!fs.existsSync(manifestPath)) {
            return null;
        }

        try {
            const content = fs.readFileSync(manifestPath, 'utf8');
            if (!content.includes('.ts')) {
                return null;
            }
            if (!state.manifestReady) {
                state.manifestReady = true;
                state.retryCount = 0; // Reset retry count on successful manifest
                if (state.startupTimer) {
                    clearTimeout(state.startupTimer);
                    state.startupTimer = null;
                }
                this._scheduleIdleCheck(key);
                console.log('HlsConverter: manifest ready for', key);
            }
            return content;
        } catch (e) {
            return null;
        }
    }

    waitForManifest(channelId, qualityLabel, timeoutMs) {
        const maxWait = timeoutMs || this.manifestWaitTimeout;
        const startTime = Date.now();
        const pollInterval = 500;

        return new Promise((resolve) => {
            const poll = () => {
                const manifest = this.getManifest(channelId, qualityLabel);
                if (manifest) {
                    resolve(manifest);
                    return;
                }

                if (Date.now() - startTime >= maxWait) {
                    resolve(null);
                    return;
                }

                setTimeout(poll, pollInterval);
            };
            poll();
        });
    }

    rewriteManifest(manifestContent, sessionToken, discontinuityCount, streamSessionId, startNumber) {
        let hasPlaylistType = false;
        let hasIndependentSegments = false;
        let hasDiscontinuitySequence = false;
        const lines = manifestContent.split('\n').flatMap(line => {
            if (line.startsWith('#EXT-X-PLAYLIST-TYPE')) {
                hasPlaylistType = true;
                return ['#EXT-X-PLAYLIST-TYPE:LIVE'];
            }
            if (line.startsWith('#EXT-X-INDEPENDENT-SEGMENTS')) {
                hasIndependentSegments = true;
            }
            if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE')) {
                hasDiscontinuitySequence = true;
                // Replace with our tracked count
                return ['#EXT-X-DISCONTINUITY-SEQUENCE:' + (discontinuityCount || 0)];
            }
            if (line.startsWith('#EXT-X-ENDLIST')) {
                return [];
            }
            if (line.match(/^seq_\d+\.ts/) && !line.includes('?session=')) {
                const rewrittenLine = line + '?session=' + sessionToken + '&_d=' + (discontinuityCount || 0) + '&_s=' + (streamSessionId || 0);
                if (startNumber > 0 && line === `seq_${startNumber}.ts`) {
                    return ['#EXT-X-DISCONTINUITY', rewrittenLine];
                }
                return [rewrittenLine];
            }
            return [line];
        }).filter(line => line !== null);

        const versionIdx = lines.findIndex(l => l.startsWith('#EXT-X-VERSION'));
        const insertIdx = versionIdx !== -1 ? versionIdx + 1 : 1;

        if (!hasPlaylistType) {
            lines.splice(insertIdx, 0, '#EXT-X-PLAYLIST-TYPE:LIVE');
        }

        if (!hasIndependentSegments) {
            const ptIdx = lines.findIndex(l => l.startsWith('#EXT-X-PLAYLIST-TYPE'));
            const indInsertIdx = ptIdx !== -1 ? ptIdx + 1 : insertIdx + 1;
            lines.splice(indInsertIdx, 0, '#EXT-X-INDEPENDENT-SEGMENTS');
        }

        // Add discontinuity sequence tag if FFmpeg has restarted
        // This tells the player to expect timestamp jumps between segments
        if (!hasDiscontinuitySequence && discontinuityCount > 0) {
            const ptIdx = lines.findIndex(l => l.startsWith('#EXT-X-PLAYLIST-TYPE'));
            const discInsertIdx = ptIdx !== -1 ? ptIdx + 1 : insertIdx + 1;
            lines.splice(discInsertIdx, 0, '#EXT-X-DISCONTINUITY-SEQUENCE:' + discontinuityCount);
        }

        return lines.join('\n');
    }

    getDiscontinuityCount(channelId, qualityLabel) {
        const key = this._getKey(channelId, qualityLabel);
        const state = this.activeConversions.get(key);
        return state ? state.discontinuityCount : 0;
    }

    getStartNumber(channelId, qualityLabel) {
        const key = this._getKey(channelId, qualityLabel);
        const state = this.activeConversions.get(key);
        return state ? state.startNumber : 0;
    }

    getStreamSessionId(channelId, qualityLabel) {
        const key = this._getKey(channelId, qualityLabel);
        const state = this.activeConversions.get(key);
        return state ? state.streamSessionId : 0;
    }

    getSegmentPath(channelId, qualityLabel, segmentName) {
        if (!segmentName.match(/^seq_\d+\.ts$/)) return null;

        const key = this._getKey(channelId, qualityLabel);
        const state = this.activeConversions.get(key);
        if (!state) return null;

        this._recordAccess(key);

        const filePath = path.join(state.dir, segmentName);
        if (!fs.existsSync(filePath)) return null;

        return filePath;
    }

    stopConversion(channelId, qualityLabel) {
        const key = this._getKey(channelId, qualityLabel);
        const state = this.activeConversions.get(key);
        if (!state) return;

        if (state.idleTimer) clearTimeout(state.idleTimer);
        if (state.startupTimer) clearTimeout(state.startupTimer);
        if (state.restartTimer) clearTimeout(state.restartTimer);
        if (state.ffmpegProcess) {
            try { state.ffmpegProcess.kill(); } catch (e) { /* ignore */ }
            state.ffmpegProcess = null;
        }

        if (fs.existsSync(state.dir)) {
            for (const f of fs.readdirSync(state.dir)) {
                try { fs.unlinkSync(path.join(state.dir, f)); } catch (e) { /* ignore */ }
            }
            try { fs.rmdirSync(state.dir); } catch (e) { /* ignore */ }
        }

        this.activeConversions.delete(key);
        console.log('HlsConverter: stopped conversion for', key);
    }

    stopAllForChannel(channelId) {
        // Collect keys first to avoid modifying Map during iteration
        const keysToStop = [];
        for (const key of this.activeConversions.keys()) {
            if (key.startsWith(channelId + ':')) {
                keysToStop.push(key);
            }
        }
        for (const key of keysToStop) {
            const state = this.activeConversions.get(key);
            if (state) this.stopConversion(state.channelId, state.qualityLabel);
        }
    }

    stopAll() {
        // Collect keys first to avoid modifying Map during iteration
        const keysToStop = Array.from(this.activeConversions.keys());
        for (const key of keysToStop) {
            const state = this.activeConversions.get(key);
            if (state) this.stopConversion(state.channelId, state.qualityLabel);
        }
    }
}

module.exports = HlsConverter;
