const express = require('express');
const { adminAuth, superAdminOnly } = require('../middleware/adminAuth');
const { generateChannelToken, generateInviteCodes } = require('../services/codeGenerator');
const { hashPassword } = require('../services/adminUser');

module.exports = function(db, streamManager) {
    const router = express.Router();
    router.use(adminAuth);

    const insertChannel = db.prepare(
        'INSERT INTO channels (name, channel_token, code_ttl_hours, link_expires_at) VALUES (?, ?, ?, ?)'
    );
    const getChannelById = db.prepare('SELECT * FROM channels WHERE id = ?');
    const getAllChannels = db.prepare('SELECT * FROM channels');
    const getQualitiesByChannel = db.prepare('SELECT * FROM channel_qualities WHERE channel_id = ? ORDER BY sort_order');
    const getCodesCountByChannel = db.prepare('SELECT COUNT(*) as count FROM invite_codes WHERE channel_id = ?');
    const deleteChannelById = db.prepare('DELETE FROM channels WHERE id = ?');
    const updateChannel = db.prepare(
        'UPDATE channels SET name = COALESCE(?, name), code_ttl_hours = COALESCE(?, code_ttl_hours), link_expires_at = COALESCE(?, link_expires_at) WHERE id = ?'
    );
    const updateChannelToken = db.prepare('UPDATE channels SET channel_token = ? WHERE id = ?');
    const insertQuality = db.prepare(
        'INSERT INTO channel_qualities (channel_id, quality_label, stream_url, sort_order) VALUES (?, ?, ?, ?)'
    );
    const getQualityById = db.prepare('SELECT * FROM channel_qualities WHERE id = ? AND channel_id = ?');
    const deleteQualityById = db.prepare('DELETE FROM channel_qualities WHERE id = ? AND channel_id = ?');
    const updateQuality = db.prepare(
        'UPDATE channel_qualities SET quality_label = COALESCE(?, quality_label), stream_url = COALESCE(?, stream_url), sort_order = COALESCE(?, sort_order) WHERE id = ?'
    );
    const getCodesByChannel = db.prepare(
        'SELECT ic.*, s.session_token FROM invite_codes ic LEFT JOIN sessions s ON ic.id = s.invite_code_id WHERE ic.channel_id = ?'
    );
    const deleteCodeByCode = db.prepare('DELETE FROM invite_codes WHERE code = ?');
    const deleteCodesByChannel = db.prepare('DELETE FROM invite_codes WHERE channel_id = ?');
    const getSessionsByChannel = db.prepare('SELECT session_token, expires_at, created_at FROM sessions WHERE channel_id = ? AND expires_at > ?');
    const deleteSessionByToken = db.prepare('DELETE FROM sessions WHERE session_token = ?');

    router.post('/channels', (req, res) => {
        const { name, link_expires_at } = req.body;
        if (!name) return res.status(400).json({ error: 'Channel name is required' });

        const ttl = parseInt(process.env.DEFAULT_CODE_TTL_HOURS) || 6;
        const token = generateChannelToken();
        const result = insertChannel.run(name, token, ttl, link_expires_at || null);
        const channel = getChannelById.get(result.lastInsertRowid);
        res.json(channel);
    });

    router.get('/channels', (req, res) => {
        const channels = getAllChannels.all();
        const enriched = channels.map(ch => {
            const qualities = getQualitiesByChannel.all(ch.id);
            const codesCount = getCodesCountByChannel.get(ch.id);
            return { ...ch, qualities, codes_count: codesCount.count };
        });
        res.json(enriched);
    });

    router.delete('/channels/:id', (req, res) => {
        const { id } = req.params;
        streamManager.stopAllStreamsForChannel(parseInt(id));
        deleteChannelById.run(id);
        res.json({ deleted: true });
    });

    router.patch('/channels/:id', (req, res) => {
        const { id } = req.params;
        const { name, code_ttl_hours, link_expires_at } = req.body;
        updateChannel.run(name || null, code_ttl_hours || null, link_expires_at || null, id);
        const channel = getChannelById.get(id);
        res.json(channel);
    });

    router.post('/channels/:id/regenerate-link', (req, res) => {
        const { id } = req.params;
        const newToken = generateChannelToken();
        updateChannelToken.run(newToken, id);
        res.json({ channel_token: newToken });
    });

    router.post('/channels/:id/qualities', (req, res) => {
        const { id } = req.params;
        const { quality_label, stream_url, sort_order } = req.body;
        if (!quality_label || !stream_url) return res.status(400).json({ error: 'quality_label and stream_url are required' });

        const existing = db.prepare('SELECT * FROM channel_qualities WHERE channel_id = ? AND quality_label = ?').get(id, quality_label);
        if (existing) return res.status(400).json({ error: 'Quality label already exists for this channel' });

        const result = insertQuality.run(id, quality_label, stream_url, sort_order || 0);
        const quality = getQualityById.get(result.lastInsertRowid, id);
        res.json(quality);
    });

    router.delete('/channels/:id/qualities/:qid', (req, res) => {
        const { id, qid } = req.params;
        const quality = getQualityById.get(qid, id);
        if (quality) streamManager.stopStream(parseInt(id), quality.quality_label);
        deleteQualityById.run(qid, id);
        res.json({ deleted: true });
    });

    router.patch('/channels/:id/qualities/:qid', (req, res) => {
        const { id, qid } = req.params;
        const { quality_label, stream_url, sort_order } = req.body;
        updateQuality.run(quality_label || null, stream_url || null, sort_order || null, qid);
        const quality = getQualityById.get(qid, id);
        res.json(quality);
    });

    router.post('/channels/:id/codes', (req, res) => {
        const { id } = req.params;
        const count = req.body.count || 10;
        const maxCodes = parseInt(process.env.MAX_CODES_PER_GENERATION) || 100;
        if (count > maxCodes) return res.status(400).json({ error: `Maximum ${maxCodes} codes per generation` });

        const channel = getChannelById.get(id);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });

        const codes = generateInviteCodes(db, parseInt(id), count, channel.link_expires_at, channel.code_ttl_hours);
        res.json(codes);
    });

    router.post('/channels/:id/regenerate-codes', (req, res) => {
        const { id } = req.params;
        const count = req.body.count || 10;
        const maxCodes = parseInt(process.env.MAX_CODES_PER_GENERATION) || 100;
        if (count > maxCodes) return res.status(400).json({ error: `Maximum ${maxCodes} codes per generation` });

        const channel = getChannelById.get(id);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });

        const transaction = db.transaction(() => {
            deleteCodesByChannel.run(id);
            return generateInviteCodes(db, parseInt(id), count, channel.link_expires_at, channel.code_ttl_hours);
        });

        const codes = transaction();
        res.json(codes);
    });

    router.get('/channels/:id/codes', (req, res) => {
        const { id } = req.params;
        const codes = getCodesByChannel.all(id);
        const now = new Date().toISOString();
        const enriched = codes.map(c => {
            let status = 'unused';
            if (c.redeemed === 1) status = 'redeemed';
            else if (c.expires_at <= now) status = 'expired';
            return { code: c.code, status, expires_at: c.expires_at, session_token: c.session_token || null };
        });
        res.json(enriched);
    });

    router.delete('/codes/:code', (req, res) => {
        const { code } = req.params;
        deleteCodeByCode.run(code);
        res.json({ deleted: true });
    });

    router.get('/channels/:id/sessions', (req, res) => {
        const { id } = req.params;
        const now = new Date().toISOString();
        const sessions = getSessionsByChannel.all(id, now);
        res.json(sessions);
    });

    router.delete('/sessions/:token', (req, res) => {
        const { token } = req.params;
        deleteSessionByToken.run(token);
        res.json({ deleted: true });
    });

    const getAllAdminUsers = db.prepare('SELECT id, username, role, created_at FROM admin_users ORDER BY id');
    const getAdminUserById = db.prepare('SELECT id, username, role, created_at FROM admin_users WHERE id = ?');
    const getAdminUserByUsername = db.prepare('SELECT id, username, role, created_at FROM admin_users WHERE username = ?');
    const insertAdminUser = db.prepare('INSERT INTO admin_users (username, password, role) VALUES (?, ?, ?)');
    const updateAdminUser = db.prepare('UPDATE admin_users SET username = COALESCE(?, username), role = COALESCE(?, role) WHERE id = ?');
    const updateAdminPassword = db.prepare('UPDATE admin_users SET password = ? WHERE id = ?');
    const deleteAdminUser = db.prepare('DELETE FROM admin_users WHERE id = ?');

    router.get('/users', superAdminOnly, (req, res) => {
        const users = getAllAdminUsers.all();
        res.json(users);
    });

    router.post('/users', superAdminOnly, (req, res) => {
        const { username, password, role } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
        if (!['superadmin', 'admin', 'moderator'].includes(role || 'admin')) return res.status(400).json({ error: 'Invalid role. Use superadmin, admin, or moderator' });

        const existing = getAdminUserByUsername.get(username);
        if (existing) return res.status(400).json({ error: 'Username already exists' });

        const result = insertAdminUser.run(username, hashPassword(password), role || 'admin');
        const user = getAdminUserById.get(result.lastInsertRowid);
        res.json(user);
    });

    router.patch('/users/:id', superAdminOnly, (req, res) => {
        const { id } = req.params;
        const { username, role } = req.body;
        if (!id) return res.status(400).json({ error: 'User ID is required' });

        if (role && !['superadmin', 'admin', 'moderator'].includes(role)) return res.status(400).json({ error: 'Invalid role. Use superadmin, admin, or moderator' });

        if (username) {
            const existing = getAdminUserByUsername.get(username);
            if (existing && existing.id != id) return res.status(400).json({ error: 'Username already taken' });
        }

        updateAdminUser.run(username || null, role || null, id);
        const user = getAdminUserById.get(id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json(user);
    });

    router.post('/users/:id/change-password', superAdminOnly, (req, res) => {
        const { id } = req.params;
        const { password } = req.body;
        if (!password) return res.status(400).json({ error: 'New password is required' });
        if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

        const user = getAdminUserById.get(id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        updateAdminPassword.run(hashPassword(password), id);
        res.json({ success: true, message: 'Password updated' });
    });

    router.delete('/users/:id', superAdminOnly, (req, res) => {
        const { id } = req.params;
        const user = getAdminUserById.get(id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.username === 'superadmin') return res.status(400).json({ error: 'Cannot delete the primary superadmin account' });

        deleteAdminUser.run(id);
        res.json({ deleted: true });
    });

    router.get('/current-user', (req, res) => {
        res.json({ id: req.adminUser.id, username: req.adminUser.username, role: req.adminUser.role });
    });

    return router;
};
