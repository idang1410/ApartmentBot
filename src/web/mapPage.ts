/**
 * The map page. It reads its token from its own URL, fetches /api/listings
 * with it, and posts status and note changes to /api/status and /api/note.
 */
export const MAP_PAGE = `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>מפת דירות</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<style>
  html, body { margin: 0; height: 100%; font-family: system-ui, sans-serif; }
  #map { position: absolute; inset: 0; }
  #bar { position: absolute; z-index: 1000; top: 10px; right: 10px; left: 60px; max-width: 420px;
    background: #fff; border-radius: 8px; box-shadow: 0 1px 6px rgba(0,0,0,.3);
    padding: 8px 10px; font-size: 14px; display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; }
  #bar select { font-size: 14px; }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; vertical-align: middle; }
  .popup { direction: rtl; text-align: right; min-width: 180px; font-size: 14px; }
  .popup img { width: 100%; max-height: 140px; object-fit: cover; border-radius: 4px; margin-bottom: 4px; }
  .popup b { font-size: 16px; }
  .muted { color: #666; font-size: 12px; }
  .track { margin-top: 6px; display: flex; flex-direction: column; gap: 4px; }
  .track textarea { font: inherit; min-height: 40px; }
</style>
</head>
<body>
<div id="map"></div>
<div id="bar">
  <label><input type="checkbox" id="exact"> מדויקות בלבד</label>
  <label><input type="checkbox" id="rejected"> הצג לא רלוונטיות</label>
  <label>עד <select id="days">
    <option>1</option><option>3</option><option>7</option><option selected>14</option>
  </select> ימים</label>
  <span><span class="dot" style="background:#1a7f37"></span> מדויק
    <span class="dot" style="background:#e8890c"></span> קרוב
    <span class="dot" style="background:#1f6feb"></span> מסומן</span>
  <span id="count" class="muted"></span>
</div>
<script>
const token = new URLSearchParams(location.search).get('t');
const map = L.map('map').setView([32.0853, 34.7818], 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);
const layer = L.layerGroup().addTo(map);
let pins = [], pending = 0, retry;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeUrl = (u) => /^https?:\\/\\//.test(u ?? '') ? esc(u) : '';
const STATUSES = [['interested', '⭐ מעניין', '#d4a106'], ['contacted', '📞 בקשר', '#1f6feb'],
  ['visit_scheduled', '📅 נקבע ביקור', '#8250df'], ['visited', '👀 ביקרתי', '#0a7d74'],
  ['rejected', '❌ לא רלוונטי', '#999'], ['taken', '🚫 נלקח', '#444']];

function trackForm(p, i) {
  const options = STATUSES.map(([code, label]) =>
    '<option value="' + code + '"' + (p.status === code ? ' selected' : '') + '>' + label + '</option>').join('');
  const notes = (p.notes ?? []).map((n) =>
    '<div class="muted">' + esc(n.at.slice(0, 16)) + ' · ' + esc(n.text) + '</div>').join('');
  return '<div class="track">' + (p.phone ? '<div>📞 ' + esc(p.phone) + '</div>' : '') + notes +
    '<select data-status="' + i + '"><option value="">סטטוס…</option>' + options + '</select>' +
    '<textarea data-note="' + i + '" maxlength="500" placeholder="הערה או טלפון"></textarea>' +
    '<button data-save="' + i + '">שמור הערה</button></div>';
}

async function post(path, body) {
  const res = await fetch(path + '?t=' + encodeURIComponent(token), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(res.status);
  return res.json();
}

async function change(i, path, body) {
  const p = pins[i];
  try {
    const { status, phone, notes } = await post(path, { ref: p.ref, ...body });
    Object.assign(p, { status, phone, notes });
    map.closePopup();
    draw();
  } catch (e) {
    alert('השמירה נכשלה');
  }
}

document.addEventListener('change', (e) => {
  const i = e.target.dataset?.status;
  if (i !== undefined && e.target.value) change(Number(i), 'api/status', { status: e.target.value });
});
document.addEventListener('click', (e) => {
  const i = e.target.dataset?.save;
  if (i === undefined) return;
  const text = document.querySelector('[data-note="' + i + '"]').value.trim();
  if (text) change(Number(i), 'api/note', { text });
});

function popup(p, i) {
  const facts = [p.rooms && p.rooms + ' חד׳', p.sqm && p.sqm + ' מ״ר'].filter(Boolean).join(' · ');
  const img = safeUrl(p.image) ? '<img src="' + safeUrl(p.image) + '" loading="lazy">' : '';
  return '<div class="popup">' + img +
    '<b>' + (p.price ? '₪' + p.price.toLocaleString('he-IL') : 'מחיר לא צוין') + '</b>' +
    (facts ? '<div>' + facts + '</div>' : '') +
    '<div>' + esc(p.place) + (p.approximate ? ' <span class="muted">(מיקום משוער)</span>' : '') + '</div>' +
    '<div class="muted">' + esc(p.source) + ' · ' + (p.matchKind === 'near' ? 'קרוב' : 'מדויק') +
    ' · נראה ' + new Date(p.firstSeen).toLocaleDateString('he-IL') + '</div>' +
    (safeUrl(p.url) ? '<a href="' + safeUrl(p.url) + '" target="_blank" rel="noopener">למודעה</a>' : '') +
    trackForm(p, i) + '</div>';
}

function draw() {
  const exactOnly = document.getElementById('exact').checked;
  const showRejected = document.getElementById('rejected').checked;
  const since = Date.now() - Number(document.getElementById('days').value) * 86400000;
  layer.clearLayers();
  let shown = 0;
  for (const [i, p] of pins.entries()) {
    if (exactOnly && p.matchKind !== 'exact') continue;
    if (!showRejected && p.status === 'rejected') continue;
    if (Date.parse(p.firstSeen) < since) continue;
    const tracked = STATUSES.find(([code]) => code === p.status);
    const color = tracked ? tracked[2] : p.matchKind === 'exact' ? '#1a7f37' : '#e8890c';
    const marker = p.approximate
      ? L.circle([p.lat, p.lng], { radius: 300, color, weight: 2, dashArray: '6 6', fillOpacity: 0.1 })
      : L.circleMarker([p.lat, p.lng], { radius: 9, color: '#fff', weight: 2, fillColor: color, fillOpacity: 0.9 });
    marker.bindPopup(popup(p, i), { maxWidth: 260 }).addTo(layer);
    shown++;
  }
  document.getElementById('count').textContent =
    shown + ' דירות' + (pending ? ' · ממקם עוד ' + pending : '');
}

async function load() {
  clearTimeout(retry);
  try {
    const res = await fetch('api/listings?t=' + encodeURIComponent(token));
    ({ pins, pending } = await res.json());
    draw();
  } catch (e) {
    document.getElementById('count').textContent = 'שגיאה בטעינה';
  }
  // Unplaced listings are being geocoded at one a second; look again soon.
  if (pending) retry = setTimeout(load, 15000);
}

document.getElementById('exact').onchange = draw;
document.getElementById('rejected').onchange = draw;
document.getElementById('days').onchange = draw;
load();
setInterval(load, 5 * 60 * 1000);
</script>
</body>
</html>
`;
