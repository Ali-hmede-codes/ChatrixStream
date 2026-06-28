'use strict';

const { http: followHttp, https: followHttps } = require('follow-redirects');
const http = require('http');
const https = require('https');

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MEDIA_UA = 'VLC/3.0.21 Vetinari';

function hostMatches(url, hosts) {
    try {
        const host = new URL(url).hostname.toLowerCase();
        return hosts.some(h => host === h || host.endsWith('.' + h));
    } catch (e) {
        return false;
    }
}

function nativeRequester(protocol) {
    return protocol === 'https:' ? https : http;
}

function resolveLocation(base, location) {
    try {
        return new URL(location, base).href;
    } catch (e) {
        return null;
    }
}

// Single GET that does NOT follow redirects. Resolves to { res, url } or rejects.
function singleGet(url, headers, timeout) {
    const parsed = new URL(url);
    const mod = nativeRequester(parsed.protocol);
    let settled = false;
    const req = mod.get(url, { headers, timeout, agent: false });
    const promise = new Promise((resolve, reject) => {
        req.on('response', (res) => { if (!settled) { settled = true; resolve({ res, url }); } });
        req.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
        req.on('timeout', () => { req.destroy(); if (!settled) { settled = true; reject(new Error('timeout')); } });
    });
    return { req, promise };
}

// ---------------------------------------------------------------------------
// Strategy: split User-Agent across a redirect gateway.
//
// Some IPTV gateways (e.g. zooox.top behind Cloudflare) accept only a
// media-player User-Agent on the frontend (returning 403 to browser UAs) while
// their origin backend accepts only a browser User-Agent (returning 406/509 to
// VLC). A normal follow-redirect request sends one UA to both hops and fails.
// This strategy resolves the redirect with a media UA, then fetches the final
// origin URL with a browser UA.
//
// Configure matching hosts via SPLIT_UA_SOURCE_HOSTS (comma-separated).
// ---------------------------------------------------------------------------
const splitUaHosts = (process.env.SPLIT_UA_SOURCE_HOSTS || 'zooox.top')
    .split(',').map(h => h.trim().toLowerCase()).filter(Boolean);

function acquireSplitUa(streamUrl, options, onResponse, onError) {
    let destroyed = false;
    let responded = false;
    let currentReq = null;

    const hop1Headers = {
        'User-Agent': MEDIA_UA,
        'Accept': '*/*',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive'
    };
    const hop2Headers = {
        'User-Agent': BROWSER_UA,
        'Accept': '*/*',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive'
    };

    function fail(err) {
        if (!responded && !destroyed) onError(err);
    }

    const hop1 = singleGet(streamUrl, hop1Headers, options.timeout);
    currentReq = hop1.req;

    hop1.promise.then(({ res, url }) => {
        if (destroyed) { res.resume(); return; }
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const nextUrl = resolveLocation(url, res.headers.location);
            res.resume(); // drain hop1 body
            if (!nextUrl) return fail(new Error('invalid redirect location'));
            const hop2 = singleGet(nextUrl, hop2Headers, options.timeout);
            currentReq = hop2.req;
            hop2.promise.then(({ res: res2, url: finalUrl }) => {
                if (destroyed) { res2.resume(); return; }
                responded = true;
                onResponse(res2, finalUrl);
            }).catch(fail);
        } else {
            responded = true;
            onResponse(res, url);
        }
    }).catch(fail);

    return {
        destroy() {
            destroyed = true;
            try { currentReq && currentReq.destroy(); } catch (e) {}
        }
    };
}

// Default strategy: follow redirects normally with the caller's headers.
function acquireDefault(streamUrl, options, onResponse, onError) {
    let responded = false;
    const parsed = new URL(streamUrl);
    const requester = parsed.protocol === 'https:' ? followHttps : followHttp;
    const req = requester.get(streamUrl, options, (res) => {
        responded = true;
        onResponse(res, streamUrl);
    });
    req.on('error', (err) => { if (!responded) onError(err); });
    req.on('timeout', () => { req.destroy(); if (!responded) onError(new Error('timeout')); });
    return { destroy: () => { try { req.destroy(); } catch (e) {} } };
}

// Public entry point. Returns a handle with destroy() and invokes onResponse
// with the final response (and its URL) or onError on failure.
function acquireSource(streamUrl, options, onResponse, onError) {
    if (hostMatches(streamUrl, splitUaHosts)) {
        return acquireSplitUa(streamUrl, options, onResponse, onError);
    }
    return acquireDefault(streamUrl, options, onResponse, onError);
}

module.exports = { acquireSource, hostMatches, BROWSER_UA, MEDIA_UA, splitUaHosts };
