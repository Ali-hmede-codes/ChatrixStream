const { spawn } = require('child_process');
const path = require('path');

class FFmpegBridge {
    constructor(options = {}) {
        this.ffmpegPath = options.ffmpegPath || 'ffmpeg';
        this.rtspHost = options.rtspHost || 'localhost';
        this.rtspPort = options.rtspPort || 8554;
        this.restartDelay = options.restartDelay || 3000;
        this.maxRestartAttempts = options.maxRestartAttempts || 5;
        this.minRuntimeMs = options.minRuntimeMs || 10000;

        this.processes = new Map();
        this._ffmpegAvailable = null;
    }

    async isFFmpegAvailable() {
        if (this._ffmpegAvailable !== null) return this._ffmpegAvailable;

        return new Promise((resolve) => {
            try {
                const proc = spawn(this.ffmpegPath, ['-version'], {
                    stdio: 'pipe',
                    windowsHide: true,
                    timeout: 5000
                });
                let output = '';
                proc.stdout.on('data', (data) => { output += data.toString(); });
                proc.stderr.on('data', (data) => { output += data.toString(); });
                proc.on('close', (code) => {
                    this._ffmpegAvailable = code === 0 && output.length > 0;
                    resolve(this._ffmpegAvailable);
                });
                proc.on('error', () => {
                    this._ffmpegAvailable = false;
                    resolve(false);
                });
                setTimeout(() => {
                    try { proc.kill(); } catch (_) {}
                    this._ffmpegAvailable = false;
                    resolve(false);
                }, 5000);
            } catch (e) {
                this._ffmpegAvailable = false;
                resolve(false);
            }
        });
    }

    needsBridge(streamUrl) {
        try {
            const parsed = new URL(streamUrl);
            return parsed.protocol === 'http:' || parsed.protocol === 'https:';
        } catch (e) {
            return false;
        }
    }

    startBridge(pathName, streamUrl, qualityConfig) {
        const existing = this.processes.get(pathName);
        if (existing && existing.process && !existing.process.killed) {
            existing.lastStart = Date.now();
            existing.attempts = 0;
            return existing;
        }

        if (existing && existing.restartTimer) {
            clearTimeout(existing.restartTimer);
            existing.restartTimer = null;
        }

        return this._startProcess(pathName, streamUrl, qualityConfig);
    }

    _buildFFmpegArgs(streamUrl, qualityConfig, rtspUrl) {
        const args = ['-loglevel', 'warning', '-fflags', '+genpts+noparsegenpts', '-flags', '+global_header'];

        args.push('-i', streamUrl);

        const isCopy = !qualityConfig || !qualityConfig.video_codec || qualityConfig.video_codec === 'copy';

        if (isCopy) {
            args.push('-c:v', 'copy');
            if (qualityConfig && qualityConfig.audio_codec && qualityConfig.audio_codec !== 'copy') {
                args.push('-c:a', qualityConfig.audio_codec);
                if (qualityConfig.audio_bitrate) args.push('-b:a', qualityConfig.audio_bitrate);
                if (qualityConfig.audio_channels) args.push('-ac', String(qualityConfig.audio_channels));
                if (qualityConfig.audio_rate) args.push('-ar', String(qualityConfig.audio_rate));
            } else {
                args.push('-c:a', 'copy');
            }
        } else {
            args.push('-c:v', qualityConfig.video_codec || 'libx264');
            if (qualityConfig.video_bitrate) args.push('-b:v', qualityConfig.video_bitrate);
            if (qualityConfig.video_maxrate) args.push('-maxrate', qualityConfig.video_maxrate);
            if (qualityConfig.video_bufsize) args.push('-bufsize', qualityConfig.video_bufsize);
            if (qualityConfig.video_preset) args.push('-preset', qualityConfig.video_preset);
            if (qualityConfig.video_profile) args.push('-profile:v', qualityConfig.video_profile);
            if (qualityConfig.video_level) args.push('-level', qualityConfig.video_level);
            if (qualityConfig.video_resolution) args.push('-s', qualityConfig.video_resolution);
            args.push('-g', '60');

            const aCodec = qualityConfig.audio_codec || 'aac';
            args.push('-c:a', aCodec);
            if (qualityConfig.audio_bitrate) args.push('-b:a', qualityConfig.audio_bitrate);
            else if (aCodec !== 'copy') args.push('-b:a', '64k');
            if (qualityConfig.audio_channels) args.push('-ac', String(qualityConfig.audio_channels));
            else if (aCodec !== 'copy') args.push('-ac', '2');
            if (qualityConfig.audio_rate) args.push('-ar', String(qualityConfig.audio_rate));
        }

        args.push('-rtsp_transport', 'tcp');
        args.push('-f', 'rtsp');
        args.push(rtspUrl);

        return args;
    }

