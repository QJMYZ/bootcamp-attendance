// Small shared helpers for all pages
async function api(url, opts = {}) {
  const res = await fetch(url, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin'
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status });
  return data;
}
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Times are shown in the session's own time zone when one is given (e.g. a Vietnam session viewed from Singapore)
const fmtTime = (iso, tz) => { try { return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz || undefined }); }
  catch { return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); } };
// Regions offered when creating a session. Any other IANA zone the browser knows also works.
const TIMEZONES = [
  ['Asia/Singapore', 'Singapore'], ['Asia/Ho_Chi_Minh', 'Vietnam'], ['Asia/Kuala_Lumpur', 'Malaysia'],
  ['Asia/Bangkok', 'Thailand'], ['Asia/Jakarta', 'Indonesia (Jakarta)'], ['Asia/Makassar', 'Indonesia (Bali, Makassar)'],
  ['Asia/Manila', 'Philippines'], ['Asia/Yangon', 'Myanmar'], ['Asia/Phnom_Penh', 'Cambodia'], ['Asia/Vientiane', 'Laos'],
  ['Asia/Brunei', 'Brunei'], ['Asia/Taipei', 'Taiwan'], ['Asia/Hong_Kong', 'Hong Kong'], ['Asia/Shanghai', 'China'],
  ['Asia/Tokyo', 'Japan'], ['Asia/Seoul', 'South Korea'], ['Asia/Kolkata', 'India'], ['Asia/Dubai', 'UAE'],
  ['Australia/Sydney', 'Australia (Sydney)'], ['Europe/London', 'United Kingdom'], ['Europe/Berlin', 'Germany'],
  ['America/Los_Angeles', 'USA (Pacific)'], ['America/New_York', 'USA (Eastern)'], ['UTC', 'UTC']];
