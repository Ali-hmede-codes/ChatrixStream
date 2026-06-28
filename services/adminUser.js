const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error('FATAL: JWT_SECRET environment variable is required. Set a strong random value in .env.');
    process.exit(1);
}
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

    const superadminPassword = process.env.ADMIN_SUPERADMIN_PASSWORD || crypto.randomBytes(12).toString('base64url');

    const admins = [
        { username: 'superadmin', password: superadminPassword, role: 'superadmin' }
    ];

    const transaction = db.transaction(() => {
        for (const admin of admins) {
            insert.run(admin.username, hashPassword(admin.password), admin.role);
        }
    });

    transaction();
    if (process.env.ADMIN_SUPERADMIN_PASSWORD) {
        console.log('Seeded 1 admin user (superadmin) with password from ADMIN_SUPERADMIN_PASSWORD env var.');
    } else {
        console.log('========================================================');
        console.log('Seeded 1 admin user with a randomly generated password:');
        console.log('  username: superadmin');
        console.log('  password: ' + superadminPassword);
        console.log('Change this immediately after first login.');
        console.log('Set ADMIN_SUPERADMIN_PASSWORD in .env to control this.');
        console.log('========================================================');
    }
}

module.exports = { hashPassword, verifyPassword, generateToken, verifyToken, seedAdminUsers };
