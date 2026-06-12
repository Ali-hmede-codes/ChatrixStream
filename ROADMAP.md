# ChatrixStream — Implementation Roadmap

## Execution Order

Follow these steps **in order**. Each step depends on the previous one.

| Step | File | What you build | Layer |
|------|------|----------------|-------|
| 01 | `steps/01-project-init.md` | package.json + deps + .env + folder structure | Setup |
| 02 | `steps/02-database.md` | SQLite schema + init.js + foreign keys + indexes | Backend |
| 03 | `steps/03-services.md` | codeGenerator.js + streamManager.js | Backend |
| 04 | `steps/04-middleware.md` | adminAuth.js + sessionAuth.js + rateLimiter.js | Backend |
| 05 | `steps/05-admin-routes.md` | Channel + quality + code + link + session management APIs | Backend |
| 06 | `steps/06-auth-routes.md` | Redeem invite code + validate session APIs | Backend |
| 07 | `steps/07-stream-routes.md` | Stream proxy endpoint `/channel/:token/:quality` | Backend |
| 08 | `steps/08-server.md` | Express server entry point + static files + cleanup task | Backend |
| 09 | `steps/09-landing-page.md` | index.html + style.css + app.js (auto-login + code entry) | Frontend |
| 10 | `steps/10-player-page.md` | player.html + player.js + mpegts.js + quality switcher | Frontend |
| 11 | `steps/11-admin-dashboard.md` | admin.html + admin.css + admin.js (full admin UI) | Frontend |
| 12 | `steps/12-testing.md` | Manual test procedures + edge cases + final polish | Testing |

## Important Rules for AI Implementation

1. **Read the step file completely before starting** — each step has exact file paths, code structure, and contracts
2. **Never skip a step** — later steps depend on earlier ones
3. **Verify each step** — each step has a "Verify" section with commands to run
4. **Follow exact file paths** — paths are specified in each step
5. **No comments in code** — unless explicitly requested
6. **Use exact dependencies listed** — don't add extra libraries
7. **Read PROJECT_PLAN.md** for full architecture context before starting any step
8. **Each step file is self-contained** — has all info needed to implement that step

## Quick Reference

- Full architecture: `PROJECT_PLAN.md`
- Database schema: `PROJECT_PLAN.md` → "Database Schema" section
- API endpoints: `PROJECT_PLAN.md` → "API Endpoints" section
- Security model: `PROJECT_PLAN.md` → "SECURITY" section
- Performance model: `PROJECT_PLAN.md` → "PERFORMANCE" section
