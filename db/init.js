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
            code_required   INTEGER DEFAULT 1,
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
            preset_key      TEXT DEFAULT NULL,
            video_codec     TEXT DEFAULT NULL,
            video_bitrate   TEXT DEFAULT NULL,
            video_maxrate   TEXT DEFAULT NULL,
            video_bufsize   TEXT DEFAULT NULL,
            video_preset    TEXT DEFAULT NULL,
            video_profile   TEXT DEFAULT NULL,
            video_level     TEXT DEFAULT NULL,
            video_resolution TEXT DEFAULT NULL,
            audio_bitrate   TEXT DEFAULT NULL,
            audio_channels  TEXT DEFAULT NULL,
            audio_rate      TEXT DEFAULT NULL,
            segment_duration INTEGER DEFAULT NULL,
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
            invite_code_id  INTEGER REFERENCES invite_codes(id) ON DELETE CASCADE,
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

    // Migration: add code_required column if missing (for existing databases)
    try {
        const colCheck = db.prepare("PRAGMA table_info(channels)").all();
        const hasCodeRequired = colCheck.some(col => col.name === 'code_required');
        if (!hasCodeRequired) {
            db.exec('ALTER TABLE channels ADD COLUMN code_required INTEGER DEFAULT 1');
            console.log('Migration: added code_required column to channels table');
        }
    } catch (e) {
        console.error('Migration error (code_required):', e.message);
    }

    // Migration: make invite_code_id nullable in sessions (for codeless channel access)
    try {
        // Clean up stale sessions_new from any previous failed migration attempt
        db.exec('DROP TABLE IF EXISTS sessions_new');

        const sessionColCheck = db.prepare("PRAGMA table_info(sessions)").all();
        const inviteCodeCol = sessionColCheck.find(col => col.name === 'invite_code_id');
        if (inviteCodeCol && inviteCodeCol.notnull === 1) {
            // Disable foreign keys during table rebuild (cannot change pragma inside a transaction)
            db.pragma('foreign_keys = OFF');

            db.exec(`
                CREATE TABLE sessions_new (
                    id              INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_token   TEXT NOT NULL UNIQUE,
                    channel_id      INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
                    invite_code_id  INTEGER REFERENCES invite_codes(id) ON DELETE CASCADE,
                    expires_at      DATETIME NOT NULL,
                    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
                );
                INSERT INTO sessions_new SELECT * FROM sessions;
                DROP TABLE sessions;
                ALTER TABLE sessions_new RENAME TO sessions;
            `);

            db.pragma('foreign_keys = ON');
            console.log('Migration: made invite_code_id nullable in sessions table');
        }
    } catch (e) {
        try { db.pragma('foreign_keys = ON'); } catch (_) {}
        console.error('Migration error (sessions invite_code_id nullable):', e.message);
    }

    // Migration: add encoding config columns to channel_qualities
    try {
        const cqColCheck = db.prepare("PRAGMA table_info(channel_qualities)").all();
        const hasPresetKey = cqColCheck.some(col => col.name === 'preset_key');
        if (!hasPresetKey) {
            db.exec(`
                ALTER TABLE channel_qualities ADD COLUMN preset_key TEXT DEFAULT NULL;
                ALTER TABLE channel_qualities ADD COLUMN video_codec TEXT DEFAULT NULL;
                ALTER TABLE channel_qualities ADD COLUMN video_bitrate TEXT DEFAULT NULL;
                ALTER TABLE channel_qualities ADD COLUMN video_maxrate TEXT DEFAULT NULL;
                ALTER TABLE channel_qualities ADD COLUMN video_bufsize TEXT DEFAULT NULL;
                ALTER TABLE channel_qualities ADD COLUMN video_preset TEXT DEFAULT NULL;
                ALTER TABLE channel_qualities ADD COLUMN video_profile TEXT DEFAULT NULL;
                ALTER TABLE channel_qualities ADD COLUMN video_level TEXT DEFAULT NULL;
                ALTER TABLE channel_qualities ADD COLUMN video_resolution TEXT DEFAULT NULL;
                ALTER TABLE channel_qualities ADD COLUMN audio_bitrate TEXT DEFAULT NULL;
                ALTER TABLE channel_qualities ADD COLUMN audio_channels TEXT DEFAULT NULL;
                ALTER TABLE channel_qualities ADD COLUMN audio_rate TEXT DEFAULT NULL;
                ALTER TABLE channel_qualities ADD COLUMN segment_duration INTEGER DEFAULT NULL;
            `);
            console.log('Migration: added encoding config columns to channel_qualities table');
        }
    } catch (e) {
        console.error('Migration error (channel_qualities encoding columns):', e.message);
    }

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
