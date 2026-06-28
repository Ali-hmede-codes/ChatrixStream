const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { QUALITY_PRESETS, resolvePreset } = require('./qualityPresets');

// Simple LRU cache for segment data (in-memory)
class SegmentLRU {
    constructor(maxSize) {
        this.maxSize = maxSize;
        this.cache = new Map();
    }
    get(name) {
        const entry = this.cache.get(name);
        if (!entry) return null;
        // Move to end (most recently used)
        this.cache.delete(name);
        this.cache.set(name, entry);
        return entry;
    }
    set(name, data) {
        if (this.cache.has(name)) {
            this.cache.delete(name);
        } else if (this.cache.size >= this.maxSize) {
            // Evict oldest (first entry)
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        this.cache.set(name, data);
    }
    clear() {
        this.cache.clear();
    }
}

class HlsConverter {
    constructor(options = {}) {
        this.activeConversions = new Map();
        this.tempDir = options.tempDir || path.join(process.cwd(), 'tmp', 'hls');
        this.segmentDuration = options.segmentDuration || 2;
        this.listSize = options.listSize || 10;
        this.idleTimeout = options.idleTimeout || 30000;
        this.idleGrace = options.idleGrace || 5000;
        this.restartDelay = options.restartDelay || 3000;
        this.maxRetries = options.maxRetries || 5;
        this.manifestWaitTimeout = options.manifestWaitTimeout || 15000;
        this.startupTimeout = options.startupTimeout || 60000;
        this.ffmpegPath = options.ffmpegPath || 'ffmpeg';
        this.ffmpegAvailable = false;
        this.qualityPresets = options.qualityPresets || QUALITY_PRESETS;
        this.segmentCacheSize = options.segmentCacheSize || 40;

        this._cleanTempDir();
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
        this._checkFfmpeg();
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
            started: false,
            // In-memory caches to avoid disk I/O per viewer
            cachedManifest: null,
            cachedManifestTime: 0,
            segmentCache: new SegmentLRU(this.segmentCacheSize)
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

    async isManifestReady(channelId, qualityLabel, minSegments = 3) {
        const key = this._getKey(channelId, qualityLabel);
        const state = this.activeConversions.get(key);
        if (!state) return false;
        const manifestPath = path.join(state.dir, 'index.m3u8');
        try {
            const content = await fs.promises.readFile(manifestPath, 'utf8');
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
            try {
                state.ffmpegProcess.stdout.destroy();
                state.ffmpegProcess.stderr.destroy();
                state.ffmpegProcess.kill('SIGKILL');
            } catch (e) { /* ignore */ }
            state.ffmpegProcess = null;
        }

        if (state.started) {
            state.discontinuityCount++;
        }
        state.started = true;

        // Delete old manifest to prevent serving stale content after restart.
        // Without this, getManifest() reads the old manifest from disk and serves
        // minutes-old segments to the player, causing the "loads old seq" bug.
        const oldManifestPath = path.join(state.dir, 'index.m3u8');
        try { fs.unlinkSync(oldManifestPath); } catch (e) { /* may not exist on first start */ }

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

        const preset = resolvePreset(state.qualityLabel, state.qualityConfig, this.qualityPresets);
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
        args.push('-threads', '0');
        args.push('-thread_queue_size', '512');
        args.push('-user_agent', 'VLC/3.0.21 Vetinari');
        args.push('-fflags', '+nobuffer+genpts+discardcorrupt+flush_packets');
        args.push('-analyzeduration', '1000000');
        args.push('-probesize', '1000000');
        args.push('-rw_timeout', '15000000');
        args.push('-reconnect', '1');
        args.push('-reconnect_at_eof', '1');
        args.push('-reconnect_streamed', '1');
        args.push('-reconnect_delay_max', '10');
        args.push('-reconnect_on_network_error', '1');
        args.push('-reconnect_on_http_error', '4xx,5xx');
        args.push('-avoid_negative_ts', 'make_zero');
        args.push('-i', urlWithoutCreds);

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
                args.push('-vf', 'scale=' + preset.videoResolution.split('x')[0] + ':' + preset.videoResolution.split('x')[1] + ':force_original_aspect_ratio=decrease,pad=' + preset.videoResolution.split('x')[0] + ':' + preset.videoResolution.split('x')[1] + ':(ow-iw)/2:(oh-ih)/2');
            }
            const segDur = preset.segmentDuration || this.segmentDuration;
            args.push('-force_key_frames', 'expr:gte(t,n_forced*' + segDur + ')');
            args.push('-sc_threshold', '0');
        }

