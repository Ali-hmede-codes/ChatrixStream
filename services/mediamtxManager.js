const http = require('http');
const https = require('https');

/**
 * MediaMTXManager — manages MediaMTX via its Control API.
 *
 * Replaces HlsConverter, PipeConverter, and StreamManager by delegating
 * all stream processing (HLS segmenting, MPEG-TS muxing, source proxying)
 * to the MediaMTX sidecar.
 *
 * Path naming convention: {channelId}_{qualityLabel}
 *   e.g. "1_high", "3_medium"
 */
class MediaMTXManager {
    constructor(options = {}) {
        this.apiUrl = options.apiUrl || 'http://localhost:9997';
        this.hlsUrl = options.hlsUrl || 'http://localhost:8888';
        this.rtspUrl = options.rtspUrl || 'rtsp://localhost:8554';
        this.idleTimeout = options.idleTimeout || 60000;
        this.startupTimeout = options.startupTimeout || 30000;

        // Track paths we've registered and their last access time
        this.activePaths = new Map();

        // Periodically check for idle paths and clean up
        this._idleCheckInterval = setInterval(() => this._cleanupIdlePaths(), 30000);
    }

    /**
     * Build the MediaMTX path name from channel + quality.
     */
    getPathName(channelId, qualityLabel) {
        return channelId + '_' + qualityLabel;
    }

    /**
     * Make an HTTP request to the MediaMTX Control API.
     */
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

