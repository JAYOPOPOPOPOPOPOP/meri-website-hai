/**
 * DEV Website — Update via ZIP
 * Similar to Minecraft Store updater.
 * Protects: data/, public/uploads/, node_modules/
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const BACKUP_DIR = path.join(ROOT, 'data', 'backups');
const MAX_ZIP = 80 * 1024 * 1024; // 80MB
const MAX_UNPACKED = 200 * 1024 * 1024;
const MAX_ENTRIES = 5000;

const pending = new Map(); // token -> { buf, at }

function isProtected(rel) {
  const r = rel.replace(/\\/g, '/');
  if (r === 'data' || r.startsWith('data/')) return true;
  if (r === 'public/uploads' || r.startsWith('public/uploads/')) return true;
  if (r === 'node_modules' || r.startsWith('node_modules/')) return true;
  if (r === '.git' || r.startsWith('.git/')) return true;
  if (r === 'package-lock.json') return true;
  return false;
}

function readZip(buf) {
  // Find EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Invalid ZIP file (EOCD not found)');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || off === 0xffffffff) throw new Error('ZIP64 not supported');
  if (count > MAX_ENTRIES) throw new Error('Too many files in ZIP');
  const out = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('Corrupt ZIP (central directory)');
    const flags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nlen);
    off += 46 + nlen + elen + clen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error('Password-protected ZIP not supported');
    total += usize;
    if (total > MAX_UNPACKED) throw new Error('ZIP too large when unpacked');
    out.push({ name, method, csize, usize, lho });
  }
  return out;
}

function extract(buf, e) {
  if (buf.readUInt32LE(e.lho) !== 0x04034b50) throw new Error('Corrupt ZIP: ' + e.name);
  const nlen = buf.readUInt16LE(e.lho + 26);
  const elen = buf.readUInt16LE(e.lho + 28);
  const start = e.lho + 30 + nlen + elen;
  const raw = buf.subarray(start, start + e.csize);
  let data;
  if (e.method === 0) data = Buffer.from(raw);
  else if (e.method === 8) data = zlib.inflateRawSync(raw);
  else throw new Error('Unsupported compression: ' + e.name);
  return data;
}

function cleanName(name) {
  let n = name.replace(/\\/g, '/').replace(/^\.\//, '');
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n)) return null;
  const parts = n.split('/');
  if (parts.some(p => p === '..' || p === '')) return null;
  return parts.join('/');
}

function buildPlan(buf) {
  const entries = readZip(buf)
    .map(e => Object.assign(e, { clean: cleanName(e.name) }))
    .filter(e => e.clean && !e.clean.startsWith('__MACOSX/') && !/(^|\/)(\.DS_Store|Thumbs\.db)$/.test(e.clean));
  if (!entries.length) throw new Error('ZIP is empty');

  // Detect root prefix (if zip has a single top folder)
  const servers = entries.filter(e => /^([^/]+\/)?server\.js$/.test(e.clean)).sort((a, b) => a.clean.length - b.clean.length);
  let prefix = '';
  if (servers.length) {
    prefix = servers[0].clean.slice(0, -'server.js'.length);
  } else {
    // try package.json
    const pkgs = entries.filter(e => /^([^/]+\/)?package\.json$/.test(e.clean)).sort((a, b) => a.clean.length - b.clean.length);
    if (pkgs.length) prefix = pkgs[0].clean.slice(0, -'package.json'.length);
  }

  const files = [];
  let added = 0, changed = 0, same = 0;
  const changedList = [];
  const skipped = [];

  for (const e of entries) {
    let rel = e.clean;
    if (prefix && rel.startsWith(prefix)) rel = rel.slice(prefix.length);
    if (!rel || isProtected(rel)) {
      if (rel) skipped.push(rel);
      continue;
    }
    const data = extract(buf, e);
    const dest = path.join(ROOT, rel);
    let status = 'added';
    if (fs.existsSync(dest)) {
      const cur = fs.readFileSync(dest);
      if (cur.equals(data)) { status = 'same'; same++; }
      else { status = 'changed'; changed++; changedList.push(rel); }
    } else {
      added++;
      changedList.push('+ ' + rel);
    }
    files.push({ rel, data, status });
  }

  return { files, added, changed, same, skipped, changedList, fullUpdate: !!servers.length };
}

function check(buf) {
  if (!buf || buf.length < 22) throw new Error('Invalid ZIP');
  if (buf.length > MAX_ZIP) throw new Error('ZIP too large (max 80MB)');
  const plan = buildPlan(buf);
  const warnings = [];
  if (plan.added + plan.changed === 0) warnings.push('No new changes (all files identical).');
  if (plan.skipped.length) warnings.push(plan.skipped.length + ' protected file(s) skipped (data/uploads).');

  const token = crypto.randomBytes(16).toString('hex');
  pending.set(token, { buf, at: Date.now() });
  // cleanup old
  for (const [k, v] of pending) if (Date.now() - v.at > 15 * 60 * 1000) pending.delete(k);

  return {
    token,
    updateType: plan.fullUpdate ? 'full' : 'partial',
    added: plan.added,
    changed: plan.changed,
    same: plan.same,
    protectedSkipped: plan.skipped.length,
    changedFiles: plan.changedList.slice(0, 60),
    moreFiles: Math.max(0, plan.changedList.length - 60),
    warnings
  };
}

function makeBackup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const id = 'bak_' + Date.now();
  const dir = path.join(BACKUP_DIR, id);
  fs.mkdirSync(dir, { recursive: true });

  const toBackup = ['server.js', 'package.json', 'src', 'public/index.html'];
  for (const item of toBackup) {
    const src = path.join(ROOT, item);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(dir, item);
    const st = fs.statSync(src);
    if (st.isDirectory()) {
      copyDir(src, dest);
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }
  // log
  const logPath = path.join(BACKUP_DIR, 'history.json');
  let hist = [];
  try { hist = JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch {}
  hist.unshift({ id, at: new Date().toISOString(), label: 'pre-update' });
  hist = hist.slice(0, 20);
  fs.writeFileSync(logPath, JSON.stringify(hist, null, 2));
  return id;
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dest, name);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function apply(token, who) {
  const p = pending.get(token);
  if (!p) throw new Error('Token expired or invalid. Please check the ZIP again.');
  pending.delete(token);

  const plan = buildPlan(p.buf);
  if (plan.added + plan.changed === 0) throw new Error('Nothing to apply.');

  const backupId = makeBackup();

  for (const f of plan.files) {
    if (f.status === 'same') continue;
    const dest = path.join(ROOT, f.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.data);
  }

  // log apply
  const logPath = path.join(BACKUP_DIR, 'history.json');
  let hist = [];
  try { hist = JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch {}
  hist.unshift({
    id: 'upd_' + Date.now(),
    at: new Date().toISOString(),
    label: 'update applied',
    by: who || 'admin',
    backupId,
    added: plan.added,
    changed: plan.changed
  });
  hist = hist.slice(0, 30);
  fs.writeFileSync(logPath, JSON.stringify(hist, null, 2));

  return {
    ok: true,
    backupId,
    added: plan.added,
    changed: plan.changed,
    message: 'Update applied! On Railway: redeploy/restart the service for changes to take full effect.'
  };
}

function info() {
  const logPath = path.join(BACKUP_DIR, 'history.json');
  let hist = [];
  try { hist = JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch {}
  let version = '1.0.0';
  try {
    version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || version;
  } catch {}
  return {
    version,
    history: hist.slice(0, 15),
    maxZipMB: MAX_ZIP / (1024 * 1024)
  };
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter(n => n.startsWith('bak_') && fs.statSync(path.join(BACKUP_DIR, n)).isDirectory())
    .map(id => ({ id, at: new Date(parseInt(id.replace('bak_', ''), 10) || 0).toISOString() }))
    .sort((a, b) => b.id.localeCompare(a.id));
}

module.exports = { check, apply, info, listBackups, MAX_ZIP };
