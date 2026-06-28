const { validateSession } = require('./codeGenerator');

class SessionCache {
    constructor(db, ttlMs = 30000, maxSize = 500) {
        this.db = db;
        this.ttlMs = ttlMs;
        this.maxSize = maxSize;
        this.cache = new Map();
    }

    get(sessionToken) {
        const now = Date.now();
        const cached = this.cache.get(sessionToken);
        if (cached && now - cached.timestamp < this.ttlMs) {
            return cached.result;
        }

        const result = validateSession(this.db, sessionToken);
        this.cache.set(sessionToken, { result, timestamp: now });

        if (this.cache.size > this.maxSize) {
            for (const [key, val] of this.cache) {
                if (now - val.timestamp > this.ttlMs) {
                    this.cache.delete(key);
                }
            }
            if (this.cache.size > this.maxSize) {
                const entries = Array.from(this.cache.entries());
                entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
                const toRemove = entries.slice(0, entries.length - Math.floor(this.maxSize * 0.8));
                for (const [key] of toRemove) {
                    this.cache.delete(key);
                }
            }
        }

        return result;
    }

    invalidate(sessionToken) {
        this.cache.delete(sessionToken);
    }
}

module.exports = SessionCache;
