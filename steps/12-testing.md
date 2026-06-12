# Step 12 — Testing & Final Polish

## What you do
End-to-end testing of all features, edge cases, security checks, and final polish.

## Depends on
All previous steps (01-11) — full system built

## Test Procedures

### 1. Admin Flow Test

```bash
# Start server
cd E:\ChatrixStream
node server.js
```

**In browser at `http://localhost:3000/admin`:**

| Test | Steps | Expected |
|------|-------|----------|
| Login | Enter wrong secret | 401, error shown |
| Login | Enter correct secret | Dashboard shown, stored in localStorage |
| Create channel | Name="Test", TTL=6, no expiry | Channel created with token |
| Add quality | SD + stream URL | Quality appears |
| Add quality | HD + stream URL | Quality appears |
| Add quality | Duplicate label "SD" | Error: duplicate not allowed |
| Generate codes | Count=5 | 5 codes shown, all "unused" |
| Regenerate link | Click button, confirm | New token, old URL returns 404 |
| Regenerate codes | Click button, confirm | Old codes gone, new batch |
| Delete quality | Remove "4K" | Quality gone, stream stops |
| Delete channel | Click button, confirm | Everything removed |
| Logout | Click logout | Redirected to login |

### 2. User Flow Test

**Prerequisites:** Create channel + qualities + generate 1 code via admin.

| Test | Steps | Expected |
|------|-------|----------|
| Landing page | Visit `/` | Code input form shown |
| Invalid code | Enter random text | Error: "Invalid code" |
| Already used code | Enter same code twice | Error: "Code already used" |
| Valid code | Enter generated code | Redirect to player, stream starts |
| Quality switch | Click HD button | Stream switches, brief loading |
| Quality switch | Click SD button | Stream switches back |
| Close & reopen | Close browser, reopen `/` | Auto-login, redirect to player |
| Session expiry | Wait for expiry (or set short TTL) | "Session expired" overlay, redirect to landing |
| Wrong channel | Visit player URL with wrong token | Error overlay |

### 3. Stream Proxy Test

```bash
# Test stream endpoint directly
# First: create channel, add quality, redeem code via API

# Get session token from redeem
curl.exe -s -X POST -H "Content-Type: application/json" -d "{\"code\":\"CS-XXXXXXX\"}" http://localhost:3000/api/auth/redeem

# Test stream with session token
curl.exe -s -H "X-Session-Token: stk-..." http://localhost:3000/channel/TOKEN/sd | Select-Object -First 3
```
Should return binary MPEG-TS data (garbled text = stream bytes).

```bash
# Test stream without session token (should fail)
curl.exe -s http://localhost:3000/channel/TOKEN/sd
```
Should return 403 `{ error: "No session token" }`.

```bash
# Test stream with wrong channel token (should fail)
curl.exe -s -H "X-Session-Token: stk-..." http://localhost:3000/channel/WRONGTOKEN/sd
```
Should return 404 `{ error: "Channel not found" }`.

```bash
# Test stream with session from different channel (should fail)
curl.exe -s -H "X-Session-Token: stk-OTHERCHANNEL..." http://localhost:3000/channel/TOKEN/sd
```
Should return 403 `{ error: "Session not valid for this channel" }`.

### 4. Rate Limiting Test

```bash
# Send 15 rapid requests to redeem endpoint
for ($i=1; $i -le 15; $i++) {
    $r = curl.exe -s -X POST -H "Content-Type: application/json" -d "{\"code\":\"CS-FAKE\"}" http://localhost:3000/api/auth/redeem
    Write-Output "Request $i: $r"
}
```
Should show first 10 returning error JSON, then 429 "Too many requests".

### 5. Cleanup Test

```bash
# Create a channel with short expiry (1 minute)
# Use admin API to create channel with link_expires_at set to 1 minute from now

# Wait 6 minutes (or modify cleanup interval to 10 seconds for testing)

# Check if channel is auto-deleted
curl.exe -s -H "X-Admin-Secret: SECRET" http://localhost:3000/api/admin/channels
```
Expired channel should not appear.

### 6. Performance Check

```bash
# With a working channel, test multiple concurrent stream connections

# Open 5 browser tabs simultaneously with valid sessions
# All should stream without lag

# Check server memory usage
# Should be minimal (under 50MB for 5 users)
```

### 7. Edge Cases

| Edge case | Test | Expected |
|-----------|------|----------|
| No qualities on channel | Generate code, redeem, visit player | Error: no qualities available |
| Channel with only 1 quality | Watch stream, quality bar shows 1 option | Works fine |
| Session token in query param | Use `?session=stk-...` instead of header | Stream works |
| Expired link + valid session | Set link expiry, try to stream | 403: channel link expired |
| Regenerate link while users watching | Users still have sessions | Sessions work, but users need new link URL to reach player page |
| Delete channel while users watching | Delete via admin | All users disconnected, sessions dead |
| Source stream goes down | Disconnect source URL | Auto-reconnect after 3s, players show loading |
| mpegts.js not supported | Visit player in very old browser | Error overlay: "Unsupported" |

## Final Polish Checklist

1. **Production CORS** — Change allowed origin from `localhost:3000` to `https://stream.chatrix.vip` only
2. **HTTPS** — Server must run behind HTTPS (use nginx reverse proxy or certbot)
3. **Admin secret** — Change from default to a strong 32+ character secret
4. **Session expiry notice** — Player shows warning when session expires within 30 min
5. **Mobile responsive** — Test on mobile browser, quality switcher accessible
6. **Error messages** — All user-facing errors are generic (no internal details leaked)
7. **Console logs** — No sensitive data in console.log (session tokens, source URLs)
8. **Cleanup interval** — Verify 5-min cleanup runs correctly
9. **Database file** — Ensure `database.sqlite` is not accessible via URL (outside public/)
10. **.env file** — Ensure `.env` is not committed to git (add to .gitignore)

## .gitignore (create this)

```
node_modules/
database.sqlite
.env
*.log
```

## Production Deployment Notes

- Use nginx as reverse proxy: HTTPS termination + static file caching
- Set `stream.chatrix.vip` DNS to server IP
- nginx config should proxy `/api/` and `/channel/` to Node.js
- nginx should serve `/admin/`, `/css/`, `/js/` static files directly (faster)
- Run Node.js with `NODE_ENV=production`
- Consider PM2 for process management: `pm2 start server.js --name chatrixstream`

---

**All 12 steps complete. The ChatrixStream platform is fully built.**
