const express = require('express');
const { redeemInviteCode, createSessionForChannel } = require('../services/codeGenerator');
const SessionCache = require('../services/sessionCache');
const { deriveBitrateInfo } = require('../services/qualityPresets');

module.exports = function(db) {
    const router = express.Router();

    const sessionCache = new SessionCache(db, 15000, 1000);

    const getQualitiesByChannel = db.prepare('SELECT quality_label as label, sort_order, preset_key, video_codec, video_bitrate, video_maxrate, video_bufsize, video_preset, video_profile, video_level, video_resolution, audio_bitrate, audio_channels, audio_rate, segment_duration FROM channel_qualities WHERE channel_id = ? ORDER BY sort_order');
    const getChannelByToken = db.prepare('SELECT * FROM channels WHERE channel_token = ?');

    router.post('/redeem', (req, res) => {
        const { code, viewer_id } = req.body;
        if (!code) return res.status(400).json({ error: 'Code is required' });

        const result = redeemInviteCode(db, code);

        if (result.error) {
            const statusMap = {
                'Code not found': 404,
                'Code already redeemed': 403,
                'Code expired': 403,
                'Channel not found': 404,
                'Channel link expired': 403
            };
            const errorMessages = {
                'Code not found': 'Invalid code',
                'Code already redeemed': 'Code already used',
                'Code expired': 'Code expired',
                'Channel not found': 'Invalid code',
                'Channel link expired': 'Channel link expired'
            };
            return res.status(statusMap[result.error] || 403).json({ error: errorMessages[result.error] || result.error });
        }

        const qualities = getQualitiesByChannel.all(result.channel_id);
        const qualitiesWithInfo = qualities.map(q => ({
            ...q,
            bitrate_info: deriveBitrateInfo(q)
        }));

        if (viewer_id && typeof viewer_id === 'string') {
            try {
                db.prepare('INSERT OR IGNORE INTO channel_viewers (channel_id, viewer_id) VALUES (?, ?)').run(result.channel_id, viewer_id);
            } catch (e) {
                console.error('Error tracking viewer:', e.message);
            }
        }

        res.json({
            session_token: result.session_token,
            channel_token: result.channel_token,
            channel_name: result.channel_name,
            qualities: qualitiesWithInfo,
            expires_at: result.expires_at
        });
    });

    // Direct access endpoint: for channels with code_required = 0 (no invite code needed)
    router.post('/direct/:channelToken', (req, res) => {
        const { channelToken } = req.params;
        const { viewer_id } = req.body || {};
        const channel = getChannelByToken.get(channelToken);

        if (!channel) {
            return res.status(404).json({ error: 'Channel not found' });
        }

        if (channel.code_required === 1) {
            return res.status(403).json({ error: 'This channel requires an invite code' });
        }

        if (channel.link_expires_at && new Date(channel.link_expires_at) <= new Date()) {
            return res.status(403).json({ error: 'Channel link expired' });
        }

        let result;
        try {
            result = createSessionForChannel(db, channel.id);
        } catch (dbErr) {
            console.error('DB error creating session for free channel:', dbErr.message);
            return res.status(500).json({ error: 'Failed to create session. Please try again.' });
        }

        if (result.error) {
            const statusMap = {
                'Channel not found': 404,
                'Channel link expired': 403
            };
            return res.status(statusMap[result.error] || 403).json({ error: result.error });
        }

        const qualities = getQualitiesByChannel.all(result.channel_id);
        const qualitiesWithInfo = qualities.map(q => ({
            ...q,
            bitrate_info: deriveBitrateInfo(q)
        }));

        if (viewer_id && typeof viewer_id === 'string') {
            try {
                db.prepare('INSERT OR IGNORE INTO channel_viewers (channel_id, viewer_id) VALUES (?, ?)').run(result.channel_id, viewer_id);
            } catch (e) {
                console.error('Error tracking viewer:', e.message);
            }
        }

        res.json({
            session_token: result.session_token,
            channel_token: result.channel_token,
            channel_name: result.channel_name,
            qualities: qualitiesWithInfo,
            expires_at: result.expires_at
        });
    });

    router.get('/free-channels', (req, res) => {
        const channels = db.prepare(
            'SELECT id, channel_token, name FROM channels WHERE code_required = 0 AND (link_expires_at IS NULL OR link_expires_at > ?)'
        ).all(new Date().toISOString());
        res.json(channels);
    });

    router.post('/session', (req, res) => {
        const { session_token, viewer_id } = req.body;
        if (!session_token) return res.json({ valid: false, error: 'No session token provided' });

        const result = sessionCache.get(session_token);

        if (!result.valid) {
            return res.json({ valid: false, error: result.error });
        }

        // Lightweight mode: skip qualities fetch and viewer tracking.
        // The periodic session check only needs to know if the session is valid.
        // Skipping these synchronous DB queries prevents event-loop blocking
        // that would stall HLS segment downloads and cause playback stutter.
        if (req.query.light === '1') {
            return res.json({
                valid: true,
                expires_at: result.expires_at
            });
        }

        const qualities = getQualitiesByChannel.all(result.channel_id);
        const qualitiesWithInfo = qualities.map(q => ({
            ...q,
            bitrate_info: deriveBitrateInfo(q)
        }));

        if (viewer_id && typeof viewer_id === 'string') {
            try {
                db.prepare('INSERT OR IGNORE INTO channel_viewers (channel_id, viewer_id) VALUES (?, ?)').run(result.channel_id, viewer_id);
            } catch (e) {}
        }

        res.json({
            valid: true,
            channel_token: result.channel_token,
            channel_name: result.channel_name,
            qualities: qualitiesWithInfo,
            expires_at: result.expires_at
        });
    });

    return router;
};