    _startProcess(pathName, streamUrl, qualityConfig) {
        const rtspUrl = 'rtsp://' + this.rtspHost + ':' + this.rtspPort + '/' + pathName;
        const args = this._buildFFmpegArgs(streamUrl, qualityConfig, rtspUrl);

        console.log('FFmpegBridge: starting for', pathName);

        const proc = spawn(this.ffmpegPath, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true
        });

        const state = {
            process: proc,
            pathName,
            streamUrl,
            qualityConfig,
            attempts: 0,
            lastStart: Date.now(),
            restartTimer: null,
            stderrBuffer: ''
        };

        proc.stderr.on('data', (data) => {
            const text = data.toString();
            state.stderrBuffer += text;
            const lines = text.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed && (trimmed.includes('Error') || trimmed.includes('error') || trimmed.includes('Invalid') || trimmed.includes['failed'] || trimmed.includes('Connection refused'))) {
                    console.warn('FFmpegBridge [' + pathName + ']:', trimmed);
                }
            }
            if (state.stderrBuffer.length > 20000) {
                state.stderrBuffer = state.stderrBuffer.slice(-5000);
            }
        });

        proc.stdout.on('data', (data) => {
            // ffmpeg stdout is usually empty for RTSP push, ignore
        });

        proc.on('close', (code, signal) => {
            const runtime = Date.now() - state.lastStart;
            console.log('FFmpegBridge: process for', pathName, 'exited (code=' + code + ', runtime=' + (runtime / 1000).toFixed(1) + 's)');

            const shouldRestart = code !== 0 && code !== 255
                && runtime > this.minRuntimeMs
                && state.attempts < this.maxRestartAttempts;

            this.processes.delete(pathName);

            if (shouldRestart) {
                state.attempts++;
                const delay = this.restartDelay * state.attempts;
                console.log('FFmpegBridge: restarting', pathName, '(attempt', state.attempts, ', delay', delay + 'ms)');
                state.restartTimer = setTimeout(() => {
                    state.restartTimer = null;
                    this._startProcess(pathName, streamUrl, qualityConfig);
                }, delay);
            } else if (code !== 0 && runtime <= this.minRuntimeMs) {
                console.error('FFmpegBridge:', pathName, 'crashed immediately — likely bad source URL or codec error. NOT restarting.');
                this.processes.delete(pathName);
            }
        });

        proc.on('error', (err) => {
            console.error('FFmpegBridge: process spawn error for', pathName, err.message);
            this.processes.delete(pathName);
        });

        this.processes.set(pathName, state);
        return state;
    }

    stopBridge(pathName) {
        const state = this.processes.get(pathName);
        if (!state) return;

        if (state.restartTimer) {
            clearTimeout(state.restartTimer);
            state.restartTimer = null;
        }

        state.attempts = this.maxRestartAttempts + 1;

        if (state.process && !state.process.killed) {
            try {
                state.process.stdin.write('q');
            } catch (_) {}

            const forceKillTimer = setTimeout(() => {
                try {
                    if (state.process && !state.process.killed) {
                        state.process.kill('SIGKILL');
                    }
                } catch (_) {}
            }, 3000);

            state.process.on('close', () => {
                clearTimeout(forceKillTimer);
            });

            try {
                state.process.kill('SIGTERM');
            } catch (_) {}
        }

        this.processes.delete(pathName);
        console.log('FFmpegBridge: stopped bridge for', pathName);
    }

    isRunning(pathName) {
        const state = this.processes.get(pathName);
        if (!state) return false;
        if (!state.process) return false;
        if (state.process.killed) return false;
        if (state.process.exitCode !== null) return false;
        return true;
    }

    getLastError(pathName) {
        const state = this.processes.get(pathName);
        if (!state) return null;
        const lines = state.stderrBuffer.split('\n').filter(l => l.trim());
        const errorLines = lines.filter(l =>
            l.includes('Error') || l.includes('error') || l.includes('Invalid') || l.includes('Connection refused')
        );
        return errorLines.length > 0 ? errorLines[errorLines.length - 1].trim() : null;
    }

    stopAll() {
        const pathNames = Array.from(this.processes.keys());
        for (const pathName of pathNames) {
            this.stopBridge(pathName);
        }
        console.log('FFmpegBridge: stopped all bridges');
    }

    destroy() {
        this.stopAll();
    }

    listRunning() {
        const result = [];
        for (const [pathName, state] of this.processes) {
            if (this.isRunning(pathName)) {
                result.push({
                    pathName,
                    streamUrl: state.streamUrl,
                    runtime: ((Date.now() - state.lastStart) / 1000).toFixed(1) + 's'
                });
            }
        }
        return result;
    }
}

module.exports = FFmpegBridge;
