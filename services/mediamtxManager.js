const http = require('http');
const https = require('https');

class MediaMTXManager {
    constructor(options = {}) {
        this.apiUrl = options.apiUrl || 'http://localhost:9997';
        this.hlsUrl = options.hlsUrl || 'http://localhost:8888';
        this.rtspUrl = options.rtspUrl || 'rtsp://localhost:8554';
        this.idleTimeout = options.idleTimeout || 60000;
        this.startupTimeout = options.startupTimeout || 30000;
        this.ffmpegBridge = options.ffmpegBridge || null;

        this.activePaths = new Map();
        this._idleCheckInterval = setInterval(() => this._cleanupIdlePaths(), 30000);
    }

    getPathName(channelId, qualityLabel) {
        return channelId + '_' + qualityLabel;
    }

    _apiRequest(method, path, body) {
        return new Promise((resolve, reject) => {
            const url = new URL(this.apiUrl + path);
            const isHttps = url.protocol === 'https:';
            const requester = isHttps ? https : http;

            const options = {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname + url.search,
                method: method,
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                timeout: 5000
            };

            if (url.username && url.password) {
                const auth = Buffer.from(url.username + ':' + url.password).toString('base64');
                options.headers['Authorization'] = 'Basic ' + auth;
            }

            const req = requester.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            resolve(data ? JSON.parse(data) : null);
                        } catch (e) {
                            resolve(data);
                        }
                    } else {
                        const err = new Error('MediaMTX API error: ' + res.statusCode + ' ' + data);
                        err.statusCode = res.statusCode;
                        reject(err);
                    }
                });
            });

            req.on('error', (err) => reject(err));
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('MediaMTX API timeout'));
            });

            if (body) {
                req.write(JSON.stringify(body));
            }
            req.end();
        });
    }

    async isAvailable() {
        try {
            await this._apiRequest('GET', '/v3/paths/list');
            return true;
        } catch (e) {
            return false;
        }
    }

    _isBridgeSource(streamUrl) {
        if (!this.ffmpegBridge) return false;
        return this.ffmpegBridge.needsBridge(streamUrl);
    }

    async ensurePath(channelId, qualityLabel, streamUrl, qualityConfig) {
        const pathName = this.getPathName(channelId, qualityLabel);

        const existing = this.activePaths.get(pathName);
        if (existing) {
            existing.lastAccess = Date.now();

            if (existing.bridgeMode && this.ffmpegBridge) {
                if (!this.ffmpegBridge.isRunning(pathName)) {
                    this.ffmpegBridge.startBridge(pathName, streamUrl, qualityConfig);
                }
            }
            return existing;
        }

        const bridgeMode = this._isBridgeSource(streamUrl);

        if (bridgeMode) {
            const ffmpegAvailable = await this.ffmpegBridge.isFFmpegAvailable();
            if (!ffmpegAvailable) {
                throw new Error('ffmpeg is required for HTTP source streams but is not installed. Install ffmpeg and ensure it is in PATH.');
            }
        }

        return this._createPath(pathName, channelId, qualityLabel, streamUrl, qualityConfig, bridgeMode);
    }

    async _createPath(pathName, channelId, qualityLabel, streamUrl, qualityConfig, bridgeMode) {
        if (bridgeMode) {
            await this._createPublisherPath(pathName);
            this.ffmpegBridge.startBridge(pathName, streamUrl, qualityConfig);
        } else {
            await this._createSourcePath(pathName, streamUrl);
        }

        const state = {
            pathName,
            channelId,
            qualityLabel,
            streamUrl,
            qualityConfig,
            bridgeMode,
            lastAccess: Date.now()
        };

        this.activePaths.set(pathName, state);
        console.log('MediaMTXManager: created path', pathName, bridgeMode ? '(ffmpeg bridge)' : '(direct source)', bridgeMode ? '' : 'source:', streamUrl);
        return state;
    }

    async _createPublisherPath(pathName) {
        try {
            await this._apiRequest('POST', '/v3/config/paths/add/' + pathName, {
                sourceOnDemand: false,
                hlsMuxerCloseAfter: '120s'
            });
        } catch (e) {
            try {
                await this._apiRequest('PATCH', '/v3/config/paths/patch/' + pathName, {
                    sourceOnDemand: false,
                    hlsMuxerCloseAfter: '120s'
                });
            } catch (e2) {
                console.error('MediaMTXManager: failed to create publisher path', pathName, e.message);
                throw e;
            }
        }
    }

    async _createSourcePath(pathName, streamUrl) {
        try {
            await this._apiRequest('POST', '/v3/config/paths/add/' + pathName, {
                source: streamUrl,
                sourceOnDemand: true,
                sourceOnDemandStartTimeout: '60s',
                sourceOnDemandCloseAfter: '120s'
            });
        } catch (e) {
            try {
                await this._apiRequest('PATCH', '/v3/config/paths/patch/' + pathName, {
                    source: streamUrl,
                    sourceOnDemand: true,
                    sourceOnDemandStartTimeout: '60s',
                    sourceOnDemandCloseAfter: '120s'
                });
            } catch (e2) {
                console.error('MediaMTXManager: failed to create/update source path', pathName, e.message);
                throw e;
            }
        }
    }

    async checkSourceReachable(streamUrl) {
        try {
            const parsed = new URL(streamUrl);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                return { reachable: true, error: null, statusCode: null };
            }
        } catch (e) {
            return { reachable: false, error: 'Invalid URL', statusCode: null };
        }

        return new Promise((resolve) => {
            const url = new URL(streamUrl);
            const isHttps = url.protocol === 'https:';
            const requester = isHttps ? https : http;

            const options = {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname + url.search,
                method: 'HEAD',
                headers: {
                    'User-Agent': 'ChatrixStream-HealthCheck/1.0'
                },
                timeout: 8000
            };

            const req = requester.request(options, (res) => {
                res.resume();
                if (res.statusCode >= 200 && res.statusCode < 400) {
                    resolve({ reachable: true, error: null, statusCode: res.statusCode });
                } else {
                    resolve({ reachable: false, error: 'Source returned status ' + res.statusCode, statusCode: res.statusCode });
                }
            });

            req.on('error', (err) => {
                resolve({ reachable: false, error: err.code || err.message, statusCode: null });
            });

            req.on('timeout', () => {
                req.destroy();
                resolve({ reachable: false, error: 'Connection timeout', statusCode: null });
            });

            req.end();
        });
    }

    async isPathReady(channelId, qualityLabel) {
        const pathName = this.getPathName(channelId, qualityLabel);
        const state = this.activePaths.get(pathName);

        if (state && state.bridgeMode && this.ffmpegBridge) {
            if (!this.ffmpegBridge.isRunning(pathName)) {
                return false;
            }
        }

        try {
            const result = await this._apiRequest('GET', '/v3/paths/get/' + pathName);
            const item = result && result.item ? result.item : result;
            if (item && item.ready !== undefined) {
                return item.ready;
            }
            if (item && item.tracks && item.tracks.length > 0) {
                return true;
            }
            return false;
        } catch (e) {
            if (e.statusCode === 404) {
                this.activePaths.delete(pathName);
                return false;
            }
            console.error('MediaMTXManager: isPathReady error for', pathName, e.message);
            return false;
        }
    }

    async triggerSource(channelId, qualityLabel) {
        const pathName = this.getPathName(channelId, qualityLabel);
        const state = this.activePaths.get(pathName);

        if (state && state.bridgeMode && this.ffmpegBridge) {
            if (!this.ffmpegBridge.isRunning(pathName)) {
                this.ffmpegBridge.startBridge(pathName, state.streamUrl, state.qualityConfig);
            }
            return true;
        }

        const hlsUrl = this.hlsUrl + '/' + pathName + '/index.m3u8';

        return new Promise((resolve) => {
            const url = new URL(hlsUrl);
            const isHttps = url.protocol === 'https:';
            const requester = isHttps ? require('https') : http;

            const options = {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname + url.search,
                method: 'GET',
                headers: {
                    'Accept': '*/*',
                    'User-Agent': 'ChatrixStream-Warmup/1.0'
                },
                timeout: 5000
            };

            const req = requester.request(options, (res) => {
                res.resume();
                resolve(res.statusCode === 200);
            });

            req.on('error', () => resolve(false));
            req.on('timeout', () => {
                req.destroy();
                resolve(false);
            });
            req.end();
        });
    }

    async waitForPathReady(channelId, qualityLabel, timeoutMs) {
        const maxWait = timeoutMs || this.startupTimeout;
        const startTime = Date.now();
        const pollInterval = 1500;
        let triggered = false;

        while (Date.now() - startTime < maxWait) {
            if (!triggered) {
                this.triggerSource(channelId, qualityLabel).catch(() => {});
                triggered = true;
            }

            const ready = await this.isPathReady(channelId, qualityLabel);
            if (ready) return true;

            const pathName = this.getPathName(channelId, qualityLabel);
            const state = this.activePaths.get(pathName);
            if (state) state.lastAccess = Date.now();

            await new Promise(resolve => setTimeout(resolve, pollInterval));
        }

        return false;
    }

    recordAccess(channelId, qualityLabel) {
        const pathName = this.getPathName(channelId, qualityLabel);
        const state = this.activePaths.get(pathName);
        if (state) {
            state.lastAccess = Date.now();
        }
    }

    async removePath(channelId, qualityLabel) {
        const pathName = this.getPathName(channelId, qualityLabel);
        const state = this.activePaths.get(pathName);

        if (state && state.bridgeMode && this.ffmpegBridge) {
            this.ffmpegBridge.stopBridge(pathName);
        }

        this.activePaths.delete(pathName);

        try {
            await this._apiRequest('DELETE', '/v3/config/paths/delete/' + pathName);
            console.log('MediaMTXManager: removed path', pathName);
        } catch (e) {
            console.log('MediaMTXManager: path', pathName, 'not found on server (may already be removed)');
        }
    }

    async removeAllForChannel(channelId) {
        const prefix = channelId + '_';
        const toRemove = [];
        for (const [pathName, state] of this.activePaths) {
            if (pathName.startsWith(prefix)) {
                toRemove.push(state);
            }
        }
        for (const state of toRemove) {
            await this.removePath(state.channelId, state.qualityLabel);
        }
    }

    async removeAll() {
        const toRemove = Array.from(this.activePaths.values());
        for (const state of toRemove) {
            if (state.bridgeMode && this.ffmpegBridge) {
                this.ffmpegBridge.stopBridge(state.pathName);
            }
            try {
                await this._apiRequest('DELETE', '/v3/config/paths/delete/' + state.pathName);
            } catch (e) {}
        }
        this.activePaths.clear();
        console.log('MediaMTXManager: removed all paths');
    }

    getHlsUrl(channelId, qualityLabel) {
        const pathName = this.getPathName(channelId, qualityLabel);
        return this.hlsUrl + '/' + pathName + '/index.m3u8';
    }

    getRtspUrl(channelId, qualityLabel) {
        const pathName = this.getPathName(channelId, qualityLabel);
        return this.rtspUrl + '/' + pathName;
    }

    async listPaths() {
        try {
            return await this._apiRequest('GET', '/v3/paths/list');
        } catch (e) {
            return [];
        }
    }

    _cleanupIdlePaths() {
        const now = Date.now();
        const toRemove = [];

        for (const [pathName, state] of this.activePaths) {
            if (now - state.lastAccess > this.idleTimeout) {
                toRemove.push(state);
            }
        }

        for (const state of toRemove) {
            console.log('MediaMTXManager: idle path, removing', state.pathName);
            this.removePath(state.channelId, state.qualityLabel);
        }
    }

    destroy() {
        if (this._idleCheckInterval) {
            clearInterval(this._idleCheckInterval);
            this._idleCheckInterval = null;
        }
    }
}

module.exports = MediaMTXManager;
