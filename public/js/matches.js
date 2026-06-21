document.addEventListener('DOMContentLoaded', () => {
    const matchesListEl = document.getElementById('matches-list');
    const loadingEl = document.getElementById('loading');
    const errorMsgEl = document.getElementById('error-msg');

    let isFirstLoad = true;
    let allMatches = [];
    let currentFilter = 'all';

    const filtersContainer = document.getElementById('matches-filters');
    const filterBtns = document.querySelectorAll('.filter-btn');

    filterBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            filterBtns.forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            currentFilter = e.target.getAttribute('data-filter');
            applyFilterAndRender();
        });
    });

    // Handle missing images globally to satisfy CSP
    document.addEventListener('error', function(e) {
        if (e.target.tagName && e.target.tagName.toLowerCase() === 'img') {
            e.target.style.display = 'none';
        }
    }, true);

    // Get today's date in YYYY-MM-DD
    const getTodayDate = () => {
        const today = new Date();
        const yyyy = today.getFullYear();
        const mm = String(today.getMonth() + 1).padStart(2, '0');
        const dd = String(today.getDate()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;
    };

    const fetchMatches = async () => {
        try {
            if (isFirstLoad) {
                loadingEl.classList.remove('hidden');
                errorMsgEl.classList.add('hidden');
            }

            const date = getTodayDate();
            const response = await fetch(`/api/matches/${date}`);
            
            if (!response.ok) {
                throw new Error('Failed to fetch matches data');
            }

            const data = await response.json();
            allMatches = data.matches || [];
            
            if (allMatches.length > 0) {
                filtersContainer.classList.remove('hidden');
            }
            
            applyFilterAndRender();
            
            if (isFirstLoad) {
                loadingEl.classList.add('hidden');
                isFirstLoad = false;
            }
        } catch (error) {
            console.error('Error:', error);
            if (isFirstLoad) {
                loadingEl.classList.add('hidden');
                errorMsgEl.textContent = 'تعذر تحميل المباريات. يرجى المحاولة لاحقاً.';
                errorMsgEl.classList.remove('hidden');
            }
        }
    };

    const applyFilterAndRender = () => {
        const now = new Date();
        const filtered = allMatches.filter(match => {
            if (currentFilter === 'all') return true;
            
            const matchDate = new Date(`${match.date}T${match.time}:00Z`);
            const diffMs = matchDate - now;
            const isLive = match.status == 1 || (match.status == 0 && diffMs <= 0);
            
            if (currentFilter === 'finished') {
                return match.status == 2;
            } else if (currentFilter === 'live') {
                return isLive && match.status != 2;
            } else if (currentFilter === 'not_started') {
                return match.status == 0 && diffMs > 0;
            }
            return true;
        });
        
        renderMatches(filtered);
    };

    const renderMatches = (matches) => {
        if (matches.length === 0) {
            matchesListEl.innerHTML = '<p style="text-align: center; color: var(--text-secondary);">لا توجد مباريات مطابقة للفلتر المحدد.</p>';
            return;
        }

        const now = new Date();
        let html = '';

        matches.forEach(match => {
            // Assume API time is UTC
            const matchDate = new Date(`${match.date}T${match.time}:00Z`);
            
            // Format time to 12-hour AM/PM local time
            const localTimeStr = matchDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });

            // Countdown logic
            const diffMs = matchDate - now;
            let countdownStr = '';
            let isLive = false;

            if (match.status == 0 && diffMs > 0) {
                const diffMins = Math.floor(diffMs / 60000);
                const hours = Math.floor(diffMins / 60);
                const mins = diffMins % 60;
                
                if (hours > 0) {
                    countdownStr = `تبدأ المباراة بعد ${hours}س ${mins}د`;
                } else {
                    countdownStr = `تبدأ المباراة بعد ${mins}د`;
                }
            } else if (match.status == 1 || (match.status == 0 && diffMs <= 0)) {
                // Approximate Live status if no explicit status=1 but time passed
                isLive = true;
            }

            let scoreDisplay = '-';
            if (match.score && match.score !== '-' && match.score !== '') {
                // Ensure the score order visually matches the DOM layout in RTL
                // DOM order (RTL visually): Away (Left) | Score | Home (Right)
                // So Score must be "AwayScore - HomeScore" if rendered LTR
                if (match.home_score !== undefined && match.away_score !== undefined && match.home_score.trim() !== '' && match.away_score.trim() !== '') {
                    scoreDisplay = `${match.away_score.trim()} - ${match.home_score.trim()}`;
                } else {
                    const parts = match.score.split('-');
                    if (parts.length === 2) {
                        scoreDisplay = `${parts[1].trim()} - ${parts[0].trim()}`;
                    } else {
                        scoreDisplay = match.score;
                    }
                }
            }

            let statusDisplay = '';
            if (match.status == 2) {
                statusDisplay = 'انتهت';
            } else if (isLive) {
                statusDisplay = '<span style="color: var(--error); display: flex; align-items: center; gap: 4px;"><span class="live-dot" style="background: var(--error); box-shadow: 0 0 8px var(--error); animation: livePulse 1.5s infinite;"></span> مباشر</span>';
            } else {
                statusDisplay = 'لم تبدأ';
            }

            const leagueLogoUrl = match.league_logo ? `https://cdn.kora-api.space/uploads/league/${match.league_logo}` : '';
            const homeLogoUrl = match.home_logo ? `https://cdn.kora-api.space/uploads/team/${match.home_logo}` : '';
            const awayLogoUrl = match.away_logo ? `https://cdn.kora-api.space/uploads/team/${match.away_logo}` : '';


            html += `
                <div class="match-card">
                    <div class="league-info">
                        ${match.league}
                    </div>
                    
                    <div class="match-team home">
                        <img src="${homeLogoUrl}" class="team-logo" alt="${match.home}">
                        <div class="team-name">${match.home}</div>
                    </div>

                    <div class="match-center">
                        <div class="match-time">${localTimeStr}</div>
                        <div class="match-score">${scoreDisplay}</div>
                        <div class="match-status">${statusDisplay}</div>
                        ${countdownStr ? `<div class="match-countdown">${countdownStr}</div>` : ''}
                    </div>

                    <div class="match-team away">
                        <img src="${awayLogoUrl}" class="team-logo" alt="${match.away}">
                        <div class="team-name">${match.away}</div>
                    </div>

                </div>
            `;
        });

        matchesListEl.innerHTML = html;
    };

    // Initial fetch
    fetchMatches();

    // Poll every 30 seconds
    setInterval(fetchMatches, 30000);
});
