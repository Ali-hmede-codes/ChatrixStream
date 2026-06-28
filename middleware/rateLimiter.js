function rateLimiter(options = {}) {
    const windowMs = options.windowMs || 60000;
    const maxRequests = options.maxRequests || 10;
    const maxIps = options.maxIps || 10000;
    const sweepIntervalMs = options.sweepIntervalMs || 60000;
    const hits = new Map();

    let lastSweep = Date.now();

    function sweep(now) {
        for (const [ip, record] of hits) {
            if (now - record.startTime > windowMs) {
                hits.delete(ip);
            }
        }
    }

    return function(req, res, next) {
        const ip = req.ip || req.connection.remoteAddress;
        const now = Date.now();

        if (now - lastSweep > sweepIntervalMs) {
            sweep(now);
            lastSweep = now;
        }

        const record = hits.get(ip);

        if (!record || now - record.startTime > windowMs) {
            hits.set(ip, { count: 1, startTime: now });
            if (hits.size > maxIps) {
                const oldestKey = hits.keys().next().value;
                hits.delete(oldestKey);
            }
            return next();
        }

        record.count++;
        if (record.count > maxRequests) {
            return res.status(429).json({ error: 'Too many requests' });
        }
        next();
    };
}

module.exports = rateLimiter;
