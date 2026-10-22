// Event Registration & Attendance Tracking System
// Express back end: trainer login, events, QR check-in by picking your name, live dashboard, reports.
// Works on a laptop (SQLite) or hosted online with a public link (PostgreSQL via DATABASE_URL).
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const QRCode = require('qrcode');
const db = require('./db');
const { all, get, run, verifyPassword, createUser, hashPassword } = db;

const PORT = process.env.PORT || 3000;
const TZ = process.env.TZ_NAME || 'Asia/Singapore';
const SESSION_HOURS = 12;

const app = express();
app.set('trust proxy', true);   // correct client IP and https detection behind Render / Cloudflare
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' }); next(); });
app.use(express.static(path.join(__dirname, 'public')));

// async route wrapper so database errors return a clean 500 instead of crashing
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- helpers ----------
const nowIso = () => new Date().toISOString();
const localDate = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: TZ });
const localTime = (d = new Date()) => d.toLocaleTimeString('en-GB', { timeZone: TZ, hour12: false }).slice(0, 5);
const toMin = hhmm => { const [hh, mm] = hhmm.split(':').map(Number); return hh * 60 + mm; };
const num = v => Number(v);

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function setCookie(req, res, name, value, maxAgeSec) {
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${req.secure ? '; Secure' : ''}`);
}

// Device ID cookie (spots one phone checking in several students) + session lookup
app.use(h(async (req, res, next) => {
  const c = parseCookies(req);
  req.deviceId = c.did;
  if (!req.deviceId) {
    req.deviceId = crypto.randomBytes(12).toString('hex');
    setCookie(req, res, 'did', req.deviceId, 60 * 60 * 24 * 365);
  }
  if (c.sid && req.path.startsWith('/api')) {
    req.user = await get(`SELECT u.id,u.username,u.name,u.role,u.email FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token=? AND s.expires>? AND u.active=1`, [c.sid, Date.now()]);
  }
  next();
}));

const auth = role => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Please log in' });
  if (role && req.user.role !== role) return res.status(403).json({ error: 'Not allowed' });
  next();
};

// Fixed QR token = HMAC(event secret, event id). Same for the whole event, so it can be printed.
// It only changes when the trainer presses "Reset QR" (new secret).
function qrToken(ev) {
  return crypto.createHmac('sha256', ev.secret).update(`${ev.id}:checkin`).digest('base64url').slice(0, 16);
}
function tokenValid(ev, token) {
  const t = qrToken(ev);
  return typeof token === 'string' && t.length === token.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token));
}
// Trainer login rate limit: 8 wrong tries per username (or per IP) in 15 minutes, to stop password guessing
const fails = new Map();
const LIMIT = 8, WINDOW_MS = 15 * 60e3;
function tooMany(key) { const f = fails.get(key); return f && f.n >= LIMIT && Date.now() - f.t < WINDOW_MS; }
function addFail(key) { const f = fails.get(key); fails.set(key, f && Date.now() - f.t < WINDOW_MS ? { n: f.n + 1, t: f.t } : { n: 1, t: Date.now() }); }

// ---------- live updates (Server-Sent Events); dashboard also polls every 5 s as a backup ----------
const streams = new Map();
function broadcast(eventId, payload) {
  for (const res of streams.get(String(eventId)) || []) res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// ---------- auth ----------
app.get('/healthz', (req, res) => res.json({ ok: true, db: db.isPg ? 'postgres' : 'sqlite' }));

app.post('/api/login', h(async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const keyU = 'u:' + username.toLowerCase(), keyI = 'i:' + req.ip;
  if (tooMany(keyU) || tooMany(keyI)) return res.status(429).json({ error: 'Too many wrong tries. Wait 15 minutes and try again.' });
  // Only trainers log in. Students do not need an account login: they pick their name after scanning the QR.
  const u = await get("SELECT * FROM users WHERE LOWER(username)=LOWER(?) AND active=1 AND role='trainer'", [username]);
  if (!u || !verifyPassword(req.body?.password || '', u.salt, u.pass_hash)) {
    addFail(keyU); addFail(keyI);
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  fails.delete(keyU);
  const token = crypto.randomBytes(24).toString('hex');
  await run('INSERT INTO sessions (token,user_id,expires) VALUES (?,?,?)', [token, u.id, Date.now() + SESSION_HOURS * 3600e3]);
  await run('DELETE FROM sessions WHERE expires<?', [Date.now()]);
  setCookie(req, res, 'sid', token, SESSION_HOURS * 3600);
  res.json({ role: u.role, name: u.name });
}));
app.post('/api/logout', h(async (req, res) => {
  const sid = parseCookies(req).sid;
  if (sid) await run('DELETE FROM sessions WHERE token=?', [sid]);
  setCookie(req, res, 'sid', '', 0);
  res.json({ ok: true });
}));
app.get('/api/me', auth(), (req, res) => res.json(req.user));
// ---------- trainer accounts: every trainer signs in with their own username and password ----------
app.get('/api/trainers', auth('trainer'), h(async (req, res) => {
  const list = await all("SELECT id,username,name FROM users WHERE role='trainer' AND active=1 ORDER BY LOWER(name)");
  res.json(list.map(t => ({ ...t, me: t.id === req.user.id })));
}));
app.post('/api/trainers', auth('trainer'), h(async (req, res) => {
  const username = String(req.body?.username || '').trim(), name = String(req.body?.name || '').trim(), password = String(req.body?.password || '');
  if (!/^[A-Za-z0-9._-]{3,30}$/.test(username)) return res.status(400).json({ error: 'Username must be 3 to 30 letters, numbers, dots, dashes or underscores, with no spaces' });
  if (!name || name.length > 60) return res.status(400).json({ error: 'Enter a display name of up to 60 characters' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const existing = await get('SELECT id,role,active FROM users WHERE LOWER(username)=LOWER(?)', [username]);
  if (existing && (existing.active || existing.role !== 'trainer')) return res.status(409).json({ error: `The username "${username}" is already taken` });
  const { salt, hash } = hashPassword(password);
  if (existing) await run('UPDATE users SET active=1,name=?,salt=?,pass_hash=? WHERE id=?', [name, salt, hash, existing.id]);   // re-adding a removed trainer
  else await createUser({ username, name, role: 'trainer', password });
  res.json({ ok: true, username, name });
}));
app.post('/api/trainers/:id/password', auth('trainer'), h(async (req, res) => {
  const t = await get("SELECT id,name FROM users WHERE id=? AND role='trainer' AND active=1", [num(req.params.id) || 0]);
  if (!t) return res.status(404).json({ error: 'Trainer not found' });
  const password = String(req.body?.password || '');
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const { salt, hash } = hashPassword(password);
  await run('UPDATE users SET salt=?,pass_hash=? WHERE id=?', [salt, hash, t.id]);
  if (t.id !== req.user.id) await run('DELETE FROM sessions WHERE user_id=?', [t.id]);   // sign them out everywhere
  res.json({ ok: true });
}));
app.delete('/api/trainers/:id', auth('trainer'), h(async (req, res) => {
  const id = num(req.params.id) || 0;
  if (id === req.user.id) return res.status(400).json({ error: "You can't remove your own account. Ask another trainer to do it." });
  const count = num((await get("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM users WHERE role='trainer' AND active=1")).n);
  if (count <= 1) return res.status(400).json({ error: 'There must always be at least one trainer account' });
  const r = await run("UPDATE users SET active=0 WHERE id=? AND role='trainer'", [id]);
  await run('DELETE FROM sessions WHERE user_id=?', [id]);
  res.json({ ok: r.changes === 1 });
}));

// Change the name shown at the top right of the dashboard
app.post('/api/me/name', auth('trainer'), h(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name || name.length > 60) return res.status(400).json({ error: 'Enter a display name of up to 60 characters' });
  await run('UPDATE users SET name=? WHERE id=?', [name, req.user.id]);
  res.json({ ok: true, name });
}));
app.post('/api/me/password', auth(), h(async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  const u = await get('SELECT * FROM users WHERE id=?', [req.user.id]);
  if (!verifyPassword(oldPassword || '', u.salt, u.pass_hash)) return res.status(400).json({ error: 'Current password is wrong' });
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  const { salt, hash } = hashPassword(newPassword);
  await run('UPDATE users SET salt=?, pass_hash=? WHERE id=?', [salt, hash, u.id]);
  res.json({ ok: true });
}));

// ---------- students (trainer) ----------
app.get('/api/students', auth('trainer'), h(async (req, res) => {
  res.json(await all("SELECT id,username,name,email,active FROM users WHERE role='student' AND active=1 ORDER BY username"));
}));
// Add students: rows = [{username, name, email}]. Students have no password; they pick their name to check in.
const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
app.post('/api/students', auth('trainer'), h(async (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [req.body];
  const created = []; const errors = [];
  for (const r of rows) {
    const username = String(r.username || '').trim(), name = String(r.name || '').trim(), email = String(r.email || '').trim().toLowerCase();
    const label = [username, name, email].filter(Boolean).join(', ') || '(blank line)';
    if (!username || !name || !email) { errors.push(`Student ID, name and email are all needed: ${label}`); continue; }
    if (!EMAIL_RE.test(email)) { errors.push(`${username}: "${email}" is not a valid email`); continue; }
    const pin = crypto.randomBytes(16).toString('hex');   // unused placeholder: students never log in
    try {
      const existing = await get('SELECT id,active FROM users WHERE LOWER(username)=LOWER(?)', [username]);
      if (existing && existing.active) { errors.push(`${username}: student ID already exists`); continue; }
      const sameEmail = await get("SELECT username FROM users WHERE LOWER(email)=? AND role='student' AND active=1", [email]);
      if (sameEmail) { errors.push(`${username}: email already used by ${sameEmail.username}`); continue; }
      if (existing) {                                 // re-adding a removed student: reactivate with new details
        const { salt, hash } = hashPassword(pin);
        await run('UPDATE users SET active=1,name=?,email=?,salt=?,pass_hash=? WHERE id=?', [name, email, salt, hash, existing.id]);
      } else await createUser({ username, name, email, role: 'student', password: pin });
      created.push({ username, name, email });
    } catch (e) { errors.push(`${username}: could not add`); }
  }
  // New students join every session from today onwards, so it doesn't matter whether sessions or students were set up first
  if (created.length) {
    await run(`INSERT INTO registrations (event_id,user_id)
      SELECT e.id, u.id FROM events e, users u
      WHERE e.date >= ? AND u.role='student' AND u.active=1 AND LOWER(u.username) IN (${created.map(() => '?').join(',')})
      ON CONFLICT DO NOTHING`, [localDate(), ...created.map(c => c.username.toLowerCase())]);
  }
  res.json({ added: created.length, created, errors });
}));
app.delete('/api/students/:id', auth('trainer'), h(async (req, res) => {
  await run("UPDATE users SET active=0 WHERE id=? AND role='student'", [req.params.id]);
  res.json({ ok: true });
}));

// ---------- events ----------
const REG_ALL = `INSERT INTO registrations (event_id,user_id) SELECT CAST(? AS INTEGER), id FROM users
  WHERE role='student' AND active=1 ON CONFLICT DO NOTHING`;

app.get('/api/events', auth('trainer'), h(async (req, res) => {
  const rows = await all(`
    SELECT e.id,e.name,e.date,e.start_time,e.late_after_min,e.checkin_open,
      CAST((SELECT COUNT(*) FROM registrations r WHERE r.event_id=e.id) AS INTEGER) AS registered,
      CAST((SELECT COUNT(*) FROM checkins c WHERE c.event_id=e.id) AS INTEGER) AS checked_in
    FROM events e ORDER BY e.date DESC, e.start_time DESC`);
  res.json(rows);
}));
app.post('/api/events', auth('trainer'), h(async (req, res) => {
  const { name, date, start_time, late_after_min = 15, register_all } = req.body || {};
  if (!name || !date || !start_time) return res.status(400).json({ error: 'Name, date and start time are required' });
  const r = await run(`INSERT INTO events (name,date,start_time,late_after_min,secret)
    VALUES (?,?,?,?,?) RETURNING id`, [name, date, start_time, num(late_after_min) || 0, crypto.randomBytes(32).toString('hex')]);
  const id = r.rows[0].id;
  if (register_all) await run(REG_ALL, [id]);
  res.json({ id });
}));
app.post('/api/events/:id/open', auth('trainer'), h(async (req, res) => {
  await run('UPDATE events SET checkin_open=? WHERE id=?', [req.body.open ? 1 : 0, req.params.id]);
  broadcast(req.params.id, { type: 'refresh' });
  res.json({ ok: true });
}));
app.post('/api/events/:id/register-all', auth('trainer'), h(async (req, res) => {
  const r = await run(REG_ALL, [req.params.id]);
  broadcast(req.params.id, { type: 'refresh' });
  res.json({ added: r.changes });
}));
app.delete('/api/events/:id', auth('trainer'), h(async (req, res) => {
  await run('DELETE FROM events WHERE id=?', [req.params.id]);
  res.json({ ok: true });
}));

// QR image for the projector or printout
app.get('/api/events/:id/qr', auth('trainer'), h(async (req, res) => {
  const ev = await get('SELECT * FROM events WHERE id=?', [req.params.id]);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const url = `${base}/checkin.html?e=${ev.id}&t=${qrToken(ev)}`;
  res.json({ dataUrl: await QRCode.toDataURL(url, { width: 520, margin: 1 }), url, open: !!ev.checkin_open, name: ev.name, date: ev.date });
}));
app.post('/api/events/:id/reset-qr', auth('trainer'), h(async (req, res) => {
  await run('UPDATE events SET secret=? WHERE id=?', [crypto.randomBytes(32).toString('hex'), req.params.id]);
  res.json({ ok: true });
}));

// ---------- check-in: scan QR, pick your name ----------
// Name list for the check-in page. Needs the QR code, so only people who scanned it can see the list.
app.get('/api/checkin/names', h(async (req, res) => {
  const ev = await get('SELECT * FROM events WHERE id=?', [num(req.query.e) || 0]);
  if (!ev || !tokenValid(ev, req.query.t)) return res.status(400).json({ error: 'This QR code is not valid. Scan the code shown by the trainer.' });
  const regCount = num((await get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM registrations WHERE event_id=?', [ev.id])).n);
  // Students registered for the event. If nobody is registered yet, show every active student.
  const names = await all(`SELECT u.id,u.username,u.name,
      CASE WHEN EXISTS(SELECT 1 FROM checkins c WHERE c.event_id=? AND c.user_id=u.id) THEN 1 ELSE 0 END AS checked_in
    FROM users u WHERE u.role='student' AND u.active=1
      AND (?=0 OR EXISTS(SELECT 1 FROM registrations r WHERE r.event_id=? AND r.user_id=u.id))
    ORDER BY u.name`, [ev.id, regCount, ev.id]);
  res.json({ event: ev.name, date: ev.date, open: !!ev.checkin_open, today: ev.date === localDate(), names });
}));

app.post('/api/checkin', h(async (req, res) => {
  const { eventId, token, studentId } = req.body || {};
  const ev = await get('SELECT * FROM events WHERE id=?', [num(eventId) || 0]);
  if (!ev || !tokenValid(ev, token)) return res.status(400).json({ error: 'This QR code is not valid. Scan the code shown by the trainer.' });
  const student = await get("SELECT id,username,name FROM users WHERE id=? AND role='student' AND active=1", [num(studentId) || 0]);
  if (!student) return res.status(404).json({ error: 'Please choose your name from the list.' });
  const ts = nowIso();
  const reject = async (reason, msg, code = 400) => {
    await run('INSERT INTO suspicious (event_id,user_id,ts,reason,device_id,ip) VALUES (?,?,?,?,?,?)', [ev.id, student.id, ts, reason, req.deviceId, req.ip]);
    broadcast(ev.id, { type: 'suspicious' });
    return res.status(code).json({ error: msg });
  };
  if (!ev.checkin_open) return reject('Check-in closed', 'Check-in is not open yet. Wait for the trainer to open it.');
  if (ev.date !== localDate()) return reject('Wrong day', 'This event is not running today.');
  if (await get('SELECT 1 AS x FROM checkins WHERE event_id=? AND user_id=?', [ev.id, student.id]))
    return reject('Duplicate', `${student.name} is already checked in.`, 409);
  // One phone checks in one student per event
  const other = await get(`SELECT u.username,u.name FROM checkins c JOIN users u ON u.id=c.user_id
    WHERE c.event_id=? AND c.device_id=? AND c.user_id<>?`, [ev.id, req.deviceId, student.id]);
  if (other) return reject(`Same phone as ${other.name} (${other.username})`, `This phone already checked in ${other.name}. Please see the trainer.`, 403);

  let flagged = 0, flag_reason = null;
  if (!(await get('SELECT 1 AS x FROM registrations WHERE event_id=? AND user_id=?', [ev.id, student.id]))) {
    await run('INSERT INTO registrations (event_id,user_id) VALUES (?,?) ON CONFLICT DO NOTHING', [ev.id, student.id]);
    flagged = 1; flag_reason = 'Walk-in (not registered)';
  }
  const status = toMin(localTime()) > toMin(ev.start_time) + num(ev.late_after_min || 0) ? 'late' : 'present';
  const ins = await run(`INSERT INTO checkins (event_id,user_id,ts,status,device_id,ip,user_agent,flagged,flag_reason)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`, [ev.id, student.id, ts, status, req.deviceId, req.ip,
    String(req.get('user-agent') || '').slice(0, 200), flagged, flag_reason]);
  if (!ins.changes) return res.status(409).json({ error: `${student.name} is already checked in.` });  // double-tap
  broadcast(ev.id, { type: 'checkin' });
  res.json({ ok: true, status, name: student.name, event: ev.name, time: localTime() });
}));

// Trainer can undo a check-in (e.g. a student picked the wrong name)
app.delete('/api/events/:id/checkins/:userId', auth('trainer'), h(async (req, res) => {
  const r = await run('DELETE FROM checkins WHERE event_id=? AND user_id=?', [req.params.id, req.params.userId]);
  broadcast(req.params.id, { type: 'refresh' });
  res.json({ ok: r.changes === 1 });
}));

app.post('/api/events/:id/manual', auth('trainer'), h(async (req, res) => {
  const u = await get("SELECT id FROM users WHERE id=? AND role='student'", [num(req.body.userId) || 0]);
  if (!u) return res.status(404).json({ error: 'Student not found' });
  await run('INSERT INTO registrations (event_id,user_id) VALUES (?,?) ON CONFLICT DO NOTHING', [req.params.id, u.id]);
  const r = await run(`INSERT INTO checkins (event_id,user_id,ts,status,flag_reason) VALUES (?,?,?,'manual',?) ON CONFLICT DO NOTHING`,
    [req.params.id, u.id, nowIso(), `Marked by ${req.user.username}`]);
  broadcast(req.params.id, { type: 'checkin' });
  res.json({ ok: r.changes === 1 });
}));

// ---------- dashboard data ----------
async function eventSummary(id) {
  const ev = await get('SELECT id,name,date,start_time,late_after_min,checkin_open FROM events WHERE id=?', [num(id) || 0]);
  if (!ev) return null;
  const checkins = await all(`SELECT c.ts,c.status,c.flagged,c.flag_reason,u.id AS user_id,u.username,u.name,u.email
    FROM checkins c JOIN users u ON u.id=c.user_id WHERE c.event_id=? ORDER BY c.ts DESC`, [ev.id]);
  // Missing = registered for the event but no check-in yet
  const missing = await all(`SELECT u.id AS user_id,u.username,u.name,u.email FROM registrations r JOIN users u ON u.id=r.user_id
    WHERE r.event_id=? AND u.active=1 AND NOT EXISTS (SELECT 1 FROM checkins c WHERE c.event_id=r.event_id AND c.user_id=r.user_id)
    ORDER BY u.username`, [ev.id]);
  const suspicious = await all(`SELECT s.ts,s.reason,s.ip,u.username,u.name FROM suspicious s LEFT JOIN users u ON u.id=s.user_id
    WHERE s.event_id=? ORDER BY s.ts DESC LIMIT 100`, [ev.id]);
  const registered = num((await get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM registrations WHERE event_id=?', [ev.id])).n);
  const count = s => checkins.filter(c => c.status === s).length;
  return {
    event: ev, registered, checkins, missing, suspicious,
    totals: { checked_in: checkins.length, present: count('present'), late: count('late'), manual: count('manual'),
      missing: missing.length, flagged: checkins.filter(c => c.flagged).length, blocked_attempts: suspicious.length,
      rate: registered ? Math.round(checkins.length / registered * 100) : 0 }
  };
}
app.get('/api/events/:id/summary', auth('trainer'), h(async (req, res) => {
  const s = await eventSummary(req.params.id);
  s ? res.json(s) : res.status(404).json({ error: 'Event not found' });
}));
app.get('/api/events/:id/stream', auth('trainer'), (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const key = String(req.params.id);
  if (!streams.has(key)) streams.set(key, new Set());
  streams.get(key).add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(ping); streams.get(key).delete(res); });
});

// ---------- reports ----------
app.get('/api/reports/daily', auth('trainer'), h(async (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : localDate();
  const events = [];
  for (const e of await all('SELECT id FROM events WHERE date=? ORDER BY start_time', [date])) {
    const s = await eventSummary(e.id);
    events.push({ ...s.event, registered: s.registered, ...s.totals });
  }
  const sum = k => events.reduce((a, e) => a + e[k], 0);
  const uniq = await get(`SELECT CAST(COUNT(DISTINCT c.user_id) AS INTEGER) AS n FROM checkins c JOIN events e ON e.id=c.event_id WHERE e.date=?`, [date]);
  res.json({ date, events, totals: { registered: sum('registered'), checked_in: sum('checked_in'), present: sum('present'),
    late: sum('late'), manual: sum('manual'), missing: sum('missing'), flagged: sum('flagged'),
    blocked_attempts: sum('blocked_attempts'), unique_students: num(uniq.n) } });
}));
const csvCell = v => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
app.get('/api/events/:id/report.csv', auth('trainer'), h(async (req, res) => {
  const s = await eventSummary(req.params.id);
  if (!s) return res.status(404).send('Not found');
  const fmt = iso => new Date(iso).toLocaleString('en-GB', { timeZone: TZ });
  const lines = [['Student ID', 'Name', 'Email', 'Status', 'Check-in time', 'Flag'].map(csvCell).join(',')];
  [...s.checkins].reverse().forEach(c => lines.push([c.username, c.name, c.email, c.status, fmt(c.ts), c.flag_reason || ''].map(csvCell).join(',')));
  s.missing.forEach(m => lines.push([m.username, m.name, m.email, 'absent', '', ''].map(csvCell).join(',')));
  lines.push('', csvCell('Summary'), ...Object.entries(s.totals).map(([k, v]) => `${csvCell(k)},${csvCell(v)}`));
  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', `attachment; filename="attendance_${s.event.date}_${s.event.name.replace(/\W+/g, '_')}.csv"`);
  res.send('﻿' + lines.join('\r\n'));
}));

app.get('/', (req, res) => res.redirect('/login.html'));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
});

async function start() {
  await db.init();
  return app.listen(PORT, '0.0.0.0', () =>
    console.log(`Attendance system running on http://localhost:${PORT}  (database: ${db.isPg ? 'PostgreSQL' : 'SQLite file'})`));
}
if (require.main === module) start().catch(e => { console.error('Could not start:', e.message); process.exit(1); });
module.exports = { app, qrToken, start };
