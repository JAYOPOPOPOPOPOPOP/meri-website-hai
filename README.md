# DEV Website (Node.js + SQLite)

Exact replica of the original PHP DEV website, rewritten in **Node.js + Express + SQLite**.

- **No external database needed** — SQLite file is created automatically with all default data.
- Ready for **Railway.com** hosting.
- All features same: Home, Minecraft files, Discord files, Partners, Promotion, Admin panel, ranks, categories, custom pages, announcements, uploads, theme/branding, etc.

---

## Local Run

```bash
cd dev-website-node
npm install
npm start
```

Open http://localhost:3000

**Pehla register karne wala user automatically Owner (admin) ban jata hai.**

---

## Railway.com Deploy (Recommended)

### Method 1 — GitHub (easiest)

1. Is folder ko GitHub pe push karo (ya naya repo banao).
2. Railway.com → **New Project** → **Deploy from GitHub repo**.
3. Repo select karo.
4. Railway automatically detect karega Node.js.
5. Deploy ho jayega. Public URL mil jayegi.

### Method 2 — Railway CLI

```bash
npm i -g @railway/cli
railway login
railway init
railway up
```

### Important Railway Settings

| Setting | Value |
|---------|-------|
| **Start Command** | `npm start` |
| **Root Directory** | (project root) |
| **Port** | Railway automatically sets `PORT` |

### Persistent Storage (uploads + DB ke liye)

Railway free tier pe files restart pe wipe ho sakte hain. Persistent volume add karo:

1. Railway project → **Variables** / **Volumes**
2. Volume mount path: `/app/data` (for DB) and optionally `/app/public/uploads`
3. Ya simply ye environment variables set karo:

```
DB_PATH=/app/data/dev.db
UPLOAD_DIR=/app/public/uploads
SESSION_SECRET=koi-random-strong-secret-string
```

Volume create karke `/app/data` mount kar dena best hai taaki database + uploads save rahein.

---

## Environment Variables (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `DB_PATH` | `./data/dev.db` | SQLite file path |
| `UPLOAD_DIR` | `./public/uploads` | Uploaded files folder |
| `SESSION_SECRET` | (built-in) | Session encryption key — **change in production** |
| `NODE_ENV` | — | Set to `production` on Railway |

---

## Features (same as original)

- Branding (logo, site name, emoji, favicon)
- Theme colors
- Home hero + feature cards
- Minecraft files (upload / external link + categories)
- Discord files
- Partners
- Promotion (MC server status via mcsrvstat + Discord promo)
- Custom pages
- Announcements bar
- Navigation labels
- User ranks: member / staff / admin / owner
- Private categories (staff+)
- File download handler
- Maintenance mode
- SEO settings

---

## First Time Setup

1. Site open karo
2. **Register** button se account banao → pehla user **Owner** ban jayega
3. Admin panel se sab edit kar sakte ho

Kuch extra data dene ki zarurat nahi — default settings, categories aur theme already loaded hain.
