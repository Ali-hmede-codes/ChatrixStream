function sessionAuth(db, validateSession) {
    return function(req, res, next) {
        const token = req.headers['x-session-token'] || req.query.session;
        if (!token) {
            return res.status(403).json({ error: 'Access denied: no session token' });
        }
        const result = validateSession(db, token);
        if (!result.valid) {
            return res.status(403).json({ error: result.error });
        }
        req.session = result;
        next();
    };
}

module.exports = sessionAuth;
