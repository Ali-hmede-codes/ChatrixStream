#!/usr/bin/env node
'use strict';

/*
 * test-cf-live.js
 *
 * Tests whether a live stream URL works, with Cloudflare bypass support.
 * Standalone — just run with Node.js. No CLI flags required (uses defaults).
 *
 * Usage:
 *   node test-cf-live.js [streamUrl]
 *
 * Phases (stops at first SUCCESS):
 *   1. Direct request (no CF bypass) — checks if VPS IP is clean
 *   2. cloudscraper CF bypass — solves old-style CF JS challenges
 *   3. cloudflare-bypasser CF bypass — alternative CF solver
 *
 * For live streams (infinite data), the CF bypass libraries can't buffer the
 * entire response. So the strategy is:
 *   a) Let the library solve the CF challenge (gets cf_clearance cookie in jar)
 *   b) The library hangs waiting for the infinite stream body
 *   c) Abort after a timeout, extract cookies from the jar
 *   d) Make a fresh streaming request with those cookies
 *   e) Read a few KB and check for MPEG-TS sync byte (0x47) / HLS markers
 */

const cloudscraper = require('cloudscraper');
const CloudflareBypasser = require('cloudflare-bypasser');
const { http: followHttp, https: followHttps } = require('follow-redirects');

// ---- Defaults (overridable via CLI) ----
const DEFAULT_STREAM_URL = 'http://zooox.top:8080/4669092343/1897383936/443954';

// ---- Timeouts (ms) ----
const DIRECT_TIMEOUT = 15000;
const CF_BYPASS_TIMEOUT = 45000;   // allow time for CF delay (5s) + retries
const STREAM_TIMEOUT = 15000;
const STREAM_SAMPLE_BYTES = 65536; // 64KB — enough to confirm media is flowing

const VLC_UA = 'VLC/3.0.21 Vetinari';

// ---- Helpers ---------------------------------------------------------------

function ts() { return new Date().toISOString(); }
function log(...args) { console.log(`[${ts()}]`, ...args); }

function parseArgs() {
    const args = process.argv.slice(2);
    return {
        streamUrl: args[0] || DEFAULT_STREAM_URL
    };
}

function extractCookies(jar, url) {
    try {
        const cookies = jar.getCookies(url);
        if (!cookies || cookies.length === 0) return '';
        return cookies.map(c => `${c.key}=${c.value}`).join('; ');
    } catch {
        return '';
    }
}

function detectMedia(contentType, firstBytes) {
    const ct = (contentType || '').toLowerCase();
    const sampleStr = firstBytes.slice(0, 512).toString('utf8').toLowerCase();
    const isTs = firstBytes.length > 0 && firstBytes[0] === 0x47;
    const isHls = ct.includes('mpegurl') || ct.includes('vnd.apple.mpegurl') || sampleStr.includes('#extm3u');
    const isMp2t = ct.includes('mp2t') || ct.includes('video/mp2t');
    const isHtml = ct.includes('text/html') || sampleStr.includes('<!doctype') || sampleStr.includes('<html');
    const isCfChallenge = isHtml && (
        sampleStr.includes('cloudflare') ||
        sampleStr.includes('challenge-platform') ||
        sampleStr.includes('just a moment') ||
        sampleStr.includes('cf-challenge') ||
        sampleStr.includes('jschl_vc') ||
        sampleStr.includes('attention required')
    );
    return { isTs, isHls, isMp2t, isHtml, isCfChallenge, ct };
}

// ---- Phase 1: Direct stream test (no CF bypass) -----------------------------

