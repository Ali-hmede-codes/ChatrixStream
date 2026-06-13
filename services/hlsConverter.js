const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

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
                        for (const f of fs.readdirSync(fullPath)) {
                            fs.unlinkSync(path.join(fullPath, f));
                        }
                        fs.rmdirSync(fullPath);
                    } else {
                        fs.unlinkSync(fullPath);
                    }
                } catch (e) { /* ignore */ }
            }
        }
    }

    _checkFfmpeg() {
        try {
            const proc = spawn(this.ffmpegPath, ['-version']);
            let outputReceived = false;
            proc.on('error', () => {
                this.ffmpegAvailable = false;
                console.warn('HlsConverter: ffmpeg not found at path:', this.ffmpegPath, '. iOS Safari HLS playback will not work.');
            });
            proc.stdout.on('data', () => { outputReceived = true; });
            proc.stderr.on('data', () => { outputReceived = true; });
            proc.on('close', (code) => {
                this.ffmpegAvailable = (code === 0);
                if (this.ffmpegAvailable) {
                    console.log('HlsConverter: ffmpeg is available at', this.ffmpegPath);
                } else {
                    console.warn('HlsConverter: ffmpeg not available (exit code', code, '). iOS Safari HLS playback will not work.');
                }
            });
        } catch (e) {
            this.ffmpegAvailable = false;
            console.warn('HlsConverter: ffmpeg check failed:', e.message);
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

    ensureConversion(channelId, qualityLabel, streamUrl) {
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
            lastAccess: Date.now(),
            idleTimer: null,
            startupTimer: null,
            restartTimer: null,
            restarting: false,
            retryCount: 0,
            manifestReady: false
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

    ensureConversionWarmup(channelId, qualityLabel, streamUrl) {
        const key = this._getKey(channelId, qualityLabel);
        const existing = this.activeConversions.get(key);
        if (existing) {
            this._recordAccess(key);
            return;
        }
        this.ensureConversion(channelId, qualityLabel, streamUrl);
    }

    isManifestReady(channelId, qualityLabel) {
        const key = this._getKey(channelId, qualityLabel);
        const state = this.activeConversions.get(key);
        if (!state) return false;
        const manifestPath = path.join(state.dir, 'index.m3u8');
        if (!fs.existsSync(manifestPath)) return false;
        try {
            const content = fs.readFileSync(manifestPath, 'utf8');
            return content.includes('.ts');
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
        args.push('-fflags', '+genpts+discardcorrupt');
        args.push('-analyzeduration', '2000000');
        args.push('-probesize', '500000');
        args.push('-timeout', '10000000');
        args.push('-reconnect', '1');
        args.push('-reconnect_streamed', '1');
        args.push('-reconnect_delay_max', '5');
        args.push('-avoid_negative_ts', 'make_zero');
        args.push('-i', urlWithoutCreds);
        args.push('-c:v', 'copy');
        args.push('-c:a', 'aac');
        args.push('-ar', '48000');
        args.push('-ac', '2');
        args.push('-b:a', '128k');
        args.push('-f', 'hls');
        args.push('-hls_time', String(this.segmentDuration));
        args.push('-hls_list_size', String(this.listSize));
        args.push('-hls_flags', 'delete_segments+program_date_time+omit_endlist');

        const manifestPath = path.join(state.dir, 'index.m3u8').replace(/\\/g, '/');
        const segmentPattern = path.join(state.dir, 'seq_%d.ts').replace(/\\/g, '/');

        args.push('-hls_segment_filename', segmentPattern);
        args.push(manifestPath);

        console.log('HlsConverter: starting ffmpeg for', key);

        const proc = spawn(this.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        state.ffmpegProcess = proc;
        state.manifestReady = false;

        proc.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg && (msg.includes('Error') || msg.includes('error') || msg.includes('Invalid') || msg.includes('failed') || msg.includes('Connection') || msg.includes('timeout') || !msg.startsWith('frame=') && !msg.startsWith('  lib'))) {
                console.log('HlsConverter ffmpeg:', msg);
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
                if (state.startupTimer) {
                    clearTimeout(state.startupTimer);
                    state.startupTimer = null;
                }
                this._scheduleIdleCheck(key);
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

    rewriteManifest(manifestContent, sessionToken) {
        let hasPlaylistType = false;
        let hasIndependentSegments = false;
        const lines = manifestContent.split('\n').map(line => {
            if (line.startsWith('#EXT-X-PLAYLIST-TYPE')) {
                hasPlaylistType = true;
                return '#EXT-X-PLAYLIST-TYPE:LIVE';
            }
            if (line.startsWith('#EXT-X-INDEPENDENT-SEGMENTS')) {
                hasIndependentSegments = true;
            }
            if (line.startsWith('#EXT-X-ENDLIST')) {
                return null;
            }
            if (line.match(/^seq_\d+\.ts/) && !line.includes('?session=')) {
                return line + '?session=' + sessionToken;
            }
            return line;
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

        return lines.join('\n');
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
        for (const key of this.activeConversions.keys()) {
            if (key.startsWith(channelId + ':')) {
                const state = this.activeConversions.get(key);
                this.stopConversion(state.channelId, state.qualityLabel);
            }
        }
    }

    stopAll() {
        for (const key of this.activeConversions.keys()) {
            const state = this.activeConversions.get(key);
            this.stopConversion(state.channelId, state.qualityLabel);
        }
    }
}

module.exports = HlsConverter;
