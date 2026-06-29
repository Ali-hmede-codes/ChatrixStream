#!/usr/bin/env node
/*
 * test-proxy-live.js
 *
 * Standalone tester (Node.js, NO external dependencies).
 * Tests whether a live stream URL works when fetched through a SOCKS5 proxy.
 *
 * Usage:
 *   node test-proxy-live.js [streamUrl] [proxyHost] [proxyPort]
 *
 * Defaults:
 *   streamUrl = http://zooox.top:8080/4669092343/1897383936/443954
 *   proxy     = 201.121.249.246:8080 (SOCKS5)
 *
 * It will:
 *   1. Connect to the SOCKS5 proxy.
 *   2. Perform the SOCKS5 handshake (no-auth).
 *   3. Ask the proxy to connect to the stream host:port (domain resolved by proxy).
 *   4. Send an HTTP GET through the tunnel using a VLC User-Agent.
 *   5. Inspect the response (status, headers, first bytes) and decide:
 *        - SUCCESS: live stream is reachable and returns media data (status 200
 *          with video/mp2t content-type, OR an MPEG-TS sync byte 0x47, OR HLS m3u8).
 *        - ERROR: connection failed, Cloudflare challenge, bad status, timeout, etc.
 */

'use strict';

const net = require('net');

// ---- Defaults (overridable via CLI) ----
const DEFAULT_STREAM_URL = 'http://zooox.top:8080/4669092343/1897383936/443954';
const DEFAULT_PROXY_HOST = '201.121.249.246';
const DEFAULT_PROXY_PORT = 8080;

// ---- Timeouts (ms) ----
const PROXY_CONNECT_TIMEOUT = 15000;
const SOCKS_HANDSHAKE_TIMEOUT = 15000;
const HTTP_RESPONSE_TIMEOUT = 20000;
const SAMPLE_READ_TIME = 8000; // how long to read stream data before declaring success

// ---- Helpers ---------------------------------------------------------------

function ts() {
    return new Date().toISOString();
}

function log(...args) {
    console.log(`[${ts()}]`, ...args);
}

function parseArgs() {
    const args = process.argv.slice(2);
    return {
        streamUrl: args[0] || DEFAULT_STREAM_URL,
        proxyHost: args[1] || DEFAULT_PROXY_HOST,
        proxyPort: parseInt(args[2] || String(DEFAULT_PROXY_PORT), 10)
    };
}

// Promisified single read of N bytes from a socket
function readExact(socket, n) {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            socket.removeListener('data', onData);
            socket.removeListener('error', onError);
            socket.removeListener('close', onClose);
            socket.removeListener('end', onEnd);
            clearTimeout(timer);
        };
        const onData = (buf) => {
            if (buf.length >= n) {
                cleanup();
                resolve(buf.slice(0, n));
                // push back remainder
                if (buf.length > n) socket.unshift(buf.slice(n));
            }
        };
        const onError = (err) => { cleanup(); reject(err); };
        const onClose = () => { cleanup(); reject(new Error('socket closed while reading')); };
        const onEnd = () => { cleanup(); reject(new Error('socket ended while reading')); };
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error('timeout reading from proxy'));
        }, SOCKS_HANDSHAKE_TIMEOUT);
        socket.on('data', onData);
        socket.on('error', onError);
        socket.on('close', onClose);
        socket.on('end', onEnd);
    });
}

// ---- SOCKS5 client ---------------------------------------------------------

