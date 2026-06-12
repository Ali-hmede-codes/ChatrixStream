# Step 06 — Auth Routes

## What you build
User authentication routes: redeem invite code and validate session token.

## Depends on
Step 03 (services: codeGenerator with redeemInviteCode, validateSession) + Step 04 (middleware: rateLimiter)

## Files to create

### 1. `routes/auth.js`

Express Router with 2 endpoints for user auth. Both use rate limiting.

**Router setup:**
```
const express = require('express');
const router = express.Router();
const { redeemInviteCode, validateSession } = require('../services/codeGenerator');
```

#### Endpoints:

**POST `/api/auth/redeem`** — Redeem invite code → get session token

- Body: `{ code: "CS-XXXXXXX" }`
- Call `redeemInviteCode(db, req.body.code)`
- If success: return 200 with `{ session_token, channel_token, channel_name, qualities, expires_at }`
- If error: return appropriate status code with `{ error: "..." }`

Error responses:
- Code not found → 404 `{ error: 'Invalid code' }`
- Code already redeemed → 403 `{ error: 'Code already used' }`
- Code expired → 403 `{ error: 'Code expired' }`
- Channel link expired → 403 `{ error: 'Channel link expired' }`

After success, also need to return available qualities:
- Query `channel_qualities` for this channel
- Return `qualities: [{ label: 'sd', sort_order: 0 }, { label: 'hd', sort_order: 1 }, ...]`

**Full success response:**
```json
{
    "session_token": "stk-a8Bf3Km9R2xP4Nq7Wv1L",
    "channel_token": "aB3xK9mR2",
    "channel_name": "Champions League",
    "qualities": [
        { "label": "sd", "sort_order": 0 },
        { "label": "hd", "sort_order": 1 },
        { "label": "4k", "sort_order": 2 }
    ],
    "expires_at": "2026-06-12T22:00:00.000Z"
}
```

**POST `/api/auth/session`** — Validate existing session (for auto-login)

- Body: `{ session_token: "stk-..." }`
- Call `validateSession(db, req.body.session_token)`
- If valid: return 200 with `{ valid: true, channel_token, channel_name, qualities, expires_at }`
- If invalid: return 200 with `{ valid: false, error: "..." }`

**Note:** Always return 200 for session validation (not 403). The `valid` field tells the frontend whether to redirect or show code input. This prevents error-triggering logic in the frontend.

After success, also return qualities:
- Same quality query as redeem endpoint

**Full success response:**
```json
{
    "valid": true,
    "channel_token": "aB3xK9mR2",
    "channel_name": "Champions League",
    "qualities": [
        { "label": "sd", "sort_order": 0 },
        { "label": "hd", "sort_order": 1 },
        { "label": "4k", "sort_order": 2 }
    ],
    "expires_at": "2026-06-12T22:00:00.000Z"
}
```

**Code structure:**
```
module.exports = function(db) {
    const router = express.Router();

    router.post('/redeem', (req, res) => { ... });
    router.post('/session', (req, res) => { ... });

    return router;
};
```

## Verify

```bash
node -e "
require('dotenv').config();
const initDB = require('./db/init');
const db = initDB(process.env.DB_PATH);
const { generateChannelToken, generateInviteCodes, redeemInviteCode, validateSession } = require('./services/codeGenerator');

// Setup test data
const token = generateChannelToken();
db.prepare('INSERT INTO channels (name, channel_token, code_ttl_hours) VALUES (?, ?, ?)').run('TestAuth', token, 6);
db.prepare('INSERT INTO channel_qualities (channel_id, quality_label, stream_url, sort_order) VALUES (?, ?, ?, ?)').run(1, 'sd', 'http://test/sd', 0);
db.prepare('INSERT INTO channel_qualities (channel_id, quality_label, stream_url, sort_order) VALUES (?, ?, ?, ?)').run(1, 'hd', 'http://test/hd', 1);

// Generate and redeem a code
const codes = generateInviteCodes(db, 1, 1, 6);
const code = codes[0].code;
console.log('Generated code:', code);

const result = redeemInviteCode(db, code);
console.log('Redeem result:', result);

if (result.session_token) {
    const sessionResult = validateSession(db, result.session_token);
    console.log('Session valid:', sessionResult.valid);
}

// Try to redeem same code again (should fail)
const result2 = redeemInviteCode(db, code);
console.log('Second redeem (should fail):', result2);

// Cleanup
db.prepare('DELETE FROM channels WHERE name = ?').run('TestAuth');
db.close();
console.log('Auth routes logic OK');
"
```

Should show: code generated, successful redemption, session valid, second redeem fails.

## Next step
→ `steps/07-stream-routes.md`
