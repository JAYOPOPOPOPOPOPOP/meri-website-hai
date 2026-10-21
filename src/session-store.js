/**
 * SQLite session store — sessions survive server restarts
 * (as long as the database file is on a persistent volume)
 */
const session = require('express-session');

class SQLiteStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expired INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_expired ON sessions(expired);
    `);
    // cleanup expired every 15 min
    this._timer = setInterval(() => this._cleanup(), 15 * 60 * 1000);
    if (this._timer.unref) this._timer.unref();
  }

  _cleanup() {
    try {
      this.db.prepare('DELETE FROM sessions WHERE expired < ?').run(Date.now());
    } catch (e) {}
  }

  get(sid, cb) {
    try {
      const row = this.db.prepare('SELECT sess, expired FROM sessions WHERE sid = ?').get(sid);
      if (!row) return cb(null, null);
      if (row.expired < Date.now()) {
        this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        return cb(null, null);
      }
      return cb(null, JSON.parse(row.sess));
    } catch (e) {
      return cb(e);
    }
  }

  set(sid, sess, cb) {
    try {
      const maxAge = sess.cookie && sess.cookie.maxAge ? sess.cookie.maxAge : 7 * 24 * 60 * 60 * 1000;
      const expired = Date.now() + maxAge;
      this.db.prepare(
        'INSERT INTO sessions (sid, sess, expired) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expired = excluded.expired'
      ).run(sid, JSON.stringify(sess), expired);
      cb && cb(null);
    } catch (e) {
      cb && cb(e);
    }
  }

  destroy(sid, cb) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      cb && cb(null);
    } catch (e) {
      cb && cb(e);
    }
  }

  touch(sid, sess, cb) {
    this.set(sid, sess, cb);
  }
}

module.exports = SQLiteStore;
