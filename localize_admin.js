const fs = require('fs');
const path = require('path');

const adminJsPath = path.join(__dirname, 'public/admin/js/admin.js');
let content = fs.readFileSync(adminJsPath, 'utf8');

// Insert localization logic at the top, inside the IIFE
const localizationCode = `
    let currentLang = localStorage.getItem('chatrix_admin_lang') || 'en';
    let translations = {};

    async function loadTranslations(lang) {
        try {
            const res = await fetch('./locales/' + lang + '.json');
            translations = await res.json();
            currentLang = lang;
            localStorage.setItem('chatrix_admin_lang', lang);
            document.documentElement.lang = lang;
            document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
            applyTranslations();
            updateLangButton();
            // Re-render dynamically if needed
            if (currentView === 'channels') renderChannels();
            else if (currentView === 'streams') renderStreamsView();
            else if (currentView === 'users') renderUsers();
            renderStats(); // Update stats
        } catch (e) {
            console.error("Failed to load translations", e);
        }
    }

    function t(key) {
        return translations[key] || key;
    }

    function applyTranslations() {
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            if (translations[key]) {
                if (el.tagName === 'INPUT' && el.type === 'button') {
                    el.value = translations[key];
                } else {
                    el.innerHTML = translations[key];
                }
            }
        });
        document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            const key = el.getAttribute('data-i18n-placeholder');
            if (translations[key]) {
                el.placeholder = translations[key];
            }
        });
    }

    function updateLangButton() {
        const btnSpan = document.querySelector('#lang-switch-btn span[data-i18n]');
        if (btnSpan) {
            btnSpan.textContent = currentLang === 'ar' ? t('switch_to_english') : t('switch_to_arabic');
        }
    }
`;

content = content.replace("var mobileOverlay = document.getElementById('mobile-overlay');", "var mobileOverlay = document.getElementById('mobile-overlay');\n" + localizationCode);

const btnLangSwitch = `
    var langSwitchBtn = document.getElementById('lang-switch-btn');
    if (langSwitchBtn) {
        langSwitchBtn.addEventListener('click', function() {
            var newLang = currentLang === 'en' ? 'ar' : 'en';
            loadTranslations(newLang);
        });
    }
    loadTranslations(currentLang);
`;

content = content.replace("init();\n})();", "init();\n" + btnLangSwitch + "\n})();");

