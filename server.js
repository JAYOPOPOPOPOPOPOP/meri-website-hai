const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { db, UPLOAD_DIR } = require('./src/db');
const SQLiteStore = require('./src/session-store');
const updater = require('./src/updater');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

// Railway / reverse proxy ke liye zaroori
app.set('trust proxy', 1);

// ---- Middleware ----
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.urlencoded({ extended: true, limit: '55mb' }));
app.use(express.json({ limit: '55mb' }));
app.use(session({
  store: new SQLiteStore(db),
  secret: process.env.SESSION_SECRET || 'dev-website-secret-change-me-in-prod',
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  }
}));

// Serve static files (frontend + uploads)
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, 'public')));

// Multer for uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const base = path.basename(file.originalname, ext).replace(/[^a-z0-9_\-]/gi, '_');
    cb(null, `${base}_${Date.now()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE }
});

// ---- Helpers ----
function json(res, data, code = 200) {
  res.status(code).json(data);
}

function getLoggedUser(req) {
  return req.session.user || null;
}

function getRankLevel(rank) {
  const levels = { member: 0, staff: 1, admin: 2, owner: 3 };
  return levels[rank] ?? 0;
}

function isAdmin(req) {
  const u = getLoggedUser(req);
  return u && (u.is_admin == 1 || getRankLevel(u.rank || 'member') >= 2);
}

function isStaff(req) {
  const u = getLoggedUser(req);
  return u && (u.is_admin == 1 || getRankLevel(u.rank || 'member') >= 1);
}

function isOwner(req) {
  const u = getLoggedUser(req);
  return u && getRankLevel(u.rank || 'member') >= 3;
}

function requireAdmin(req, res) {
  if (!isAdmin(req)) {
    json(res, { error: 'Unauthorized - Admin required' }, 401);
    return false;
  }
  return true;
}

function requireStaff(req, res) {
  if (!isStaff(req)) {
    json(res, { error: 'Unauthorized - Staff required' }, 401);
    return false;
  }
  return true;
}

function formatFilesize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let i = 0;
  while (size >= 1024 && i < 3) { size /= 1024; i++; }
  return Math.round(size * 100) / 100 + ' ' + units[i];
}

function handleUpload(file) {
  if (!file) return { filename: null, filesize: null };
  return { filename: file.filename, filesize: formatFilesize(file.size) };
}

// ---- API Router (handles both /api and /api/index.php style) ----
function apiHandler(req, res) {
  const action = req.query.action || req.body.action || '';

  try {
    switch (action) {
      // ========== DEBUG ==========
      case 'whoami': {
        const u = getLoggedUser(req);
        return json(res, {
          logged_in: !!u,
          user: u,
          isAdmin: isAdmin(req),
          isStaff: isStaff(req),
          sessionID: req.sessionID
        });
      }

      // ========== SETTINGS ==========
      case 'get_settings': {
        const rows = db.prepare('SELECT skey, svalue FROM settings').all();
        const settings = {};
        for (const r of rows) settings[r.skey] = r.svalue;
        return json(res, settings);
      }

      case 'save_setting': {
        if (!requireAdmin(req, res)) return;
        const key = (req.body.key || '').trim();
        const val = req.body.value ?? '';
        if (!key) return json(res, { error: 'Key required' }, 400);
        db.prepare('INSERT INTO settings (skey, svalue) VALUES (?, ?) ON CONFLICT(skey) DO UPDATE SET svalue = excluded.svalue')
          .run(key, val);
        return json(res, { ok: true });
      }

      // ========== AUTH ==========
      case 'register': {
        const username = (req.body.username || '').trim();
        const email = (req.body.email || '').trim();
        const password = req.body.password || '';
        if (!username || !email || !password) return json(res, { error: 'Sabhi fields required' }, 400);
        if (password.length < 4) return json(res, { error: 'Password min 4 chars' }, 400);

        const exists = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
        if (exists) return json(res, { error: 'Username ya email already exists!' }, 400);

        const count = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
        const isAdminVal = count === 0 ? 1 : 0;
        const rank = count === 0 ? 'owner' : 'member';
        const hash = bcrypt.hashSync(password, 10);

        const info = db.prepare('INSERT INTO users (username, email, password, is_admin, rank) VALUES (?, ?, ?, ?, ?)')
          .run(username, email, hash, isAdminVal, rank);

        // Auto-login after register
        const newUser = {
          id: info.lastInsertRowid,
          username,
          email,
          is_admin: isAdminVal,
          rank,
          created_at: new Date().toISOString()
        };
        req.session.user = newUser;

        return json(res, {
          ok: true,
          is_admin: isAdminVal,
          rank,
          user: newUser,
          message: isAdminVal ? 'Owner account created!' : 'Account created!'
        });
      }

      case 'login': {
        const username = (req.body.username || '').trim();
        const password = req.body.password || '';
        if (!username || !password) return json(res, { error: 'Fields required' }, 400);

        const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
        if (!user || !bcrypt.compareSync(password, user.password)) {
          return json(res, { error: 'Galat username ya password!' }, 401);
        }
        const { password: _, ...safeUser } = user;
        req.session.user = safeUser;
        return json(res, { ok: true, user: safeUser });
      }

      case 'logout': {
        req.session.destroy(() => {});
        return json(res, { ok: true });
      }

      case 'check_session': {
        const u = getLoggedUser(req);
        if (u) {
          const fresh = db.prepare('SELECT id, username, email, is_admin, rank, created_at FROM users WHERE id = ?').get(u.id);
          if (fresh) {
            req.session.user = fresh;
            return json(res, { user: fresh });
          }
        }
        return json(res, { user: null });
      }

      // ========== CATEGORIES ==========
      case 'get_categories': {
        const type = req.query.type || '';
        const showPrivate = isStaff(req);
        let rows;
        if (type) {
          if (showPrivate) {
            rows = db.prepare('SELECT * FROM categories WHERE type = ? ORDER BY sort_order, id').all(type);
          } else {
            rows = db.prepare('SELECT * FROM categories WHERE type = ? AND is_private = 0 ORDER BY sort_order, id').all(type);
          }
        } else {
          if (showPrivate) {
            rows = db.prepare('SELECT * FROM categories ORDER BY type, sort_order, id').all();
          } else {
            rows = db.prepare('SELECT * FROM categories WHERE is_private = 0 ORDER BY type, sort_order, id').all();
          }
        }
        return json(res, rows);
      }

      case 'add_category': {
        if (!requireStaff(req, res)) return;
        const type = (req.body.type || '').trim();
        const label = (req.body.label || '').trim();
        const icon = (req.body.icon || '📁').trim();
        let slug = (req.body.slug || label).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
        const isPrivate = parseInt(req.body.is_private || 0, 10);
        if (!type || !label || !slug) return json(res, { error: 'Type, label aur slug required' }, 400);
        if (!['mc', 'dc'].includes(type)) return json(res, { error: 'Type mc ya dc hona chahiye' }, 400);
        if (!isAdmin(req) && !isPrivate) return json(res, { error: 'Staff sirf private categories create kar sakta hai!' }, 403);

        const exists = db.prepare('SELECT id FROM categories WHERE type = ? AND slug = ?').get(type, slug);
        if (exists) return json(res, { error: 'Yeh category already exists!' }, 400);

        const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM categories WHERE type = ?').get(type);
        const order = ((maxOrder && maxOrder.m) || 0) + 1;

        const info = db.prepare('INSERT INTO categories (type, slug, label, icon, sort_order, is_private) VALUES (?, ?, ?, ?, ?, ?)')
          .run(type, slug, label, icon, order, isPrivate);
        return json(res, { ok: true, id: info.lastInsertRowid, slug, is_private: isPrivate });
      }

      case 'delete_category': {
        if (!requireStaff(req, res)) return;
        const id = parseInt(req.body.id || 0, 10);
        const catRow = db.prepare('SELECT type, slug FROM categories WHERE id = ?').get(id);
        if (catRow) {
          const tbl = catRow.type === 'mc' ? 'mc_files' : 'dc_files';
          const count = db.prepare(`SELECT COUNT(*) as c FROM ${tbl} WHERE category = ?`).get(catRow.slug).c;
          if (count > 0) return json(res, { error: 'Pehle is category ki sabhi files delete karein!' }, 400);
        }
        db.prepare('DELETE FROM categories WHERE id = ?').run(id);
        return json(res, { ok: true });
      }

      // ========== MC FILES ==========
      case 'get_mc_files': {
        const cat = req.query.category || '';
        const showPrivate = isStaff(req);
        let rows;
        if (cat && cat !== 'all') {
          if (!showPrivate) {
            const catCheck = db.prepare("SELECT is_private FROM categories WHERE type = 'mc' AND slug = ?").get(cat);
            if (catCheck && catCheck.is_private) return json(res, []);
          }
          rows = db.prepare('SELECT * FROM mc_files WHERE category = ? ORDER BY id DESC').all(cat);
        } else {
          if (showPrivate) {
            rows = db.prepare('SELECT * FROM mc_files ORDER BY id DESC').all();
          } else {
            rows = db.prepare(`
              SELECT f.* FROM mc_files f
              JOIN categories c ON c.type = 'mc' AND c.slug = f.category
              WHERE c.is_private = 0
              ORDER BY f.id DESC
            `).all();
          }
        }
        return json(res, rows);
      }

      case 'add_mc_file': {
        if (!requireAdmin(req, res)) return;
        const cat = (req.body.category || '').trim();
        const name = (req.body.name || '').trim();
        const desc = (req.body.description || '').trim();
        const link = (req.body.link || '').trim();
        if (!cat || !name) return json(res, { error: 'Category and name required' }, 400);

        const { filename, filesize } = handleUpload(req.file);
        const info = db.prepare('INSERT INTO mc_files (category, name, description, filename, link, filesize) VALUES (?, ?, ?, ?, ?, ?)')
          .run(cat, name, desc, filename, link, filesize);
        return json(res, { ok: true, id: info.lastInsertRowid });
      }

      case 'delete_mc_file': {
        if (!requireAdmin(req, res)) return;
        const id = parseInt(req.body.id || 0, 10);
        const row = db.prepare('SELECT filename FROM mc_files WHERE id = ?').get(id);
        if (row && row.filename) {
          const p = path.join(UPLOAD_DIR, row.filename);
          if (fs.existsSync(p)) fs.unlinkSync(p);
        }
        db.prepare('DELETE FROM mc_files WHERE id = ?').run(id);
        return json(res, { ok: true });
      }

      // ========== DC FILES ==========
      case 'get_dc_files': {
        const cat = req.query.category || '';
        const showPrivate = isStaff(req);
        let rows;
        if (cat && cat !== 'all') {
          if (!showPrivate) {
            const catCheck = db.prepare("SELECT is_private FROM categories WHERE type = 'dc' AND slug = ?").get(cat);
            if (catCheck && catCheck.is_private) return json(res, []);
          }
          rows = db.prepare('SELECT * FROM dc_files WHERE category = ? ORDER BY id DESC').all(cat);
        } else {
          if (showPrivate) {
            rows = db.prepare('SELECT * FROM dc_files ORDER BY id DESC').all();
          } else {
            rows = db.prepare(`
              SELECT f.* FROM dc_files f
              JOIN categories c ON c.type = 'dc' AND c.slug = f.category
              WHERE c.is_private = 0
              ORDER BY f.id DESC
            `).all();
          }
        }
        return json(res, rows);
      }

      case 'add_dc_file': {
        if (!requireAdmin(req, res)) return;
        const cat = (req.body.category || '').trim();
        const name = (req.body.name || '').trim();
        const desc = (req.body.description || '').trim();
        const link = (req.body.link || '').trim();
        if (!cat || !name) return json(res, { error: 'Category and name required' }, 400);

        const { filename, filesize } = handleUpload(req.file);
        const info = db.prepare('INSERT INTO dc_files (category, name, description, filename, link, filesize) VALUES (?, ?, ?, ?, ?, ?)')
          .run(cat, name, desc, filename, link, filesize);
        return json(res, { ok: true, id: info.lastInsertRowid });
      }

      case 'delete_dc_file': {
        if (!requireAdmin(req, res)) return;
        const id = parseInt(req.body.id || 0, 10);
        const row = db.prepare('SELECT filename FROM dc_files WHERE id = ?').get(id);
        if (row && row.filename) {
          const p = path.join(UPLOAD_DIR, row.filename);
          if (fs.existsSync(p)) fs.unlinkSync(p);
        }
        db.prepare('DELETE FROM dc_files WHERE id = ?').run(id);
        return json(res, { ok: true });
      }

      // ========== PAGES ==========
      case 'get_pages': {
        const onlyNav = req.query.nav_only;
        let rows;
        if (onlyNav) {
          rows = db.prepare('SELECT id, slug, title, nav_label, icon, show_in_nav, sort_order FROM pages WHERE show_in_nav = 1 ORDER BY sort_order, id').all();
        } else {
          rows = db.prepare('SELECT * FROM pages ORDER BY sort_order, id').all();
        }
        return json(res, rows);
      }

      case 'get_page': {
        const slug = (req.query.slug || '').trim();
        if (!slug) return json(res, { error: 'Slug required' }, 400);
        const page = db.prepare('SELECT * FROM pages WHERE slug = ?').get(slug);
        if (!page) return json(res, { error: 'Page not found' }, 404);
        return json(res, page);
      }

      case 'add_page': {
        if (!requireAdmin(req, res)) return;
        const title = (req.body.title || '').trim();
        const navLabel = (req.body.nav_label || title).trim();
        const icon = (req.body.icon || '📄').trim();
        const content = req.body.content || '';
        const showNav = parseInt(req.body.show_in_nav ?? 1, 10);
        let slug = (req.body.slug || title).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
        if (!title || !slug) return json(res, { error: 'Title required' }, 400);
        if (['home', 'minecraft', 'discord', 'partner', 'promo', 'api', 'uploads'].includes(slug)) {
          return json(res, { error: 'Yeh slug reserved hai, koi aur naam rakhein' }, 400);
        }
        const exists = db.prepare('SELECT id FROM pages WHERE slug = ?').get(slug);
        if (exists) return json(res, { error: 'Is slug ka page already exists!' }, 400);
        const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM pages').get();
        const order = ((maxOrder && maxOrder.m) || 0) + 1;
        const info = db.prepare('INSERT INTO pages (slug, title, nav_label, icon, content, show_in_nav, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(slug, title, navLabel, icon, content, showNav, order);
        return json(res, { ok: true, id: info.lastInsertRowid, slug });
      }

      case 'update_page': {
        if (!requireAdmin(req, res)) return;
        const id = parseInt(req.body.id || 0, 10);
        const title = (req.body.title || '').trim();
        const navLabel = (req.body.nav_label || '').trim();
        const icon = (req.body.icon || '📄').trim();
        const content = req.body.content || '';
        const showNav = parseInt(req.body.show_in_nav ?? 1, 10);
        if (!id || !title) return json(res, { error: 'ID aur title required' }, 400);
        db.prepare('UPDATE pages SET title = ?, nav_label = ?, icon = ?, content = ?, show_in_nav = ? WHERE id = ?')
          .run(title, navLabel, icon, content, showNav, id);
        return json(res, { ok: true });
      }

      case 'delete_page': {
        if (!requireAdmin(req, res)) return;
        const id = parseInt(req.body.id || 0, 10);
        db.prepare('DELETE FROM pages WHERE id = ?').run(id);
        return json(res, { ok: true });
      }

      // ========== PARTNERS ==========
      case 'get_partners': {
        return json(res, db.prepare('SELECT * FROM partners ORDER BY id DESC').all());
      }

      case 'add_partner': {
        if (!requireAdmin(req, res)) return;
        const name = (req.body.name || '').trim();
        const desc = (req.body.description || '').trim();
        const mc_ip = (req.body.mc_ip || '').trim();
        const discord = (req.body.discord_link || '').trim();
        const banner = (req.body.banner_img || '').trim();
        const tags = (req.body.tags || '').trim();
        if (!name) return json(res, { error: 'Name required' }, 400);
        const info = db.prepare('INSERT INTO partners (name, description, mc_ip, discord_link, banner_img, tags) VALUES (?, ?, ?, ?, ?, ?)')
          .run(name, desc, mc_ip, discord, banner, tags);
        return json(res, { ok: true, id: info.lastInsertRowid });
      }

      case 'delete_partner': {
        if (!requireAdmin(req, res)) return;
        db.prepare('DELETE FROM partners WHERE id = ?').run(parseInt(req.body.id || 0, 10));
        return json(res, { ok: true });
      }

      // ========== ANNOUNCEMENTS ==========
      case 'get_announcements': {
        return json(res, db.prepare('SELECT * FROM announcements WHERE active = 1 ORDER BY id DESC').all());
      }

      case 'get_all_announcements': {
        if (!requireAdmin(req, res)) return;
        return json(res, db.prepare('SELECT * FROM announcements ORDER BY id DESC').all());
      }

      case 'add_announcement': {
        if (!requireAdmin(req, res)) return;
        const msg = (req.body.message || '').trim();
        let type = (req.body.type || 'info').trim();
        if (!msg) return json(res, { error: 'Message required' }, 400);
        if (!['info', 'success', 'warning', 'error'].includes(type)) type = 'info';
        const info = db.prepare('INSERT INTO announcements (message, type, active) VALUES (?, ?, 1)').run(msg, type);
        return json(res, { ok: true, id: info.lastInsertRowid });
      }

      case 'toggle_announcement': {
        if (!requireAdmin(req, res)) return;
        const id = parseInt(req.body.id || 0, 10);
        const val = parseInt(req.body.active || 0, 10);
        db.prepare('UPDATE announcements SET active = ? WHERE id = ?').run(val, id);
        return json(res, { ok: true });
      }

      case 'delete_announcement': {
        if (!requireAdmin(req, res)) return;
        db.prepare('DELETE FROM announcements WHERE id = ?').run(parseInt(req.body.id || 0, 10));
        return json(res, { ok: true });
      }

      // ========== USERS ==========
      case 'get_users': {
        if (!requireAdmin(req, res)) return;
        return json(res, db.prepare('SELECT id, username, email, is_admin, rank, created_at FROM users ORDER BY id').all());
      }

      case 'toggle_admin': {
        if (!requireAdmin(req, res)) return;
        const id = parseInt(req.body.id || 0, 10);
        const val = parseInt(req.body.value || 0, 10);
        db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(val, id);
        return json(res, { ok: true });
      }

      case 'set_rank': {
        if (!requireAdmin(req, res)) return;
        const id = parseInt(req.body.id || 0, 10);
        const rank = (req.body.rank || 'member').trim();
        const me = getLoggedUser(req);
        const myRank = me.rank || 'member';

        if (!['member', 'staff', 'admin', 'owner'].includes(rank)) {
          return json(res, { error: 'Invalid rank' }, 400);
        }
        const targetUser = db.prepare('SELECT id, rank FROM users WHERE id = ?').get(id);
        if (!targetUser) return json(res, { error: 'User not found' }, 404);

        if ((rank === 'owner' || targetUser.rank === 'owner') && myRank !== 'owner') {
          return json(res, { error: 'Sirf owner rank change kar sakta hai!' }, 403);
        }
        if (myRank === 'admin' && rank === 'owner') {
          return json(res, { error: 'Admin owner rank nahi de sakta!' }, 403);
        }

        const isAdminVal = (rank === 'admin' || rank === 'owner') ? 1 : 0;
        db.prepare('UPDATE users SET rank = ?, is_admin = ? WHERE id = ?').run(rank, isAdminVal, id);
        return json(res, { ok: true, rank });
      }

      case 'delete_user': {
        if (!requireAdmin(req, res)) return;
        const id = parseInt(req.body.id || 0, 10);
        const me = getLoggedUser(req);
        if (id === parseInt(me.id, 10)) return json(res, { error: 'Apne aap ko delete nahi kar sakte!' }, 400);
        db.prepare('DELETE FROM users WHERE id = ?').run(id);
        return json(res, { ok: true });
      }

      // ========== STATS ==========
      case 'get_stats': {
        if (!requireAdmin(req, res)) return;
        return json(res, {
          mc_files: db.prepare('SELECT COUNT(*) as c FROM mc_files').get().c,
          dc_files: db.prepare('SELECT COUNT(*) as c FROM dc_files').get().c,
          users: db.prepare('SELECT COUNT(*) as c FROM users').get().c,
          partners: db.prepare('SELECT COUNT(*) as c FROM partners').get().c,
          pages: db.prepare('SELECT COUNT(*) as c FROM pages').get().c,
          categories: db.prepare('SELECT COUNT(*) as c FROM categories').get().c
        });
      }

      default:
        return json(res, { error: 'Invalid action' }, 400);
    }
  } catch (err) {
    console.error('API Error:', err);
    return json(res, { error: 'Server error: ' + err.message }, 500);
  }
}

// Route for API - support both GET/POST and file uploads
app.all('/api', upload.single('file'), apiHandler);
app.all('/api/index.php', upload.single('file'), apiHandler);

// ---- Download endpoint ----
app.get('/download', (req, res) => {
  const type = req.query.type || '';
  const id = parseInt(req.query.id || 0, 10);
  if (!['mc', 'dc'].includes(type) || !id) {
    return res.status(400).send('Invalid request');
  }
  const table = type === 'mc' ? 'mc_files' : 'dc_files';
  const file = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!file) return res.status(404).send('File not found');

  if (file.link && !file.filename) {
    return res.redirect(file.link);
  }

  if (file.filename) {
    const filePath = path.join(UPLOAD_DIR, file.filename);
    if (!fs.existsSync(filePath)) return res.status(404).send('File missing on server');

    const ext = path.extname(file.filename).toLowerCase().slice(1);
    const mimeTypes = {
      zip: 'application/zip', rar: 'application/x-rar-compressed',
      jar: 'application/java-archive', sk: 'text/plain',
      yml: 'text/plain', yaml: 'text/plain', json: 'application/json',
      txt: 'text/plain', pdf: 'application/pdf',
      '7z': 'application/x-7z-compressed', gz: 'application/gzip',
      tar: 'application/x-tar', schematic: 'application/octet-stream'
    };
    const mime = mimeTypes[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(file.filename)}"`);
    res.setHeader('Content-Length', fs.statSync(filePath).size);
    res.setHeader('Cache-Control', 'no-cache');
    return fs.createReadStream(filePath).pipe(res);
  }

  res.status(400).send('No download available');
});


