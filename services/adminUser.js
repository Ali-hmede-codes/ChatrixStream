const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'chatrix_jwt_secret_key_2026';
const JWT_EXPIRES_IN = '24h';

function hashPassword(password) {
    return bcrypt.hashSync(password, 10);
}

function verifyPassword(password, hash) {
    return bcrypt.compareSync(password, hash);
}

function generateToken(adminUser) {
    return jwt.sign(
        { id: adminUser.id, username: adminUser.username, role: adminUser.role },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
    );
}

function verifyToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (e) {
        return null;
    }
}

function seedAdminUsers(db) {
    const count = db.prepare('SELECT COUNT(*) as count FROM admin_users').get();
    if (count.count > 0) return;

    const insert = db.prepare('INSERT INTO admin_users (username, password, role) VALUES (?, ?, ?)');

    const admins = [
        { username: 'superadmin', password: 'SuperAdmin@2026', role: 'superadmin' },
        { username: 'admin1', password: 'AdminOne@2026', role: 'admin' },
        { username: 'admin2', password: 'AdminTwo@2026', role: 'admin' },
        { username: 'admin3', password: 'AdminThree@2026', role: 'admin' },
        { username: 'moderator', password: 'Moderator@2026', role: 'moderator' }
    ];

    const transaction = db.transaction(() => {
        for (const admin of admins) {
            insert.run(admin.username, hashPassword(admin.password), admin.role);
        }
    });

    transaction();
    console.log('Seeded 5 admin users: superadmin, admin1, admin2, admin3, moderator');
}

module.exports = { hashPassword, verifyPassword, generateToken, verifyToken, seedAdminUsers };
