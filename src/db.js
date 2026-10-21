const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'dev.db');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'public', 'uploads');

// Ensure directories exist
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initDB() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      skey TEXT NOT NULL PRIMARY KEY,
      svalue TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
      rank TEXT DEFAULT 'member' CHECK(rank IN ('member','staff','admin','owner')),
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS mc_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      filename TEXT,
      link TEXT,
      filesize TEXT,
      uploaded_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS dc_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      filename TEXT,
      link TEXT,
      filesize TEXT,
      uploaded_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS partners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      mc_ip TEXT,
      discord_link TEXT,
      banner_img TEXT,
      tags TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      nav_label TEXT NOT NULL,
      icon TEXT DEFAULT '📄',
      content TEXT,
      show_in_nav INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('mc','dc')),
      slug TEXT NOT NULL,
      label TEXT NOT NULL,
      icon TEXT DEFAULT '📁',
      sort_order INTEGER DEFAULT 0,
      is_private INTEGER DEFAULT 0,
      UNIQUE(type, slug)
    );

    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message TEXT NOT NULL,
      type TEXT DEFAULT 'info' CHECK(type IN ('info','success','warning','error')),
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Default settings
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (skey, svalue) VALUES (?, ?)');
  const defaults = [
    ['site_name', 'DEV'],
    ['small_icon', '⚡'],
    ['logo_url', ''],
    ['favicon_url', ''],
    ['hero_title', 'The Ultimate Developer Hub'],
    ['hero_desc', 'DEV is the ultimate free platform for developers and Minecraft server owners. Get setups, maps, plugins, skripts, configs, models and much more — completely free. Join our growing community!'],
    ['discord_link', ''],
    ['discord_hero_title', 'Join Our Discord Server'],
    ['discord_hero_desc', 'Hamare Discord server pe join karein. Latest updates, help, resources aur ek amazing community milegi!'],
    ['promo_mc_ip', ''],
    ['promo_mc_name', ''],
    ['promo_dc_link', ''],
    ['promo_dc_desc', 'Hamare Discord server pe 24/7 support milta hai, latest resources milte hain aur ek active community hai!'],
    ['nav_home', 'HOME'],
    ['nav_minecraft', 'MINECRAFT'],
    ['nav_discord', 'DISCORD'],
    ['nav_partner', 'PARTNER'],
    ['nav_promo', 'PROMOTION'],
    ['color_accent', '#00ff88'],
    ['color_accent2', '#7c3aed'],
    ['color_bg', '#0a0a0f'],
    ['color_bg2', '#111118'],
    ['color_text', '#e8e8f0'],
    ['maintenance_mode', '0'],
    ['maintenance_msg', 'Site currently under maintenance. Please check back soon!'],
    ['seo_description', 'Free Minecraft setups, maps, plugins, skripts, configs and Discord resources for developers.'],
    ['seo_keywords', 'minecraft, setup, plugin, skript, discord, free, developer'],
    ['footer_text', ''],
    ['feature_cards', JSON.stringify([
      {"icon":"📦","title":"Free Downloads","desc":"Sabhi resources completely free hain. Setups, maps, plugins, configs, models — sab kuch bina kisi charge ke."},
      {"icon":"🎯","title":"Organized Categories","desc":"Har cheez properly categorized hai taaki aap exactly woh dhundh sake jo aapko chahiye."},
      {"icon":"⚡","title":"Regular Updates","desc":"Naye resources regularly add kiye jaate hain. Latest Minecraft plugins, setups aur bahut kuch."},
      {"icon":"🌐","title":"Active Community","desc":"Our Discord server pe developers hain jo help karte hain, share karte hain aur collaborate karte hain."}
    ])]
  ];
  for (const [k, v] of defaults) insertSetting.run(k, v);

  // Default MC categories
  const insertCat = db.prepare('INSERT OR IGNORE INTO categories (type, slug, label, icon, sort_order) VALUES (?, ?, ?, ?, ?)');
  const mcCats = [
    ['mc', 'setup', 'Setup', '⚙️', 1],
    ['mc', 'maps', 'Maps', '🗺️', 2],
    ['mc', 'plugin', 'Plugin', '🔌', 3],
    ['mc', 'skript', 'Skript', '📜', 4],
    ['mc', 'config', 'Config', '🛠️', 5],
    ['mc', 'models', 'Models', '🧊', 6]
  ];
  for (const c of mcCats) insertCat.run(...c);

  // Default DC categories
  const dcCats = [
    ['dc', 'template', 'Template', '📄', 1],
    ['dc', 'others', 'Others', '📦', 2]
  ];
  for (const c of dcCats) insertCat.run(...c);

  console.log('Database initialized at', DB_PATH);
}

initDB();

module.exports = { db, UPLOAD_DIR, DB_PATH };