const tzOffsetLabel = tz => { try { return new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date()).find(p => p.type === 'timeZoneName').value; } catch { return ''; } };
const tzName = tz => (TIMEZONES.find(z => z[0] === tz) || [tz, String(tz || '').split('/').pop().replace(/_/g, ' ')])[1];
const tzLabel = (tz, off) => `${tzName(tz)} time (${off || tzOffsetLabel(tz)})`;
const today = () => new Date().toLocaleDateString('en-CA');
const fmtDate = ymd => new Date(ymd + 'T00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
async function requireLogin(role) {
  try {
    const me = await api('/api/me');
    if (role && me.role !== role) { location.href = '/'; return null; }
    return me;
  } catch { location.href = '/login.html?next=' + encodeURIComponent(location.pathname + location.search); return null; }
}
async function logout() { await api('/api/logout', { body: {} }); location.href = '/login.html'; }

// Short message at the bottom of the screen (instead of a pop-up)
function toast(text) {
  document.querySelector('.toast')?.remove();
  const t = Object.assign(document.createElement('div'), { className: 'toast', textContent: text });
  t.setAttribute('role', 'status');
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

// Wafer map: one die per student, laid out on a round wafer like a semiconductor yield map.
// dies = [{ state: 'present'|'late'|'manual'|'missing', title, id }]
function waferLayout(n) {
  for (let g = Math.max(3, Math.ceil(Math.sqrt(n * 1.35)) + 1); g < 60; g++) {
    const s = 92 / g, cells = [];
    for (let r = 0; r < g; r++) for (let c = 0; c < g; c++) {
      const x = 4 + c * s, y = 4 + r * s;
      const corners = [[x, y], [x + s, y], [x, y + s], [x + s, y + s]];
      if (corners.every(([px, py]) => (px - 50) ** 2 + (py - 50) ** 2 <= 45.5 ** 2)) cells.push({ x, y, s });
    }
    if (cells.length >= n) {
      // stretch the grid so the outer dies sit near the wafer edge (small classes would otherwise huddle in the middle)
      let maxR = 0;
      cells.forEach(({ x, y, s }) => [[x, y], [x + s, y], [x, y + s], [x + s, y + s]].forEach(([px, py]) => { maxR = Math.max(maxR, Math.hypot(px - 50, py - 50)); }));
      const k = 44 / maxR;
      return cells.map(({ x, y, s }) => ({ x: 50 + (x - 50) * k, y: 50 + (y - 50) * k, s: s * k }));
    }
  }
  return [];
}
function drawWafer(el, dies, { onDie } = {}) {
  const cells = waferLayout(Math.max(dies.length, 1));
  const gap = cells.length ? cells[0].s * 0.14 : 0;
  // notch at the bottom edge, like a real wafer
  let svg = `<svg viewBox="0 0 100 100" role="img" aria-label="Wafer map: ${dies.filter(d => d.state !== 'missing').length} of ${dies.length} checked in">
    <path class="edge" d="M50 1.5 A48.5 48.5 0 1 1 49.99 1.5 Z M47.5 98.4 L50 95.6 L52.5 98.4"/>`;
  cells.forEach((c, i) => {
    const d = dies[i];
    const cls = d ? d.state + (onDie && d.id != null ? ' clickable' : '') : 'unused';
    svg += `<rect class="die ${cls}" ${d && d.id != null ? `data-i="${i}"` : ''} x="${(c.x + gap / 2).toFixed(2)}" y="${(c.y + gap / 2).toFixed(2)}"
      width="${(c.s - gap).toFixed(2)}" height="${(c.s - gap).toFixed(2)}" rx="${(c.s * 0.08).toFixed(2)}">${d ? `<title>${esc(d.title)}</title>` : ''}</rect>`;
  });
  el.innerHTML = svg + '</svg>';
  if (onDie) el.querySelectorAll('[data-i]').forEach(r => r.addEventListener('click', () => onDie(dies[r.dataset.i])));
}

// Overview ring: how many students are checked in, coloured by on time / late / marked.
// t = summary totals, total = students on the class list
function drawRing(el, t, total) {
  const R = 40, C = 2 * Math.PI * R;
  const parts = [[t.present, 'var(--green)'], [t.late, 'var(--amber)'], [t.manual, 'var(--marked)']];
  let offset = 0, arcs = '';
  parts.forEach(([n, color]) => {
    if (!n || !total) return;
    const len = n / total * C;
    arcs += `<circle class="ring-arc" cx="50" cy="50" r="${R}" stroke="${color}" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}"/>`;
    offset += len;
  });
  const pct = total ? Math.round(t.checked_in / total * 100) : 0;
  el.innerHTML = `<svg viewBox="0 0 100 100" role="img" aria-label="${t.checked_in} of ${total} students checked in">
      <g transform="rotate(-90 50 50)"><circle class="ring-track" cx="50" cy="50" r="${R}"/>${arcs}</g></svg>
    <div class="ring-center"><b>${t.checked_in}</b><span>of ${total} checked in</span><em>${pct}%</em></div>`;
}

// ---------- light / dark theme ----------
// Saved choice wins; otherwise follow the device setting. The <head> of each page sets it early so there is no flash.
const THEME_KEY = 'att_theme';
function savedTheme() { try { return localStorage.getItem(THEME_KEY); } catch { return null; } }
function systemTheme() { return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
function currentTheme() { return document.documentElement.dataset.theme || 'light'; }
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'dark' ? '#101418' : '#F2F5F3');
  document.querySelectorAll('[data-theme-icon]').forEach(el => { el.innerHTML = t === 'dark' ? ICONS.sun : ICONS.moon; el.title = t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'; });
}
function toggleTheme() {
  const t = currentTheme() === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, t); } catch {}
  applyTheme(t);
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { const s = savedTheme(); if (s !== 'light' && s !== 'dark') applyTheme(systemTheme()); });

// ---------- small helpers ----------
const initials = name => String(name || '').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
const avatar = name => `<span class="av" aria-hidden="true">${esc(initials(name))}</span>`;
const ICONS = {
  live: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="2.5"/><path d="M6.3 6.3a8 8 0 0 0 0 11.4M17.7 6.3a8 8 0 0 1 0 11.4"/></svg>',
  cal: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  people: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6 6 0 0 1 3.5 5.5"/></svg>',
  chart: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20V11M10 20V4M16 20v-7M21 20H3"/></svg>',
  user: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  qr: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/></svg>',
  download: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0-5-5m5 5 5-5M4 20h16"/></svg>',
  lock: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
  unlock: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.5-2"/></svg>',
  refresh: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 0 0-14.5-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5L20 16M20 20v-4h-4"/></svg>',
  plus: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  search: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>',
  out: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l5-5-5-5M15 12H3"/></svg>',
  moon: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/></svg>',
  sun: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  print: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 9V3h10v6M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2M7 14h10v7H7z"/></svg>',
  full: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
};
document.addEventListener('DOMContentLoaded', () => applyTheme(currentTheme()));
