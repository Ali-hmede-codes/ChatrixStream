(function() {
    const TOKEN_KEY = 'chatrix_admin_token';
    const ADMIN_INFO_KEY = 'chatrix_admin_info';

    let authToken = '';
    let channels = [];
    let currentView = 'channels';

    const adminLogin = document.getElementById('admin-login');
    const dashboard = document.getElementById('dashboard');
    const usernameInput = document.getElementById('username-input');
    const passwordInput = document.getElementById('password-input');
    const loginBtn = document.getElementById('login-btn');
    const loginError = document.getElementById('login-error');
    const logoutBtn = document.getElementById('logout-btn');
    const createChannelBtn = document.getElementById('create-channel-btn');
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
                loadChannels();
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
                loadChannels();
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
        return res.json();
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
                            return '<div class="stream-quality-row' + (isMain ? ' main-stream' : '') + '" data-quality-id="' + q.id + '" data-channel-id="' + ch.id + '">' +
                                '<div class="quality-display">' +
                                    '<span class="label">' + q.quality_label + '</span>' +
                                    '<span class="url">' + q.stream_url + '</span>' +
                                '</div>' +
                                '<div class="quality-edit hidden">' +
                                    '<input type="text" class="edit-label" value="' + q.quality_label + '">' +
                                    '<input type="text" class="edit-url" value="' + q.stream_url + '">' +
                                    '<input type="number" class="edit-sort" value="' + (q.sort_order || 0) + '" style="width:60px">' +
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
                    '<button class="btn-success" data-action="add-quality-stream" data-id="' + ch.id + '">Add</button>' +
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
        if (view === 'channels') {
            topBarTitle.textContent = 'Channels';
            createBtn.classList.remove('hidden');
            channelsListSection.classList.remove('hidden');
            streamsViewSection.classList.add('hidden');
            renderChannels();
        } else {
            topBarTitle.textContent = 'Streams & Qualities';
            createBtn.classList.add('hidden');
            channelsListSection.classList.add('hidden');
            streamsViewSection.classList.remove('hidden');
            renderStreamsView();
        }
    }

    function isExpired(dateStr) {
        if (!dateStr) return false;
        return new Date(dateStr) <= new Date();
    }

    function createChannelCard(channel) {
        var card = document.createElement('div');
        card.className = 'channel-card';
        card.dataset.channelId = channel.id;

        var expiryClass = isExpired(channel.link_expires_at) ? 'expired' : '';
        var expiryTag = channel.link_expires_at
            ? '<span class="meta-tag expiry-tag"><span class="meta-label">Expires:</span> <span class="meta-value ' + expiryClass + '">' + formatDate(channel.link_expires_at) + '</span></span>'
            : '<span class="meta-tag expiry-tag"><span class="meta-label">Expires:</span> <span class="meta-value">Never (set expiry to generate codes)</span></span>';

        card.innerHTML =
            '<div class="channel-header">' +
                '<h4>' + channel.name + '</h4>' +
                '<span class="channel-id">ID: ' + channel.id + '</span>' +
            '</div>' +
            '<div class="channel-meta">' +
                expiryTag +
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
            '<div class="channel-section">' +
                '<h5>Streams & Qualities</h5>' +
                '<div id="qualities-list-' + channel.id + '"></div>' +
                '<div class="add-quality-form">' +
                    '<input type="text" id="add-quality-label-' + channel.id + '" placeholder="Label (hd, sd, 4k)">' +
                    '<input type="text" id="add-quality-url-' + channel.id + '" placeholder="Stream URL">' +
                    '<button class="btn-success" data-action="add-quality" data-id="' + channel.id + '">Add</button>' +
                '</div>' +
            '</div>' +
            '<div class="channel-section">' +
                '<h5>Invite Codes</h5>' +
                '<div id="codes-list-' + channel.id + '" style="margin-bottom: 8px"></div>' +
                '<div class="codes-form">' +
                    '<input type="number" id="gen-codes-count-' + channel.id + '" value="10" min="1" max="100">' +
                    '<button class="btn-success" data-action="generate-codes" data-id="' + channel.id + '">Generate</button>' +
                    '<button class="btn-danger" data-action="regenerate-codes" data-id="' + channel.id + '">Regenerate All</button>' +
                '</div>' +
            '</div>' +
            '<div class="channel-section">' +
                '<button class="btn-danger" data-action="delete-channel" data-id="' + channel.id + '">Delete Channel</button>' +
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
            var item = document.createElement('div');
            var isMain = q.quality_label.toLowerCase() === 'source' || q.quality_label.toLowerCase() === 'main' || idx === 0 && sorted.length === 1;
            item.className = 'quality-item' + (isMain ? ' main-stream' : '');
            item.dataset.qualityId = q.id;
            item.dataset.channelId = channel.id;
            item.innerHTML =
                '<div class="quality-display">' +
                    '<span class="label">' + q.quality_label + '</span>' +
                    '<span class="url">' + q.stream_url + '</span>' +
                '</div>' +
                '<div class="quality-edit hidden">' +
                    '<input type="text" class="edit-label" value="' + q.quality_label + '">' +
                    '<input type="text" class="edit-url" value="' + q.stream_url + '">' +
                    '<input type="number" class="edit-sort" value="' + (q.sort_order || 0) + '" style="width:60px">' +
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

    async function loadCodes(channelId) {
        var codes = await adminFetch('/channels/' + channelId + '/codes');
        var list = document.getElementById('codes-list-' + channelId);
        if (!list) return;

        if (codes.length === 0) {
            list.innerHTML = '<p style="color: var(--text-secondary); font-size: 0.85rem">No codes generated yet</p>';
            return;
        }

        list.innerHTML = '';
        codes.forEach(function(c) {
            var statusClass = c.status;
            var item = document.createElement('div');
            item.className = 'code-item';
            item.innerHTML =
                '<span class="code_text">' + c.code + '</span>' +
                '<span class="status ' + statusClass + '">' + c.status + '</span>' +
                '<span class="expiry-info">Expires: ' + formatDate(c.expires_at) + '</span>' +
                '<button class="delete-btn" data-action="revoke-code" data-code="' + c.code + '">Revoke</button>';
            list.appendChild(item);
        });
    }

    function formatDate(dateStr) {
        if (!dateStr) return 'Never';
        return new Date(dateStr).toLocaleString();
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
        document.getElementById('new-channel-name').focus();
    }

    function closeCreateModal() {
        createChannelSection.classList.add('hidden');
    }

    async function createChannel() {
        var name = document.getElementById('new-channel-name').value.trim();
        var streamUrl = document.getElementById('new-channel-stream-url').value.trim();
        var expiry = document.getElementById('new-channel-expiry').value || null;

        if (!name) {
            showToast('Channel name is required', 'error');
            return;
        }

        var channel = await adminFetch('/channels', {
            method: 'POST',
            body: { name: name, link_expires_at: expiry }
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
                var d = new Date(ch.link_expires_at);
                var local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
                expiryDatetimeInput.value = local;
            } else {
                expiryDatetimeInput.value = '';
            }
            expiryModal.classList.remove('hidden');
            expiryDatetimeInput.focus();
            return;
        }

        if (action === 'add-quality') {
            var channelId = btn.dataset.id;
            var label = document.getElementById('add-quality-label-' + channelId).value.trim();
            var url = document.getElementById('add-quality-url-' + channelId).value.trim();
            if (!label || !url) {
                showToast('Label and URL required', 'error');
                return;
            }
            var ch = channels.find(function(c) { return c.id == channelId; });
            var sortOrder = ch && ch.qualities ? ch.qualities.length : 0;
            await adminFetch('/channels/' + channelId + '/qualities', {
                method: 'POST',
                body: { quality_label: label, stream_url: url, sort_order: sortOrder }
            });
            showToast('Quality "' + label + '" added', 'success');
            loadChannels();
            return;
        }

        if (action === 'remove-quality') {
            if (!confirm('Remove this quality? Users watching it will be disconnected.')) return;
            await adminFetch('/channels/' + btn.dataset.channelId + '/qualities/' + btn.dataset.qualityId, { method: 'DELETE' });
            showToast('Quality removed', 'success');
            loadChannels();
            return;
        }

        if (action === 'edit-quality') {
            var row = btn.closest('.quality-item, .stream-quality-row');
            row.querySelector('.quality-display').classList.add('hidden');
            row.querySelector('.quality-edit').classList.remove('hidden');
            row.querySelector('.edit-btn').classList.add('hidden');
            row.querySelector('.save-btn').classList.remove('hidden');
            row.querySelector('.cancel-btn').classList.remove('hidden');
            row.querySelector('.edit-label').focus();
            return;
        }

        if (action === 'save-quality') {
            var row = btn.closest('.quality-item, .stream-quality-row');
            var newLabel = row.querySelector('.edit-label').value.trim();
            var newUrl = row.querySelector('.edit-url').value.trim();
            var newSort = parseInt(row.querySelector('.edit-sort').value) || 0;
            if (!newLabel || !newUrl) {
                showToast('Label and URL required', 'error');
                return;
            }
            await adminFetch('/channels/' + btn.dataset.channelId + '/qualities/' + btn.dataset.qualityId, {
                method: 'PATCH',
                body: { quality_label: newLabel, stream_url: newUrl, sort_order: newSort }
            });
            showToast('Quality updated', 'success');
            loadChannels();
            return;
        }

        if (action === 'cancel-edit-quality') {
            var row = btn.closest('.quality-item, .stream-quality-row');
            row.querySelector('.quality-display').classList.remove('hidden');
            row.querySelector('.quality-edit').classList.add('hidden');
            row.querySelector('.edit-btn').classList.remove('hidden');
            row.querySelector('.save-btn').classList.add('hidden');
            row.querySelector('.cancel-btn').classList.add('hidden');
            return;
        }

        if (action === 'add-quality-stream') {
            var channelId = btn.dataset.id;
            var labelEl = document.getElementById('stream-add-label-' + channelId);
            var urlEl = document.getElementById('stream-add-url-' + channelId);
            var label = labelEl.value.trim();
            var url = urlEl.value.trim();
            if (!label || !url) {
                showToast('Label and URL required', 'error');
                return;
            }
            var ch = channels.find(function(c) { return c.id == channelId; });
            var sortOrder = ch && ch.qualities ? ch.qualities.length : 0;
            await adminFetch('/channels/' + channelId + '/qualities', {
                method: 'POST',
                body: { quality_label: label, stream_url: url, sort_order: sortOrder }
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
        await adminFetch('/channels/' + expiryEditChannelId, { method: 'PATCH', body: { link_expires_at: value } });
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
        }
    });

    usernameInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') passwordInput.focus(); });
    passwordInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') login(); });
    loginBtn.addEventListener('click', login);
    logoutBtn.addEventListener('click', logout);
    createChannelBtn.addEventListener('click', openCreateModal);
    emptyCreateBtn.addEventListener('click', openCreateModal);
    confirmCreateBtn.addEventListener('click', createChannel);

    init();
})();