function testDirect(url, proxyAgent, label) {
    label = label || 'direct';
    log(`[${label}] Testing direct request (no CF bypass)...`);

    return new Promise((resolve) => {
        let parsed;
        try { parsed = new URL(url); }
        catch { return resolve({ ok: false, method: label, reason: `invalid URL: ${url}` }); }

        const requester = parsed.protocol === 'https:' ? followHttps : followHttp;
        const options = {
            timeout: DIRECT_TIMEOUT,
            headers: { 'User-Agent': VLC_UA, 'Accept': '*/*' },
        };
        if (proxyAgent) options.agent = proxyAgent;

        let settled = false;
        function done(result) {
            if (settled) return;
            settled = true;
            resolve(result);
        }

        const req = requester.get(url, options, (res) => {
            log(`[${label}] HTTP ${res.statusCode}, Content-Type: ${res.headers['content-type'] || '(none)'}, Server: ${res.headers['server'] || '(none)'}`);

            let chunks = [];
            let totalBytes = 0;

            function checkAndFinish() {
                if (totalBytes < 1024 && totalBytes > 0) return; // need more data
                if (totalBytes === 0) return;

                const firstBytes = Buffer.concat(chunks);
                const d = detectMedia(res.headers['content-type'], firstBytes);

                if (d.isTs || d.isHls || d.isMp2t) {
                    res.destroy();
                    req.destroy();
                    done({
                        ok: true,
                        method: label,
                        status: res.statusCode,
                        contentType: res.headers['content-type'],
                        server: res.headers['server'],
                        bytesRead: totalBytes,
                        reason: `Direct access works! Video data detected (${d.isTs ? 'MPEG-TS 0x47' : d.isHls ? 'HLS m3u8' : 'mp2t'}). No Cloudflare bypass needed.`
                    });
                } else if (d.isHtml) {
                    res.destroy();
                    req.destroy();
                    done({
                        ok: false,
                        method: label,
                        status: res.statusCode,
                        contentType: res.headers['content-type'],
                        server: res.headers['server'],
                        bytesRead: totalBytes,
                        isCfChallenge: d.isCfChallenge,
                        reason: d.isCfChallenge
                            ? `Cloudflare challenge page detected (HTTP ${res.statusCode}). CF bypass needed.`
                            : `HTML page received (HTTP ${res.statusCode}), not video data.`
                    });
                } else if (totalBytes >= STREAM_SAMPLE_BYTES) {
                    res.destroy();
                    req.destroy();
                    done({
                        ok: true,
                        method: label,
                        status: res.statusCode,
                        contentType: res.headers['content-type'],
                        server: res.headers['server'],
                        bytesRead: totalBytes,
                        reason: `Direct access works! ${totalBytes} bytes received.`
                    });
                }
            }

            res.on('data', (chunk) => {
                chunks.push(chunk);
                totalBytes += chunk.length;
                checkAndFinish();
            });

            res.on('end', () => {
                if (totalBytes === 0) {
                    done({
                        ok: false,
                        method: label,
                        status: res.statusCode,
                        contentType: res.headers['content-type'],
                        reason: `Empty response (HTTP ${res.statusCode}).`
                    });
                    return;
                }
                if (totalBytes < 1024) checkAndFinish();
            });

            res.on('error', (err) => {
                done({ ok: false, method: label, reason: `Response error: ${err.message}` });
            });
        });

        req.on('error', (err) => {
            done({ ok: false, method: label, reason: `Request error: ${err.message}` });
        });

        req.on('timeout', () => {
            req.destroy();
            done({ ok: false, method: label, reason: `Request timed out after ${DIRECT_TIMEOUT / 1000}s.` });
        });
    });
}

// ---- Phase 2/3: CF bypass + stream verification -----------------------------

