# Step 11 — Admin Dashboard

## What you build
Full admin dashboard UI for managing channels, qualities, invite codes, link regeneration, and sessions.

## Depends on
Step 08 (server with admin API endpoints)

## Files to create

### 1. `public/admin/admin.html`
### 2. `public/admin/css/admin.css`
### 3. `public/admin/js/admin.js`

---

### `public/admin/admin.html`

**Structure:**
```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ChatrixStream — Admin</title>
    <link rel="stylesheet" href="/css/style.css">
    <link rel="stylesheet" href="/admin/css/admin.css">
</head>
<body>
    <div id="admin-app">
        <!-- Login screen (enter admin secret) -->
        <div id="admin-login">
            <div class="container">
                <h1>ChatrixStream Admin</h1>
                <p class="subtitle">Enter your admin secret to continue</p>
                <input type="password" id="secret-input" placeholder="Admin Secret" autocomplete="off">
                <button id="login-btn">Login</button>
                <p id="login-error" class="error hidden"></p>
            </div>
        </div>

        <!-- Dashboard (shown after auth) -->
        <div id="dashboard" class="hidden">
            <header>
                <h2>ChatrixStream Admin</h2>
                <button id="logout-btn">Logout</button>
            </header>

            <!-- Create new channel -->
            <section id="create-channel">
                <h3>Create New Channel</h3>
                <div class="form-row">
                    <input type="text" id="new-channel-name" placeholder="Channel name">
                    <input type="number" id="new-channel-ttl" placeholder="Code TTL (hours)" value="6" min="1">
                    <input type="datetime-local" id="new-channel-expiry" placeholder="Link expiry (optional)">
                    <button id="create-channel-btn">Create Channel</button>
                </div>
            </section>

            <!-- Channels list -->
            <section id="channels-list">
                <h3>Channels</h3>
                <div id="channels-container"></div>
            </section>
        </div>
    </div>
    <script src="/admin/js/admin.js"></script>
</body>
</html>
```

---

### `public/admin/css/admin.css`

```css
/* Admin dashboard */
#admin-login .container {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 20px;
    gap: 16px;
}

#admin-login h1 {
    font-size: 2rem;
    font-weight: 700;
}

#secret-input {
    width: 100%;
    max-width: 400px;
    padding: 14px 18px;
    font-size: 1rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-primary);
    outline: none;
}

#login-btn {
    padding: 14px 28px;
    background: var(--accent);
    color: white;
    border: none;
    border-radius: var(--radius);
    cursor: pointer;
    font-weight: 600;
    width: 100%;
    max-width: 400px;
}

/* Dashboard */
#dashboard {
    padding: 24px;
    max-width: 1200px;
    margin: 0 auto;
}

header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 32px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border);
}

header h2 {
    font-size: 1.5rem;
}

#logout-btn {
    padding: 8px 16px;
    background: var(--bg-secondary);
    color: var(--text-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    cursor: pointer;
}

/* Forms */
.form-row {
    display: flex;
    gap: 12px;
    align-items: center;
    flex-wrap: wrap;
}

.form-row input {
    padding: 10px 14px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-primary);
    outline: none;
    min-width: 150px;
}

.form-row input:focus {
    border-color: var(--accent);
}

.form-row button {
    padding: 10px 20px;
    background: var(--accent);
    color: white;
    border: none;
    border-radius: var(--radius);
    cursor: pointer;
    font-weight: 600;
}

.form-row button:hover { background: var(--accent-hover); }

/* Channel cards */
.channel-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 20px;
    margin-bottom: 16px;
}

.channel-card h4 {
    font-size: 1.2rem;
    margin-bottom: 12px;
}

.channel-section {
    margin-top: 16px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
}

.channel-section h5 {
    font-size: 0.9rem;
    color: var(--text-secondary);
    margin-bottom: 8px;
}

/* Quality items */
.quality-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 0;
    flex-wrap: wrap;
}

.quality-item .label {
    font-weight: 600;
    color: var(--accent);
    text-transform: uppercase;
    min-width: 40px;
}

.quality-item .url {
    color: var(--text-secondary);
    font-size: 0.85rem;
    overflow: hidden;
    text-overflow: ellipsis;
}

.quality-item button {
    padding: 4px 10px;
    font-size: 0.75rem;
    background: var(--bg-secondary);
    color: var(--text-secondary);
    border: 1px solid var(--border);
    border-radius: 4px;
    cursor: pointer;
}

.quality-item button:hover { color: var(--text-primary); }
.quality-item .delete-btn { color: var(--error); }

/* Code items */
.code-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 0;
}

.code-item .code-text {
    font-weight: 600;
    font-size: 1rem;
    letter-spacing: 1px;
}

.code-item .status {
    font-size: 0.8rem;
    padding: 2px 8px;
    border-radius: 4px;
}

.code-item .status.unused { background: var(--success); color: white; }
.code-item .status.redeemed { background: var(--accent); color: white; }
.code-item .status.expired { background: var(--error); color: white; }

/* Buttons */
.btn-secondary {
    padding: 8px 16px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    cursor: pointer;
}

.btn-secondary:hover { border-color: var(--accent); }

.btn-danger {
    padding: 8px 16px;
    background: transparent;
    color: var(--error);
    border: 1px solid var(--error);
    border-radius: var(--radius);
    cursor: pointer;
}

.btn-danger:hover { background: var(--error); color: white; }

.link-display {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 8px;
}

.link-display .url {
    color: var(--accent);
    font-size: 0.95rem;
    word-break: break-all;
}
```

