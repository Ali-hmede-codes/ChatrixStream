const { verifyToken } = require('../services/adminUser');

function adminAuth(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized — missing or invalid token' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = verifyToken(token);
    if (!decoded) {
        return res.status(401).json({ error: 'Unauthorized — invalid or expired token' });
    }

    req.adminUser = decoded;
    next();
}

function superAdminOnly(req, res, next) {
    if (!req.adminUser || req.adminUser.role !== 'superadmin') {
        return res.status(403).json({ error: 'Forbidden — superadmin access required' });
    }
    next();
}

module.exports = { adminAuth, superAdminOnly };
