const { http, https } = require('follow-redirects');

/**
 * Resolves the final redirected URL for a stream link by performing a GET request
 * and immediately destroying the response once the headers and responseUrl are received.
 * This ensures we don't stream any video data during resolution.
 * 
 * @param {string} urlStr - The initial stream URL.
 * @param {number} timeoutMs - Timeout for the request in milliseconds.
 * @returns {Promise<string>} The final redirected URL or the original URL on failure.
 */
function resolveRedirect(urlStr, timeoutMs = 5000) {
    return new Promise((resolve) => {
        try {
            const parsedUrl = new URL(urlStr);
            const client = parsedUrl.protocol === 'https:' ? https : http;
            
            const reqOptions = {
                timeout: timeoutMs,
                headers: {
                    'User-Agent': 'VLC/3.0.21 Vetinari',
                    'Accept': '*/*'
                }
            };

            if (parsedUrl.username && parsedUrl.password) {
                const auth = Buffer.from(parsedUrl.username + ':' + parsedUrl.password).toString('base64');
                reqOptions.headers['Authorization'] = 'Basic ' + auth;
            }

            const req = client.get(urlStr, reqOptions, (res) => {
                let finalUrl = res.responseUrl || urlStr;
                try {
                    const originalUrl = new URL(urlStr);
                    if (originalUrl.username || originalUrl.password) {
                        const finalParsed = new URL(finalUrl);
                        if (!finalParsed.username && !finalParsed.password) {
                            finalParsed.username = originalUrl.username;
                            finalParsed.password = originalUrl.password;
                            finalUrl = finalParsed.toString();
                        }
                    }
                } catch (e) {
                    // Ignore parsing errors
                }
                res.destroy(); // Destroy immediately to stop reading data
                resolve(finalUrl);
            });
            
            req.on('error', (err) => {
                console.error(`[urlResolver] Error resolving redirect for ${urlStr}:`, err.message);
                resolve(urlStr);
            });
            
            req.on('timeout', () => {
                console.error(`[urlResolver] Timeout resolving redirect for ${urlStr}`);
                req.destroy();
                resolve(urlStr);
            });
        } catch (e) {
            console.error(`[urlResolver] Exception resolving redirect for ${urlStr}:`, e.message);
            resolve(urlStr);
        }
    });
}

module.exports = { resolveRedirect };