function socks5Connect(proxyHost, proxyPort, targetHost, targetPort) {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host: proxyHost, port: proxyPort });
        socket.setTimeout(PROXY_CONNECT_TIMEOUT);

        socket.once('connect', () => {
            socket.setTimeout(0);
            doHandshake().catch(reject);
        });
        socket.once('error', (err) => reject(err));
        socket.once('timeout', () => {
            socket.destroy();
            reject(new Error(`timeout connecting to proxy ${proxyHost}:${proxyPort}`));
        });

        async function doHandshake() {
            // 1) Greeting: VER=5, NMETHODS=1, METHODS=0x00 (no auth)
            socket.write(Buffer.from([0x05, 0x01, 0x00]));

            // 2) Read method selection: VER(1) METHOD(1)
            const greetReply = await readExact(socket, 2);
            if (greetReply[0] !== 0x05) {
                throw new Error(`invalid SOCKS version in greeting reply: ${greetReply[0]}`);
            }
            const method = greetReply[1];
            if (method === 0xff) {
                throw new Error('proxy rejected auth: no acceptable methods (no-auth not supported)');
            }
            if (method !== 0x00) {
                throw new Error(`proxy selected unsupported auth method: ${method}`);
            }

            // 3) CONNECT request: VER=5 CMD=1(connect) RSV=0 ATYP=3(domain)
            const hostBuf = Buffer.from(targetHost, 'utf8');
            if (hostBuf.length > 255) {
                throw new Error('target host name too long for SOCKS5');
            }
            const portBuf = Buffer.alloc(2);
            portBuf.writeUInt16BE(targetPort, 0);
            const req = Buffer.concat([
                Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
                hostBuf,
                portBuf
            ]);
            socket.write(req);

            // 4) Read CONNECT reply: VER(1) REP(1) RSV(1) ATYP(1) BND.ADDR BND.PORT
            const head = await readExact(socket, 4);
            if (head[0] !== 0x05) {
                throw new Error(`invalid SOCKS version in connect reply: ${head[0]}`);
            }
            const rep = head[1];
            if (rep !== 0x00) {
                const messages = {
                    0x01: 'general SOCKS server failure',
                    0x02: 'connection not allowed by ruleset',
                    0x03: 'network unreachable',
                    0x04: 'host unreachable',
                    0x05: 'connection refused',
                    0x06: 'TTL expired',
                    0x07: 'command not supported',
                    0x08: 'address type not supported'
                };
                throw new Error(`SOCKS5 connect failed (REP=0x${rep.toString(16)}): ${messages[rep] || 'unknown'}`);
            }
            const atyp = head[3];
            let addrLen;
            if (atyp === 0x01) addrLen = 4;          // IPv4
            else if (atyp === 0x03) {               // domain
                const lenBuf = await readExact(socket, 1);
                addrLen = lenBuf[0];
            } else if (atyp === 0x04) addrLen = 16;  // IPv6
            else throw new Error(`unsupported BND.ADDR type in reply: ${atyp}`);

            await readExact(socket, addrLen);   // BND.ADDR
            await readExact(socket, 2);          // BND.PORT

            resolve(socket); // tunnel established
        }
    });
}

// ---- HTTP over the SOCKS5 tunnel -------------------------------------------

