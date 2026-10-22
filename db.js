// Database layer.
// - Online (DATABASE_URL set): PostgreSQL, e.g. a free Neon database. Data survives restarts on any host.
// - On a laptop (no DATABASE_URL): SQLite file attendance.db, using Node's built-in SQLite.
// All queries are written once with ? placeholders and portable SQL, then run on whichever is active.
const crypto = require('crypto');
const path = require('path');

const isPg = !!process.env.DATABASE_URL;
let all, run, exec;

if (isPg) {
  const { Pool } = require('pg');
  const url = process.env.DATABASE_URL;
  const local = /localhost|127\.0\.0\.1/.test(url);
  const pool = new Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false }, max: 5 });
  const toPg = sql => { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); };
  all = async (sql, p = []) => (await pool.query(toPg(sql), p)).rows;
  run = async (sql, p = []) => { const r = await pool.query(toPg(sql), p); return { changes: r.rowCount, rows: r.rows }; };
  exec = async sql => { await pool.query(sql); };
  module.exports.close = () => pool.end();
} else {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(process.env.DB_FILE || path.join(__dirname, 'attendance.db'));
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  all = async (sql, p = []) => db.prepare(sql).all(...p);
  run = async (sql, p = []) => {
    const st = db.prepare(sql);
    if (/returning/i.test(sql)) { const rows = st.all(...p); return { changes: rows.length, rows }; }
    const r = st.run(...p); return { changes: r.changes, rows: [] };
  };
  exec = async sql => db.exec(sql);
  module.exports.close = () => db.close();
}
const get = async (sql, p) => (await all(sql, p))[0];

const ID = isPg ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
const BIG = isPg ? 'BIGINT' : 'INTEGER';

async function init() {
  await exec(`
  CREATE TABLE IF NOT EXISTS users (
    id ${ID},
    username TEXT UNIQUE NOT NULL,        -- student ID (e.g. S001) or trainer login
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('trainer','student')),
    email TEXT DEFAULT '',                -- student email
    salt TEXT NOT NULL,
    pass_hash TEXT NOT NULL,
    active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires ${BIG} NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id ${ID},
    name TEXT NOT NULL,
    date TEXT NOT NULL,                   -- YYYY-MM-DD
    start_time TEXT NOT NULL,             -- HH:MM
    late_after_min INTEGER DEFAULT 15,
    checkin_open INTEGER DEFAULT 0,
    secret TEXT NOT NULL                  -- per-event key used to sign the event QR token
  );
  CREATE TABLE IF NOT EXISTS registrations (
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (event_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS checkins (
    id ${ID},
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ts TEXT NOT NULL,
    status TEXT NOT NULL,                 -- present | late | manual
    device_id TEXT, ip TEXT, user_agent TEXT,
    flagged INTEGER DEFAULT 0, flag_reason TEXT,
    UNIQUE (event_id, user_id)            -- anti-cheat: one check-in per student per event
  );
  CREATE TABLE IF NOT EXISTS suspicious (
    id ${ID},
    event_id INTEGER, user_id INTEGER,
    ts TEXT NOT NULL, reason TEXT NOT NULL,
    device_id TEXT, ip TEXT
  );`);

  // Databases created by older versions have no email column yet: add it.
  if (isPg) await exec("ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT DEFAULT ''");
  else if (!(await all('PRAGMA table_info(users)')).some(c => c.name === 'email')) await exec("ALTER TABLE users ADD COLUMN email TEXT DEFAULT ''");

  // Always have a trainer account. On a hosted site, set ADMIN_PASSWORD so the default is never public.
  if (!(await get("SELECT 1 AS x FROM users WHERE role='trainer'"))) {
    const pw = process.env.ADMIN_PASSWORD || 'admin123';
    await createUser({ username: 'admin', name: process.env.ADMIN_NAME || 'Admin Trainer', role: 'trainer', password: pw });
    console.log(process.env.ADMIN_PASSWORD ? 'Created trainer login "admin" with ADMIN_PASSWORD'
      : 'Created default trainer login  admin / admin123  (change it after first login)');
  }
}

function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(pw), salt, 64).toString('hex') };
}
function verifyPassword(pw, salt, hash) {
  return crypto.timingSafeEqual(crypto.scryptSync(String(pw), salt, 64), Buffer.from(hash, 'hex'));
}

async function createUser({ username, name, role, password, email = '' }) {
  const { salt, hash } = hashPassword(password);
  return run('INSERT INTO users (username,name,role,email,salt,pass_hash) VALUES (?,?,?,?,?,?)',
    [String(username).trim(), String(name).trim(), role, String(email || '').trim().toLowerCase(), salt, hash]);
}

Object.assign(module.exports, { isPg, init, all, get, run, hashPassword, verifyPassword, createUser });
