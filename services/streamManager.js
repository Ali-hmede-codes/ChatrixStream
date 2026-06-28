const { PassThrough } = require('stream');
const http = require('http');
const https = require('https');
const { http: followHttp, https: followHttps } = require('follow-redirects');

const keepAliveHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

class StreamManager {
    constructor(options = {}) {
        this.activeStreams = new Map();
        this.highWaterMark = options.highWaterMark || 1048576;
        this.idleTimeout = options.idleTimeout || 30000;
        this.reconnectDelay = options.reconnectDelay || 2000;
        this.sourceTimeout = options.sourceTimeout || 30000;
    }

    _getKey(channelId, qualityLabel) {
        return `${channelId}:${qualityLabel}`;
    }

    _connectSource(key) {
        const state = this.activeStreams.get(key);
        if (!state) return;

        if (state.sourceResponse) {
            state.sourceResponse.unpipe(state.passThrough);
            state.sourceResponse.destroy();
            state.sourceResponse = null;
        }
        if (state.sourceRequest) {
            state.sourceRequest.destroy();
            state.sourceRequest = null;
        }

        const parsedUrl = new URL(state.streamUrl);
        const requester = parsedUrl.protocol === 'https:' ? followHttps : followHttp;

        const requestOptions = {
            timeout: this.sourceTimeout,
            headers: {
                'User-Agent': 'VLC/3.0.21 Vetinari',
                'Accept': '*/*',
                'Accept-Encoding': 'identity',
                'Connection': 'keep-alive'
            },
            agent: parsedUrl.protocol === 'https:' ? keepAliveHttpsAgent : keepAliveHttpAgent
        };

        if (parsedUrl.username && parsedUrl.password) {
            const auth = Buffer.from(parsedUrl.username + ':' + parsedUrl.password).toString('base64');
            requestOptions.headers['Authorization'] = 'Basic ' + auth;
        }

        let isIntentionalAbort = false;

        const req = requester.get(state.streamUrl, requestOptions, (res) => {
            if (res.statusCode !== 200) {
                console.error(`Stream source returned status ${res.statusCode} for ${state.streamUrl}`);
                res.resume();
                this._scheduleReconnect(key);
                return;
            }

            console.log(`Stream connected: ${state.streamUrl} (status ${res.statusCode}, type ${res.headers['content-type'] || 'unknown'})`);

            state.sourceResponse = res;

            res.on('error', (err) => {
                if (!isIntentionalAbort && err.message !== 'aborted') {
                    console.error('Stream source response error:', err.message);
                }
                res.unpipe(state.passThrough);
                this._scheduleReconnect(key);
            });

            res.on('end', () => {
                console.log('Stream source ended, reconnecting...');
                res.unpipe(state.passThrough);
                this._scheduleReconnect(key);
            });

            res.pipe(state.passThrough, { end: false });
        });

        state.sourceRequest = req;

        req.on('error', (err) => {
            if (!isIntentionalAbort && err.message !== 'socket hang up') {
                console.error('Stream source request error:', err.message);
            }
            this._scheduleReconnect(key);
        });

        req.on('timeout', () => {
            console.error('Stream source request timeout for', state.streamUrl);
            isIntentionalAbort = true;
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

        const maxBuffer = 5 * 1024 * 1024; // 5MB limit
        passThrough.on('data', (chunk) => {
            for (const client of state.clients) {
                if (!client.destroyed && !client.writableEnded) {
                    client.write(chunk);
                    if (client.writableLength > maxBuffer) {
                        console.log(`StreamManager: Client fell too far behind (${client.writableLength} bytes buffered), dropping connection`);
                        client.destroy();
                    }
                }
            }
        });

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
        if (res.socket) res.socket.setNoDelay(true);

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

        if (state.sourceResponse) {
            state.sourceResponse.unpipe(state.passThrough);
            state.sourceResponse.destroy();
        }
        if (state.sourceRequest) state.sourceRequest.destroy();
        state.passThrough.destroy();

        for (const client of state.clients) {
            client.end();
        }

        this.activeStreams.delete(key);
    }

    stopAllStreamsForChannel(channelId) {
        // Collect keys first to avoid modifying Map during iteration
        const targetId = String(channelId);
        const keysToStop = [];
        for (const [key, state] of this.activeStreams) {
            if (String(state.channelId) === targetId) {
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

module.exports = StreamManager;
