# Step 05 — Admin Routes

## What you build
All admin API routes: channel management, quality management, invite code management, link regeneration, session management.

## Depends on
Step 03 (services: codeGenerator) + Step 04 (middleware: adminAuth)

## Files to create

### 1. `routes/admin.js`

Express Router with all admin endpoints. All routes require `adminAuth` middleware.

**Router setup:**
```
const express = require('express');
const router = express.Router();
const adminAuth = require('../middleware/adminAuth');
const { generateChannelToken, generateInviteCode, generateInviteCodes } = require('../services/codeGenerator');

router.use(adminAuth);   // all admin routes require auth
```

#### Endpoints to implement:

**POST `/api/admin/channels`** — Create channel
- Body: `{ name, code_ttl_hours (optional, default from env), link_expires_at (optional) }`
- Generate `channel_token` via `generateChannelToken()`
- Insert into `channels` table
- Return: `{ id, name, channel_token, code_ttl_hours, link_expires_at, created_at }`

**GET `/api/admin/channels`** — List all channels
- Query all channels
- For each channel, also fetch its qualities and codes count
- Return: `[{ id, name, channel_token, qualities: [...], codes_count, ... }]`
- Use LEFT JOIN or separate queries

**DELETE `/api/admin/channels/:id`** — Delete channel (cascade)
- Delete from `channels` table
- CASCADE automatically deletes: qualities, invite_codes, sessions
- Also call `streamManager.stopAllStreamsForChannel(id)` to kill active streams
- Return: `{ deleted: true }`
- Note: streamManager will be passed as parameter or accessed via req.app

**PATCH `/api/admin/channels/:id`** — Update channel
- Body: `{ name, code_ttl_hours, link_expires_at }` (all optional)
- UPDATE channels table with provided fields
- Return: updated channel object

**POST `/api/admin/channels/:id/regenerate-link`** — Regenerate public link
- Generate new `channel_token`
- UPDATE channel's `channel_token` to new value
- Old link instantly invalid (token changed in DB)
- Existing sessions still work (validated by channel_id, not token)
- Return: `{ channel_token: "newToken" }`

**POST `/api/admin/channels/:id/qualities`** — Add quality
- Body: `{ quality_label, stream_url, sort_order (optional) }`
- Validate: quality_label not empty, stream_url not empty
- Validate: no duplicate quality_label for same channel
- Insert into `channel_qualities` table
- Return: `{ id, quality_label, stream_url, sort_order }`

**DELETE `/api/admin/channels/:id/qualities/:qid`** — Remove quality
- Delete from `channel_qualities` where id = qid AND channel_id = :id
- Also call `streamManager.stopStream(channelId, qualityLabel)` to kill that stream
- Return: `{ deleted: true }`

**PATCH `/api/admin/channels/:id/qualities/:qid`** — Update quality
- Body: `{ quality_label, stream_url, sort_order }` (all optional)
- UPDATE channel_qualities table
- Return: updated quality object

**POST `/api/admin/channels/:id/codes`** — Generate invite codes
- Body: `{ count (default 10), ttl_hours (optional, uses channel's code_ttl_hours) }`
- Validate: count ≤ MAX_CODES_PER_GENERATION (from env)
- Call `generateInviteCodes(db, channelId, count, ttlHours)`
- Return: `[{ code, expires_at }, ...]`

**POST `/api/admin/channels/:id/regenerate-codes`** — Regenerate all codes
- Body: `{ count (default 10), ttl_hours (optional) }`
- DELETE all invite_codes for this channel (CASCADE deletes their sessions)
- Call `generateInviteCodes(db, channelId, count, ttlHours)`
- Return: `[{ code, expires_at }, ...]`

**GET `/api/admin/channels/:id/codes`** — List codes
- Query all invite_codes for this channel
- For each code, determine status: unused / redeemed / expired
- Also show session info if redeemed (join with sessions table)
- Return: `[{ code, status, expires_at, session_token (if redeemed) }]`

**DELETE `/api/admin/codes/:code`** — Revoke single code
- DELETE from invite_codes (CASCADE deletes its session)
- Return: `{ deleted: true }`

**GET `/api/admin/channels/:id/sessions`** — List active sessions
- Query sessions where channel_id = :id AND expires_at > now()
- Return: `[{ session_token, expires_at, created_at }]`

**DELETE `/api/admin/sessions/:token`** — Revoke session
- DELETE from sessions where session_token = :token
- Return: `{ deleted: true }`

**Code structure:**
```
module.exports = function(db, streamManager) {
    const router = express.Router();
    router.use(adminAuth);

    // ... all route handlers using db.prepare() + stmt.run()/get()/all()

    return router;
};
```

**Important:** All database operations use `db.prepare()` for prepared statements. Read operations use `.all()` or `.get()`. Write operations use `.run()`. Transactions use `db.transaction()`.

## Verify

```bash
node -e "
require('dotenv').config();
const initDB = require('./db/init');
const db = initDB(process.env.DB_PATH);
const { generateChannelToken, generateInviteCodes } = require('./services/codeGenerator');

// Manual test: create channel
const token = generateChannelToken();
db.prepare('INSERT INTO channels (name, channel_token, code_ttl_hours) VALUES (?, ?, ?)').run('TestChannel', token, 6);
const channel = db.prepare('SELECT * FROM channels WHERE name = ?').get('TestChannel');
console.log('Channel created:', channel);

// Manual test: add quality
db.prepare('INSERT INTO channel_qualities (channel_id, quality_label, stream_url, sort_order) VALUES (?, ?, ?, ?)').run(channel.id, 'sd', 'http://test.com/sd', 0);
db.prepare('INSERT INTO channel_qualities (channel_id, quality_label, stream_url, sort_order) VALUES (?, ?, ?, ?)').run(channel.id, 'hd', 'http://test.com/hd', 1);
const qualities = db.prepare('SELECT * FROM channel_qualities WHERE channel_id = ?').all(channel.id);
console.log('Qualities:', qualities);

// Manual test: generate codes
const codes = generateInviteCodes(db, channel.id, 3, 6);
console.log('Codes:', codes);

// Manual test: cascade delete
db.prepare('DELETE FROM channels WHERE id = ?').run(channel.id);
const remaining = db.prepare('SELECT * FROM channel_qualities').all();
const remainingCodes = db.prepare('SELECT * FROM invite_codes').all();
console.log('After delete - qualities:', remaining.length, 'codes:', remainingCodes.length);

db.close();
console.log('Admin routes DB operations OK');
"
```

Should show: channel created, 2 qualities, 3 codes, after delete → 0 qualities, 0 codes (cascade works).

## Next step
→ `steps/06-auth-routes.md`