    /**
     * Check if MediaMTX is reachable by hitting the API.
     */
    async isAvailable() {
        try {
            await this._apiRequest('GET', '/v3/paths/list');
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Ensure a MediaMTX path exists for the given channel+quality.
     * If the path already exists, just update last access time.
     * If not, create it via the Control API.
     *
     * @param {number|string} channelId
     * @param {string} qualityLabel
     * @param {string} streamUrl — the upstream source URL (RTSP, HLS, etc.)
     * @param {object} qualityConfig — optional quality config (ignored for remux, kept for API compat)
     * @returns {object} path state
     */
    async ensurePath(channelId, qualityLabel, streamUrl, qualityConfig) {
        const pathName = this.getPathName(channelId, qualityLabel);

        const existing = this.activePaths.get(pathName);
        if (existing) {
            existing.lastAccess = Date.now();
            return existing;
        }

        // Parse credentials from the stream URL for MediaMTX source
        const sourceUrl = this._buildSourceUrl(streamUrl);

        try {
            await this._apiRequest('POST', '/v3/config/paths/add/' + pathName, {
                source: sourceUrl,
                sourceOnDemand: true,
                sourceOnDemandStartTimeout: '30s',
                sourceOnDemandCloseAfter: '60s'
            });
        } catch (e) {
            // Path might already exist from a previous session — try to update it
            try {
                await this._apiRequest('PATCH', '/v3/config/paths/patch/' + pathName, {
                    source: sourceUrl,
                    sourceOnDemand: true,
                    sourceOnDemandStartTimeout: '30s',
                    sourceOnDemandCloseAfter: '60s'
                });
            } catch (e2) {
                console.error('MediaMTXManager: failed to create/update path', pathName, e.message);
                throw e;
            }
        }

        const state = {
            pathName,
            channelId,
            qualityLabel,
            streamUrl,
            qualityConfig,
            lastAccess: Date.now()
        };

        this.activePaths.set(pathName, state);
        console.log('MediaMTXManager: created path', pathName, 'source:', sourceUrl);
        return state;
    }

    /**
     * Build a source URL suitable for MediaMTX.
     * MediaMTX can pull from: rtsp://, rtmp://, http:// (HLS), rtsps://, etc.
     *
     * For HTTP URLs with credentials, extract them and set as source.
     * For RTSP URLs, pass through directly.
     */
    _buildSourceUrl(streamUrl) {
        try {
            const parsed = new URL(streamUrl);
            // If the URL has credentials, MediaMTX handles them natively
            // for RTSP/RTMP sources. For HTTP sources, credentials are
            // passed in the URL.
            return streamUrl;
        } catch (e) {
            return streamUrl;
        }
    }

    /**
     * Check if a path's source is ready (stream is available).
     */
    async isPathReady(channelId, qualityLabel) {
        const pathName = this.getPathName(channelId, qualityLabel);
        try {
            const result = await this._apiRequest('GET', '/v3/paths/get/' + pathName);
            // If we get here, the path exists and is configured
            // Check if the source is ready (has tracks/ready status)
            if (result && result.ready !== undefined) {
                return result.ready;
            }
            // If path exists in the API, it's considered ready enough
            return true;
        } catch (e) {
            if (e.statusCode === 404) return false;
            // API error — assume not ready
            return false;
        }
    }

    /**
     * Wait for a path's source to become ready, polling until timeout.
     */
    async waitForPathReady(channelId, qualityLabel, timeoutMs) {
        const maxWait = timeoutMs || this.startupTimeout;
        const startTime = Date.now();
        const pollInterval = 1000;

        while (Date.now() - startTime < maxWait) {
            const ready = await this.isPathReady(channelId, qualityLabel);
            if (ready) return true;

            // Also record access
            const pathName = this.getPathName(channelId, qualityLabel);
            const state = this.activePaths.get(pathName);
            if (state) state.lastAccess = Date.now();

            await new Promise(resolve => setTimeout(resolve, pollInterval));
        }

        return false;
    }

    /**
     * Record that a path is being accessed (updates lastAccess time).
     */
    recordAccess(channelId, qualityLabel) {
        const pathName = this.getPathName(channelId, qualityLabel);
        const state = this.activePaths.get(pathName);
        if (state) {
            state.lastAccess = Date.now();
        }
    }

    /**
     * Remove a single path from MediaMTX.
     */
    async removePath(channelId, qualityLabel) {
        const pathName = this.getPathName(channelId, qualityLabel);
        this.activePaths.delete(pathName);

        try {
            await this._apiRequest('DELETE', '/v3/config/paths/delete/' + pathName);
            console.log('MediaMTXManager: removed path', pathName);
        } catch (e) {
            // Path may not exist on the server — that's fine
            console.log('MediaMTXManager: path', pathName, 'not found on server (may already be removed)');
        }
    }

    /**
     * Remove all paths for a given channel.
     */
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

    /**
     * Remove all managed paths.
     */
    async removeAll() {
        const toRemove = Array.from(this.activePaths.values());
        for (const state of toRemove) {
            try {
                await this._apiRequest('DELETE', '/v3/config/paths/delete/' + state.pathName);
            } catch (e) { /* ignore */ }
        }
        this.activePaths.clear();
        console.log('MediaMTXManager: removed all paths');
    }

    /**
     * Get the HLS URL for a path.
     * MediaMTX serves HLS at: http://host:port/{pathName}/index.m3u8
     */
    getHlsUrl(channelId, qualityLabel) {
        const pathName = this.getPathName(channelId, qualityLabel);
        return this.hlsUrl + '/' + pathName + '/index.m3u8';
    }

    /**
     * Get the RTSP URL for a path.
     * MediaMTX serves RTSP at: rtsp://host:port/{pathName}
     */
    getRtspUrl(channelId, qualityLabel) {
        const pathName = this.getPathName(channelId, qualityLabel);
        return this.rtspUrl + '/' + pathName;
    }

    /**
     * Get list of all active paths from MediaMTX server.
     */
    async listPaths() {
        try {
            return await this._apiRequest('GET', '/v3/paths/list');
        } catch (e) {
            return [];
        }
    }

    /**
     * Periodically clean up idle paths.
     * A path is considered idle if it hasn't been accessed within idleTimeout.
     */
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

    /**
     * Shut down the manager and clean up.
     */
    destroy() {
        if (this._idleCheckInterval) {
            clearInterval(this._idleCheckInterval);
            this._idleCheckInterval = null;
        }
    }
}

module.exports = MediaMTXManager;
