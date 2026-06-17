(function() {
    const TOKEN_KEY = 'chatrix_admin_token';
    const ADMIN_INFO_KEY = 'chatrix_admin_info';

    let authToken = '';
    let channels = [];
    let adminUsers = [];
    let currentView = 'channels';
    var editingUserId = null;
    var activeCodeTabs = {};

    const adminLogin = document.getElementById('admin-login');
    const dashboard = document.getElementById('dashboard');
    const usernameInput = document.getElementById('username-input');
    const passwordInput = document.getElementById('password-input');
    const loginBtn = document.getElementById('login-btn');
    const loginError = document.getElementById('login-error');
    const logoutBtn = document.getElementById('logout-btn');
    const createChannelBtn = document.getElementById('create-channel-btn');
    const addUserBtn = document.getElementById('add-user-btn');
    const confirmCreateBtn = document.getElementById('confirm-create-btn');
    const emptyCreateBtn = document.getElementById('empty-create-btn');
    const channelsContainer = document.getElementById('channels-container');
    const emptyState = document.getElementById('empty-state');
    const statsBar = document.getElementById('stats-bar');
    const adminNameEl = document.getElementById('admin-name');
    const adminRoleEl = document.getElementById('admin-role');
    const adminAvatarEl = document.getElementById('admin-avatar');
    const createChannelSection = document.getElementById('create-channel');
    const toastContainer = document.getElementById('toast-container');
    const channelsListSection = document.getElementById('channels-list');
    const streamsViewSection = document.getElementById('streams-view');
    const streamsContainer = document.getElementById('streams-container');
    const expiryModal = document.getElementById('expiry-modal');
    const expiryDatetimeInput = document.getElementById('expiry-datetime-input');
    const expirySaveBtn = document.getElementById('expiry-save-btn');
    const expiryClearBtn = document.getElementById('expiry-clear-btn');
    var expiryEditChannelId = null;
    var navUsers = document.getElementById('nav-users');
    var usersViewSection = document.getElementById('users-view');
    var usersContainer = document.getElementById('users-container');
    var usersEmptyState = document.getElementById('users-empty-state');
    var addUserModal = document.getElementById('add-user-modal');
    var editUserModal = document.getElementById('edit-user-modal');
    var changePasswordModal = document.getElementById('change-password-modal');
    var addUserUsername = document.getElementById('add-user-username');
    var addUserPassword = document.getElementById('add-user-password');
    var addUserRole = document.getElementById('add-user-role');
    var editUserUsername = document.getElementById('edit-user-username');
    var editUserRole = document.getElementById('edit-user-role');
    var changePwUsernameDisplay = document.getElementById('change-pw-username-display');
    var menuToggle = document.getElementById('menu-toggle');
    var sidebar = document.querySelector('.sidebar');
    var mobileOverlay = document.getElementById('mobile-overlay');

    function openMobileMenu() {
        sidebar.classList.add('open');
        mobileOverlay.classList.remove('hidden');
    }

    function closeMobileMenu() {
        sidebar.classList.remove('open');
        mobileOverlay.classList.add('hidden');
    }
    var changePwNewPassword = document.getElementById('change-pw-new-password');

    function init() {
        const stored = localStorage.getItem(TOKEN_KEY);
        if (stored) {
            authToken = stored;
            validateAndShowDashboard();
        }
    }

    function showToast(message, type) {
        type = type || 'info';
        var icons = { success: '&#10003;', error: '&#10007;', info: '&#9679;' };
        var toast = document.createElement('div');
        toast.className = 'toast ' + type;
        toast.innerHTML = '<span class="toast-icon">' + icons[type] + '</span><span class="toast-message">' + message + '</span>';
        toastContainer.appendChild(toast);
        setTimeout(function() {
            toast.classList.add('removing');
            setTimeout(function() { toast.remove(); }, 300);
        }, 4000);
    }

    function updateAdminInfo() {
        try {
            var info = JSON.parse(localStorage.getItem(ADMIN_INFO_KEY));
            if (info) {
                adminNameEl.textContent = info.username;
                adminRoleEl.textContent = info.role;
                adminAvatarEl.textContent = info.username.substring(0, 2).toUpperCase();
            }
        } catch (e) {}
    }

    async function login() {
        var username = usernameInput.value.trim();
        var password = passwordInput.value.trim();
        if (!username || !password) {
            loginError.textContent = 'Username and password are required';
            loginError.classList.remove('hidden');
            return;
        }

        loginBtn.disabled = true;
        loginBtn.querySelector('.btn-text').textContent = 'Signing in...';
        loginBtn.querySelector('.btn-spinner').classList.remove('hidden');

        try {
            var res = await fetch('/api/admin/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: username, password: password })
            });
            if (res.status === 200) {
                var data = await res.json();
                authToken = data.token;
                localStorage.setItem(TOKEN_KEY, authToken);
                localStorage.setItem(ADMIN_INFO_KEY, JSON.stringify({ username: data.username, role: data.role }));
                showToast('Welcome back, ' + data.username, 'success');
                showDashboard();
                updateAdminInfo();
                checkCurrentUserRole();
                loadChannels();
                loadUsers();
            } else {
                var errData = await res.json();
                loginError.textContent = errData.error || 'Invalid credentials';
                loginError.classList.remove('hidden');
                loginBtn.disabled = false;
                loginBtn.querySelector('.btn-text').textContent = 'Sign In';
                loginBtn.querySelector('.btn-spinner').classList.add('hidden');
            }
        } catch (e) {
            loginError.textContent = 'Connection error';
            loginError.classList.remove('hidden');
            loginBtn.disabled = false;
            loginBtn.querySelector('.btn-text').textContent = 'Sign In';
            loginBtn.querySelector('.btn-spinner').classList.add('hidden');
        }
    }

    async function validateAndShowDashboard() {
        try {
            var res = await fetch('/api/admin/channels', {
                headers: { 'Authorization': 'Bearer ' + authToken }
            });
            if (res.status === 200) {
                showDashboard();
                updateAdminInfo();
                checkCurrentUserRole();
                loadChannels();
                loadUsers();
            } else {
                localStorage.removeItem(TOKEN_KEY);
                localStorage.removeItem(ADMIN_INFO_KEY);
                authToken = '';
                showLogin();
            }
        } catch (e) {
            showLogin();
        }
    }

    async function adminFetch(path, options) {
        options = options || {};
        options.headers = {
            'Authorization': 'Bearer ' + authToken,
            'Content-Type': 'application/json'
        };
        if (options.body) options.body = JSON.stringify(options.body);
        var res = await fetch('/api/admin' + path, options);
        var data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Request failed');
        return data;
    }

    async function loadChannels() {
        channels = await adminFetch('/channels');
        renderStats();
        if (currentView === 'channels') {
            renderChannels();
        } else {
            renderStreamsView();
        }
    }

    function renderStats() {
        var totalChannels = channels.length;
        var totalCodes = 0;
        channels.forEach(function(ch) {
            totalCodes += ch.codes_count || 0;
        });

        statsBar.innerHTML =
            '<div class="stat-card">' +
                '<div class="stat-value accent">' + totalChannels + '</div>' +
                '<div class="stat-label">Total Channels</div>' +
            '</div>' +
            '<div class="stat-card">' +
                '<div class="stat-value success">' + totalCodes + '</div>' +
                '<div class="stat-label">Total Invite Codes</div>' +
            '</div>' +
            '<div class="stat-card">' +
                '<div class="stat-value">' + channels.reduce(function(sum, ch) { return sum + (ch.qualities ? ch.qualities.length : 0); }, 0) + '</div>' +
                '<div class="stat-label">Stream Qualities</div>' +
            '</div>';
    }

    function renderChannels() {
        channelsContainer.innerHTML = '';
        if (channels.length === 0) {
            emptyState.classList.remove('hidden');
            return;
        }
        emptyState.classList.add('hidden');
        channels.forEach(function(ch) {
            var card = createChannelCard(ch);
            channelsContainer.appendChild(card);
        });
    }

    function renderStreamsView() {
        streamsContainer.innerHTML = '';
        if (channels.length === 0) {
            streamsContainer.innerHTML = '<div class="empty-state"><div class="empty-icon">&#9656;</div><h4>No channels yet</h4><p>Create your first channel to start streaming</p></div>';
            return;
        }
        channels.forEach(function(ch) {
            var sorted = ch.qualities ? ch.qualities.slice().sort(function(a, b) { return (a.sort_order || 0) - (b.sort_order || 0); }) : [];
            var card = document.createElement('div');
            card.className = 'stream-channel-card';
            card.innerHTML =
                '<div class="stream-channel-header">' +
                    '<h4>' + ch.name + '</h4>' +
                    '<span class="channel-id">ID: ' + ch.id + '</span>' +
                '</div>' +
                '<div class="stream-qualities-list" id="stream-qualities-' + ch.id + '">' +
                    (sorted.length === 0
                        ? '<p style="color: var(--text-secondary); font-size: 0.85rem">No streams configured</p>'
                        : sorted.map(function(q, idx) {
                            var isMain = q.quality_label.toLowerCase() === 'source' || q.quality_label.toLowerCase() === 'main' || idx === 0 && sorted.length === 1;
                            var presetDisplay = q.preset_key ? q.preset_key : 'auto';
                            var encSummary = buildEncodingSummary(q);
                            return '<div class="stream-quality-row' + (isMain ? ' main-stream' : '') + '" data-quality-id="' + q.id + '" data-channel-id="' + ch.id + '">' +
                                '<div class="quality-display">' +
                                    '<span class="label">' + q.quality_label + '</span>' +
                                    '<span class="url">' + q.stream_url + '</span>' +
                                    '<span class="preset-info">' + presetDisplay + ' — ' + encSummary + '</span>' +
                                '</div>' +
                                '<div class="quality-edit hidden">' +
                                    '<div class="edit-row"><label>Label</label><input type="text" class="edit-label" value="' + q.quality_label + '"></div>' +
                                    '<div class="edit-row"><label>Stream URL</label><input type="text" class="edit-url" value="' + q.stream_url + '"></div>' +
                                    '<div class="edit-row"><label>Sort Order</label><input type="number" class="edit-sort" value="' + (q.sort_order || 0) + '" style="width:60px"></div>' +
                                    '<div class="edit-row"><label>Preset</label><select class="edit-preset-key">' +
                                        '<option value="">Auto (resolve from label)</option>' +
                                        '<option value="low"' + (q.preset_key === 'low' ? ' selected' : '') + '>Low (640x360, ~400k)</option>' +
                                        '<option value="medium"' + (q.preset_key === 'medium' ? ' selected' : '') + '>Medium (source res, ~1000k)</option>' +
                                        '<option value="high"' + (q.preset_key === 'high' ? ' selected' : '') + '>High / Source (copy)</option>' +
                                        '<option value="copy"' + (q.preset_key === 'copy' ? ' selected' : '') + '>Copy (no transcode)</option>' +
                                        '<option value="custom"' + (q.preset_key === 'custom' ? ' selected' : '') + '>Custom</option>' +
                                    '</select></div>' +
                                    '<div class="encoding-fields">' +
                                        '<div class="edit-row"><label>Video Codec</label><input type="text" class="edit-video-codec" value="' + (q.video_codec || '') + '" placeholder="libx264 or copy"></div>' +
                                        '<div class="edit-row"><label>Video Bitrate</label><input type="text" class="edit-video-bitrate" value="' + (q.video_bitrate || '') + '" placeholder="e.g. 800k"></div>' +
                                        '<div class="edit-row"><label>Video Max Rate</label><input type="text" class="edit-video-maxrate" value="' + (q.video_maxrate || '') + '" placeholder="e.g. 1000k"></div>' +
                                        '<div class="edit-row"><label>Video Buf Size</label><input type="text" class="edit-video-bufsize" value="' + (q.video_bufsize || '') + '" placeholder="e.g. 1200k"></div>' +
                                        '<div class="edit-row"><label>Enc Preset</label><input type="text" class="edit-video-preset" value="' + (q.video_preset || '') + '" placeholder="ultrafast, veryfast"></div>' +
                                        '<div class="edit-row"><label>Profile</label><input type="text" class="edit-video-profile" value="' + (q.video_profile || '') + '" placeholder="baseline, main"></div>' +
                                        '<div class="edit-row"><label>Level</label><input type="text" class="edit-video-level" value="' + (q.video_level || '') + '" placeholder="3.0, 3.1"></div>' +
                                        '<div class="edit-row"><label>Resolution</label><input type="text" class="edit-video-resolution" value="' + (q.video_resolution || '') + '" placeholder="640x480"></div>' +
                                        '<div class="edit-row"><label>Audio Bitrate</label><input type="text" class="edit-audio-bitrate" value="' + (q.audio_bitrate || '') + '" placeholder="64k"></div>' +
                                        '<div class="edit-row"><label>Audio Ch</label><input type="text" class="edit-audio-channels" value="' + (q.audio_channels || '') + '" placeholder="1 or 2"></div>' +
                                        '<div class="edit-row"><label>Audio Rate</label><input type="text" class="edit-audio-rate" value="' + (q.audio_rate || '') + '" placeholder="48000"></div>' +
                                        '<div class="edit-row"><label>Seg Duration</label><input type="number" class="edit-segment-duration" value="' + (q.segment_duration || '') + '" placeholder="2-6" style="width:80px"></div>' +
                                    '</div>' +
                                '</div>' +
                                '<div class="quality-actions">' +
                                    '<button class="edit-btn" data-action="edit-quality" data-channel-id="' + ch.id + '" data-quality-id="' + q.id + '">Edit</button>' +
                                    '<button class="save-btn hidden" data-action="save-quality" data-channel-id="' + ch.id + '" data-quality-id="' + q.id + '">Save</button>' +
                                    '<button class="cancel-btn hidden" data-action="cancel-edit-quality" data-channel-id="' + ch.id + '" data-quality-id="' + q.id + '">Cancel</button>' +
                                    '<button class="delete-btn" data-action="remove-quality" data-channel-id="' + ch.id + '" data-quality-id="' + q.id + '">Remove</button>' +
                                '</div>' +
                            '</div>';
                        }).join('')
                    ) +
                '</div>' +
                '<div class="add-quality-form">' +
                    '<input type="text" id="stream-add-label-' + ch.id + '" placeholder="Label (hd, sd, 4k)">' +
                    '<input type="text" id="stream-add-url-' + ch.id + '" placeholder="Stream URL">' +
                    '<select id="stream-add-preset-' + ch.id + '">' +
                        '<option value="">Auto (resolve from label)</option>' +
                        '<option value="low">Low (640x360, ~400k)</option>' +
                        '<option value="medium">Medium (source res, ~1000k)</option>' +
                        '<option value="high">High / Source (copy)</option>' +
                        '<option value="copy">Copy (no transcode)</option>' +
                        '<option value="custom">Custom</option>' +
                    '</select>' +
                    '<button class="btn-success" data-action="add-quality-stream" data-id="' + ch.id + '">Add</button>' +
                    '<div class="add-quality-encoding" id="stream-add-encoding-' + ch.id + '">' +
                        '<input type="text" id="stream-add-vcodec-' + ch.id + '" placeholder="Video codec (libx264/copy)">' +
                        '<input type="text" id="stream-add-vbitrate-' + ch.id + '" placeholder="Video bitrate (800k)">' +
                        '<input type="text" id="stream-add-vmaxrate-' + ch.id + '" placeholder="Video maxrate (1000k)">' +
                        '<input type="text" id="stream-add-vbufsize-' + ch.id + '" placeholder="Video bufsize (1200k)">' +
                        '<input type="text" id="stream-add-vpreset-' + ch.id + '" placeholder="Encoding preset (ultrafast)">' +
                        '<input type="text" id="stream-add-vprofile-' + ch.id + '" placeholder="Profile (baseline/main)">' +
                        '<input type="text" id="stream-add-vlevel-' + ch.id + '" placeholder="Level (3.0)">' +
                        '<input type="text" id="stream-add-vres-' + ch.id + '" placeholder="Resolution (640x480)">' +
                        '<input type="text" id="stream-add-abitrate-' + ch.id + '" placeholder="Audio bitrate (64k)">' +
                        '<input type="text" id="stream-add-achannels-' + ch.id + '" placeholder="Audio channels (1/2)">' +
                        '<input type="text" id="stream-add-arate-' + ch.id + '" placeholder="Audio rate (48000)">' +
                        '<input type="text" id="stream-add-segdur-' + ch.id + '" placeholder="Segment dur (2-6)">' +
                    '</div>' +
                '</div>';
            streamsContainer.appendChild(card);
        });
    }

    function switchView(view) {
        currentView = view;
        document.querySelectorAll('.nav-item').forEach(function(item) {
            item.classList.toggle('active', item.dataset.section === view);
        });
        var topBarTitle = document.querySelector('.page-title');
        var createBtn = document.getElementById('create-channel-btn');
        channelsListSection.classList.add('hidden');
        streamsViewSection.classList.add('hidden');
        if (usersViewSection) usersViewSection.classList.add('hidden');
        createBtn.classList.add('hidden');
        if (addUserBtn) addUserBtn.classList.add('hidden');
        if (view === 'channels') {
            topBarTitle.textContent = 'Channels';
            createBtn.classList.remove('hidden');
            channelsListSection.classList.remove('hidden');
            renderChannels();
        } else if (view === 'streams') {
            topBarTitle.textContent = 'Streams & Qualities';
            streamsViewSection.classList.remove('hidden');
            renderStreamsView();
        } else if (view === 'users') {
            topBarTitle.textContent = 'Users';
            if (addUserBtn) addUserBtn.classList.remove('hidden');
            if (usersViewSection) usersViewSection.classList.remove('hidden');
            renderUsers();
        }
    }

    // --- Timezone-aware datetime helpers ---
    // Convert datetime-local input value (local browser time) to UTC ISO string
    function localDatetimeToUTC(datetimeLocalValue) {
        if (!datetimeLocalValue) return null;
        // datetime-local gives "YYYY-MM-DDTHH:MM" in local browser time
        // new Date() interprets this as local time, then toISOString() converts to UTC
        var d = new Date(datetimeLocalValue);
        if (isNaN(d.getTime())) return null;
        return d.toISOString();
    }

    // Convert UTC ISO string to datetime-local format (local browser time) for input display
    function utcToLocalDatetime(isoString) {
        if (!isoString) return '';
        var d = new Date(isoString);
        if (isNaN(d.getTime())) return '';
        var year = d.getFullYear();
        var month = String(d.getMonth() + 1).padStart(2, '0');
        var day = String(d.getDate()).padStart(2, '0');
        var hours = String(d.getHours()).padStart(2, '0');
        var minutes = String(d.getMinutes()).padStart(2, '0');
        return year + '-' + month + '-' + day + 'T' + hours + ':' + minutes;
    }

    // Get the user's timezone abbreviation (e.g., "GMT+3", "EST", "PST")
    function getUserTimezoneLabel() {
        try {
            return Intl.DateTimeFormat().resolvedOptions().timeZone;
        } catch (e) {
            var offset = new Date().getTimezoneOffset();
            var sign = offset <= 0 ? '+' : '-';
            var absOffset = Math.abs(offset);
            var hours = Math.floor(absOffset / 60);
            var mins = absOffset % 60;
            return 'UTC' + sign + hours + (mins ? ':' + String(mins).padStart(2, '0') : '');
        }
    }

    function isExpired(dateStr) {
        if (!dateStr) return false;
        if (new Date(dateStr).getFullYear() >= 9000) return false;
        return new Date(dateStr) <= new Date();
    }

    function updateToggleLabel(checkbox, labelId) {
        var label = document.getElementById(labelId);
        if (label) {
            label.textContent = checkbox.checked ? 'Code required to watch' : 'Free access — no code needed';
        }
    }

    function createChannelCard(channel) {
        var card = document.createElement('div');
        card.className = 'channel-card';
        card.dataset.channelId = channel.id;

        var expiryClass = isExpired(channel.link_expires_at) ? 'expired' : '';
        var expiryTag = channel.link_expires_at
            ? '<span class="meta-tag expiry-tag"><span class="meta-label">Expires:</span> <span class="meta-value ' + expiryClass + '">' + formatDate(channel.link_expires_at) + '</span></span>'
            : '<span class="meta-tag expiry-tag"><span class="meta-label">Expires:</span> <span class="meta-value">Never (set expiry to generate codes)</span></span>';

        var codeReqStatus = channel.code_required === 1 ? 'Code Required' : 'Free Access';
        var codeReqClass = channel.code_required === 1 ? 'code-required' : 'code-free';

        card.innerHTML =
            '<div class="channel-header" data-action="toggle-channel" data-id="' + channel.id + '">' +
                '<div class="channel-header-left">' +
                    '<h4>' + channel.name + '</h4>' +
                    '<span class="channel-id">ID: ' + channel.id + '</span>' +
                    '<span class="meta-tag code-req-tag ' + codeReqClass + '">' + codeReqStatus + '</span>' +
                '</div>' +
                '<div class="channel-header-right">' +
                    expiryTag +
                    '<button class="channel-toggle-btn" data-action="toggle-channel" data-id="' + channel.id + '" aria-label="Toggle details">' +
                        '<span class="toggle-arrow">&#9662;</span>' +
                    '</button>' +
                '</div>' +
            '</div>' +
            '<div class="channel-body collapsed" id="channel-body-' + channel.id + '">' +
                '<div class="channel-section">' +
                    '<h5>Channel Settings</h5>' +
                    '<div class="setting-row">' +
                        '<label class="setting-label" for="code-required-' + channel.id + '">Require Invite Code</label>' +
                        '<label class="toggle-switch">' +
                            '<input type="checkbox" id="code-required-' + channel.id + '"' + (channel.code_required === 1 ? ' checked' : '') + ' data-action="toggle-code-required" data-id="' + channel.id + '">' +
                            '<span class="toggle-slider"></span>' +
                        '</label>' +
                        '<span class="setting-hint" id="code-required-hint-' + channel.id + '">' + (channel.code_required === 1 ? 'Viewers must enter a code' : 'Anyone with the link can watch') + '</span>' +
                    '</div>' +
                '</div>' +
                '<div class="channel-section">' +
                    '<h5>Public Link</h5>' +
                    '<div class="link-display">' +
                        '<span class="url">stream.chatrix.vip/channel/' + channel.channel_token + '</span>' +
                        '<button class="btn-secondary" data-action="copy-link" data-token="' + channel.channel_token + '">Copy Link</button>' +
                        '<button class="btn-secondary" data-action="regenerate-link" data-id="' + channel.id + '">Regenerate</button>' +
                        '<button class="btn-secondary" data-action="change-expiry" data-id="' + channel.id + '">Change Expiry</button>' +
                    '</div>' +
                '</div>' +
                '<div class="channel-section code-section' + (channel.code_required === 0 ? ' hidden' : '') + '" id="codes-section-' + channel.id + '">' +
                    '<h5>Invite Codes</h5>' +
                    '<div id="codes-list-' + channel.id + '" style="margin-bottom: 8px"></div>' +
                    '<div class="codes-form">' +
                        '<input type="number" id="gen-codes-count-' + channel.id + '" value="10" min="1" max="100">' +
                        '<button class="btn-success" data-action="generate-codes" data-id="' + channel.id + '">Generate</button>' +
                        '<button class="btn-danger" data-action="regenerate-codes" data-id="' + channel.id + '">Regenerate All</button>' +
                    '</div>' +
                '</div>' +
                '<div class="channel-section">' +
                    '<h5>Streams & Qualities</h5>' +
                    '<div id="qualities-list-' + channel.id + '"></div>' +
                    '<div class="add-quality-form">' +
                        '<input type="text" id="add-quality-label-' + channel.id + '" placeholder="Label (hd, sd, 4k)">' +
                        '<input type="text" id="add-quality-url-' + channel.id + '" placeholder="Stream URL">' +
                        '<select id="add-quality-preset-' + channel.id + '">' +
                            '<option value="">Auto (resolve from label)</option>' +
                            '<option value="low">Low (640x360, ~400k)</option>' +
                            '<option value="medium">Medium (source res, ~1000k)</option>' +
                            '<option value="high">High / Source (copy)</option>' +
                            '<option value="copy">Copy (no transcode)</option>' +
                            '<option value="custom">Custom</option>' +
                        '</select>' +
                        '<button class="btn-success" data-action="add-quality" data-id="' + channel.id + '">Add</button>' +
                        '<div class="add-quality-encoding" id="add-quality-encoding-' + channel.id + '">' +
                            '<input type="text" id="add-quality-vcodec-' + channel.id + '" placeholder="Video codec (libx264/copy)">' +
                            '<input type="text" id="add-quality-vbitrate-' + channel.id + '" placeholder="Video bitrate (800k)">' +
                            '<input type="text" id="add-quality-vmaxrate-' + channel.id + '" placeholder="Video maxrate (1000k)">' +
                            '<input type="text" id="add-quality-vbufsize-' + channel.id + '" placeholder="Video bufsize (1200k)">' +
                            '<input type="text" id="add-quality-vpreset-' + channel.id + '" placeholder="Encoding preset (ultrafast)">' +
                            '<input type="text" id="add-quality-vprofile-' + channel.id + '" placeholder="Profile (baseline/main)">' +
                            '<input type="text" id="add-quality-vlevel-' + channel.id + '" placeholder="Level (3.0)">' +
                            '<input type="text" id="add-quality-vres-' + channel.id + '" placeholder="Resolution (640x480)">' +
                            '<input type="text" id="add-quality-abitrate-' + channel.id + '" placeholder="Audio bitrate (64k)">' +
                            '<input type="text" id="add-quality-achannels-' + channel.id + '" placeholder="Audio channels (1/2)">' +
                            '<input type="text" id="add-quality-arate-' + channel.id + '" placeholder="Audio rate (48000)">' +
                            '<input type="text" id="add-quality-segdur-' + channel.id + '" placeholder="Segment duration (2-6)">' +
                        '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="channel-section">' +
                    '<button class="btn-danger" data-action="delete-channel" data-id="' + channel.id + '">Delete Channel</button>' +
                '</div>' +
            '</div>';

        loadQualities(channel);
        loadCodes(channel.id);

        return card;
    }

    function loadQualities(channel) {
        var list = document.getElementById('qualities-list-' + channel.id);
        if (!list) return;

        if (!channel.qualities || channel.qualities.length === 0) {
            list.innerHTML = '<p style="color: var(--text-secondary); font-size: 0.85rem">No streams added yet. Add a main stream URL above or use the form below.</p>';
            return;
        }

        list.innerHTML = '';
        var sorted = channel.qualities.slice().sort(function(a, b) { return (a.sort_order || 0) - (b.sort_order || 0); });

        sorted.forEach(function(q, idx) {
            var isMain = q.quality_label.toLowerCase() === 'source' || q.quality_label.toLowerCase() === 'main' || idx === 0 && sorted.length === 1;
            var presetDisplay = q.preset_key ? q.preset_key : 'auto (' + resolvePresetForDisplay(q.quality_label) + ')';
            var encodingSummary = buildEncodingSummary(q);
            var item = document.createElement('div');
            item.className = 'quality-item' + (isMain ? ' main-stream' : '');
            item.dataset.qualityId = q.id;
            item.dataset.channelId = channel.id;
            item.innerHTML =
                '<div class="quality-display">' +
                    '<span class="label">' + q.quality_label + '</span>' +
                    '<span class="url">' + q.stream_url + '</span>' +
                    '<span class="preset-info">' + presetDisplay + ' — ' + encodingSummary + '</span>' +
                '</div>' +
                '<div class="quality-edit hidden">' +
                    '<div class="edit-row"><label>Label</label><input type="text" class="edit-label" value="' + q.quality_label + '"></div>' +
                    '<div class="edit-row"><label>Stream URL</label><input type="text" class="edit-url" value="' + q.stream_url + '"></div>' +
                    '<div class="edit-row"><label>Sort Order</label><input type="number" class="edit-sort" value="' + (q.sort_order || 0) + '" style="width:60px"></div>' +
                    '<div class="edit-row"><label>Preset</label><select class="edit-preset-key">' +
                        '<option value="">Auto (resolve from label)</option>' +
                        '<option value="low"' + (q.preset_key === 'low' ? ' selected' : '') + '>Low (640x360, ~400k)</option>' +
                        '<option value="medium"' + (q.preset_key === 'medium' ? ' selected' : '') + '>Medium (source res, ~1000k)</option>' +
                        '<option value="high"' + (q.preset_key === 'high' ? ' selected' : '') + '>High / Source (copy, no transcode)</option>' +
                        '<option value="copy"' + (q.preset_key === 'copy' ? ' selected' : '') + '>Copy (stream copy, no transcode)</option>' +
                        '<option value="custom"' + (q.preset_key === 'custom' ? ' selected' : '') + '>Custom</option>' +
                    '</select></div>' +
                    '<div class="encoding-fields">' +
                        '<div class="edit-row"><label>Video Codec</label><input type="text" class="edit-video-codec" value="' + (q.video_codec || '') + '" placeholder="libx264 or copy"></div>' +
                        '<div class="edit-row"><label>Video Bitrate</label><input type="text" class="edit-video-bitrate" value="' + (q.video_bitrate || '') + '" placeholder="e.g. 800k"></div>' +
                        '<div class="edit-row"><label>Video Max Rate</label><input type="text" class="edit-video-maxrate" value="' + (q.video_maxrate || '') + '" placeholder="e.g. 1000k"></div>' +
                        '<div class="edit-row"><label>Video Buffer Size</label><input type="text" class="edit-video-bufsize" value="' + (q.video_bufsize || '') + '" placeholder="e.g. 1200k"></div>' +
                        '<div class="edit-row"><label>Encoding Preset</label><input type="text" class="edit-video-preset" value="' + (q.video_preset || '') + '" placeholder="ultrafast, veryfast, fast..."></div>' +
                        '<div class="edit-row"><label>Profile</label><input type="text" class="edit-video-profile" value="' + (q.video_profile || '') + '" placeholder="baseline, main, high"></div>' +
                        '<div class="edit-row"><label>Level</label><input type="text" class="edit-video-level" value="' + (q.video_level || '') + '" placeholder="3.0, 3.1, 4.0"></div>' +
                        '<div class="edit-row"><label>Resolution</label><input type="text" class="edit-video-resolution" value="' + (q.video_resolution || '') + '" placeholder="e.g. 640x480 or empty for source"></div>' +
                        '<div class="edit-row"><label>Audio Bitrate</label><input type="text" class="edit-audio-bitrate" value="' + (q.audio_bitrate || '') + '" placeholder="e.g. 64k"></div>' +
                        '<div class="edit-row"><label>Audio Channels</label><input type="text" class="edit-audio-channels" value="' + (q.audio_channels || '') + '" placeholder="1 or 2"></div>' +
                        '<div class="edit-row"><label>Audio Rate</label><input type="text" class="edit-audio-rate" value="' + (q.audio_rate || '') + '" placeholder="44100 or 48000"></div>' +
                        '<div class="edit-row"><label>Segment Duration</label><input type="number" class="edit-segment-duration" value="' + (q.segment_duration || '') + '" placeholder="2-6 seconds" style="width:80px"></div>' +
                    '</div>' +
                '</div>' +
                '<div class="quality-actions">' +
                    '<button class="edit-btn" data-action="edit-quality" data-channel-id="' + channel.id + '" data-quality-id="' + q.id + '">Edit</button>' +
                    '<button class="save-btn hidden" data-action="save-quality" data-channel-id="' + channel.id + '" data-quality-id="' + q.id + '">Save</button>' +
                    '<button class="cancel-btn hidden" data-action="cancel-edit-quality" data-channel-id="' + channel.id + '" data-quality-id="' + q.id + '">Cancel</button>' +
                    '<button class="delete-btn" data-action="remove-quality" data-channel-id="' + channel.id + '" data-quality-id="' + q.id + '">Remove</button>' +
                '</div>';
            list.appendChild(item);
        });
    }

    function resolvePresetForDisplay(label) {
        var lower = label.toLowerCase().trim();
        if (lower === 'low' || lower.includes('low')) return 'low';
        if (lower === 'medium' || lower.includes('medium')) return 'medium';
        if (lower === 'high' || lower.includes('high')) return 'high';
        if (lower === 'source' || lower === 'copy') return 'copy';
        var resMatch = lower.match(/(\d+)p/);
        if (resMatch) {
            var h = parseInt(resMatch[1]);
            if (h <= 360) return 'low';
            if (h <= 720) return 'medium';
        }
        return 'high';
    }

    function buildEncodingSummary(q) {
        if (q.video_codec === 'copy') return 'stream copy (no transcode)';
        if (q.video_codec || q.video_bitrate || q.video_resolution) {
            var parts = [];
            if (q.video_codec) parts.push(q.video_codec);
            if (q.video_bitrate) parts.push(q.video_bitrate);
            if (q.video_resolution) parts.push(q.video_resolution);
            return parts.join(', ');
        }
        var preset = resolvePresetForDisplay(q.quality_label || q.label || '');
        if (preset === 'low') return 'libx264, ~400k, 640x360';
        if (preset === 'medium') return 'libx264, ~1000k, source res';
        return 'stream copy (no transcode)';
    }

    async function loadCodes(channelId, isSilent = false) {
        var codes = await adminFetch('/channels/' + channelId + '/codes');
        var list = document.getElementById('codes-list-' + channelId);
        if (!list) return;

        if (codes.length === 0) {
            list.innerHTML = '<p style="color: var(--text-secondary); font-size: 0.85rem">No codes generated yet</p>';
            return;
        }

        var activeTab = activeCodeTabs[channelId] || 'unread';

        var unreadCodes = codes.filter(function(c) { return c.status === 'unused'; });
        var redeemedCodes = codes.filter(function(c) { return c.status !== 'unused'; });

        var codesToShow = activeTab === 'unread' ? unreadCodes : redeemedCodes;

        var html = 
            '<div class="codes-tabs">' +
                '<button class="codes-tab ' + (activeTab === 'unread' ? 'active' : '') + '" data-action="switch-codes-tab" data-tab="unread" data-channel-id="' + channelId + '">Unread (' + unreadCodes.length + ')</button>' +
                '<button class="codes-tab ' + (activeTab === 'redeemed' ? 'active' : '') + '" data-action="switch-codes-tab" data-tab="redeemed" data-channel-id="' + channelId + '">Redeemed/Expired (' + redeemedCodes.length + ')</button>' +
            '</div>' +
            '<div class="codes-header">' +
                '<span class="codes-count">' + codesToShow.length + ' code' + (codesToShow.length !== 1 ? 's' : '') + ' in this tab</span>' +
                '<button class="btn-copy-all" data-action="copy-all-codes" data-channel-id="' + channelId + '" data-tab="' + activeTab + '">Copy ' + (activeTab === 'unread' ? 'Unread' : 'These') + ' Codes</button>' +
            '</div>';

        var scrollHtml = '<div class="codes-scroll">';
        if (codesToShow.length === 0) {
            scrollHtml += '<p style="color: var(--text-secondary); font-size: 0.85rem; padding: 8px 0;">No codes in this category</p>';
        } else {
            codesToShow.forEach(function(c) {
                var statusClass = c.status;
                scrollHtml +=
                    '<div class="code-item">' +
                        '<span class="code_text">' + c.code + '</span>' +
                        '<span class="status ' + statusClass + '">' + c.status + '</span>' +
                        '<span class="expiry-info">Expires: ' + formatDate(c.expires_at) + '</span>' +
                        '<div class="code-item-actions">' +
                            '<button class="btn-copy-code" data-action="copy-code" data-code="' + c.code + '" title="Copy code">&#128203;</button>' +
                            '<button class="delete-btn" data-action="revoke-code" data-code="' + c.code + '">Revoke</button>' +
                        '</div>' +
                    '</div>';
            });
        }
        scrollHtml += '</div>';

        var oldScroll = list.querySelector('.codes-scroll');
        var scrollTop = oldScroll ? oldScroll.scrollTop : 0;

        list.innerHTML = html + scrollHtml;

        var newScroll = list.querySelector('.codes-scroll');
        if (newScroll) newScroll.scrollTop = scrollTop;
    }

    function formatDate(dateStr) {
        if (!dateStr) return 'Never';
        try {
            var d = new Date(dateStr);
            if (isNaN(d.getTime())) return dateStr;
            if (d.getFullYear() >= 9000) return 'Never';
            // Show date in user's local timezone with timezone abbreviation
            return d.toLocaleString(undefined, {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                timeZoneName: 'short'
            });
        } catch (e) {
            return dateStr;
        }
    }

    function showLogin() {
        adminLogin.classList.remove('hidden');
        dashboard.classList.add('hidden');
        usernameInput.focus();
    }

    function showDashboard() {
        adminLogin.classList.add('hidden');
        dashboard.classList.remove('hidden');
    }

    function logout() {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(ADMIN_INFO_KEY);
        authToken = '';
        showLogin();
        showToast('Signed out successfully', 'info');
    }

    function openCreateModal() {
        createChannelSection.classList.remove('hidden');
        // Show timezone label on the expiry input
        var createTzLabel = document.getElementById('create-expiry-tz-label');
        if (createTzLabel) createTzLabel.textContent = 'Timezone: ' + getUserTimezoneLabel();
        document.getElementById('new-channel-name').focus();
        // Reset the code required toggle to default ON
        var codeRequiredToggle = document.getElementById('new-channel-code-required');
        if (codeRequiredToggle) {
            codeRequiredToggle.checked = true;
            updateToggleLabel(codeRequiredToggle, 'new-channel-code-label');
        }
    }

    function closeCreateModal() {
        createChannelSection.classList.add('hidden');
    }

    async function createChannel() {
        var name = document.getElementById('new-channel-name').value.trim();
        var streamUrl = document.getElementById('new-channel-stream-url').value.trim();
        var expiryLocal = document.getElementById('new-channel-expiry').value || null;
        var codeRequired = document.getElementById('new-channel-code-required').checked;

        if (!name) {
            showToast('Channel name is required', 'error');
            return;
        }

        // Convert local datetime to UTC ISO before sending to server
        var expiryUTC = localDatetimeToUTC(expiryLocal);

        var channel = await adminFetch('/channels', {
            method: 'POST',
            body: { name: name, link_expires_at: expiryUTC, code_required: codeRequired }
        });

        if (streamUrl) {
            await adminFetch('/channels/' + channel.id + '/qualities', {
                method: 'POST',
                body: { quality_label: 'source', stream_url: streamUrl, sort_order: 0 }
            });
        }

        showToast('Channel "' + name + '" created' + (streamUrl ? ' with main stream' : ''), 'success');
        document.getElementById('new-channel-name').value = '';
        document.getElementById('new-channel-stream-url').value = '';
        closeCreateModal();
        loadChannels();
    }

    document.addEventListener('click', async function(e) {
        var btn = e.target.closest('button[data-action]');
        if (!btn) return;

        var action = btn.dataset.action;

        if (action === 'toggle-channel') {
            var body = document.getElementById('channel-body-' + btn.dataset.id);
            var arrow = btn.closest('.channel-card').querySelector('.toggle-arrow');
            if (body) {
                body.classList.toggle('collapsed');
                if (body.classList.contains('collapsed')) {
                    arrow.innerHTML = '&#9662;';
                } else {
                    arrow.innerHTML = '&#9652;';
                }
            }
            return;
        }

        if (action === 'copy-code') {
            navigator.clipboard.writeText(btn.dataset.code);
            btn.classList.add('copied');
            btn.innerHTML = '&#10003;';
            showToast('Code copied: ' + btn.dataset.code, 'success');
            setTimeout(function() {
                btn.classList.remove('copied');
                btn.innerHTML = '&#128203;';
            }, 1500);
            return;
        }

        if (action === 'switch-codes-tab') {
            activeCodeTabs[btn.dataset.channelId] = btn.dataset.tab;
            loadCodes(btn.dataset.channelId, true);
            return;
        }

        if (action === 'copy-all-codes') {
            var channelId = btn.dataset.channelId;
            var tab = btn.dataset.tab;
            var codesList = document.getElementById('codes-list-' + channelId);
            var codeEls = codesList.querySelectorAll('.code_text');
            var allCodes = [];
            codeEls.forEach(function(el) { allCodes.push(el.textContent); });
            if (allCodes.length === 0) {
                showToast('No codes to copy', 'error');
                return;
            }
            navigator.clipboard.writeText(allCodes.join('\n'));
            showToast(allCodes.length + (tab === 'unread' ? ' unread' : '') + ' codes copied to clipboard', 'success');
            return;
        }

        if (action === 'copy-link') {
            navigator.clipboard.writeText('https://stream.chatrix.vip/channel/' + btn.dataset.token);
            showToast('Link copied to clipboard', 'success');
            return;
        }

        if (action === 'regenerate-link') {
            if (!confirm('Regenerate link? The old link will stop working immediately.')) return;
            var result = await adminFetch('/channels/' + btn.dataset.id + '/regenerate-link', { method: 'POST' });
            showToast('Link regenerated', 'success');
            loadChannels();
            return;
        }

        if (action === 'change-expiry') {
            expiryEditChannelId = btn.dataset.id;
            var ch = channels.find(function(c) { return c.id == expiryEditChannelId; });
            if (ch && ch.link_expires_at) {
                // Convert UTC ISO string to local datetime for the input
                expiryDatetimeInput.value = utcToLocalDatetime(ch.link_expires_at);
            } else {
                expiryDatetimeInput.value = '';
            }
            // Update timezone label
            var tzLabel = document.getElementById('expiry-tz-label');
            if (tzLabel) tzLabel.textContent = getUserTimezoneLabel();
            expiryModal.classList.remove('hidden');
            expiryDatetimeInput.focus();
            return;
        }

        if (action === 'add-quality') {
            var channelId = btn.dataset.id;
            var label = document.getElementById('add-quality-label-' + channelId).value.trim();
            var url = document.getElementById('add-quality-url-' + channelId).value.trim();
            var presetKey = document.getElementById('add-quality-preset-' + channelId);
            presetKey = presetKey ? presetKey.value : '';
            if (!label || !url) {
                showToast('Label and URL required', 'error');
                return;
            }
            var ch = channels.find(function(c) { return c.id == channelId; });
            var sortOrder = ch && ch.qualities ? ch.qualities.length : 0;
            var body = { quality_label: label, stream_url: url, sort_order: sortOrder, preset_key: presetKey };
            var encIds = [
                ['add-quality-vcodec-' + channelId, 'video_codec'],
                ['add-quality-vbitrate-' + channelId, 'video_bitrate'],
                ['add-quality-vmaxrate-' + channelId, 'video_maxrate'],
                ['add-quality-vbufsize-' + channelId, 'video_bufsize'],
                ['add-quality-vpreset-' + channelId, 'video_preset'],
                ['add-quality-vprofile-' + channelId, 'video_profile'],
                ['add-quality-vlevel-' + channelId, 'video_level'],
                ['add-quality-vres-' + channelId, 'video_resolution'],
                ['add-quality-abitrate-' + channelId, 'audio_bitrate'],
                ['add-quality-achannels-' + channelId, 'audio_channels'],
                ['add-quality-arate-' + channelId, 'audio_rate'],
                ['add-quality-segdur-' + channelId, 'segment_duration']
            ];
            encIds.forEach(function(pair) {
                var el = document.getElementById(pair[0]);
                if (el && el.value.trim()) body[pair[1]] = el.value.trim();
            });
            await adminFetch('/channels/' + channelId + '/qualities', {
                method: 'POST',
                body: body
            });
            showToast('Quality "' + label + '" added', 'success');
            loadChannels();
            return;
        }

        if (action === 'generate-codes') {
            var channelId = btn.dataset.id;
            var count = parseInt(document.getElementById('gen-codes-count-' + channelId).value) || 10;
            var codes = await adminFetch('/channels/' + channelId + '/codes', {
                method: 'POST',
                body: { count: count }
            });
            showToast(codes.length + ' codes generated', 'success');
            loadChannels();
            return;
        }

        if (action === 'regenerate-codes') {
            if (!confirm('Regenerate ALL codes? Old codes and sessions will be invalidated.')) return;
            var channelId = btn.dataset.id;
            var count = parseInt(document.getElementById('gen-codes-count-' + channelId).value) || 10;
            var codes = await adminFetch('/channels/' + channelId + '/regenerate-codes', {
                method: 'POST',
                body: { count: count }
            });
            showToast(codes.length + ' new codes generated. Old codes invalidated.', 'success');
            loadChannels();
            return;
        }

        if (action === 'revoke-code') {
            if (!confirm('Revoke this code and its session?')) return;
            await adminFetch('/codes/' + btn.dataset.code, { method: 'DELETE' });
            showToast('Code revoked', 'success');
            loadChannels();
            return;
        }

        if (action === 'delete-channel') {
            if (!confirm('Delete this channel? ALL qualities, codes, and sessions will be removed.')) return;
            await adminFetch('/channels/' + btn.dataset.id, { method: 'DELETE' });
            showToast('Channel deleted', 'success');
            loadChannels();
            return;
        }

        if (action === 'edit-quality') {
            var row = btn.closest('.quality-item, .stream-quality-row');
            if (!row) return;
            row.querySelector('.quality-display').classList.add('hidden');
            row.querySelector('.quality-edit').classList.remove('hidden');
            row.querySelector('.edit-btn').classList.add('hidden');
            row.querySelector('.save-btn').classList.remove('hidden');
            row.querySelector('.cancel-btn').classList.remove('hidden');
            return;
        }

        if (action === 'cancel-edit-quality') {
            var row = btn.closest('.quality-item, .stream-quality-row');
            if (!row) return;
            row.querySelector('.quality-display').classList.remove('hidden');
            row.querySelector('.quality-edit').classList.add('hidden');
            row.querySelector('.edit-btn').classList.remove('hidden');
            row.querySelector('.save-btn').classList.add('hidden');
            row.querySelector('.cancel-btn').classList.add('hidden');
            return;
        }

        if (action === 'save-quality') {
            var channelId = btn.dataset.channelId;
            var qualityId = btn.dataset.qualityId;
            var row = btn.closest('.quality-item, .stream-quality-row');
            if (!row) return;
            var body = {
                quality_label: row.querySelector('.edit-label').value.trim() || null,
                stream_url: row.querySelector('.edit-url').value.trim() || null,
                sort_order: parseInt(row.querySelector('.edit-sort').value) || null,
                preset_key: row.querySelector('.edit-preset-key').value || '',
                video_codec: row.querySelector('.edit-video-codec').value.trim() || '',
                video_bitrate: row.querySelector('.edit-video-bitrate').value.trim() || '',
                video_maxrate: row.querySelector('.edit-video-maxrate').value.trim() || '',
                video_bufsize: row.querySelector('.edit-video-bufsize').value.trim() || '',
                video_preset: row.querySelector('.edit-video-preset').value.trim() || '',
                video_profile: row.querySelector('.edit-video-profile').value.trim() || '',
                video_level: row.querySelector('.edit-video-level').value.trim() || '',
                video_resolution: row.querySelector('.edit-video-resolution').value.trim() || '',
                audio_bitrate: row.querySelector('.edit-audio-bitrate').value.trim() || '',
                audio_channels: row.querySelector('.edit-audio-channels').value.trim() || '',
                audio_rate: row.querySelector('.edit-audio-rate').value.trim() || '',
                segment_duration: row.querySelector('.edit-segment-duration').value.trim() || ''
            };
            try {
                await adminFetch('/channels/' + channelId + '/qualities/' + qualityId, { method: 'PATCH', body: body });
                showToast('Quality updated', 'success');
                loadChannels();
            } catch (e) {
                showToast(e.message || 'Failed to update quality', 'error');
            }
            return;
        }

        if (action === 'remove-quality') {
            var channelId = btn.dataset.channelId;
            var qualityId = btn.dataset.qualityId;
            if (!confirm('Remove this quality? The stream will be stopped.')) return;
            try {
                await adminFetch('/channels/' + channelId + '/qualities/' + qualityId, { method: 'DELETE' });
                showToast('Quality removed', 'success');
                loadChannels();
            } catch (e) {
                showToast(e.message || 'Failed to remove quality', 'error');
            }
            return;
        }

        if (action === 'add-quality-stream') {
            var channelId = btn.dataset.id;
            var label = document.getElementById('stream-add-label-' + channelId).value.trim();
            var url = document.getElementById('stream-add-url-' + channelId).value.trim();
            var presetKey = document.getElementById('stream-add-preset-' + channelId);
            presetKey = presetKey ? presetKey.value : '';
            if (!label || !url) {
                showToast('Label and URL required', 'error');
                return;
            }
            var ch = channels.find(function(c) { return c.id == channelId; });
            var sortOrder = ch && ch.qualities ? ch.qualities.length : 0;
            var body = { quality_label: label, stream_url: url, sort_order: sortOrder, preset_key: presetKey };
            var encIds = [
                ['stream-add-vcodec-' + channelId, 'video_codec'],
                ['stream-add-vbitrate-' + channelId, 'video_bitrate'],
                ['stream-add-vmaxrate-' + channelId, 'video_maxrate'],
                ['stream-add-vbufsize-' + channelId, 'video_bufsize'],
                ['stream-add-vpreset-' + channelId, 'video_preset'],
                ['stream-add-vprofile-' + channelId, 'video_profile'],
                ['stream-add-vlevel-' + channelId, 'video_level'],
                ['stream-add-vres-' + channelId, 'video_resolution'],
                ['stream-add-abitrate-' + channelId, 'audio_bitrate'],
                ['stream-add-achannels-' + channelId, 'audio_channels'],
                ['stream-add-arate-' + channelId, 'audio_rate'],
                ['stream-add-segdur-' + channelId, 'segment_duration']
            ];
            encIds.forEach(function(pair) {
                var el = document.getElementById(pair[0]);
                if (el && el.value.trim()) body[pair[1]] = el.value.trim();
            });
            try {
                await adminFetch('/channels/' + channelId + '/qualities', { method: 'POST', body: body });
                showToast('Quality "' + label + '" added', 'success');
                loadChannels();
            } catch (e) {
                showToast(e.message || 'Failed to add quality', 'error');
            }
            return;
        }

        if (action === 'edit-user') {
            openEditUserModal(parseInt(btn.dataset.userId), btn.dataset.userUsername, btn.dataset.userRole);
            return;
        }

        if (action === 'change-pw-user') {
            openChangePasswordModal(parseInt(btn.dataset.userId), btn.dataset.userUsername);
            return;
        }

        if (action === 'delete-user') {
            deleteUser(parseInt(btn.dataset.userId), btn.dataset.userUsername);
            return;
        }
    });

    // Handle toggle-switch change events (for code_required toggles)
    document.addEventListener('change', async function(e) {
        var checkbox = e.target;
        if (checkbox.dataset && checkbox.dataset.action === 'toggle-code-required') {
            var channelId = checkbox.dataset.id;
            var isChecked = checkbox.checked;
            try {
                await adminFetch('/channels/' + channelId, {
                    method: 'PATCH',
                    body: { code_required: isChecked }
                });
                var hint = document.getElementById('code-required-hint-' + channelId);
                if (hint) {
                    hint.textContent = isChecked ? 'Viewers must enter a code' : 'Anyone with the link can watch';
                }
                var codesSection = document.getElementById('codes-section-' + channelId);
                if (codesSection) {
                    if (isChecked) {
                        codesSection.classList.remove('hidden');
                    } else {
                        codesSection.classList.add('hidden');
                    }
                }
                showToast(isChecked ? 'Invite code now required' : 'Free access enabled — no code needed', 'success');
            } catch (e) {
                // Revert toggle on error
                checkbox.checked = !isChecked;
                showToast(e.message || 'Failed to update setting', 'error');
            }
        }

        // Handle the create modal code-required toggle
        if (checkbox.id === 'new-channel-code-required') {
            updateToggleLabel(checkbox, 'new-channel-code-label');
        }
    });

    document.addEventListener('click', function(e) {
        var closeBtn = e.target.closest('[data-close-modal]');
        if (closeBtn && e.target === closeBtn) {
            var sectionId = closeBtn.dataset.closeModal;
            document.getElementById(sectionId).classList.add('hidden');
        }
    });

    expirySaveBtn.addEventListener('click', async function() {
        var value = expiryDatetimeInput.value;
        if (!value) {
            showToast('Please select a date or click Clear', 'error');
            return;
        }
        // Convert local datetime to UTC ISO before sending to server
        var utcValue = localDatetimeToUTC(value);
        if (!utcValue) {
            showToast('Invalid date/time value', 'error');
            return;
        }
        await adminFetch('/channels/' + expiryEditChannelId, { method: 'PATCH', body: { link_expires_at: utcValue } });
        expiryModal.classList.add('hidden');
        showToast('Expiry updated', 'success');
        loadChannels();
    });

    expiryClearBtn.addEventListener('click', async function() {
        await adminFetch('/channels/' + expiryEditChannelId, { method: 'PATCH', body: { link_expires_at: null } });
        expiryModal.classList.add('hidden');
        showToast('Expiry cleared — link will never expire', 'success');
        loadChannels();
    });

    document.addEventListener('click', function(e) {
        var navItem = e.target.closest('.nav-item[data-section]');
        if (navItem) {
            switchView(navItem.dataset.section);
            closeMobileMenu();
        }
    });

    menuToggle.addEventListener('click', openMobileMenu);
    mobileOverlay.addEventListener('click', closeMobileMenu);

    usernameInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') passwordInput.focus(); });
    passwordInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') login(); });
    loginBtn.addEventListener('click', login);
    logoutBtn.addEventListener('click', logout);
    createChannelBtn.addEventListener('click', openCreateModal);
    if (addUserBtn) addUserBtn.addEventListener('click', openAddUserModal);
    emptyCreateBtn.addEventListener('click', openCreateModal);
    confirmCreateBtn.addEventListener('click', createChannel);
    if (document.getElementById('users-empty-add-btn')) document.getElementById('users-empty-add-btn').addEventListener('click', openAddUserModal);
    if (document.getElementById('confirm-add-user-btn')) document.getElementById('confirm-add-user-btn').addEventListener('click', confirmAddUser);
    if (document.getElementById('confirm-edit-user-btn')) document.getElementById('confirm-edit-user-btn').addEventListener('click', confirmEditUser);
    if (document.getElementById('confirm-change-pw-btn')) document.getElementById('confirm-change-pw-btn').addEventListener('click', confirmChangePassword);

    async function loadUsers() {
        try {
            adminUsers = await adminFetch('/users');
        } catch (e) {
            adminUsers = [];
        }
    }

    function renderUsers() {
        usersContainer.innerHTML = '';
        if (!adminUsers || adminUsers.length === 0) {
            usersEmptyState.classList.remove('hidden');
            return;
        }
        usersEmptyState.classList.add('hidden');

        adminUsers.forEach(function(user) {
            var card = document.createElement('div');
            card.className = 'user-card';
            var roleBadgeClass = user.role === 'superadmin' ? 'role-superadmin' : (user.role === 'admin' ? 'role-admin' : 'role-moderator');
            card.innerHTML =
                '<div class="user-header">' +
                    '<div class="user-avatar">' + user.username.substring(0, 2).toUpperCase() + '</div>' +
                    '<div class="user-details">' +
                        '<span class="user-name">' + user.username + '</span>' +
                        '<span class="user-role-badge ' + roleBadgeClass + '">' + user.role + '</span>' +
                    '</div>' +
                    '<span class="user-id">ID: ' + user.id + '</span>' +
                '</div>' +
                '<div class="user-meta">' +
                    '<span class="meta-tag"><span class="meta-label">Created:</span> <span class="meta-value">' + formatDate(user.created_at) + '</span></span>' +
                '</div>' +
                '<div class="user-actions">' +
                    '<button class="btn-secondary" data-action="edit-user" data-user-id="' + user.id + '" data-user-username="' + user.username + '" data-user-role="' + user.role + '">Edit</button>' +
                    '<button class="btn-secondary" data-action="change-pw-user" data-user-id="' + user.id + '" data-user-username="' + user.username + '">Change Password</button>' +
                    (user.username !== 'superadmin' ? '<button class="btn-danger" data-action="delete-user" data-user-id="' + user.id + '" data-user-username="' + user.username + '">Delete</button>' : '') +
                '</div>';
            usersContainer.appendChild(card);
        });
    }

    function openAddUserModal() {
        addUserUsername.value = '';
        addUserPassword.value = '';
        addUserRole.value = 'admin';
        addUserModal.classList.remove('hidden');
        addUserUsername.focus();
    }

    function closeAddUserModal() {
        addUserModal.classList.add('hidden');
    }

    async function confirmAddUser() {
        var username = addUserUsername.value.trim();
        var password = addUserPassword.value.trim();
        var role = addUserRole.value;
        if (!username || !password) {
            showToast('Username and password are required', 'error');
            return;
        }
        try {
            var user = await adminFetch('/users', { method: 'POST', body: { username: username, password: password, role: role } });
            showToast('User "' + username + '" created', 'success');
            closeAddUserModal();
            loadUsers().then(function() { renderUsers(); });
        } catch (e) {
            showToast(e.message || 'Failed to create user', 'error');
        }
    }

    function openEditUserModal(userId, username, role) {
        editingUserId = userId;
        editUserUsername.value = username;
        editUserRole.value = role;
        editUserModal.classList.remove('hidden');
        editUserUsername.focus();
    }

    function closeEditUserModal() {
        editUserModal.classList.add('hidden');
        editingUserId = null;
    }

    async function confirmEditUser() {
        var username = editUserUsername.value.trim();
        var role = editUserRole.value;
        if (!username) {
            showToast('Username is required', 'error');
            return;
        }
        try {
            var user = await adminFetch('/users/' + editingUserId, { method: 'PATCH', body: { username: username, role: role } });
            showToast('User "' + username + '" updated', 'success');
            closeEditUserModal();
            loadUsers().then(function() { renderUsers(); });
        } catch (e) {
            showToast(e.message || 'Failed to update user', 'error');
        }
    }

    function openChangePasswordModal(userId, username) {
        editingUserId = userId;
        changePwUsernameDisplay.value = username;
        changePwNewPassword.value = '';
        changePasswordModal.classList.remove('hidden');
        changePwNewPassword.focus();
    }

    function closeChangePasswordModal() {
        changePasswordModal.classList.add('hidden');
        editingUserId = null;
    }

    async function confirmChangePassword() {
        var password = changePwNewPassword.value.trim();
        if (!password || password.length < 6) {
            showToast('Password must be at least 6 characters', 'error');
            return;
        }
        try {
            await adminFetch('/users/' + editingUserId + '/change-password', { method: 'POST', body: { password: password } });
            showToast('Password updated', 'success');
            closeChangePasswordModal();
        } catch (e) {
            showToast(e.message || 'Failed to change password', 'error');
        }
    }

    async function deleteUser(userId, username) {
        if (!confirm('Delete user "' + username + '"? They will immediately lose access.')) return;
        try {
            await adminFetch('/users/' + userId, { method: 'DELETE' });
            showToast('User "' + username + '" deleted', 'success');
            loadUsers().then(function() { renderUsers(); });
        } catch (e) {
            showToast(e.message || 'Failed to delete user', 'error');
        }
    }

    async function checkCurrentUserRole() {
        try {
            var info = await adminFetch('/current-user');
            if (navUsers) {
                navUsers.style.display = info.role === 'superadmin' ? '' : 'none';
            }
        } catch (e) {
            if (navUsers) navUsers.style.display = 'none';
        }
    }

    setInterval(function() {
        if (currentView !== 'channels') return;
        var openBodies = document.querySelectorAll('.channel-body:not(.collapsed)');
        openBodies.forEach(function(body) {
            var id = body.id.replace('channel-body-', '');
            if (id) loadCodes(id, true);
        });
    }, 5000);

    init();
})();
