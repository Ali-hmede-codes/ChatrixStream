const express = require('express');
const { verifyPassword, generateToken } = require('../services/adminUser');

module.exports = function(db) {
    const router = express.Router();

    const getAdminByUsername = db.prepare('SELECT * FROM admin_users WHERE username = ?');

    router.post('/', (req, res) => {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' });
        }

        const admin = getAdminByUsername.get(username);
        if (!admin || !verifyPassword(password, admin.password)) {
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        const token = generateToken(admin);
        res.json({
            token,
            username: admin.username,
            role: admin.role
        });
    });

    return router;
};