        args.push('-c:a', 'aac');
        args.push('-threads:a', '0');
        args.push('-af', 'aresample=async=1000');
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
        args.push('-fflags', '+flush_packets');
        args.push('-hls_delete_threshold', '6');

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

        const checkInterval = 5000;

        state.idleTimer = setTimeout(() => {
            const currentState = this.activeConversions.get(key);
            if (!currentState) return;
            
            currentState.idleTimer = null;
            const now = Date.now();
            
            if (now - currentState.lastAccess > this.idleTimeout) {
                console.log('HlsConverter: stream idle, stopping', key);
                this.stopConversion(currentState.channelId, currentState.qualityLabel);
                return;
            }

            if (currentState.ffmpegProcess && currentState.manifestReady) {
                const manifestPath = path.join(currentState.dir, 'index.m3u8');
                try {
                    if (fs.existsSync(manifestPath)) {
                        const stats = fs.statSync(manifestPath);
                        if (now - stats.mtimeMs > 15000) {
                            console.log('HlsConverter: watchdog detected stalled stream (no manifest update in 15s) for', key);
                            currentState.ffmpegProcess.kill('SIGKILL');
                        }
                    }
                } catch (e) {
                    console.error('HlsConverter: watchdog error', e);
                }
            }

            this._scheduleIdleCheck(key);
        }, checkInterval);
    }

