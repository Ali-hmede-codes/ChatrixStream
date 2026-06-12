# Step 02 — Database Schema & Initialization

## What you build
SQLite database with all 4 tables, indexes, foreign keys, and `db/init.js` that creates everything on startup.

## Depends on
Step 01 (project init, better-sqlite3 installed)

## Files to create

### 1. `db/init.js`

This file:
- Opens SQLite database at path from env (`DB_PATH`)
- Enables WAL mode for concurrent read/write performance
- Enables foreign keys enforcement (`PRAGMA foreign_keys = ON`)
- Creates all 4 tables if they don't exist
- Creates all indexes if they don't exist
- Exports the db instance for use in other modules

**Tables (exact SQL):**

```sql
CREATE TABLE IF NOT EXISTS channels (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    channel_token   TEXT NOT NULL UNIQUE,
    code_ttl_hours  INTEGER DEFAULT 6,
    link_expires_at DATETIME,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS channel_qualities (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id      INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    quality_label   TEXT NOT NULL,
    stream_url      TEXT NOT NULL,
    sort_order      INTEGER DEFAULT 0,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS invite_codes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    code            TEXT NOT NULL UNIQUE,
    channel_id      INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    redeemed        INTEGER DEFAULT 0,
    expires_at      DATETIME NOT NULL,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_token   TEXT NOT NULL UNIQUE,
    channel_id      INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    invite_code_id  INTEGER NOT NULL REFERENCES invite_codes(id) ON DELETE CASCADE,
    expires_at      DATETIME NOT NULL,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**Indexes:**

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_token ON channels(channel_token);
CREATE INDEX IF NOT EXISTS idx_channel_qualities_channel ON channel_qualities(channel_id);
CREATE INDEX IF NOT EXISTS idx_invite_codes_code ON invite_codes(code);
CREATE INDEX IF NOT EXISTS idx_invite_codes_channel ON invite_codes(channel_id);
CREATE INDEX IF NOT EXISTS idx_invite_codes_expires ON invite_codes(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(session_token);
CREATE INDEX IF NOT EXISTS idx_sessions_channel ON sessions(channel_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
```

**Code structure for `db/init.js`:**

```
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

module.exports = function initDB(dbPath) {
    // Ensure db directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Open database
    const db = new Database(dbPath);

    // Enable WAL mode (performance)
    db.pragma('journal_mode = WAL');

    // Enable foreign keys (security — cascade deletes work)
    db.pragma('foreign_keys = ON');

    // Create all tables (IF NOT EXISTS — safe to run multiple times)
    db.exec(`... all CREATE TABLE statements ...`);
    db.exec(`... all CREATE INDEX statements ...`);

    // Return db instance
    return db;
};
```

## Verify
```bash
cd E:\ChatrixStream
node -e "require('dotenv').config(); const initDB = require('./db/init'); const db = initDB(process.env.DB_PATH); const tables = db.prepare('SELECT name FROM sqlite_master WHERE type=\"table\"').all(); console.log(tables); db.close();"
```
Should print 4 tables: channels, channel_qualities, invite_codes, sessions.

```bash
node -e "require('dotenv').config(); const initDB = require('./db/init'); const db = initDB(process.env.DB_PATH); const indexes = db.prepare('SELECT name FROM sqlite_master WHERE type=\"index\" AND name LIKE \"idx_%\"').all(); console.log(indexes); db.close();"
```
Should print 7 indexes.

Also verify foreign keys work:
```bash
node -e "require('dotenv').config(); const initDB = require('./db/init'); const db = initDB(process.env.DB_PATH); const fk = db.pragma('foreign_keys'); console.log(fk); db.close();"
```
Should print `{ foreign_keys: 1 }`.

## Next step
→ `steps/03-services.md`
