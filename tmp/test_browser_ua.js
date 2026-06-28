require('dotenv').config();
const sourceHandlers = require('../services/sourceHandlers');

const URL = process.argv[2] || 'http://81.161.238.24:8080/live/play/Ulc1elMyRm1la2xFTkZVMU0zcGtlWFZTY1VRelpHWmlVV2xOVGpsMVlucHVOalpRUkRoNU5VbFpVVDA9/443955';
console.log('Testing acquireSource against:', URL);
console.log('strategy:', sourceHandlers.resolveStrategy(URL));
console.log('splitUaHosts:', sourceHandlers.splitUaHosts);
console.log('browserUaHosts:', sourceHandlers.browserUaHosts);

const options = { timeout: 15000, headers: { 'User-Agent': 'VLC/3.0.21 Vetinari' }, agent: false };
let bytes = 0;
let done = false;

const handle = sourceHandlers.acquireSource(
    URL,
    options,
    (res, finalUrl) => {
        console.log(`RESPONSE status=${res.statusCode} finalUrl=${finalUrl} type=${res.headers['content-type']} server=${res.headers['server'] || '-'}`);
        if (res.statusCode !== 200) {
            res.resume();
            finish(new Error('non-200: ' + res.statusCode));
            return;
        }
        res.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes >= 512 * 1024 && !done) {
                done = true;
                console.log(`SUCCESS: received ${(bytes / 1024 / 1024).toFixed(2)} MB of ${res.headers['content-type']}`);
                handle.destroy();
                process.exit(0);
            }
        });
        res.on('end', () => finish(new Error('stream ended before 512KB')));
        res.on('error', (e) => finish(e));
    },
    (err) => finish(err)
);

function finish(err) {
    if (done) return;
    done = true;
    if (err) {
        console.error('FAILED:', err.message);
        process.exit(1);
    }
    process.exit(0);
}

setTimeout(() => finish(new Error('overall timeout')), 30000);
