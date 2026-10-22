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
  // Large class: no limit on students
  const big = Array.from({ length: 250 }, (_, i) => ({ username: `BIG${i + 1}`, name: `Big Class Student ${i + 1}`, email: `big${i + 1}@example.com` }));
  const bigAdd = (await T('/api/students', { rows: big })).body;
  ok(bigAdd.added === 250 && bigAdd.errors.length === 0, 'add 250 students in one paste');
  ok((await T('/api/students')).body.filter(x => x.username.startsWith('BIG')).length === 250, 'all 250 appear on the class list');
  ok((await C()(`/api/checkin/names?e=${ev.id}&t=${newTok}`)).body.names.filter(n => n.username.startsWith('BIG')).length === 250, "all 250 appear on today's check-in name list");
  ok((await C()('/api/login', { username: 'BIG1', password: '' })).status === 401, 'students still cannot sign in to the dashboard');

  // Student list stays in sync with session lists
  const future = (await T('/api/events', { name: 'Future Day', date: '2099-02-02', start_time: '09:00', late_after_min: 15, register_all: true })).body.id;
  const onList = async id => (await T(`/api/events/${id}/summary`)).body;
  const sync = (await T('/api/students', { rows: [{ username: 'SYNC1', name: 'Sync Student', email: 'sync1@example.com' }] })).body;
  ok(sync.added === 1 && (await onList(future)).missing.some(m => m.username === 'SYNC1'), 'added student appears on upcoming session automatically');
  const syncId = (await T('/api/students')).body.find(x => x.username === 'SYNC1').id;
  const beforeFuture = (await onList(future)).registered, beforeToday = (await onList(ev.id)).registered;
  await T(`/api/students/${syncId}`, null, 'DELETE');
  const af = await onList(future), at = await onList(ev.id);
  ok(!af.missing.some(m => m.username === 'SYNC1') && af.registered === beforeFuture - 1, 'removed student comes off upcoming session and its count drops');
  ok(!at.missing.some(m => m.username === 'SYNC1') && at.registered === beforeToday - 1, "removed student comes off today's session too");
  ok(!(await C()(`/api/checkin/names?e=${ev.id}&t=${newTok}`)).body.names.some(n => n.username === 'SYNC1'), 'removed student no longer on the check-in name list');
  // a student who already checked in keeps their record after being removed
  const s1 = (await T('/api/students')).body.find(x => x.username === 'S001').id;
  const keepBefore = (await onList(ev.id)).registered;
  await T(`/api/students/${s1}`, null, 'DELETE');
  const keep = await onList(ev.id);
  ok(keep.checkins.some(c => c.username === 'S001') && keep.registered === keepBefore, 'removed student who already checked in keeps their attendance record');
  // re-adding brings them back onto upcoming sessions
  await T('/api/students', { rows: [{ username: 'SYNC1', name: 'Sync Student', email: 'sync1@example.com' }] });
  ok((await onList(future)).missing.some(m => m.username === 'SYNC1'), 're-added student is back on upcoming session');
  await T('/api/students', { rows: [{ username: 'S001', name: 'Tan Wei Ming', email: 'tan.wei.ming@example.com' }] });

  // Edit a session's start time: statuses are re-checked
  const nowSg = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Singapore', hour12: false }).slice(0, 5);
  const before = (await T(`/api/events/${ev.id}/summary`)).body.checkins.filter(c => c.status === 'late').length;
  const upd = (await T(`/api/events/${ev.id}/update`, { start_time: nowSg, late_after_min: 15 })).body;
  const after = (await T(`/api/events/${ev.id}/summary`)).body;
  ok(upd.ok && after.event.start_time === nowSg && after.checkins.filter(c => c.status === 'late').length === 0, `editing start time re-marks late check-ins as on time (${before} late before, ${upd.changed} changed)`);
  ok(after.checkins.some(c => c.status === 'manual'), 'trainer-marked check-ins are left alone');
  await T(`/api/events/${ev.id}/update`, { start_time: '09:00', late_after_min: 15 });

  // Per-session time zone (e.g. a bootcamp in Vietnam, server in Singapore)
  const inTz = tz => { const d = new Date(); return { date: d.toLocaleDateString('en-CA', { timeZone: tz }), time: d.toLocaleTimeString('en-GB', { timeZone: tz, hour12: false }).slice(0, 5) }; };
  ok((await T('/api/events', { name: 'Bad zone', date: '2099-01-01', start_time: '09:00', timezone: 'Mars/Olympus' })).status === 400, 'unknown time zone rejected');
  const vn = inTz('Asia/Ho_Chi_Minh');
  const vnId = (await T('/api/events', { name: 'Hanoi Day', date: vn.date, start_time: vn.time, late_after_min: 0, register_all: true, timezone: 'Asia/Ho_Chi_Minh' })).body.id;
  await T(`/api/events/${vnId}/open`, { open: true });
  const vnTok = new URL((await T(`/api/events/${vnId}/qr`)).body.url).searchParams.get('t');
  const vnList = (await C()(`/api/checkin/names?e=${vnId}&t=${vnTok}`)).body;
  ok(vnList.timezone === 'Asia/Ho_Chi_Minh' && vnList.tz_offset === 'GMT+7' && vnList.today, `phone gets the session zone (${vnList.tz_offset}) and "today" uses it`);
  const vnR = (await C()('/api/checkin', { eventId: vnId, token: vnTok, studentId: vnList.names[0].id })).body;
  ok(vnR.status === 'present' && vnR.time === vn.time, `check-in at ${vn.time} Vietnam time is on time for a ${vn.time} Vietnam start`);
  const vnSum = (await T(`/api/events/${vnId}/summary`)).body.event;
  ok(vnSum.timezone === 'Asia/Ho_Chi_Minh' && vnSum.now_local === vn.time, 'live dashboard shows the time in Vietnam');
  const tk = (await T(`/api/events/${vnId}/update`, { start_time: vn.time, late_after_min: 0, timezone: 'Asia/Tokyo' })).body;
  ok(tk.ok && tk.changed === 1 && (await T(`/api/events/${vnId}/summary`)).body.checkins[0].status === 'late', 'switching the zone to Japan (2 h ahead) re-marks that check-in late');
  await T(`/api/events/${vnId}/update`, { timezone: 'Asia/Ho_Chi_Minh' });
  ok((await T(`/api/events/${vnId}/summary`)).body.checkins[0].status === 'present', 'switching back to Vietnam makes it on time again');
  const csvVn = (await T(`/api/events/${vnId}/report.csv`)).body;
  ok(String(csvVn).includes('Asia/Ho_Chi_Minh, GMT+7'), 'CSV says which time zone the times are in');
  const old = (await T('/api/events')).body.find(e => e.id === ev.id);
  ok(old.timezone === 'Asia/Singapore', 'sessions without a zone use the server default (Singapore)');
  await T(`/api/events/${vnId}`, null, 'DELETE');

  // Multiple trainer accounts
  ok((await T('/api/trainers', { username: 'ms.tan', name: 'Ms Tan', password: 'TanPass2026' })).body.ok, 'add a second trainer');
  ok((await T('/api/trainers', { username: 'MS.TAN', name: 'Dup', password: 'whatever123' })).status === 409, 'duplicate trainer username rejected');
  ok((await T('/api/trainers', { username: 'S001', name: 'Clash', password: 'whatever123' })).status === 409, 'username that is a student ID rejected');
  ok((await T('/api/trainers', { username: 'mr lee', name: 'Mr Lee', password: 'whatever123' })).status === 400, 'username with a space rejected');
  ok((await T('/api/trainers', { username: 'mr.lee', name: 'Mr Lee', password: 'short' })).status === 400, 'short trainer password rejected');
  const T2 = C();
  ok((await T2('/api/login', { username: 'ms.tan', password: 'TanPass2026' })).status === 200, 'second trainer signs in with own username and password');
  ok((await T2('/api/events')).status === 200, 'second trainer can see sessions');
  const tl = (await T('/api/trainers')).body;
  const tanId = tl.find(x => x.username === 'ms.tan').id, adminId = tl.find(x => x.username === 'admin').id;
  ok(tl.length === 2 && tl.find(x => x.username === 'admin').me, 'trainer list shows both, marks "you"');
  ok((await T(`/api/trainers/${tanId}/password`, { password: 'NewTanPass99' })).body.ok, 'admin sets a new password for Ms Tan');
  ok((await T2('/api/events')).status === 401 && (await C()('/api/login', { username: 'ms.tan', password: 'NewTanPass99' })).status === 200, 'old sign-in ends, new password works');
  ok((await T(`/api/trainers/${adminId}`, null, 'DELETE')).status === 400, "can't remove your own account");
  ok((await T(`/api/trainers/${tanId}`, null, 'DELETE')).body.ok && (await C()('/api/login', { username: 'ms.tan', password: 'NewTanPass99' })).status === 401, 'removed trainer can no longer sign in');
  ok((await T('/api/me/password', { oldPassword: 'admin123', newPassword: 'short' })).status === 400, 'trainer password must be 8+ characters');
  ok((await T('/api/me/password', { oldPassword: 'admin123', newPassword: 'Bootcamp2026!' })).status === 200, 'trainer password changed');

  console.log(`\n${pass} passed, ${fail} failed`);
  srv.close(); await db.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
