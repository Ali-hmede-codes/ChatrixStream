const QUALITY_PRESETS = {
    low: {
        videoCodec: 'libx264',
        videoBitrate: '400k',
        videoMaxRate: '500k',
        videoBufSize: '800k',
        videoPreset: 'ultrafast',
        videoTune: 'zerolatency',
        videoProfile: 'baseline',
        videoLevel: '3.0',
        videoResolution: '640x360',
        audioBitrate: '48k',
        audioChannels: '1',
        audioRate: '44100',
        segmentDuration: 2,
        copyVideo: false
    },
    medium: {
        videoCodec: 'libx264',
        videoBitrate: '1000k',
        videoMaxRate: '1200k',
        videoBufSize: '2000k',
        videoPreset: 'veryfast',
        videoTune: 'zerolatency',
        videoProfile: 'main',
        videoLevel: '3.1',
        videoResolution: null,
        audioBitrate: '64k',
        audioChannels: '2',
        audioRate: '48000',
        segmentDuration: 2,
        copyVideo: false
    },
    high: {
        videoCodec: 'copy',
        videoBitrate: null,
        videoMaxRate: null,
        videoBufSize: null,
        videoPreset: null,
        videoTune: null,
        videoProfile: null,
        videoLevel: null,
        videoResolution: null,
        audioBitrate: '128k',
        audioChannels: '2',
        audioRate: '48000',
        segmentDuration: 2,
        copyVideo: true
    }
};

function applyOverrides(base, cfg) {
    if (!cfg) return Object.assign({}, base);
    const r = Object.assign({}, base);
    if (cfg.video_codec != null) { r.videoCodec = cfg.video_codec; r.copyVideo = cfg.video_codec === 'copy'; }
    if (cfg.video_bitrate != null) r.videoBitrate = cfg.video_bitrate;
    if (cfg.video_maxrate != null) r.videoMaxRate = cfg.video_maxrate;
    if (cfg.video_bufsize != null) r.videoBufSize = cfg.video_bufsize;
    if (cfg.video_preset != null) r.videoPreset = cfg.video_preset;
    if (cfg.video_profile != null) r.videoProfile = cfg.video_profile;
    if (cfg.video_level != null) r.videoLevel = cfg.video_level;
    if (cfg.video_resolution != null) r.videoResolution = cfg.video_resolution;
    if (cfg.audio_bitrate != null) r.audioBitrate = cfg.audio_bitrate;
    if (cfg.audio_channels != null) r.audioChannels = String(cfg.audio_channels);
    if (cfg.audio_rate != null) r.audioRate = String(cfg.audio_rate);
    if (cfg.segment_duration != null) r.segmentDuration = cfg.segment_duration;
    return r;
}

function resolvePreset(qualityLabel, qualityConfig, presets) {
    presets = presets || QUALITY_PRESETS;
    const baseKey = (qualityConfig && qualityConfig.preset_key) || qualityLabel.toLowerCase().trim();
    if (presets[baseKey]) {
        return applyOverrides(presets[baseKey], qualityConfig);
    }
    for (const key of Object.keys(presets)) {
        if (baseKey.includes(key)) {
            return applyOverrides(presets[key], qualityConfig);
        }
    }
    const resMatch = baseKey.match(/(\d+)p/);
    if (resMatch) {
        const h = parseInt(resMatch[1]);
        if (h <= 360) return applyOverrides(presets.low, qualityConfig);
        if (h <= 720) return applyOverrides(presets.medium, qualityConfig);
    }
    return applyOverrides(presets.high, qualityConfig);
}

const DISPLAY_PRESETS = {
    low: { approxBitrate: '~500kbps', description: 'Low (200KB/s WiFi)', videoBitrate: '400k', videoResolution: '640x360', audioBitrate: '48k' },
    medium: { approxBitrate: '~1200kbps', description: 'Medium (1MB/s WiFi)', videoBitrate: '1000k', videoResolution: null, audioBitrate: '64k' },
    high: { approxBitrate: 'source', description: 'High (unlimited)', videoBitrate: null, videoResolution: null, audioBitrate: '128k' },
    copy: { approxBitrate: 'source', description: 'Source (no transcoding)', videoBitrate: null, videoResolution: null, audioBitrate: '128k' }
};

function resolveDisplayPreset(qualityLabel) {
    if (!qualityLabel) return DISPLAY_PRESETS.high;
    const lower = qualityLabel.toLowerCase().trim();
    if (DISPLAY_PRESETS[lower]) return DISPLAY_PRESETS[lower];
    for (const key of Object.keys(DISPLAY_PRESETS)) {
        if (lower.includes(key)) return DISPLAY_PRESETS[key];
    }
    const resolutionMatch = lower.match(/(\d+)p/);
    if (resolutionMatch) {
        const height = parseInt(resolutionMatch[1]);
        if (height <= 360) return DISPLAY_PRESETS.low;
        if (height <= 720) return DISPLAY_PRESETS.medium;
    }
    return DISPLAY_PRESETS.high;
}

function deriveBitrateInfo(qualityRow) {
    const base = resolveDisplayPreset(qualityRow.label || qualityRow.quality_label);
    const ql = qualityRow.label || qualityRow.quality_label || '';
    const presetKey = (qualityRow.preset_key || ql).toLowerCase().trim();
    const presetBase = DISPLAY_PRESETS[presetKey] || base;

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
        description = ql.toUpperCase() + ' (' + qualityRow.video_resolution + ')';
    } else if (qualityRow.video_codec !== 'copy' && qualityRow.video_bitrate) {
        description = ql.toUpperCase() + ' (~' + qualityRow.video_bitrate + ')';
    }

    return { approxBitrate, description };
}

module.exports = {
    QUALITY_PRESETS,
    DISPLAY_PRESETS,
    applyOverrides,
    resolvePreset,
    resolveDisplayPreset,
    deriveBitrateInfo
};
