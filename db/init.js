const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

module.exports = function initDB(dbPath) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const db = new Database(dbPath);

    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    db.exec(`
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

        CREATE TABLE IF NOT EXISTS admin_users (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            username    TEXT NOT NULL UNIQUE,
            password    TEXT NOT NULL,
            role        TEXT NOT NULL DEFAULT 'admin',
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_token ON channels(channel_token);
        CREATE INDEX IF NOT EXISTS idx_channel_qualities_channel ON channel_qualities(channel_id);
        CREATE INDEX IF NOT EXISTS idx_invite_codes_code ON invite_codes(code);
        CREATE INDEX IF NOT EXISTS idx_invite_codes_channel ON invite_codes(channel_id);
        CREATE INDEX IF NOT EXISTS idx_invite_codes_expires ON invite_codes(expires_at);
        CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(session_token);
        CREATE INDEX IF NOT EXISTS idx_sessions_channel ON sessions(channel_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_users_username ON admin_users(username);
    `);

    return db;
};
