const { PassThrough } = require('stream');
const { http: followHttp, https: followHttps } = require('follow-redirects');
const { resolveRedirect } = require('./urlResolver');


class StreamManager {
    constructor(options = {}) {
        this.activeStreams = new Map();
        this.highWaterMark = options.highWaterMark || 1048576;
        this.idleTimeout = options.idleTimeout || 30000;
        this.reconnectDelay = options.reconnectDelay || 2000;
        this.sourceTimeout = options.sourceTimeout || 15000;
    }

    _getKey(channelId, qualityLabel) {
        return `${channelId}:${qualityLabel}`;
    }

    async _connectSource(key) {
        const state = this.activeStreams.get(key);
        if (!state) return;

        if (state.sourceResponse) {
            state.sourceResponse.destroy();
            state.sourceResponse = null;
        }

        let resolvedUrl = state.streamUrl;
        try {
            resolvedUrl = await resolveRedirect(state.streamUrl);
        } catch (e) {
            console.error('StreamManager: error pre-resolving stream URL:', e.message);
        }

        // Check if stream was stopped while resolving the redirect
        if (!this.activeStreams.has(key)) return;

        const parsedUrl = new URL(resolvedUrl);
        const requester = parsedUrl.protocol === 'https:' ? followHttps : followHttp;

        const requestOptions = {
            timeout: this.sourceTimeout,
            headers: {
                'User-Agent': 'VLC/3.0.21 Vetinari',
                'Accept': '*/*',
                'Accept-Encoding': 'identity',
                'Icy-MetaData': '1',
                'Connection': 'keep-alive'
            },
            agent: false
        };

        if (parsedUrl.username && parsedUrl.password) {
            const auth = Buffer.from(parsedUrl.username + ':' + parsedUrl.password).toString('base64');
            requestOptions.headers['Authorization'] = 'Basic ' + auth;
        }

        const req = requester.get(resolvedUrl, requestOptions, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400) {
                console.log(`Stream redirect: ${res.statusCode} -> ${res.headers.location}`);
                res.resume();
                this._scheduleReconnect(key);
                return;
            }

            if (res.statusCode !== 200) {
                console.error(`Stream source returned status ${res.statusCode} for ${resolvedUrl}`);
                res.resume();
                this._scheduleReconnect(key);
                return;
            }

            console.log(`Stream connected: ${resolvedUrl} (status ${res.statusCode}, type ${res.headers['content-type'] || 'unknown'})`);

            state.sourceResponse = res;

            res.on('error', (err) => {
                console.error('Stream source response error:', err.message);
                this._scheduleReconnect(key);
            });

            res.on('end', () => {
                console.log('Stream source ended, reconnecting...');
                this._scheduleReconnect(key);
            });

            res.pipe(state.passThrough, { end: false });
        });

        req.on('error', (err) => {
            console.error('Stream source request error:', err.message);
            this._scheduleReconnect(key);
        });

        req.on('timeout', () => {
            console.error('Stream source request timeout for', state.streamUrl);
            req.destroy();
            this._scheduleReconnect(key);
        });
    }

    startStream(channelId, qualityLabel, streamUrl) {
        const key = this._getKey(channelId, qualityLabel);
        const existing = this.activeStreams.get(key);
        if (existing) return existing.passThrough;

        const passThrough = new PassThrough({ highWaterMark: this.highWaterMark });
        const state = {
            sourceResponse: null,
            passThrough,
            clients: new Set(),
            idleTimer: null,
            reconnectTimer: null,
            streamUrl,
            channelId,
            qualityLabel
        };

        this.activeStreams.set(key, state);
        this._connectSource(key);

        return passThrough;
    }

    _scheduleReconnect(key) {
        const state = this.activeStreams.get(key);
        if (!state) return;

        if (state.reconnectTimer) return;

        state.reconnectTimer = setTimeout(() => {
            state.reconnectTimer = null;
            if (!this.activeStreams.has(key) || state.clients.size === 0) {
                this.stopStream(state.channelId, state.qualityLabel);
                return;
            }
            this._connectSource(key);
        }, this.reconnectDelay);
    }

    addClient(channelId, qualityLabel, streamUrl, res) {
        const key = this._getKey(channelId, qualityLabel);
        let state = this.activeStreams.get(key);

        if (!state) {
            this.startStream(channelId, qualityLabel, streamUrl);
            state = this.activeStreams.get(key);
        }

        if (state.idleTimer) {
            clearTimeout(state.idleTimer);
            state.idleTimer = null;
        }

        res.writeHead(200, {
            'Content-Type': 'video/mp2t',
            'Cache-Control': 'no-cache, no-store, no-transform',
            'Connection': 'keep-alive',
            'Transfer-Encoding': 'chunked',
            'Access-Control-Allow-Origin': '*',
            'X-Accel-Buffering': 'no'
        });

        state.passThrough.pipe(res, { end: false });
        state.clients.add(res);

        res.on('close', () => {
            this.removeClient(channelId, qualityLabel, res);
        });

        res.on('error', () => {
            this.removeClient(channelId, qualityLabel, res);
        });
    }

    removeClient(channelId, qualityLabel, res) {
        const key = this._getKey(channelId, qualityLabel);
        const state = this.activeStreams.get(key);
        if (!state) return;

        state.clients.delete(res);
        state.passThrough.unpipe(res);

        if (state.clients.size === 0) {
            state.idleTimer = setTimeout(() => {
                this.stopStream(channelId, qualityLabel);
            }, this.idleTimeout);
        }
    }

    stopStream(channelId, qualityLabel) {
        const key = this._getKey(channelId, qualityLabel);
        const state = this.activeStreams.get(key);
        if (!state) return;

        if (state.idleTimer) clearTimeout(state.idleTimer);
        if (state.reconnectTimer) clearTimeout(state.reconnectTimer);

        if (state.sourceResponse) state.sourceResponse.destroy();
        state.passThrough.destroy();

        for (const client of state.clients) {
            client.end();
        }

        this.activeStreams.delete(key);
    }

    stopAllStreamsForChannel(channelId) {
        // Collect keys first to avoid modifying Map during iteration
        const keysToStop = [];
        for (const key of this.activeStreams.keys()) {
            if (key.startsWith(`${channelId}:`)) {
                keysToStop.push(key);
            }
        }
        for (const key of keysToStop) {
            const qualityLabel = key.split(':')[1];
            this.stopStream(channelId, qualityLabel);
        }
    }
}

module.exports = StreamManager;
