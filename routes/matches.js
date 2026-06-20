const express = require('express');
const router = express.Router();

router.get('/:date', async (req, res) => {
    try {
        const { date } = req.params;
        // Validate date format YYYY-MM-DD
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ error: 'Invalid date format. Expected YYYY-MM-DD.' });
        }

        const apiUrl = `https://ws.kora-api.space/api/matches/${date}/ar`;
        const response = await fetch(apiUrl);
        
        if (!response.ok) {
            throw new Error(`External API responded with status ${response.status}`);
        }

        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error('Error fetching matches:', error.message);
        res.status(500).json({ error: 'Failed to fetch matches data.' });
    }
});

module.exports = router;
