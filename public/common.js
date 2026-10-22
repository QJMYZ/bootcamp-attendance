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
const fmtTime = iso => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
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
  const parts = [[t.present, 'var(--green)'], [t.late, 'var(--amber)'], [t.manual, 'var(--green-ink)']];
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