function testCloudscraper(url, proxyAgent) {
    const label = proxyAgent ? 'proxy+cloudscraper' : 'cloudscraper';
    log(`[${label}] Solving Cloudflare challenge...`);

    const jar = cloudscraper.jar();
    const options = {
        uri: url,
        jar: jar,
        resolveWithFullResponse: true,
        encoding: null,
        challengesToSolve: 3,
        cloudflareMaxTimeout: 30000,
        headers: { 'User-Agent': VLC_UA, 'Accept': '*/*' },
    };
    if (proxyAgent) options.agent = proxyAgent;

    let request;
    try {
        request = cloudscraper(options);
    } catch (err) {
        return Promise.resolve({ ok: false, method: label, reason: `cloudscraper init error: ${err.message}` });
    }

    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        try { request.abort(); } catch (_) {}
    }, CF_BYPASS_TIMEOUT);

    return request.then((response) => {
        clearTimeout(timer);
        const ct = response.headers['content-type'] || '';
        log(`[${label}] Response: HTTP ${response.statusCode}, Content-Type: ${ct}`);

        if (response.statusCode === 200 && !ct.toLowerCase().includes('text/html')) {
            const d = detectMedia(ct, Buffer.from(response.body || ''));
            return {
                ok: true,
                method: label,
                status: response.statusCode,
                contentType: ct,
                reason: `Cloudflare bypassed! Got content (${d.isTs ? 'MPEG-TS' : d.isHls ? 'HLS' : ct}).`
            };
        }
        return {
            ok: false,
            method: label,
            status: response.statusCode,
            contentType: ct,
            reason: `cloudscraper returned HTTP ${response.statusCode}, Content-Type: ${ct}. Challenge may not have been solved.`
        };
    }).catch((error) => {
        clearTimeout(timer);

        if (timedOut) {
            log(`[${label}] Timed out (likely infinite stream after CF bypass). Extracting cookies...`);
            const cookies = extractCookies(jar, url);
            log(`[${label}] CF cookies obtained: ${cookies ? 'yes' : 'no'}`);
            if (cookies) {
                log(`[${label}] Testing stream with CF cookies...`);
                return testStreamWithCookies(url, cookies, proxyAgent, label);
            }
            return {
                ok: false,
                method: label,
                reason: 'Timed out without Cloudflare cookies. The site likely uses a modern challenge (Turnstile) that cloudscraper cannot solve.'
            };
        }

        const name = error.constructor ? error.constructor.name : 'Error';
        const etype = error.errorType;
        if (name === 'CaptchaError' || etype === 2) {
            return { ok: false, method: label, reason: 'Cloudflare CAPTCHA detected. cloudscraper cannot solve CAPTCHAs automatically.' };
        }
        if (name === 'CloudflareError') {
            return { ok: false, method: label, reason: `Cloudflare error: ${error.message || error.cause || 'blocked'}` };
        }
        if (name === 'ParserError') {
            return { ok: false, method: label, reason: `Failed to parse CF challenge: ${error.message}. The site may use a modern challenge format.` };
        }
        return { ok: false, method: label, reason: `cloudscraper error: ${error.message || error}` };
    });
}

function testCloudflareBypasser(url, proxyAgent) {
    const label = proxyAgent ? 'proxy+cf-bypasser' : 'cf-bypasser';
    log(`[${label}] Solving Cloudflare challenge...`);

    const cf = new CloudflareBypasser({ delay: 4000 });
    const jar = cf.jar;

    const params = { uri: url, headers: { 'User-Agent': VLC_UA, 'Accept': '*/*' } };
    if (proxyAgent) params.agent = proxyAgent;

    let timedOut = false;
    const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => { timedOut = true; reject(new Error('TIMEOUT')); }, CF_BYPASS_TIMEOUT);
    });

    // Suppress unhandled rejection if the cf request settles after our timeout
    const cfPromise = cf.request(params).catch(() => null);

    return Promise.race([cfPromise, timeoutPromise]).then((response) => {
        if (response === null) {
            // cf.request rejected — check cookies then fall through
            const cookies = extractCookies(jar, url);
            if (cookies) {
                log(`[${label}] CF cookies obtained, testing stream...`);
                return testStreamWithCookies(url, cookies, proxyAgent, label);
            }
            return { ok: false, method: label, reason: 'cloudflare-bypasser request failed and no cookies were obtained.' };
        }

        const ct = response.headers['content-type'] || '';
        log(`[${label}] Response: HTTP ${response.statusCode}, Content-Type: ${ct}`);

        if (response.statusCode === 200 && !ct.toLowerCase().includes('text/html')) {
            return {
                ok: true,
                method: label,
                status: response.statusCode,
                contentType: ct,
                reason: `cloudflare-bypasser worked! Got content (${ct}).`
            };
        }
        return {
            ok: false,
            method: label,
            status: response.statusCode,
            contentType: ct,
            reason: `cloudflare-bypasser returned HTTP ${response.statusCode}, Content-Type: ${ct}.`
        };
    }).catch((error) => {
        if (timedOut || error.message === 'TIMEOUT') {
            log(`[${label}] Timed out (likely infinite stream after CF bypass). Extracting cookies...`);
            const cookies = extractCookies(jar, url);
            log(`[${label}] CF cookies obtained: ${cookies ? 'yes' : 'no'}`);
            if (cookies) {
                log(`[${label}] Testing stream with CF cookies...`);
                return testStreamWithCookies(url, cookies, proxyAgent, label);
            }
            return {
                ok: false,
                method: label,
                reason: 'Timed out without Cloudflare cookies. The site likely uses a modern challenge that cloudflare-bypasser cannot solve.'
            };
        }
        return { ok: false, method: label, reason: `cloudflare-bypasser error: ${error.message || error}` };
    });
}