function buildHttpRequest(urlStr) {
    let parsed;
    try {
        parsed = new URL(urlStr);
    } catch (e) {
        throw new Error(`invalid stream URL: ${urlStr}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`only http/https supported, got ${parsed.protocol}`);
    }

    const targetHost = parsed.hostname;
    const targetPort = parsed.port
        ? parseInt(parsed.port, 10)
        : (parsed.protocol === 'https:' ? 443 : 80);
    const path = (parsed.pathname + parsed.search) || '/';

    // Use the same VLC UA the production StreamManager uses, plus realistic headers.
    const headers = [
        `GET ${path} HTTP/1.1`,
        `Host: ${parsed.host}`,
        `User-Agent: VLC/3.0.21 Vetinari`,
        `Accept: */*`,
        `Accept-Encoding: identity`,
        `Connection: close`,
        ``,
        ``
    ].join('\r\n');

    return { parsed, targetHost, targetPort, request: Buffer.from(headers, 'utf8') };
}

function readHttpHead(socket) {
    return new Promise((resolve, reject) => {
        let buf = Buffer.alloc(0);
        const timer = setTimeout(() => {
            cleanup();
            if (buf.length > 0) {
                reject(new Error(`timeout waiting for HTTP response head (got ${buf.length} bytes)`));
            } else {
                reject(new Error('timeout waiting for HTTP response (no data received)'));
            }
        }, HTTP_RESPONSE_TIMEOUT);

        function cleanup() {
            socket.removeListener('data', onData);
            socket.removeListener('error', onError);
            socket.removeListener('close', onClose);
            socket.removeListener('end', onEnd);
            clearTimeout(timer);
        }
        function onData(chunk) {
            buf = Buffer.concat([buf, chunk]);
            const sep = buf.indexOf('\r\n\r\n');
            if (sep !== -1) {
                cleanup();
                const headBuf = buf.slice(0, sep);
                const body = buf.slice(sep + 4);
                resolve({ headBuf, body });
            }
        }
        function onError(err) { cleanup(); reject(err); }
        function onClose() {
            cleanup();
            if (buf.length > 0) {
                // We may still parse a partial head
                const sep = buf.indexOf('\r\n\r\n');
                if (sep !== -1) {
                    resolve({ headBuf: buf.slice(0, sep), body: buf.slice(sep + 4) });
                    return;
                }
                reject(new Error(`connection closed before full HTTP head (got ${buf.length} bytes)`));
            } else {
                reject(new Error('connection closed by remote before any HTTP data'));
            }
        }
        function onEnd() { onClose(); }

        socket.on('data', onData);
        socket.on('error', onError);
        socket.on('close', onClose);
        socket.on('end', onEnd);
    });
}

function parseHttpHead(headBuf) {
    const text = headBuf.toString('utf8');
    const lines = text.split('\r\n');
    const statusLine = lines[0] || '';
    const m = statusLine.match(/^HTTP\/\d\.\d\s+(\d+)\s*(.*)$/);
    const status = m ? parseInt(m[1], 10) : 0;
    const statusText = m ? m[2] : statusLine;
    const headers = {};
    for (let i = 1; i < lines.length; i++) {
        const idx = lines[i].indexOf(':');
        if (idx === -1) continue;
        const key = lines[i].slice(0, idx).trim().toLowerCase();
        const val = lines[i].slice(idx + 1).trim();
        headers[key] = val;
    }
    return { status, statusText, headers, raw: text };
}

// Collect body bytes for SAMPLE_READ_TIME to confirm media is actually flowing.
function collectSample(socket, initialBody) {
    return new Promise((resolve) => {
        const start = Date.now();
        let collected = Buffer.from(initialBody);
        const timer = setTimeout(() => finish('sample-time'), SAMPLE_READ_TIME);

        function finish(reason) {
            clearTimeout(timer);
            socket.removeListener('data', onData);
            socket.removeListener('error', onError);
            socket.removeListener('end', onEnd);
            socket.removeListener('close', onClose);
            resolve({ bytes: collected.length, sample: collected.slice(0, 64), reason });
        }
        function onData(chunk) {
            collected = Buffer.concat([collected, chunk]);
            // Stop early once we clearly have media bytes.
            if (collected.length >= 512) finish('enough-data');
        }
        function onError() { finish('error'); }
        function onEnd() { finish('end'); }
        function onClose() { finish('close'); }

        socket.on('data', onData);
        socket.on('error', onError);
        socket.on('end', onEnd);
        socket.on('close', onClose);
    });
}

// ---- Decision logic --------------------------------------------------------

function detectLive(head, sampleBytes) {
    const ct = (head.headers['content-type'] || '').toLowerCase();
    const server = (head.headers['server'] || '').toLowerCase();
    const isTs = sampleBytes.length > 0 && sampleBytes[0] === 0x47;
    const isHls = ct.includes('mpegurl') || ct.includes('vnd.apple.mpegurl');
    const isMp2t = ct.includes('mp2t') || ct.includes('video/mp2t');

    // Cloudflare challenge markers
    const headText = head.raw.toLowerCase();
    const cfChallenge =
        head.status === 403 || head.status === 503 || head.status === 429 ||
        headText.includes('cloudflare') && (
            headText.includes('just a moment') ||
            headText.includes('challenge-platform') ||
            headText.includes('cf-challenge') ||
            headText.includes('attention required')
        );

    return { ct, server, isTs, isHls, isMp2t, cfChallenge };
}

function buildVerdict(head, sample) {
    const d = detectLive(head, sample.sample);

    if (d.cfChallenge) {
        return {
            ok: false,
            verdict: 'ERROR',
            reason: `Cloudflare challenge detected (status ${head.status}). The proxy reached the site but Cloudflare blocked automated access.`
        };
    }

    if (head.status !== 200) {
        return {
            ok: false,
            verdict: 'ERROR',
            reason: `HTTP status ${head.status} ${head.statusText}. Content-Type: "${d.ct}". Server: "${d.server}".`
        };
    }

    // Status 200 — confirm media bytes
    const media = d.isTs || d.isHls || d.isMp2t;
    if (media && sample.bytes > 0) {
        return {
            ok: true,
            verdict: 'SUCCESS',
            reason: `Live stream is working. Content-Type: "${d.ct}". Received ${sample.bytes} bytes. Media sync detected: ${d.isTs ? 'MPEG-TS(0x47)' : d.isHls ? 'HLS(m3u8)' : 'mp2t'}.`
        };
    }

    if (sample.bytes > 0 && d.isTs) {
        return {
            ok: true,
            verdict: 'SUCCESS',
            reason: `Live stream is working. Received ${sample.bytes} bytes, MPEG-TS sync byte (0x47) present. Content-Type: "${d.ct}".`
        };
    }

    if (sample.bytes === 0) {
        return {
            ok: false,
            verdict: 'ERROR',
            reason: `Status 200 but no media bytes received within ${SAMPLE_READ_TIME}ms. Content-Type: "${d.ct}". The endpoint may not be a live stream or returned an empty body.`
        };
    }

    return {
        ok: true,
        verdict: 'SUCCESS',
        reason: `Status 200, received ${sample.bytes} bytes. Content-Type: "${d.ct}" (media type not definitively recognized, but data is flowing).`
    };
}

// ---- Main ------------------------------------------------------------------

async function main() {
    const cfg = parseArgs();

    console.log('==============================================');
    console.log(' PROXY + LIVE STREAM TESTER (SOCKS5)');
    console.log('==============================================');
    log('Stream URL :', cfg.streamUrl);
    log('SOCKS5     :', `${cfg.proxyHost}:${cfg.proxyPort}`);
    console.log('----------------------------------------------');

    let { parsed, targetHost, targetPort, request } = buildHttpRequest(cfg.streamUrl);
    log('Target     :', `${targetHost}:${targetPort} (${parsed.protocol})`);
    log('Path       :', (parsed.pathname + parsed.search) || '/');

    let tunnel;
    try {
        log('Connecting to SOCKS5 proxy...');
        tunnel = await socks5Connect(cfg.proxyHost, cfg.proxyPort, targetHost, targetPort);
        log('SOCKS5 tunnel established.');
    } catch (err) {
        return reportFinal({
            ok: false,
            verdict: 'ERROR',
            reason: `Could not establish SOCKS5 tunnel via ${cfg.proxyHost}:${cfg.proxyPort} -> ${targetHost}:${targetPort}. ${err.message}`
        }, cfg, null, null);
    }

    try {
        log('Sending HTTP GET through proxy...');
        tunnel.write(request);

        const { headBuf, body } = await readHttpHead(tunnel);
        const head = parseHttpHead(headBuf);
        log('HTTP status:', `${head.status} ${head.statusText}`);
        log('Content-Type:', head.headers['content-type'] || '(none)');
        log('Server     :', head.headers['server'] || '(none)');

        if (head.status !== 200) {
            // For error responses, show a snippet of the body if text.
            const snippet = body.slice(0, 300).toString('utf8').replace(/\s+/g, ' ').trim();
            if (snippet) log('Body snippet:', snippet);
            tunnel.destroy();
            const v = buildVerdict(head, { sample: body, bytes: body.length });
            return reportFinal(v, cfg, head, { sample: body, bytes: body.length });
        }

        log('Reading stream sample...');
        const sample = await collectSample(tunnel, body);
        log('Sample bytes received:', sample.bytes);
        if (sample.bytes > 0) {
            const hex = sample.sample.toString('hex').match(/.{1,2}/g).join(' ');
            log('First bytes (hex)   :', hex);
        }
        tunnel.destroy();

        const v = buildVerdict(head, sample);
        return reportFinal(v, cfg, head, sample);
    } catch (err) {
        tunnel.destroy();
        return reportFinal({
            ok: false,
            verdict: 'ERROR',
            reason: `HTTP request through proxy failed: ${err.message}`
        }, cfg, null, null);
    }
}

function reportFinal(v, cfg, head, sample) {
    console.log('==============================================');
    console.log(` RESULT: ${v.verdict}`);
    console.log('==============================================');
    console.log(' Stream URL :', cfg.streamUrl);
    console.log(' Proxy      :', `${cfg.proxyHost}:${cfg.proxyPort} (SOCKS5)`);
    if (head) {
        console.log(' HTTP status:', `${head.status} ${head.statusText}`);
        console.log(' Content-Type:', head.headers['content-type'] || '(none)');
        console.log(' Server     :', head.headers['server'] || '(none)');
    }
    if (sample) {
        console.log(' Sample bytes:', sample.bytes);
    }
    console.log(' Detail     :', v.reason);
    console.log('----------------------------------------------');
    console.log(v.ok ? '✅ The live stream worked through this proxy.' : '❌ The live stream did NOT work through this proxy.');
    console.log('----------------------------------------------');
    process.exit(v.ok ? 0 : 1);
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(2);
});
