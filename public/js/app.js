(function() {
    const SESSION_KEY = 'chatrix_session';

    const loading = document.getElementById('loading');
    const loadingText = document.getElementById('loading-text');
    const codeForm = document.getElementById('code-form');
    const codeInput = document.getElementById('code-input');
    const watchBtn = document.getElementById('watch-btn');
    const errorMsg = document.getElementById('error-msg');

    // Detect if we're on a /channel/:token page
    var channelTokenFromUrl = null;
    var pathParts = window.location.pathname.split('/');
    if (pathParts.length >= 3 && pathParts[1] === 'channel') {
        channelTokenFromUrl = pathParts[2];
    }

    function getViewerId() {
        let viewerId = localStorage.getItem('chatrix_viewer_id');
        if (!viewerId) {
            viewerId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : 'vid-' + Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
            localStorage.setItem('chatrix_viewer_id', viewerId);
        }
        return viewerId;
    }

    async function init() {
        const session = localStorage.getItem(SESSION_KEY);
        if (session) {
            showLoading();
            try {
                const data = JSON.parse(session);
                const res = await fetch('/api/auth/session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ session_token: data.session_token, viewer_id: getViewerId() })
                });
                const result = await res.json();
                if (result.valid) {
                    localStorage.setItem(SESSION_KEY, JSON.stringify({
                        session_token: data.session_token,
                        channel_token: result.channel_token
                    }));
                    window.location.href = '/player/' + result.channel_token;
                    return;
                }
            } catch (e) {}
            localStorage.removeItem(SESSION_KEY);
        }

        if (channelTokenFromUrl) {
            showLoading();
            try {
                const res = await fetch('/api/auth/direct/' + channelTokenFromUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ viewer_id: getViewerId() })
                });
                const result = await res.json();

                if (result.session_token) {
                    localStorage.setItem(SESSION_KEY, JSON.stringify({
                        session_token: result.session_token,
                        channel_token: result.channel_token
                    }));
                    window.location.href = '/player/' + result.channel_token;
                    return;
                }

                if (result.error === 'This channel requires an invite code') {
                    showCodeForm();
                    var subtitle = document.querySelector('.subtitle');
                    if (subtitle) {
                        subtitle.textContent = 'Enter your invite code to start watching';
                    }
                    return;
                }

                showCodeForm();
                showError(result.error || 'Channel not available');
                return;
            } catch (e) {
                showCodeForm();
                showError('Connection error. Please try again.');
                return;
            }
        }

        // No channel token in URL — try to find free-access channels
        try {
            const res = await fetch('/api/auth/free-channels');
            const freeChannels = await res.json();

            if (freeChannels && freeChannels.length > 0) {
                // Auto-redirect to the first free-access channel
                window.location.href = '/channel/' + freeChannels[0].channel_token;
                return;
            }
        } catch (e) {}

        showCodeForm();
    }

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
                body: JSON.stringify({ code: code, viewer_id: getViewerId() })
            });
            const result = await res.json();

            if (result.session_token) {
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

    watchBtn.addEventListener('click', redeemCode);
    codeInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') redeemCode();
    });
    codeInput.addEventListener('input', function(e) {
        let val = e.target.value.toUpperCase();
        
        if (val === '') return;
        
        if (val === 'C' || val === 'CS' || val === 'CS-') {
            e.target.value = val;
            return;
        }

        let codePart = val;
        
        // Remove 'CS-' from the beginning, as many times as it appears (e.g., if user pastes 'CS-...' after 'CS-')
        while (codePart.startsWith('CS-')) {
            codePart = codePart.substring(3);
        }

        let finalVal = 'CS-' + codePart;
        
        // Enforce the max length of 10 manually
        if (finalVal.length > 10) {
            finalVal = finalVal.substring(0, 10);
        }
        
        e.target.value = finalVal;
    });

    init();
})();
