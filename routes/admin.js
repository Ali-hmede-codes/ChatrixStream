const express = require('express');
const { adminAuth, superAdminOnly } = require('../middleware/adminAuth');
const { generateChannelToken, generateInviteCodes } = require('../services/codeGenerator');
const { hashPassword } = require('../services/adminUser');

// Normalize any datetime string to UTC ISO format for consistent storage and comparison
// Handles: "2026-06-13T15:30" (no tz), "2026-06-13T12:30:00.000Z" (UTC), "2026-06-13T15:30:00+03:00" (with offset)
function normalizeToUTC(dateStr) {
    if (!dateStr) return null;
    try {
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return dateStr; // Can't parse, return as-is
        return d.toISOString();
    } catch (e) {
        return dateStr; // Can't parse, return as-is
    }
}

module.exports = function(db, streamManager, hlsConverter, pipeConverter) {
    const router = express.Router();
    router.use(adminAuth);

    const insertChannel = db.prepare(
        'INSERT INTO channels (name, channel_token, code_required, code_ttl_hours, link_expires_at) VALUES (?, ?, ?, ?, ?)'
    );
    const getChannelById = db.prepare('SELECT * FROM channels WHERE id = ?');
    const getAllChannels = db.prepare('SELECT * FROM channels');
    const getQualitiesByChannel = db.prepare('SELECT * FROM channel_qualities WHERE channel_id = ? ORDER BY sort_order');
    const getCodesCountByChannel = db.prepare('SELECT COUNT(*) as count FROM invite_codes WHERE channel_id = ?');
    const getViewersCountByChannel = db.prepare('SELECT COUNT(*) as count FROM channel_viewers WHERE channel_id = ?');
    const deleteChannelById = db.prepare('DELETE FROM channels WHERE id = ?');
    const updateChannel = db.prepare(
        'UPDATE channels SET name = COALESCE(?, name), code_required = COALESCE(?, code_required), code_ttl_hours = COALESCE(?, code_ttl_hours), link_expires_at = ? WHERE id = ?'
    );
    const expireSessionsForChannel = db.prepare(
        'UPDATE sessions SET expires_at = ? WHERE channel_id = ? AND expires_at > ?'
    );
    const updateChannelToken = db.prepare('UPDATE channels SET channel_token = ? WHERE id = ?');
    const insertQuality = db.prepare(
        'INSERT INTO channel_qualities (channel_id, quality_label, stream_url, sort_order, preset_key, video_codec, video_bitrate, video_maxrate, video_bufsize, video_preset, video_profile, video_level, video_resolution, audio_bitrate, audio_channels, audio_rate, segment_duration) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const getQualityById = db.prepare('SELECT * FROM channel_qualities WHERE id = ? AND channel_id = ?');
    const deleteQualityById = db.prepare('DELETE FROM channel_qualities WHERE id = ? AND channel_id = ?');
    const updateQuality = db.prepare(
        'UPDATE channel_qualities SET quality_label = COALESCE(?, quality_label), stream_url = COALESCE(?, stream_url), sort_order = COALESCE(?, sort_order), preset_key = ?, video_codec = ?, video_bitrate = ?, video_maxrate = ?, video_bufsize = ?, video_preset = ?, video_profile = ?, video_level = ?, video_resolution = ?, audio_bitrate = ?, audio_channels = ?, audio_rate = ?, segment_duration = ? WHERE id = ?'
    );
    const getCodesByChannel = db.prepare(
        'SELECT ic.*, s.session_token FROM invite_codes ic LEFT JOIN sessions s ON ic.id = s.invite_code_id WHERE ic.channel_id = ?'
    );
    const deleteCodeByCode = db.prepare('DELETE FROM invite_codes WHERE code = ?');
    const deleteCodesByChannel = db.prepare('DELETE FROM invite_codes WHERE channel_id = ?');
    const getSessionsByChannel = db.prepare('SELECT session_token, expires_at, created_at FROM sessions WHERE channel_id = ? AND expires_at > ?');
    const deleteSessionByToken = db.prepare('DELETE FROM sessions WHERE session_token = ?');

    router.post('/channels', (req, res) => {
        const { name, link_expires_at, code_required } = req.body;
        if (!name) return res.status(400).json({ error: 'Channel name is required' });

        const ttl = parseInt(process.env.DEFAULT_CODE_TTL_HOURS) || 6;
        const token = generateChannelToken();
        const normalizedExpiry = normalizeToUTC(link_expires_at);
        const codeReq = (code_required !== undefined) ? (code_required ? 1 : 0) : 1;
        const result = insertChannel.run(name, token, codeReq, ttl, normalizedExpiry);
        const channel = getChannelById.get(result.lastInsertRowid);
        res.json(channel);
    });

    router.get('/server-time', (req, res) => {
        const now = new Date();
        res.json({
            server_time_utc: now.toISOString(),
            server_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            server_timezone_offset: now.getTimezoneOffset()
        });
    });

    router.get('/channels', (req, res) => {
        const channels = getAllChannels.all();
        const enriched = channels.map(ch => {
            const qualities = getQualitiesByChannel.all(ch.id);
            const codesCount = getCodesCountByChannel.get(ch.id);
            const viewersCount = getViewersCountByChannel.get(ch.id);
            return { ...ch, qualities, codes_count: codesCount.count, viewers_count: viewersCount.count };
        });
        res.json(enriched);
    });

    router.delete('/channels/:id', (req, res) => {
        const { id } = req.params;
        streamManager.stopAllStreamsForChannel(parseInt(id));
        if (hlsConverter) hlsConverter.stopAllForChannel(parseInt(id));
        if (pipeConverter) pipeConverter.stopAllForChannel(parseInt(id));
        deleteChannelById.run(id);
        res.json({ deleted: true });
    });

    router.patch('/channels/:id', (req, res) => {
        const { id } = req.params;
        const { name, code_required, code_ttl_hours, link_expires_at } = req.body;

        // link_expires_at is sent explicitly: null means clear it, a string means set it
        // Only use COALESCE for fields that are truly optional (not sent = keep old value)
        const previousChannel = getChannelById.get(id);
        if (!previousChannel) return res.status(404).json({ error: 'Channel not found' });

        const previousLinkExpiresAt = previousChannel.link_expires_at;
        const effectiveLinkExpiresAt = (link_expires_at !== undefined)
            ? (link_expires_at ? normalizeToUTC(link_expires_at) : null)   // Normalize to UTC; null/empty -> null (clear)
            : previousChannel.link_expires_at;  // not sent -> keep old value

        const effectiveTtl = code_ttl_hours || null;

        // code_required: 1 = require code, 0 = no code needed (free access)
        // Only update if explicitly sent in the request body
        const effectiveCodeRequired = (code_required !== undefined) ? (code_required ? 1 : 0) : null;

        updateChannel.run(name || null, effectiveCodeRequired, effectiveTtl, effectiveLinkExpiresAt, id);

        const channel = getChannelById.get(id);
        const expiryChanged = effectiveLinkExpiresAt !== previousLinkExpiresAt;

        if (expiryChanged) {
            const propagateTx = db.transaction(() => {
                // 1. Fetch all invite codes for this channel
                const codes = db.prepare('SELECT * FROM invite_codes WHERE channel_id = ?').all(id);
                for (const code of codes) {
                    let uncappedExpiresAt;
                    if (channel.code_ttl_hours && channel.code_ttl_hours > 0) {
                        let createdAtStr = code.created_at;
                        if (!createdAtStr.endsWith('Z') && !createdAtStr.includes('+')) {
                            createdAtStr = createdAtStr.replace(' ', 'T') + 'Z';
                        }
                        const createdTime = new Date(createdAtStr).getTime();
                        uncappedExpiresAt = new Date(createdTime + channel.code_ttl_hours * 3600 * 1000).toISOString();
                    } else {
                        uncappedExpiresAt = '9999-12-31T23:59:59.999Z';
                    }

                    let codeNewExpiresAt = uncappedExpiresAt;
                    if (effectiveLinkExpiresAt) {
                        codeNewExpiresAt = (new Date(effectiveLinkExpiresAt) < new Date(uncappedExpiresAt))
                            ? effectiveLinkExpiresAt
                            : uncappedExpiresAt;
                    }

                    // Update invite code expiration
                    db.prepare('UPDATE invite_codes SET expires_at = ? WHERE id = ?').run(codeNewExpiresAt, code.id);

                    // Update sessions associated with this invite code
                    db.prepare('UPDATE sessions SET expires_at = ? WHERE invite_code_id = ?').run(codeNewExpiresAt, code.id);
                }

                // 2. Fetch and update direct/codeless sessions (invite_code_id IS NULL)
                const directSessions = db.prepare('SELECT * FROM sessions WHERE channel_id = ? AND invite_code_id IS NULL').all(id);
                for (const session of directSessions) {
                    let createdAtStr = session.created_at;
                    if (!createdAtStr.endsWith('Z') && !createdAtStr.includes('+')) {
                        createdAtStr = createdAtStr.replace(' ', 'T') + 'Z';
                    }
                    const createdTime = new Date(createdAtStr).getTime();
                    const uncappedSessionExpiry = new Date(createdTime + 24 * 3600 * 1000).toISOString();

                    let sessionNewExpiresAt = uncappedSessionExpiry;
                    if (effectiveLinkExpiresAt) {
                        sessionNewExpiresAt = (new Date(effectiveLinkExpiresAt) < new Date(uncappedSessionExpiry))
                            ? effectiveLinkExpiresAt
                            : uncappedSessionExpiry;
                    }

                    db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(sessionNewExpiresAt, session.id);
                }
            });

            propagateTx();
        }

        // If link_expires_at was set/updated to a value that is already in the past, kill active streams
        if (effectiveLinkExpiresAt) {
            const isExpired = new Date(effectiveLinkExpiresAt) <= new Date();
            if (isExpired) {
                streamManager.stopAllStreamsForChannel(parseInt(id));
                if (hlsConverter) hlsConverter.stopAllForChannel(parseInt(id));
                if (pipeConverter) pipeConverter.stopAllForChannel(parseInt(id));
            }
        }

        res.json(channel);
    });

    router.post('/channels/:id/regenerate-link', (req, res) => {
        const { id } = req.params;
        const newToken = generateChannelToken();
        updateChannelToken.run(newToken, id);
        
        // Reset the views count when regenerating the link
        db.prepare('DELETE FROM channel_viewers WHERE channel_id = ?').run(id);
        
        res.json({ channel_token: newToken });
    });

    // Restart all restream processes (source + FFmpeg) for a channel.
    // This does NOT disconnect viewers — it reconnects the source and
    // restarts FFmpeg so the stream recovers from lag/stall/audio-desync.
    router.post('/channels/:id/restart-stream', (req, res) => {
        const { id } = req.params;
        const channel = getChannelById.get(id);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });

        const channelId = parseInt(id);
        const sourceCount = streamManager.restartAllStreamsForChannel(channelId);
        const hlsCount = hlsConverter ? hlsConverter.restartAllForChannel(channelId) : 0;
        const pipeCount = pipeConverter ? pipeConverter.restartAllForChannel(channelId) : 0;

        console.log(`Restart-stream for channel ${id}: source=${sourceCount}, hls=${hlsCount}, pipe=${pipeCount}`);
        res.json({
            restarted: true,
            source_streams: sourceCount,
            hls_streams: hlsCount,
            pipe_streams: pipeCount
        });
    });

    router.post('/channels/:id/qualities', (req, res) => {
        const { id } = req.params;
        const { quality_label, stream_url, sort_order, preset_key, video_codec, video_bitrate, video_maxrate, video_bufsize, video_preset, video_profile, video_level, video_resolution, audio_bitrate, audio_channels, audio_rate, segment_duration } = req.body;
        if (!quality_label || !stream_url) return res.status(400).json({ error: 'quality_label and stream_url are required' });

        const existing = db.prepare('SELECT * FROM channel_qualities WHERE channel_id = ? AND quality_label = ?').get(id, quality_label);
        if (existing) return res.status(400).json({ error: 'Quality label already exists for this channel' });

        const result = insertQuality.run(
            id, quality_label, stream_url, sort_order || 0,
            preset_key || null, video_codec || null, video_bitrate || null,
            video_maxrate || null, video_bufsize || null, video_preset || null,
            video_profile || null, video_level || null, video_resolution || null,
            audio_bitrate || null, audio_channels || null, audio_rate || null,
            segment_duration || null
        );
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
        const { quality_label, stream_url, sort_order, preset_key, video_codec, video_bitrate, video_maxrate, video_bufsize, video_preset, video_profile, video_level, video_resolution, audio_bitrate, audio_channels, audio_rate, segment_duration } = req.body;

        const nullIfEmpty = (v) => (v === '' || v === undefined) ? null : v;

        const oldQuality = getQualityById.get(qid, id);

        updateQuality.run(
            quality_label || null, stream_url || null, sort_order || null,
            nullIfEmpty(preset_key), nullIfEmpty(video_codec), nullIfEmpty(video_bitrate),
            nullIfEmpty(video_maxrate), nullIfEmpty(video_bufsize), nullIfEmpty(video_preset),
            nullIfEmpty(video_profile), nullIfEmpty(video_level), nullIfEmpty(video_resolution),
            nullIfEmpty(audio_bitrate), nullIfEmpty(audio_channels), nullIfEmpty(audio_rate),
            nullIfEmpty(segment_duration),
            qid
        );
        const quality = getQualityById.get(qid, id);

        if (oldQuality) {
            const labelToStop = oldQuality.quality_label;
            streamManager.stopStream(parseInt(id), labelToStop);
            if (hlsConverter) hlsConverter.stopConversion(parseInt(id), labelToStop);
            if (pipeConverter) pipeConverter.stopStream(parseInt(id), labelToStop);
        }

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
        const now = new Date();
        const enriched = codes.map(c => {
            let status = 'unused';
            if (c.redeemed === 1) status = 'redeemed';
            else if (new Date(c.expires_at) <= now) status = 'expired';
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