// ---- Stream test with CF cookies -------------------------------------------

function testStreamWithCookies(url, cookieString, proxyAgent, label) {
    return new Promise((resolve) => {
        let parsed;
        try { parsed = new URL(url); }
        catch { return resolve({ ok: false, method: label + '+stream', reason: `invalid URL: ${url}` }); }

        const requester = parsed.protocol === 'https:' ? followHttps : followHttp;
        const options = {
            timeout: STREAM_TIMEOUT,
            headers: {
                'User-Agent': VLC_UA,
                'Accept': '*/*',
                'Cookie': cookieString,
            },
        };
        if (proxyAgent) options.agent = proxyAgent;

        let settled = false;
        function done(result) {
            if (settled) return;
            settled = true;
            resolve(result);
        }

        const req = requester.get(url, options, (res) => {
            log(`[${label}+stream] HTTP ${res.statusCode}, Content-Type: ${res.headers['content-type'] || '(none)'}`);

            let chunks = [];
            let totalBytes = 0;

            function checkAndFinish() {
                if (totalBytes < 1024 && totalBytes > 0) return;
                if (totalBytes === 0) return;

                const firstBytes = Buffer.concat(chunks);
                const d = detectMedia(res.headers['content-type'], firstBytes);

                if (d.isTs || d.isHls || d.isMp2t) {
                    res.destroy();
                    req.destroy();
                    done({
                        ok: true,
                        method: label + '+stream',
                        status: res.statusCode,
                        contentType: res.headers['content-type'],
                        bytesRead: totalBytes,
                        reason: `Stream works after CF bypass! Video data detected (${d.isTs ? 'MPEG-TS 0x47' : d.isHls ? 'HLS m3u8' : 'mp2t'}). ${totalBytes} bytes received.`
                    });
                } else if (d.isHtml) {
                    res.destroy();
                    req.destroy();
                    done({
                        ok: false,
                        method: label + '+stream',
                        status: res.statusCode,
                        contentType: res.headers['content-type'],
                        reason: d.isCfChallenge
                            ? `Still getting Cloudflare challenge page after CF bypass. Cookies may be invalid or the challenge is unsolvable.`
                            : `Got HTML page instead of video data. Cookies may be invalid or expired.`
                    });
                } else if (totalBytes >= STREAM_SAMPLE_BYTES) {
                    res.destroy();
                    req.destroy();
                    done({
                        ok: true,
                        method: label + '+stream',
                        status: res.statusCode,
                        contentType: res.headers['content-type'],
                        bytesRead: totalBytes,
                        reason: `Stream works! ${totalBytes} bytes received after CF bypass.`
                    });
                }
            }

            res.on('data', (chunk) => {
                chunks.push(chunk);
                totalBytes += chunk.length;
                checkAndFinish();
            });

            res.on('end', () => {
                if (totalBytes === 0) {
                    done({
                        ok: false,
                        method: label + '+stream',
                        status: res.statusCode,
                        contentType: res.headers['content-type'],
                        reason: `Empty response after CF bypass (HTTP ${res.statusCode}).`
                    });
                    return;
                }
                if (totalBytes < 1024) checkAndFinish();
            });

            res.on('error', (err) => {
                done({ ok: false, method: label + '+stream', reason: `Stream response error: ${err.message}` });
            });
        });

        req.on('error', (err) => {
            done({ ok: false, method: label + '+stream', reason: `Stream request error: ${err.message}` });
        });

        req.on('timeout', () => {
            req.destroy();
            done({ ok: false, method: label + '+stream', reason: `Stream test timed out after ${STREAM_TIMEOUT / 1000}s.` });
        });
    });
}

