# Bootcamp Attendance System

Event registration and attendance tracking with QR check-in, a live trainer dashboard, daily reports, anti-cheat checks and a missing-student list. Students can check in from any network (mobile data, school Wi-Fi, home) once it is hosted online.

## Two ways to run it

| | Online (real events) | Laptop (testing) |
|---|---|---|
| Who can reach it | Anyone, any network | Same Wi-Fi only |
| Link | Fixed `https://...onrender.com` | `http://<laptop-IP>:3000` |
| Data stored in | Neon cloud database (PostgreSQL) | `attendance.db` file on the laptop |

The app picks automatically: if `DATABASE_URL` is set it uses PostgreSQL, otherwise the local SQLite file.

## Put it online (about 20 minutes, free)

You need three free accounts: **GitHub** (stores the code), **Neon** (stores the data), **Render** (runs the app).

**1. Upload the code to GitHub**
1. Create a new **private** repository on github.com, e.g. `bootcamp-attendance`.
2. Click **uploading an existing file** and drag in everything inside this folder **except** `node_modules` and any `.db` file. (`.gitignore` already excludes them if you use Git or GitHub Desktop.)
3. Commit.

**2. Create the database on Neon**
1. Sign up at neon.tech, create a project, region **AWS Asia Pacific (Singapore)**.
2. On the dashboard click **Connect** and copy the connection string. It looks like
   `postgresql://user:password@ep-xxxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`
3. Keep it private. Anyone with this string can read the data.

**3. Run the app on Render**
1. Sign up at render.com with your GitHub account.
2. Click **New** then **Blueprint**, pick your repository. Render reads `render.yaml`.
3. When asked, fill in:
   * `DATABASE_URL`: the Neon string from step 2
   * `ADMIN_PASSWORD`: a strong trainer password (this replaces `admin123`)
4. Click **Apply**. After 2 to 4 minutes you get a link like `https://bootcamp-attendance.onrender.com`.
5. Open it and log in as `admin` with your `ADMIN_PASSWORD`. The tables are created automatically.

**Free plan note:** Render's free service sleeps after 15 minutes with no visitors, and the first visit then takes about 30 to 60 seconds to wake up. Your data is safe in Neon either way. **Open the dashboard 5 minutes before check-in starts** so it is awake. If this becomes annoying, Render's Starter plan (about US$7/month) never sleeps.

Updating later: change the code on GitHub and Render redeploys by itself.

## Before the first real event

1. **My account** tab: change the trainer password if you did not set `ADMIN_PASSWORD`.
2. **Students** tab: key in **Student ID, Name and Email** for each student, or paste a list (`studentID, name, email`, one per line, or three columns copied from Excel).
3. **Events** tab: create the session and tick "Register all active students". These are the names students see when they scan.
4. Do a test run with 2 or 3 people on mobile data.

## On the day

1. Open the dashboard 5 minutes early (wakes the free server).
2. Live dashboard: pick the event, click **Open check-in** then **Show QR**. Project it or print it.
3. Students scan with the phone camera, **choose their name** from the list and tap **Check in**. No login needed.
4. Watch the missing list. Use **Mark present** for flat batteries, and **Undo** in the check-in feed if someone picked the wrong name. Close check-in when done.
5. Reports tab: daily totals. **Download CSV** for the full list.

## Checks that stay in place

Students do not log in, so anyone with the QR can pick any name. These lighter checks remain:

| Check | What it stops |
|---|---|
| QR token is signed (HMAC) and tied to one event | Made-up or edited check-in links |
| **Reset QR** issues a new code | A leaked QR photo being reused |
| Trainer opens and closes check-in, event date only | Check-ins outside session time |
| One check-in per student per event | Double scans |
| One phone, one name per event | One student checking in friends on their phone |
| Checked-in names are greyed out on the list | Picking a name that is already in |
| Trainer login locks after 8 wrong passwords | Guessing the trainer password |

Every blocked attempt is logged with time, student, reason and IP, and shown live on the dashboard.

## Run on a laptop instead

Needs Node.js 22.5 or newer.
```
npm install
npm run seed      # optional demo data: 20 students S001 to S020
npm start         # http://localhost:3000, login admin / admin123
```

## Settings (environment variables)

`DATABASE_URL` (PostgreSQL, enables online mode), `ADMIN_PASSWORD` (first trainer password), `PORT` (3000), `PUBLIC_URL` (force the address in the QR), `TZ_NAME` (Asia/Singapore), `DB_FILE` (SQLite path).

## Tests

`npm test` runs 33 end-to-end checks. Set `DATABASE_URL` to run them against PostgreSQL. Both pass.

## Files

`server.js` API and anti-cheat logic, `db.js` database (PostgreSQL or SQLite), `public/` pages, `seed.js` demo data, `test.js` tests, `render.yaml` hosting setup.
