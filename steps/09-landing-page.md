# Step 09 — Landing Page (auto-login + code entry)

## What you build
The landing page where users either auto-login (if they have a session) or enter an invite code.

## Depends on
Step 08 (server running with auth endpoints)

## Files to create

### 1. `public/index.html`
### 2. `public/css/style.css`
### 3. `public/js/app.js`

---

### `public/index.html`

**Structure:**
```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ChatrixStream</title>
    <link rel="stylesheet" href="/css/style.css">
</head>
<body>
    <div id="app">
        <!-- Auto-login spinner (shown while checking session) -->
        <div id="loading" class="hidden">
            <div class="spinner"></div>
            <p>Checking your session...</p>
        </div>

        <!-- Code entry form (shown when no valid session) -->
        <div id="code-form">
            <div class="container">
                <h1>ChatrixStream</h1>
                <p class="subtitle">Enter your invite code to start watching</p>
                <div class="input-group">
                    <input type="text" id="code-input" placeholder="CS-XXXXXXX"
                           maxlength="10" autocomplete="off" spellcheck="false">
                    <button id="watch-btn">Watch</button>
                </div>
                <p id="error-msg" class="error hidden"></p>
            </div>
        </div>
    </div>
    <script src="/js/app.js"></script>
</body>
</html>
```

---

### `public/css/style.css`

**Global styles — dark theme, used by ALL pages (landing, player, admin):**

```css
/* Base */
:root {
    --bg-primary: #0a0a0f;
    --bg-secondary: #141420;
    --bg-card: #1a1a2e;
    --text-primary: #e0e0e0;
    --text-secondary: #888;
    --accent: #6c5ce7;
    --accent-hover: #7c6cf7;
    --error: #e74c3c;
    --success: #2ecc71;
    --border: #2a2a3e;
    --radius: 8px;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg-primary);
    color: var(--text-primary);
    min-height: 100vh;
}

.hidden { display: none !important; }

/* Landing page */
#code-form .container {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 20px;
}

#code-form h1 {
    font-size: 2.5rem;
    font-weight: 700;
    margin-bottom: 8px;
}

#code-form .subtitle {
    color: var(--text-secondary);
    margin-bottom: 32px;
}

.input-group {
    display: flex;
    gap: 12px;
    width: 100%;
    max-width: 400px;
}

#code-input {
    flex: 1;
    padding: 14px 18px;
    font-size: 1.1rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-primary);
    outline: none;
    text-transform: uppercase;
}

#code-input:focus {
    border-color: var(--accent);
}

#watch-btn {
    padding: 14px 28px;
    font-size: 1.1rem;
    background: var(--accent);
    color: white;
    border: none;
    border-radius: var(--radius);
    cursor: pointer;
    font-weight: 600;
}

#watch-btn:hover { background: var(--accent-hover); }
#watch-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.error {
    color: var(--error);
    margin-top: 16px;
    text-align: center;
    max-width: 400px;
}

/* Spinner */
.spinner {
    width: 40px;
    height: 40px;
    border: 3px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
}

@keyframes spin { to { transform: rotate(360deg); } }

#loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    gap: 16px;
}

/* Player page styles (added later) */
/* Admin page styles (added later) */
```

---

### `public/js/app.js`

**Logic — auto-login + code entry:**

```javascript
(function() {
    const SESSION_KEY = 'chatrix_session';

    // DOM elements
    const loading = document.getElementById('loading');
    const codeForm = document.getElementById('code-form');
    const codeInput = document.getElementById('code-input');
    const watchBtn = document.getElementById('watch-btn');
    const errorMsg = document.getElementById('error-msg');

    // On page load: check for existing session (auto-login)
    async function init() {
        const session = localStorage.getItem(SESSION_KEY);
        if (session) {
            showLoading();
            try {
                const data = JSON.parse(session);
                const res = await fetch('/api/auth/session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ session_token: data.session_token })
                });
                const result = await res.json();
                if (result.valid) {
                    // Session valid → redirect to player
                    window.location.href = '/player/' + result.channel_token;
                    return;
                }
            } catch (e) {
                // Network error or invalid → clear and show form
            }
            // Session invalid/expired → clear storage
            localStorage.removeItem(SESSION_KEY);
        }
        showCodeForm();
    }

    // Watch button click → redeem invite code
    async function redeemCode() {
        const code = codeInput.value.trim().toUpperCase();
        if (!code) {
            showError('Please enter an invite code');
            return;
        }

        watchBtn.disabled = true;
        errorMsg.classList.add('hidden');

        try {
            const res = await fetch('/api/auth/redeem', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code: code })
            });
            const result = await res.json();

            if (result.session_token) {
                // Success → store session and redirect
                localStorage.setItem(SESSION_KEY, JSON.stringify({
                    session_token: result.session_token,
                    channel_token: result.channel_token
                }));
                window.location.href = '/player/' + result.channel_token;
            } else {
                showError(result.error || 'Invalid code');
                watchBtn.disabled = false;
            }
        } catch (e) {
            showError('Connection error. Please try again.');
            watchBtn.disabled = false;
        }
    }

    function showLoading() {
        loading.classList.remove('hidden');
        codeForm.classList.add('hidden');
    }

    function showCodeForm() {
        loading.classList.add('hidden');
        codeForm.classList.remove('hidden');
    }

    function showError(msg) {
        errorMsg.textContent = msg;
        errorMsg.classList.remove('hidden');
    }

    // Event listeners
    watchBtn.addEventListener('click', redeemCode);
    codeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') redeemCode();
    });

    // Init on load
    init();
})();
```

## Verify

Start server: `node server.js`

Open browser: `http://localhost:3000`

1. **Should show code entry form** (no existing session)
2. Enter a valid invite code → should redirect to player page (404 for now since player.html not yet built — that's OK)
3. Check `localStorage` in browser DevTools → should have `chatrix_session` with session_token
4. Refresh page → should briefly show "Checking your session..." spinner → then redirect (or show form if session invalid)

## Next step
→ `steps/10-player-page.md`