// ---- Main ------------------------------------------------------------------

async function main() {
    const cfg = parseArgs();

    console.log('==============================================');
    console.log(' LIVE STREAM TESTER (Cloudflare Bypass)');
    console.log('==============================================');
    log('Stream URL :', cfg.streamUrl);
    log('Proxy      : none (direct only)');
    console.log('----------------------------------------------');

    const results = [];

    // Phase 1: Direct (no proxy)
    const r1 = await testDirect(cfg.streamUrl, null, 'direct');
    results.push(r1);
    log(`[direct] => ${r1.ok ? 'SUCCESS' : 'ERROR'}: ${r1.reason}`);
    if (r1.ok) return reportFinal(cfg, results, r1);

    // Phase 2: cloudscraper (no proxy)
    const r2 = await testCloudscraper(cfg.streamUrl, null);
    results.push(r2);
    log(`[cloudscraper] => ${r2.ok ? 'SUCCESS' : 'ERROR'}: ${r2.reason}`);
    if (r2.ok) return reportFinal(cfg, results, r2);

    // Phase 3: cloudflare-bypasser (no proxy)
    const r3 = await testCloudflareBypasser(cfg.streamUrl, null);
    results.push(r3);
    log(`[cf-bypasser] => ${r3.ok ? 'SUCCESS' : 'ERROR'}: ${r3.reason}`);
    if (r3.ok) return reportFinal(cfg, results, r3);

    return reportFinal(cfg, results, null);
}

function reportFinal(cfg, results, success) {
    console.log('==============================================');
    if (success) {
        console.log(' RESULT: SUCCESS');
        console.log('==============================================');
        console.log(` Method      : ${success.method}`);
        console.log(` Stream URL  : ${cfg.streamUrl}`);
        if (success.status) console.log(` HTTP Status : ${success.status}`);
        if (success.contentType) console.log(` Content-Type: ${success.contentType}`);
        if (success.server) console.log(` Server      : ${success.server}`);
        if (success.bytesRead) console.log(` Bytes Read  : ${success.bytesRead}`);
        console.log(` Detail      : ${success.reason}`);
        console.log('----------------------------------------------');
        console.log(' The live stream WORKS!');
    } else {
        console.log(' RESULT: ERROR');
        console.log('==============================================');
        console.log(` Stream URL  : ${cfg.streamUrl}`);
        console.log(' Proxy       : none (direct only)');
        console.log(' All methods failed.');
        console.log('----------------------------------------------');
        console.log(' Attempted methods:');
        for (const r of results) {
            console.log(`   - ${r.method.padEnd(22)} ${r.ok ? 'OK' : 'FAIL'}  ${r.reason}`);
        }
        console.log('----------------------------------------------');
        console.log(' The live stream does NOT work.');
        console.log('----------------------------------------------');
        console.log(' Possible reasons:');
        console.log('   * Cloudflare uses a modern challenge (Turnstile/managed)');
        console.log('     that cloudscraper and cloudflare-bypasser cannot solve.');
        console.log('     -> Try a headless browser (puppeteer + stealth plugin).');
        console.log('   * The stream URL is wrong or the stream is offline.');
        console.log('     -> Verify the URL in a browser/VLC first.');
    }
    console.log('==============================================');

    process.exit(success ? 0 : 1);
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(2);
});