    async getManifest(channelId, qualityLabel) {
        const key = this._getKey(channelId, qualityLabel);
        const state = this.activeConversions.get(key);
        if (!state) return null;

        this._recordAccess(key);

        // Serve from in-memory cache if fresh (updated every 500ms max)
        const now = Date.now();
        if (state.cachedManifest && state.manifestReady && (now - state.cachedManifestTime) < 500) {
            return state.cachedManifest;
        }

        const manifestPath = path.join(state.dir, 'index.m3u8');

        try {
            await fs.promises.access(manifestPath);
        } catch (e) {
            return null;
        }

        try {
            const content = await fs.promises.readFile(manifestPath, 'utf8');
            if (!content.includes('.ts')) {
                return null;
            }
            // After a restart, don't serve the manifest until FFmpeg has produced
            // enough segments for smooth playback. Without this gate, a 1-segment
            // manifest causes immediate buffer underrun and stalling.
            if (!state.manifestReady) {
                const segmentCount = (content.match(/#EXTINF:/g) || []).length;
                if (segmentCount < 3) {
                    return null;
                }
                state.manifestReady = true;
                state.retryCount = 0;
                if (state.startupTimer) {
                    clearTimeout(state.startupTimer);
                    state.startupTimer = null;
                }
                this._scheduleIdleCheck(key);
                console.log('HlsConverter: manifest ready for', key);
            }
            // Update in-memory cache
            state.cachedManifest = content;
            state.cachedManifestTime = now;
            return content;
        } catch (e) {
            return null;
        }
    }

    async waitForManifest(channelId, qualityLabel, timeoutMs) {
        const maxWait = timeoutMs || this.manifestWaitTimeout;
        const startTime = Date.now();
        const pollInterval = 500;

        return new Promise((resolve) => {
            const poll = async () => {
                const manifest = await this.getManifest(channelId, qualityLabel);
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
        let hasIndependentSegments = false;
        let hasDiscontinuitySequence = false;
        let mediaSequence = 0;

        const lines = manifestContent.split('\n');
        
        for (const line of lines) {
            if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
                mediaSequence = parseInt(line.split(':')[1], 10);
            }
        }

        let currentDiscontinuitySeq = discontinuityCount;
        if (startNumber > 0 && mediaSequence <= startNumber) {
            currentDiscontinuitySeq = Math.max(0, discontinuityCount - 1);
        }

        const rewrittenLines = lines.flatMap(line => {
            if (line.startsWith('#EXT-X-PLAYLIST-TYPE')) {
                return [];
            }
            if (line.startsWith('#EXT-X-INDEPENDENT-SEGMENTS')) {
                hasIndependentSegments = true;
            }
            if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE')) {
                hasDiscontinuitySequence = true;
                return ['#EXT-X-DISCONTINUITY-SEQUENCE:' + currentDiscontinuitySeq];
            }
            if (line.startsWith('#EXT-X-ENDLIST')) {
                return [];
            }
            if (line.match(/^seq_\d+\.ts/) && !line.includes('?session=')) {
                const rewrittenLine = line + '?session=' + sessionToken + '&_d=' + (discontinuityCount || 0) + '&_s=' + (streamSessionId || 0);
                
                const match = line.match(/^seq_(\d+)\.ts/);
                if (match && parseInt(match[1], 10) === startNumber && startNumber > 0) {
                    return ['#EXT-X-DISCONTINUITY', rewrittenLine];
                }

                return [rewrittenLine];
            }
            return [line];
        }).filter(line => line !== null);

        const versionIdx = rewrittenLines.findIndex(l => l.startsWith('#EXT-X-VERSION'));
        const insertIdx = versionIdx !== -1 ? versionIdx + 1 : 1;

        if (!hasIndependentSegments) {
            rewrittenLines.splice(insertIdx, 0, '#EXT-X-INDEPENDENT-SEGMENTS');
        }

        const startOffsetIdx = rewrittenLines.findIndex(l => l.startsWith('#EXT-X-INDEPENDENT-SEGMENTS'));
        const finalInsertIdx = startOffsetIdx !== -1 ? startOffsetIdx + 1 : insertIdx;
        rewrittenLines.splice(finalInsertIdx, 0, '#EXT-X-START:TIME-OFFSET=-6.0');

        if (!hasDiscontinuitySequence && discontinuityCount > 0) {
            const indIdx = rewrittenLines.findIndex(l => l.startsWith('#EXT-X-INDEPENDENT-SEGMENTS'));
            const discInsertIdx = indIdx !== -1 ? indIdx + 1 : insertIdx + 1;
            rewrittenLines.splice(discInsertIdx, 0, '#EXT-X-DISCONTINUITY-SEQUENCE:' + currentDiscontinuitySeq);
        }

        return rewrittenLines.join('\n');
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

    /**
     * Get segment data from in-memory cache, or read from disk and cache it.
     * Returns { data: Buffer, size: number, etag: string } or null if not found.
     * The ETag is computed once on cache miss and stored alongside the segment.
     */
    async getSegmentData(channelId, qualityLabel, segmentName) {
        if (!segmentName.match(/^seq_\d+\.ts$/)) return null;

        const key = this._getKey(channelId, qualityLabel);
        const state = this.activeConversions.get(key);
        if (!state) return null;

        this._recordAccess(key);

        // Check in-memory cache first
        const cached = state.segmentCache.get(segmentName);
        if (cached) return cached;

        // Read from disk and cache
        const filePath = path.join(state.dir, segmentName);
        try {
            const data = await fs.promises.readFile(filePath);
            const etag = '"' + crypto.createHash('md5').update(data).digest('hex') + '"';
            const entry = { data, size: data.length, etag };
            state.segmentCache.set(segmentName, entry);
            return entry;
        } catch (e) {
            return null;
        }
    }

    stopConversion(channelId, qualityLabel) {
        const key = this._getKey(channelId, qualityLabel);
        const state = this.activeConversions.get(key);
        if (!state) return;

        if (state.idleTimer) clearTimeout(state.idleTimer);
        if (state.startupTimer) clearTimeout(state.startupTimer);
        if (state.restartTimer) clearTimeout(state.restartTimer);
        if (state.ffmpegProcess) {
            try {
                state.ffmpegProcess.stdout.destroy();
                state.ffmpegProcess.stderr.destroy();
                state.ffmpegProcess.kill('SIGKILL');
            } catch (e) { /* ignore */ }
            state.ffmpegProcess = null;
        }

        // Clear in-memory caches
        state.cachedManifest = null;
        state.segmentCache.clear();

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