// ---- Website Update (ZIP) — like Minecraft Store ----
app.get('/api/admin/update/info', (req, res) => {
  if (!isAdmin(req)) return json(res, { error: 'Unauthorized - Admin required' }, 401);
  try {
    return json(res, { success: true, ...updater.info(), backups: updater.listBackups() });
  } catch (e) {
    return json(res, { error: e.message }, 500);
  }
});

app.post('/api/admin/update/check', express.raw({ type: '*/*', limit: '80mb' }), (req, res) => {
  if (!isAdmin(req)) return json(res, { error: 'Unauthorized - Admin required' }, 401);
  try {
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
    const result = updater.check(buf);
    return json(res, { success: true, result });
  } catch (e) {
    return json(res, { error: e.message }, 400);
  }
});

app.post('/api/admin/update/apply', express.json(), (req, res) => {
  if (!isAdmin(req)) return json(res, { error: 'Unauthorized - Admin required' }, 401);
  try {
    const me = getLoggedUser(req);
    const result = updater.apply(String(req.body.token || ''), me && me.username);
    return json(res, { success: true, ...result });
  } catch (e) {
    return json(res, { error: e.message }, 400);
  }
});

// SPA fallback - serve index.html for any non-api route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`DEV Website running on http://localhost:${PORT}`);
  console.log('First user to register becomes Owner (admin).');
});