---

### `public/admin/js/admin.js`

**This file handles all admin operations via API calls:**

```javascript
(function() {
    const SECRET_KEY = 'chatrix_admin_secret';

    let adminSecret = '';
    let channels = [];

    // DOM
    const adminLogin = document.getElementById('admin-login');
    const dashboard = document.getElementById('dashboard');
    const secretInput = document.getElementById('secret-input');
    const loginBtn = document.getElementById('login-btn');
    const loginError = document.getElementById('login-error');
    const logoutBtn = document.getElementById('logout-btn');
    const createChannelBtn = document.getElementById('create-channel-btn');
    const channelsContainer = document.getElementById('channels-container');

    // Init: check for stored secret
    function init() {
        const stored = localStorage.getItem(SECRET_KEY);
        if (stored) {
            adminSecret = stored;
            validateAndShowDashboard();
        }
    }

    // Login
    async function login() {
        adminSecret = secretInput.value.trim();
        if (!adminSecret) return;

        loginBtn.disabled = true;
        try {
            const res = await fetch('/api/admin/channels', {
                headers: { 'X-Admin-Secret': adminSecret }
            });
            if (res.status === 200) {
                localStorage.setItem(SECRET_KEY, adminSecret);
                showDashboard();
                loadChannels();
            } else {
                loginError.textContent = 'Invalid admin secret';
                loginError.classList.remove('hidden');
                loginBtn.disabled = false;
            }
        } catch (e) {
            loginError.textContent = 'Connection error';
            loginError.classList.remove('hidden');
            loginBtn.disabled = false;
        }
    }

    // Validate stored secret
    async function validateAndShowDashboard() {
        try {
            const res = await fetch('/api/admin/channels', {
                headers: { 'X-Admin-Secret': adminSecret }
            });
            if (res.status === 200) {
                showDashboard();
                loadChannels();
            } else {
                localStorage.removeItem(SECRET_KEY);
                showLogin();
            }
        } catch (e) {
            showLogin();
        }
    }

    // API helper — all calls include admin secret header
    async function adminFetch(path, options = {}) {
        options.headers = {
            ...options.headers,
            'X-Admin-Secret': adminSecret,
            'Content-Type': 'application/json'
        };
        const res = await fetch('/api/admin' + path, options);
        return res.json();
    }

    // Load all channels
    async function loadChannels() {
        channels = await adminFetch('/channels');
        renderChannels();
    }

    // Render channels
    function renderChannels() {
        channelsContainer.innerHTML = '';
        if (channels.length === 0) {
            channelsContainer.innerHTML = '<p style="color: var(--text-secondary)">No channels yet. Create one above.</p>';
            return;
        }
        channels.forEach(ch => {
            const card = createChannelCard(ch);
            channelsContainer.appendChild(card);
        });
    }

    // Create channel card (most complex UI element)
    function createChannelCard(channel) {
        const card = document.createElement('div');
        card.className = 'channel-card';
        card.dataset.channelId = channel.id;

        card.innerHTML = `
            <h4>${channel.name}</h4>

            <div class="channel-section">
                <h5>Public Link</h5>
                <div class="link-display">
                    <span class="url">stream.chatrix.vip/channel/${channel.channel_token}</span>
                    <button class="btn-secondary" onclick="copyLink('${channel.channel_token}')">Copy</button>
                    <button class="btn-secondary" onclick="regenerateLink(${channel.id})">Regenerate Link</button>
                    ${channel.link_expires_at ? `<span style="color: var(--text-secondary); font-size: 0.85rem">Expires: ${formatDate(channel.link_expires_at)}</span>` : ''}
                    <button class="btn-secondary" onclick="changeLinkExpiry(${channel.id})">Change Expiry</button>
                </div>
            </div>

            <div class="channel-section" id="qualities-${channel.id}">
                <h5>Qualities</h5>
                <div id="qualities-list-${channel.id}"></div>
                <div class="form-row" style="margin-top: 8px">
                    <input type="text" id="add-quality-label-${channel.id}" placeholder="Label (sd, hd, 4k)">
                    <input type="text" id="add-quality-url-${channel.id}" placeholder="Stream URL">
                    <button onclick="addQuality(${channel.id})">Add Quality</button>
                </div>
            </div>

            <div class="channel-section" id="codes-${channel.id}">
                <h5>Invite Codes</h5>
                <div id="codes-list-${channel.id}" style="margin-bottom: 8px"></div>
                <div class="form-row">
                    <input type="number" id="gen-codes-count-${channel.id}" placeholder="Count" value="10" min="1" max="100" style="max-width: 80px">
                    <button onclick="generateCodes(${channel.id})">Generate Codes</button>
                    <button class="btn-danger" onclick="regenerateCodes(${channel.id})">Regenerate All Codes</button>
                </div>
            </div>

            <div class="channel-section" style="margin-top: 16px">
                <button class="btn-danger" onclick="deleteChannel(${channel.id})">Delete Channel</button>
            </div>
        `;

        // Load qualities and codes for this channel
        loadQualities(channel.id);
        loadCodes(channel.id);

        return card;
    }

    // Load qualities for a channel
    async function loadQualities(channelId) {
        // Fetch qualities from channel data or separate endpoint
        const channel = channels.find(c => c.id === channelId);
        const list = document.getElementById(`qualities-list-${channelId}`);
        if (!list) return;

        if (!channel.qualities || channel.qualities.length === 0) {
            list.innerHTML = '<p style="color: var(--text-secondary); font-size: 0.85rem">No qualities added</p>';
            return;
        }

        list.innerHTML = '';
        channel.qualities.forEach(q => {
            const item = document.createElement('div');
            item.className = 'quality-item';
            item.innerHTML = `
                <span class="label">${q.quality_label}</span>
                <span class="url">${q.stream_url}</span>
                <button onclick="removeQuality(${channelId}, ${q.id})" class="delete-btn">Delete</button>
            `;
            list.appendChild(item);
        });
    }

    // Load codes for a channel
    async function loadCodes(channelId) {
        const codes = await adminFetch(`/channels/${channelId}/codes`);
        const list = document.getElementById(`codes-list-${channelId}`);
        if (!list) return;

        if (codes.length === 0) {
            list.innerHTML = '<p style="color: var(--text-secondary); font-size: 0.85rem">No codes generated</p>';
            return;
        }

        list.innerHTML = '';
        codes.forEach(c => {
            const status = c.redeemed ? 'redeemed' : (new Date(c.expires_at) < new Date() ? 'expired' : 'unused');
            const item = document.createElement('div');
            item.className = 'code-item';
            item.innerHTML = `
                <span class="code-text">${c.code}</span>
                <span class="status ${status}">${status}</span>
                <span style="color: var(--text-secondary); font-size: 0.8rem">${formatDate(c.expires_at)}</span>
                <button onclick="revokeCode('${c.code}')" class="delete-btn" style="font-size: 0.75rem">Revoke</button>
            `;
            list.appendChild(item);
        });
    }

    // === Actions ===

    // Global functions (accessible from onclick in HTML)
    window.copyLink = function(token) {
        navigator.clipboard.writeText(`https://stream.chatrix.vip/channel/${token}`);
    };

    window.regenerateLink = async function(channelId) {
        if (!confirm('Regenerate link? The old link will stop working immediately.')) return;
        const result = await adminFetch(`/channels/${channelId}/regenerate-link`, { method: 'POST' });
        alert('New link: stream.chatrix.vip/channel/' + result.channel_token);
        loadChannels();
    };

    window.changeLinkExpiry = async function(channelId) {
        const expiry = prompt('Enter link expiry date (YYYY-MM-DDTHH:MM) or leave empty for never:');
        if (expiry === null) return;
        const body = expiry ? { link_expires_at: expiry } : { link_expires_at: null };
        await adminFetch(`/channels/${channelId}`, { method: 'PATCH', body: JSON.stringify(body) });
        loadChannels();
    };

    window.addQuality = async function(channelId) {
        const label = document.getElementById(`add-quality-label-${channelId}`).value.trim();
        const url = document.getElementById(`add-quality-url-${channelId}`).value.trim();
        if (!label || !url) return alert('Label and URL required');
        await adminFetch(`/channels/${channelId}/qualities`, {
            method: 'POST',
            body: JSON.stringify({ quality_label: label, stream_url: url })
        });
        loadChannels();
    };

    window.removeQuality = async function(channelId, qualityId) {
        if (!confirm('Remove this quality? Users watching it will be disconnected.')) return;
        await adminFetch(`/channels/${channelId}/qualities/${qualityId}`, { method: 'DELETE' });
        loadChannels();
    };

    window.generateCodes = async function(channelId) {
        const count = parseInt(document.getElementById(`gen-codes-count-${channelId}`).value) || 10;
        const codes = await adminFetch(`/channels/${channelId}/codes`, {
            method: 'POST',
            body: JSON.stringify({ count })
        });
        loadChannels();
        alert(`Generated ${codes.length} codes`);
    };

    window.regenerateCodes = async function(channelId) {
        if (!confirm('Regenerate ALL codes? Old codes and sessions will be invalidated.')) return;
        const count = parseInt(document.getElementById(`gen-codes-count-${channelId}`).value) || 10;
        const codes = await adminFetch(`/channels/${channelId}/regenerate-codes`, {
            method: 'POST',
            body: JSON.stringify({ count })
        });
        loadChannels();
        alert(`Regenerated ${codes.length} new codes. Old codes are now invalid.`);
    };

    window.revokeCode = async function(code) {
        if (!confirm('Revoke this code and its session?')) return;
        await adminFetch(`/codes/${code}`, { method: 'DELETE' });
        loadChannels();
    };

    window.deleteChannel = async function(channelId) {
        if (!confirm('Delete this channel? ALL qualities, codes, and sessions will be removed.')) return;
        await adminFetch(`/channels/${channelId}`, { method: 'DELETE' });
        loadChannels();
    };

    // Create channel
    async function createChannel() {
        const name = document.getElementById('new-channel-name').value.trim();
        const ttl = parseInt(document.getElementById('new-channel-ttl').value) || 6;
        const expiry = document.getElementById('new-channel-expiry').value || null;

        if (!name) return alert('Channel name required');

        await adminFetch('/channels', {
            method: 'POST',
            body: JSON.stringify({ name, code_ttl_hours: ttl, link_expires_at: expiry })
        });

        document.getElementById('new-channel-name').value = '';
        loadChannels();
    }

    // Utility
    function formatDate(dateStr) {
        if (!dateStr) return 'Never';
        return new Date(dateStr).toLocaleString();
    }

    // Show/hide
    function showLogin() {
        adminLogin.classList.remove('hidden');
        dashboard.classList.add('hidden');
    }

    function showDashboard() {
        adminLogin.classList.add('hidden');
        dashboard.classList.remove('hidden');
    }

    // Logout
    function logout() {
        localStorage.removeItem(SECRET_KEY);
        adminSecret = '';
        showLogin();
    }

    // Event listeners
    loginBtn.addEventListener('click', login);
    secretInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
    logoutBtn.addEventListener('click', logout);
    createChannelBtn.addEventListener('click', createChannel);

    // Init
    init();
})();
```

## Verify

1. Start server: `node server.js`
2. Open `http://localhost:3000/admin` in browser
3. Enter admin secret → should show dashboard
4. Create a channel → should appear in list with public link
5. Add quality (SD) with test stream URL → should appear under channel
6. Generate 5 invite codes → should show 5 codes with "unused" status
7. Copy link → clipboard should have `https://stream.chatrix.vip/channel/TOKEN`
8. Test regenerate link → new token, old link dead
9. Test regenerate codes → old codes gone, new batch generated
10. Logout → redirect to login screen
11. Re-enter secret → dashboard loads again (auto-auth via localStorage)

## Next step
→ `steps/12-testing.md`
