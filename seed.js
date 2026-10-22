// Adds 20 demo students and a "today" event so you can try the system.
// For a real bootcamp, skip this and add real students in the Students tab.
const crypto = require('crypto');
const db = require('./db');
const names = ['Tan Wei Ming', 'Nur Aisyah', 'Rajesh Kumar', 'Lim Jia Hui', 'Muhammad Faris', 'Chloe Ng', 'Arjun Pillai', 'Siti Nurhaliza',
  'Ong Kai Xiang', 'Priya Devi', 'Lee Jun Hao', 'Farah Amira', 'Darren Goh', 'Kavya Menon', 'Ryan Teo', 'Nadia Rahman',
  'Ethan Koh', 'Hui Min Chua', 'Aaron Sim', 'Melissa Wong'];
async function seed() {
  await db.init();
  let added = 0;
  for (const [i, n] of names.entries()) {
    const id = 'S' + String(i + 1).padStart(3, '0');
    if (await db.get('SELECT 1 AS x FROM users WHERE username=?', [id])) continue;
    await db.run("INSERT INTO users (username,name,role,email,salt,pass_hash) VALUES (?,?,'student',?,'','')", [id, n, n.toLowerCase().replace(/[^a-z]+/g, '.') + '@example.com']); added++;
  }
  const date = new Date().toLocaleDateString('en-CA', { timeZone: process.env.TZ_NAME || 'Asia/Singapore' });
  if (!(await db.get('SELECT 1 AS x FROM events WHERE date=?', [date]))) {
    const r = await db.run('INSERT INTO events (name,date,start_time,late_after_min,secret) VALUES (?,?,?,?,?) RETURNING id',
      ['Bootcamp Day 1 (demo)', date, '09:00', 15, crypto.randomBytes(32).toString('hex')]);
    await db.run(`INSERT INTO registrations (event_id,user_id) SELECT CAST(? AS INTEGER), id FROM users WHERE role='student' AND active=1 ON CONFLICT DO NOTHING`, [r.rows[0].id]);
  }
  console.log(`Seeded ${added} demo students (S001 to S020) and today's demo event.`);
}
module.exports = seed;
if (require.main === module) seed().then(() => db.close()).catch(e => { console.error(e); process.exit(1); });
