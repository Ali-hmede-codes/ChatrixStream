const express = require('express');
const { redeemInviteCode, validateSession, createSessionForChannel } = require('../services/codeGenerator');

const QUALITY_PRESETS = {
    low: { approxBitrate: '~500kbps', description: 'Low (200KB/s WiFi)', videoBitrate: '400k', videoResolution: '480x360', audioBitrate: '48k' },
    medium: { approxBitrate: '~1200kbps', description: 'Medium (1MB/s WiFi)', videoBitrate: '1000k', videoResolution: null, audioBitrate: '64k' },
    high: { approxBitrate: 'source', description: 'High (unlimited)', videoBitrate: null, videoResolution: null, audioBitrate: '128k' },
    copy: { approxBitrate: 'source', description: 'Source (no transcoding)', videoBitrate: null, videoResolution: null, audioBitrate: '128k' }
};

function resolvePresetInfo(qualityLabel) {
    const lower = qualityLabel.toLowerCase().trim();
    if (QUALITY_PRESETS[lower]) return QUALITY_PRESETS[lower];
    for (const key of Object.keys(QUALITY_PRESETS)) {
        if (lower.includes(key)) return QUALITY_PRESETS[key];
    }
    const resolutionMatch = lower.match(/(\d+)p/);
    if (resolutionMatch) {
        const height = parseInt(resolutionMatch[1]);
        if (height <= 360) return QUALITY_PRESETS.low;
        if (height <= 720) return QUALITY_PRESETS.medium;
    }
    return QUALITY_PRESETS.high;
}

function deriveBitrateInfo(qualityRow) {
    const base = resolvePresetInfo(qualityRow.quality_label);
    const presetKey = (qualityRow.preset_key || qualityRow.quality_label).toLowerCase().trim();
    const presetBase = QUALITY_PRESETS[presetKey] || base;

    let approxBitrate = presetBase.approxBitrate;
    let description = presetBase.description;

    if (qualityRow.video_bitrate) {
        approxBitrate = '~' + qualityRow.video_bitrate;
    }
    if (qualityRow.video_codec === 'copy') {
        approxBitrate = 'source';
        description = 'Source (no transcoding)';
    }
    if (qualityRow.video_resolution) {
        description = qualityRow.quality_label.toUpperCase() + ' (' + qualityRow.video_resolution + ')';
    } else if (qualityRow.video_codec !== 'copy' && qualityRow.video_bitrate) {
        description = qualityRow.quality_label.toUpperCase() + ' (~' + qualityRow.video_bitrate + ')';
    }

    return { approxBitrate, description };
}

module.exports = function(db) {
    const router = express.Router();

    const getQualitiesByChannel = db.prepare('SELECT quality_label as label, sort_order, preset_key, video_codec, video_bitrate, video_maxrate, video_bufsize, video_preset, video_profile, video_level, video_resolution, audio_bitrate, audio_channels, audio_rate, segment_duration FROM channel_qualities WHERE channel_id = ? ORDER BY sort_order');
    const getChannelByToken = db.prepare('SELECT * FROM channels WHERE channel_token = ?');

    router.post('/redeem', (req, res) => {
        const { code } = req.body;
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

        const result = createSessionForChannel(db, channel.id);

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
        const { session_token } = req.body;
        if (!session_token) return res.json({ valid: false, error: 'No session token provided' });

        const result = validateSession(db, session_token);

        if (!result.valid) {
            return res.json({ valid: false, error: result.error });
        }

        const qualities = getQualitiesByChannel.all(result.channel_id);
        const qualitiesWithInfo = qualities.map(q => ({
            ...q,
            bitrate_info: deriveBitrateInfo(q)
        }));
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