// Replacements array
const reps = [
    // Toast messages
    ["'Username and password are required'", "t('username_password_required')"],
    ["'Invalid credentials'", "t('invalid_credentials')"],
    ["'Connection error'", "t('connection_error')"],
    ["'Welcome back, ' + data.username", "t('welcome_back') + ' ' + data.username"],
    ["'Signed out successfully'", "t('signed_out')"],
    ["'Channel name is required'", "t('channel_name_required')"],
    ["'Channel \"' + name + '\" created' + (streamUrl ? ' with main stream' : '')", "t('channel_created') + ' \"' + name + '\"' + (streamUrl ? ' ' + t('channel_created_with_stream') : '')"],
    ["'Link copied to clipboard'", "t('copied_to_clipboard')"],
    ["'Link regenerated'", "t('link_regenerated')"],
    ["'Expiry updated'", "t('expiry_updated')"],
    ["'Expiry cleared — link will never expire'", "t('expiry_cleared')"],
    ["'Channel deleted'", "t('channel_deleted')"],
    ["codes.length + ' codes generated'", "codes.length + ' ' + t('codes_generated')"],
    ["codes.length + ' new codes generated. Old codes invalidated.'", "t('codes_regenerated')"],
    ["'Code revoked'", "t('code_revoked')"],
    ["'Quality \"' + label + '\" added'", "t('quality_added')"],
    ["'Quality updated'", "t('quality_updated')"],
    ["'Quality removed'", "t('quality_removed')"],
    ["'User \"' + username + '\" created'", "t('user_added')"],
    ["'User \"' + username + '\" updated'", "t('user_updated')"],
    ["'Password updated'", "t('password_updated')"],
    ["'User \"' + username + '\" deleted'", "t('user_deleted')"],

    // Stats
    ["'Total Channels'", "t('total_channels')"],
    ["'Total Invite Codes'", "t('total_invite_codes')"],
    ["'Stream Qualities'", "t('stream_qualities')"],
    ["'Total Watchers'", "t('total_watchers')"],
    ["'ID: '", "t('id_label') + ': '"],
    ["' Watchers'", "' ' + t('watchers')"],
    ["'<span class=\"meta-label\">Expires:</span> '", "'<span class=\"meta-label\">' + t('expires_label') + '</span> '"],
    ["'Never'", "t('never')"],
    ["'Never (set expiry to generate codes)'", "t('never_set_expiry')"],
    ["'Code Required'", "t('code_required')"],
    ["'Free Access'", "t('free_access')"],
    ["'Channel Settings'", "t('channel_settings')"],
    ["'Viewers must enter a code'", "t('viewers_must_enter_code')"],
    ["'Anyone with the link can watch'", "t('anyone_can_watch')"],
    ["'Public Link'", "t('public_link')"],
    ["'>Copy Link<'", ">' + t('copy_link') + '<"],
    ["'>Regenerate<'", ">' + t('regenerate') + '<"],
    ["'>Change Expiry<'", ">' + t('change_expiry') + '<"],
    ["'Invite Codes'", "t('invite_codes')"],
    ["'>Generate<'", ">' + t('generate') + '<"],
    ["'>Regenerate All<'", ">' + t('regenerate_all') + '<"],
    ["'Streams & Qualities'", "t('streams_and_qualities')"],
    ["'No streams added yet. Add a main stream URL above or use the form below.'", "t('no_streams_added')"],
    ["'>Add<'", ">' + t('add_btn') + '<"],

    // Placeholders inside JS HTML generation
    ["'Label (hd, sd, 4k)'", "t('label_placeholder')"],
    ["'Stream URL'", "t('stream_url_placeholder_short')"],
    ["'>Auto (resolve from label)<'", ">' + t('auto_resolve') + '<"],
    ["'>Low (640x360, ~400k)<'", ">' + t('low_res') + '<"],
    ["'>Medium (source res, ~1000k)<'", ">' + t('medium_res') + '<"],
    ["'>High / Source (copy, no transcode)<'", ">' + t('high_res') + '<"],
    ["'>Copy (stream copy, no transcode)<'", ">' + t('copy_res') + '<"],
    ["'>Custom<'", ">' + t('custom_res') + '<"],

    ["'Video codec (libx264/copy)'", "t('video_codec_placeholder')"],
    ["'Video bitrate (800k)'", "t('video_bitrate_placeholder')"],
    ["'Video maxrate (1000k)'", "t('video_maxrate_placeholder')"],
    ["'Video bufsize (1200k)'", "t('video_bufsize_placeholder')"],
    ["'Encoding preset (ultrafast)'", "t('encoding_preset_placeholder')"],
    ["'Profile (baseline/main)'", "t('profile_placeholder')"],
    ["'Level (3.0)'", "t('level_placeholder')"],
    ["'Resolution (640x480)'", "t('resolution_placeholder')"],
    ["'Audio bitrate (64k)'", "t('audio_bitrate_placeholder')"],
    ["'Audio channels (1/2)'", "t('audio_channels_placeholder')"],
    ["'Audio rate (48000)'", "t('audio_rate_placeholder')"],
    ["'Segment duration (2-6)'", "t('segment_duration_placeholder')"],

    // Buttons
    ["'>Delete Channel<'", ">' + t('delete_channel') + '<"],
    ["'>Edit<'", ">' + t('edit') + '<"],
    ["'>Save<'", ">' + t('save') + '<"],
    ["'>Remove<'", ">' + t('remove') + '<"],

    ["'<label>Video Codec</label>'", "'<label>' + t('video_codec') + '</label>'"],
    ["'<label>Video Bitrate</label>'", "'<label>' + t('video_bitrate') + '</label>'"],
    ["'<label>Video Max Rate</label>'", "'<label>' + t('video_max_rate') + '</label>'"],
    ["'<label>Video Buffer Size</label>'", "'<label>' + t('video_buf_size') + '</label>'"],
    ["'<label>Video Buf Size</label>'", "'<label>' + t('video_buf_size') + '</label>'"],
    ["'<label>Encoding Preset</label>'", "'<label>' + t('encoding_preset') + '</label>'"],
    ["'<label>Enc Preset</label>'", "'<label>' + t('encoding_preset') + '</label>'"],
    ["'<label>Profile</label>'", "'<label>' + t('profile') + '</label>'"],
    ["'<label>Level</label>'", "'<label>' + t('level') + '</label>'"],
    ["'<label>Resolution</label>'", "'<label>' + t('resolution') + '</label>'"],
    ["'<label>Audio Bitrate</label>'", "'<label>' + t('audio_bitrate') + '</label>'"],
    ["'<label>Audio Channels</label>'", "'<label>' + t('audio_channels') + '</label>'"],
    ["'<label>Audio Ch</label>'", "'<label>' + t('audio_channels') + '</label>'"],
    ["'<label>Audio Rate</label>'", "'<label>' + t('audio_rate') + '</label>'"],
    ["'<label>Segment Duration</label>'", "'<label>' + t('segment_duration') + '</label>'"],
    ["'<label>Seg Duration</label>'", "'<label>' + t('segment_duration') + '</label>'"],
    ["'<label>Label</label>'", "'<label>' + t('label') + '</label>'"],
    ["'<label>Preset</label>'", "'<label>' + t('preset') + '</label>'"],
    ["'<label>Sort Order</label>'", "'<label>' + t('sort_order') + '</label>'"],

    ["'No streams configured'", "t('no_streams_configured')"],
    ["'No codes generated yet'", "t('no_codes_generated')"],
    ["'Unread (' + unreadCodes.length + ')'", "t('unread_codes') + ' (' + unreadCodes.length + ')'"],
    ["'Redeemed/Expired (' + redeemedCodes.length + ')'", "t('redeemed_codes') + ' (' + redeemedCodes.length + ')'"],
    ["' code' + (codesToShow.length !== 1 ? 's' : '') + ' in this tab'", "' ' + (codesToShow.length !== 1 ? t('codes_in_tab') : t('code_in_tab'))"],
    ["'Copy ' + (activeTab === 'unread' ? 'Unread' : 'These') + ' Codes'", "activeTab === 'unread' ? t('copy_unread_codes') : t('copy_these_codes')"],
    ["'No codes in this category'", "t('no_codes_in_category')"],
    ["'>Revoke<'", ">' + t('revoke') + '<"],
    ["'>High / Source (copy)<'", ">' + t('high_res') + '<"],
    ["'>Copy (no transcode)<'", ">' + t('copy_res') + '<"],
    ["'stream copy (no transcode)'", "t('copy_res')"]
];

reps.forEach(rep => {
    content = content.split(rep[0]).join(rep[1]);
});

fs.writeFileSync(adminJsPath, content);
console.log('admin.js localized successfully.');
