# Step 04 — Middleware (adminAuth + sessionAuth + rateLimiter)

## What you build
3 middleware functions for Express route protection.

## Depends on
Step 03 (services created)

## Files to create

### 1. `middleware/adminAuth.js`

**Purpose:** Protect all admin routes. Require `X-Admin-Secret` header matching `ADMIN_SECRET` env var.

**Implementation:**
```
function adminAuth(req, res, next) {
    const secret = req.headers['x-admin-secret'];
    if (!secret || secret !== process.env.ADMIN_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}
module.exports = adminAuth;
```

**Behavior:**
- No `X-Admin-Secret` header → 401 `{ error: 'Unauthorized' }`
- Wrong secret → 401 `{ error: 'Unauthorized' }`
- Correct secret → passes to next middleware/route handler
- Never reveals what the expected secret is
- Never reveals whether the header was missing vs wrong

### 2. `middleware/sessionAuth.js`

**Purpose:** Protect stream and player routes. Require valid `X-Session-Token` header. Validate against database on every request.

**Implementation:**
```
function sessionAuth(db, validateSession) {
    return function(req, res, next) {
        const token = req.headers['x-session-token'] || req.query.session;
        if (!token) {
            return res.status(403).json({ error: 'Access denied: no session token' });
        }
        const result = validateSession(db, token);
        if (!result.valid) {
            return res.status(403).json({ error: result.error });
        }
        req.session = result;   // attach session info to request
        next();
    };
}
module.exports = sessionAuth;
```

**Behavior:**
- No session token (header or query param) → 403
- Invalid/expired token → 403
- Valid token → attaches `{ channel_id, channel_token, channel_name, expires_at }` to `req.session`
- Used on: `GET /channel/:token/:quality` route
- Validation happens on EVERY request (not cached)

**Note:** This middleware also needs to verify that the session belongs to the channel being accessed. The stream route will do the channel_token + quality matching separately. The middleware just validates the session exists and is valid.

### 3. `middleware/rateLimiter.js`

**Purpose:** Prevent brute-force attacks on auth endpoints and stream abuse.

**Implementation:**
```
function rateLimiter(options = {}) {
    const windowMs = options.windowMs || 60000;
    const maxRequests = options.maxRequests || 10;
    const hits = new Map();   // key: IP, value: { count, startTime }

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
```

**Usage in server.js:**
```
const rateLimiter = require('./middleware/rateLimiter');

// Apply to auth endpoints
app.use('/api/auth/redeem', rateLimiter({ windowMs: 60000, maxRequests: 10 }));
app.use('/api/auth/session', rateLimiter({ windowMs: 60000, maxRequests: 10 }));

// Apply to stream endpoints (more restrictive)
app.use('/channel/', rateLimiter({ windowMs: 60000, maxRequests: 5 }));
```

**Behavior:**
- Tracks requests per IP in memory (Map)
- Resets counter every `windowMs`
- Over limit → 429 Too Many Requests
- No external dependencies needed

## Verify

```bash
node -e "
const adminAuth = require('./middleware/adminAuth');
const rateLimiter = require('./middleware/rateLimiter');

// Test adminAuth
const mockReq = { headers: {} };
const mockRes = { status: (c) => ({ json: (d) => console.log('adminAuth:', c, d) }) };
adminAuth(mockReq, mockRes, () => console.log('adminAuth: passed'));

// Test with correct secret
mockReq.headers['x-admin-secret'] = 'ChatrixAdmin2026SecretKey32Chars!';
adminAuth(mockReq, mockRes, () => console.log('adminAuth: passed'));

// Test rateLimiter
const limiter = rateLimiter({ windowMs: 60000, maxRequests: 3 });
for (let i = 0; i < 5; i++) {
    const req = { ip: '127.0.0.1' };
    const res = { status: (c) => ({ json: (d) => console.log('rateLimiter request', i+1, ':', c, d) }) };
    limiter(req, res, () => console.log('rateLimiter request', i+1, ': passed'));
}
console.log('All middleware OK');
"
```

Should show:
- adminAuth without secret → 401
- adminAuth with correct secret → passed
- rateLimiter: first 3 requests pass, 4th+ return 429

## Next step
→ `steps/05-admin-routes.md`
