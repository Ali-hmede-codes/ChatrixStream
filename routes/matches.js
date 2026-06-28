const express = require('express');
const router = express.Router();

const CACHE_TTL_MS = 60000;
const cache = new Map();

router.get('/:date', async (req, res) => {
    try {
        const { date } = req.params;
        // Validate date format YYYY-MM-DD
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ error: 'Invalid date format. Expected YYYY-MM-DD.' });
        }

        const now = Date.now();
        const cached = cache.get(date);
        if (cached && now - cached.timestamp < CACHE_TTL_MS) {
            return res.json(cached.data);
        }

        const apiUrl = `https://ws.kora-api.space/api/matches/${date}/ar`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        try {
            const response = await fetch(apiUrl, { signal: controller.signal });
            if (!response.ok) {
                throw new Error(`External API responded with status ${response.status}`);
            }
            const data = await response.json();
            cache.set(date, { data, timestamp: now });
            res.json(data);
        } finally {
            clearTimeout(timeout);
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            console.error('Error fetching matches: request timed out');
            return res.status(504).json({ error: 'External matches API timed out.' });
        }
        console.error('Error fetching matches:', error.message);
        res.status(500).json({ error: 'Failed to fetch matches data.' });
    }
});

module.exports = router;
