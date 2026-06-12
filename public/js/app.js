(function() {
    const SESSION_KEY = 'chatrix_session';

    const loading = document.getElementById('loading');
    const codeForm = document.getElementById('code-form');
    const codeInput = document.getElementById('code-input');
    const watchBtn = document.getElementById('watch-btn');
    const errorMsg = document.getElementById('error-msg');

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
                body: JSON.stringify({ code: code })
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

    init();
})();
