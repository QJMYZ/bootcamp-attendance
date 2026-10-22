// End-to-end tests. Uses a throwaway SQLite file, or PostgreSQL if DATABASE_URL is set.
if (!process.env.DATABASE_URL) process.env.DB_FILE = require('path').join(require('os').tmpdir(), 'att_test_' + Date.now() + '.db');
const { app } = require('./server');
const db = require('./db');
const seed = require('./seed');

// Each client keeps its own cookies, like a separate phone or browser.
function client(base, initCookies = {}, ip) {
  const cookies = { ...initCookies };
  const call = async (path, body, method) => {
    const headers = { 'Content-Type': 'application/json', Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ') };
    if (ip) headers['X-Forwarded-For'] = ip;
    const r = await fetch(base + path, { method: method || (body ? 'POST' : 'GET'), headers, body: body && JSON.stringify(body) });
    r.headers.getSetCookie().forEach(s => { const kv = s.split(';')[0]; const i = kv.indexOf('='); cookies[kv.slice(0, i)] = kv.slice(i + 1); });
    const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, body: data };
  };
  call.cookies = cookies;
  return call;
}
let pass = 0, fail = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); cond ? pass++ : fail++; };

(async () => {
  await seed();
  const srv = app.listen(0);
  const base = `http://localhost:${srv.address().port}`;
  const C = (init, ip) => client(base, init, ip);
  const T = C();
  console.log(`Database: ${db.isPg ? 'PostgreSQL' : 'SQLite'}`);

  ok((await C()('/healthz')).body.ok, 'health check');
  ok((await T('/api/login', { username: 'admin', password: 'admin123' })).status === 200, 'trainer login');
  ok((await C()('/api/login', { username: 'S001', password: 'anything' })).status === 401, 'students cannot log in (no student login)');
  ok((await C()('/api/events')).status === 401, 'event list needs trainer login');

  const ev = (await T('/api/events')).body[0];
  const qr = await T(`/api/events/${ev.id}/qr`);
  ok(qr.body.dataUrl?.startsWith('data:image/png'), 'QR image generated');
  const tok = new URL(qr.body.url).searchParams.get('t');
  ok((await T(`/api/events/${ev.id}/qr`)).body.url === qr.body.url, 'QR stays the same (fixed code)');

  // Name list after scanning
  const phoneA = C();
  ok((await phoneA(`/api/checkin/names?e=${ev.id}&t=wrongcode`)).status === 400, 'name list hidden without the right QR code');
  const list = (await phoneA(`/api/checkin/names?e=${ev.id}&t=${tok}`)).body;
  ok(list.names.length === 20 && list.names.every(n => n.name && n.username), `name list shows ${list.names.length} registered students`);
  ok(list.names.map(n => n.name).join() === [...list.names.map(n => n.name)].sort().join(), 'names sorted A to Z');
  const byId = u => list.names.find(n => n.username === u).id;

  ok((await phoneA('/api/checkin', { eventId: ev.id, token: tok, studentId: byId('S001') })).status === 400, 'blocked while check-in is closed');
  await T(`/api/events/${ev.id}/open`, { open: true });
  ok((await phoneA('/api/checkin', { eventId: ev.id, token: tok })).status === 404, 'must choose a name');
  ok((await phoneA('/api/checkin', { eventId: ev.id, token: 'fakecode12345678', studentId: byId('S001') })).status === 400, 'fake QR link blocked');
  const r1 = await phoneA('/api/checkin', { eventId: ev.id, token: tok, studentId: byId('S001') });
  ok(r1.status === 200 && r1.body.name === 'Tan Wei Ming', `S001 picks name and checks in (${r1.body.status})`);
  ok((await phoneA('/api/checkin', { eventId: ev.id, token: tok, studentId: byId('S001') })).status === 409, 'same name twice blocked');
  ok((await phoneA(`/api/checkin/names?e=${ev.id}&t=${tok}`)).body.names.find(n => n.username === 'S001').checked_in === 1, 'checked-in name marked on the list');
  ok((await phoneA('/api/checkin', { eventId: ev.id, token: tok, studentId: byId('S002') })).status === 403, 'one phone cannot check in a second name');
  const phoneB = C();
  ok((await phoneB('/api/checkin', { eventId: ev.id, token: tok, studentId: byId('S002') })).status === 200, 'S002 checks in on own phone');

  await T(`/api/events/${ev.id}/reset-qr`, {});
  const phoneC = C();
  ok((await phoneC('/api/checkin', { eventId: ev.id, token: tok, studentId: byId('S003') })).status === 400, 'old QR blocked after Reset QR');
  const newTok = new URL((await T(`/api/events/${ev.id}/qr`)).body.url).searchParams.get('t');
  ok((await phoneC('/api/checkin', { eventId: ev.id, token: newTok, studentId: byId('S004') })).status === 200, 'new QR works after reset');

  // Undo a wrong pick: phone C picked S004 by mistake
  ok((await T(`/api/events/${ev.id}/checkins/${byId('S004')}`, null, 'DELETE')).body.ok, 'trainer undoes a wrong check-in');

  // Add students: ID, name, email (no PIN)
  const add = await T('/api/students', { rows: [{ username: 'R001', name: 'Real Student', email: 'Real.Student@Example.com' }] });
  ok(add.body.added === 1 && add.body.created[0].email === 'real.student@example.com' && !('pin' in add.body.created[0]), 'add student with ID, name and email (no PIN)');
  const bad = await T('/api/students', { rows: [
    { username: 'R002', name: 'No Email' }, { username: 'R003', name: 'Bad Email', email: 'not-an-email' },
    { username: 'R004', name: 'Same Email', email: 'real.student@example.com' }, { username: 'R001', name: 'Same ID', email: 'other@example.com' }] });
  ok(bad.body.added === 0 && bad.body.errors.length === 4, 'rejects missing email, invalid email, duplicate email and duplicate ID');
  // R001 is not registered for the event: still shown? (list shows registered only once some exist)
  const rid = (await T('/api/students')).body.find(s => s.username === 'R001').id;
  ok((await phoneC(`/api/checkin/names?e=${ev.id}&t=${newTok}`)).body.names.some(n => n.id === rid), "new student joins today's session list automatically");
  await T(`/api/events/${ev.id}/register-all`, {});
  ok((await phoneC(`/api/checkin/names?e=${ev.id}&t=${newTok}`)).body.names.some(n => n.id === rid), 'appears after "Register all"');
  // Session first, students after: new students join today's and future sessions automatically
  const s2 = (await T('/api/events', { name: 'Day 2', date: '2099-01-01', start_time: '09:00', late_after_min: 15, register_all: false })).body.id;
  ok(s2 > 0, 'trainer creates a session through the API');
  await T('/api/students', { rows: [{ username: 'R010', name: 'Late Joiner', email: 'late.joiner@example.com' }] });
  ok((await T(`/api/events/${s2}/summary`)).body.missing.some(m => m.username === 'R010'), 'student added after the session is on its class list');

  // Brute force protection on trainer login
  const G = C({}, '10.9.9.9'); let last;
  for (let i = 0; i < 9; i++) last = await G('/api/login', { username: 'admin', password: 'guess' + i });
  ok(last.status === 429, 'trainer login locked after 8 wrong passwords');

  const sum = (await T(`/api/events/${ev.id}/summary`)).body;
  ok(sum.totals.checked_in === 2 && sum.totals.missing === 20, `live summary: ${sum.totals.checked_in} in, ${sum.totals.missing} missing`);
  ok(sum.missing.some(m => m.username === 'S004'), 'undone student is back on the missing list');
  ok(sum.suspicious.some(s => s.reason.startsWith('Same phone')), 'anti-cheat log records the shared phone attempt');
  ok((await T(`/api/events/${ev.id}/manual`, { userId: byId('S003') })).body.ok, 'trainer marks S003 present manually');

  const rep = (await T('/api/reports/daily')).body.totals;
  ok(rep.checked_in === 3, `daily report: ${rep.checked_in} checked in, ${rep.missing} absent, ${rep.blocked_attempts} blocked`);
  const csv = await T(`/api/events/${ev.id}/report.csv`);
  ok(typeof csv.body === 'string' && csv.body.includes('S001') && csv.body.includes('absent') && csv.body.includes('@example.com'), 'CSV export has present and absent rows with email');
  ok((await T('/api/me/name', { name: 'Ms Tan (Trainer)' })).body.name === 'Ms Tan (Trainer)' && (await T('/api/me')).body.name === 'Ms Tan (Trainer)', 'trainer changes display name');
  ok((await T('/api/me/name', { name: '   ' })).status === 400, 'blank display name rejected');
  ok((await T('/api/me/password', { oldPassword: 'admin123', newPassword: 'short' })).status === 400, 'trainer password must be 8+ characters');
  ok((await T('/api/me/password', { oldPassword: 'admin123', newPassword: 'Bootcamp2026!' })).status === 200, 'trainer password changed');

  console.log(`\n${pass} passed, ${fail} failed`);
  srv.close(); await db.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
