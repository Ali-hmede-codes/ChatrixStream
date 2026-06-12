function rateLimiter(options = {}) {
    const windowMs = options.windowMs || 60000;
    const maxRequests = options.maxRequests || 10;
    const hits = new Map();

    return function(req, res, next) {
        const ip = req.ip || req.connection.remoteAddress;
        const now = Date.now();
        const record = hits.get(ip);

        if (!record || now - record.startTime > windowMs) {
            hits.set(ip, { count: 1, startTime: now });
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
