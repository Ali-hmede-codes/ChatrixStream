# Step 01 — Project Initialization

## What you build
Project folder structure, package.json with all dependencies, .env configuration file.

## Files to create

### 1. `package.json`
```json
{
  "name": "chatrixstream",
  "version": "1.0.0",
  "description": "Live stream restream platform with invite code authentication",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js"
  },
  "dependencies": {
    "express": "^4.21.0",
    "better-sqlite3": "^11.7.0",
    "dotenv": "^16.4.0",
    "crypto": "built-in",
    "follow-redirects": "^1.15.0",
    "cors": "^2.8.5"
  }
}
```

### 2. `.env`
```
PORT=3000
ADMIN_SECRET=ChatrixAdmin2026SecretKey32Chars!
DB_PATH=./db/database.sqlite
DEFAULT_CODE_TTL_HOURS=6
DEFAULT_LINK_EXPIRY_HOURS=24
MAX_CODES_PER_GENERATION=100
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=10
STREAM_HIGH_WATER_MARK=1048576
STREAM_IDLE_TIMEOUT_MS=30000
STREAM_RECONNECT_DELAY_MS=3000
```

### 3. Folder structure
Create these empty directories:
```
E:\ChatrixStream\
├── db/
├── routes/
├── services/
├── middleware/
├── public/
│   ├── css/
│   ├── js/
│   └── admin/
│       ├── css/
│       └── js/
```

## Commands to run

```bash
cd E:\ChatrixStream
npm install
```

## Verify
- `npm install` completes without errors
- `node -e "require('express'); require('better-sqlite3'); require('dotenv'); console.log('OK')"` prints OK
- All directories exist
- `.env` file exists with all variables

## Next step
→ `steps/02-database.md`
