const crypto = require('crypto');

const CHARSET_UPPER = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CHARSET_MIXED = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function toBase62(bytes, charset, length) {
    let num = BigInt('0x' + Buffer.from(bytes).toString('hex'));
    const base = BigInt(charset.length);
    let result = '';
    while (num > 0n) {
        result += charset[Number(num % base)];
        num = num / base;
    }
    result = result.padEnd(length, charset[0]);
    return result.slice(0, length);
}

function generateChannelToken() {
    return toBase62(crypto.randomBytes(8), CHARSET_MIXED, 10);
}

function generateInviteCode() {
    let code = 'CS-';
    for (let i = 0; i < 7; i++) {
        code += CHARSET_UPPER[crypto.randomInt(29)];
    }
    return code;
}

function generateSessionToken() {
    return 'stk-' + toBase62(crypto.randomBytes(18), CHARSET_MIXED, 24);
}

function generateInviteCodes(db, channelId, count, expiresAtStr, ttlHours) {
    const insertStmt = db.prepare(
        'INSERT INTO invite_codes (code, channel_id, expires_at) VALUES (?, ?, ?)'
    );
    const codes = [];

    let finalExpiresAt;
    if (expiresAtStr) {
        finalExpiresAt = expiresAtStr;
    } else if (ttlHours && ttlHours > 0) {
        // Use TTL-based expiry when no link_expires_at is set
        const expires = new Date(Date.now() + ttlHours * 3600 * 1000);
        finalExpiresAt = expires.toISOString();
    } else {
        // Fallback: far-future expiry only if no TTL and no link expiry
        finalExpiresAt = '9999-12-31T23:59:59.999Z';
    }

    const transaction = db.transaction(() => {
        for (let i = 0; i < count; i++) {
            const code = generateInviteCode();
            insertStmt.run(code, channelId, finalExpiresAt);
            codes.push({ code, expires_at: finalExpiresAt });
        }
    });
    transaction();

    return codes;
}

function redeemInviteCode(db, code) {
    const transaction = db.transaction(() => {
        const codeRow = db.prepare(
            'SELECT * FROM invite_codes WHERE code = ?'
        ).get(code);

        if (!codeRow) return { error: 'Code not found' };
        if (codeRow.redeemed === 1) return { error: 'Code already redeemed' };

        const now = new Date();
        if (new Date(codeRow.expires_at) <= now) return { error: 'Code expired' };

        const channel = db.prepare(
            'SELECT * FROM channels WHERE id = ?'
        ).get(codeRow.channel_id);

        if (!channel) return { error: 'Channel not found' };
        if (channel.link_expires_at && new Date(channel.link_expires_at) <= now) return { error: 'Channel link expired' };

        db.prepare('UPDATE invite_codes SET redeemed = 1 WHERE id = ?').run(codeRow.id);

        // Session expires at the earliest of: code expiry, channel link expiry
        const sessionExpiresAt = (channel.link_expires_at && new Date(channel.link_expires_at) < new Date(codeRow.expires_at))
            ? channel.link_expires_at
            : codeRow.expires_at;

        const sessionToken = generateSessionToken();
        db.prepare(
            'INSERT INTO sessions (session_token, channel_id, invite_code_id, expires_at) VALUES (?, ?, ?, ?)'
        ).run(sessionToken, codeRow.channel_id, codeRow.id, sessionExpiresAt);

        return {
            session_token: sessionToken,
            channel_id: channel.id,
            channel_token: channel.channel_token,
            channel_name: channel.name,
            expires_at: sessionExpiresAt
        };
    });

    return transaction();
}

function createSessionForChannel(db, channelId) {
    const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
    if (!channel) return { error: 'Channel not found' };

    const now = new Date();
    if (channel.link_expires_at && new Date(channel.link_expires_at) <= now) return { error: 'Channel link expired' };

    // Session expiry: use link_expires_at if set, otherwise 24 hours from now
    const sessionExpiresAt = channel.link_expires_at
        ? channel.link_expires_at
        : new Date(Date.now() + 24 * 3600 * 1000).toISOString();

    const sessionToken = generateSessionToken();
    // Use NULL for invite_code_id since no code was used
    db.prepare(
        'INSERT INTO sessions (session_token, channel_id, invite_code_id, expires_at) VALUES (?, ?, ?, ?)'
    ).run(sessionToken, channelId, null, sessionExpiresAt);

    return {
        session_token: sessionToken,
        channel_id: channel.id,
        channel_token: channel.channel_token,
        channel_name: channel.name,
        expires_at: sessionExpiresAt
    };
}

function validateSession(db, sessionToken) {
    const session = db.prepare(
        'SELECT * FROM sessions WHERE session_token = ?'
    ).get(sessionToken);

    if (!session) return { valid: false, error: 'Session not found' };

    const now = new Date();
    if (new Date(session.expires_at) <= now) return { valid: false, error: 'Session expired' };

    const channel = db.prepare(
        'SELECT * FROM channels WHERE id = ?'
    ).get(session.channel_id);

    if (!channel) return { valid: false, error: 'Channel not found' };
    if (channel.link_expires_at && new Date(channel.link_expires_at) <= now) return { valid: false, error: 'Channel link expired' };

    return {
        valid: true,
        channel_id: channel.id,
        channel_token: channel.channel_token,
        channel_name: channel.name,
        expires_at: session.expires_at
    };
}

module.exports = {
    generateChannelToken,
    generateInviteCode,
    generateSessionToken,
    generateInviteCodes,
    redeemInviteCode,
    createSessionForChannel,
    validateSession
};
