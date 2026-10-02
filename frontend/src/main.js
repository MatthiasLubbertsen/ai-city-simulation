import './style.css';
import Chart from 'chart.js/auto';
import { CityScene, MODE_COLORS } from './scene.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hex = (n) => '#' + n.toString(16).padStart(6, '0');
const MODE_NAMES = ['Idle', 'Werkt', 'Eet', 'Hongerig', 'Binnen', 'Overleden'];
const JOBS = { farmer: 'Landbouwer', maker: 'Maker', medic: 'Zorgverlener' };
const TASKS = { work: 'aan het werk', eat: 'eet', sleep: 'slaapt', ration: 'onderweg naar eten', leisure: 'ontspant', rest: 'rust uit', depot_visit: 'naar het depot (ruilen)', await_drone: 'wacht op de drone', sample: 'geeft sample', hospital: 'in het ziekenhuis' };

const S = { items: {}, citizens: new Map(), live: null, history: [], selected: null, feedFilter: new Set(['eten', 'werk', 'ruil', 'zorg', 'overheid', 'dood']), minutes: 0 };
const scene = new CityScene($('#c'), $('#labels'));

// ---- logboek-categorieën ------------------------------------------------------
const CATS = {
  eten: ['ration', 'eat', 'subsidy', 'subsidy_delivered'],
  werk: ['work', 'produce', 'job_change', 'order_rest'],
  ruil: ['trade', 'trade_denied', 'rebalance', 'rebalance_give', 'rebalance_get', 'census_total', 'audit_fraud', 'audit_ok'],
  zorg: ['sick', 'appointment', 'drone_dispatch', 'sampling', 'sample_sent', 'lab_positive', 'lab_negative', 'lab_fraud', 'lab_missed', 'medicine_delivered', 'admitted', 'recover', 'no_show'],
  overheid: ['decision', 'announcement', 'new_day', 'start'],
  gedachten: ['think'],
  dood: ['death'],
  detail: ['census', 'wake'],
};
const CAT_OF = {}; for (const [k, v] of Object.entries(CATS)) v.forEach((t) => { CAT_OF[t] = k; });
const CAT_LABELS = { eten: '🍽 Eten', werk: '🏭 Werk', ruil: '🔁 Ruilen', zorg: '🏥 Zorg', overheid: '🏛 Overheid', gedachten: '💭 Gedachten', dood: '☠ Sterfte', detail: '📋 Details' };

function buildFilters() {
  $('#filters').innerHTML = Object.keys(CAT_LABELS).map((k) => `<button class="chip ${S.feedFilter.has(k) ? 'on' : ''}" data-k="${k}">${CAT_LABELS[k]}</button>`).join('');
  $('#filters').onclick = (e) => {
    const k = e.target.dataset?.k; if (!k) return;
    S.feedFilter.has(k) ? S.feedFilter.delete(k) : S.feedFilter.add(k);
    buildFilters(); rebuildFeed();
  };
}
let feedEvents = [];
function evHtml(e) {
  const day = e.day ?? Math.floor((e.minute ?? 0) / 1440), time = e.time ?? fmtMin(e.minute);
  return `<div class="ev t-${e.type} ${e.actor ? 'click' : ''}" data-a="${e.actor || ''}"><time>d${day} ${time}</time><span>${esc(e.text)}</span></div>`;
}
const fmtMin = (m) => { m = Math.floor(m % 1440); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
function rebuildFeed() {
  const el = $('#feed');
  el.innerHTML = feedEvents.filter((e) => S.feedFilter.has(CAT_OF[e.type] || 'detail')).slice(-160).reverse().map(evHtml).join('');
}
function pushEvents(list) {
  feedEvents.push(...list); if (feedEvents.length > 600) feedEvents = feedEvents.slice(-500);
  const el = $('#feed'), vis = list.filter((e) => S.feedFilter.has(CAT_OF[e.type] || 'detail'));
  if (!vis.length) return;
  el.insertAdjacentHTML('afterbegin', vis.reverse().map(evHtml).join(''));
  while (el.children.length > 220) el.lastChild.remove();
}
$('#feed').addEventListener('click', (e) => { const a = e.target.closest('.ev')?.dataset.a; if (a) selectCitizen(+a, true); });

// ---- websocket ------------------------------------------------------------------
let ws, retry = 0, built = false;
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => { retry = 0; };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    switch (m.type) {
      case 'hello': onHello(m); break;
      case 'frame': scene.applyFrame(m); S.minutes = m.m; scene.setTime(m.m); updateClock(); updateList(m.c); break;
      case 'events': pushEvents(m.data); break;
      case 'state': S.live = m.data; renderLive(); break;
      case 'gov': S.decisions.unshift(m.data); renderGov(); break;
      case 'stat': S.history.push(m.data); if (S.history.length > 600) S.history.shift(); drawChart(); break;
    }
  };
  ws.onclose = () => { $('#loading').classList.remove('done'); $('#loading p').textContent = 'Verbinding verbroken — opnieuw proberen…'; setTimeout(connect, Math.min(5000, 500 * ++retry)); };
}
function onHello(m) {
  S.items = Object.fromEntries(m.items.map((i) => [i.id, i]));
  S.history = m.history || []; S.decisions = m.decisions || [];
  S.citizens = new Map(m.citizens.map((c) => [c.id, { ...c, mode: 0, hunger: 0 }]));
  if (!built) { scene.buildWorld(m.world); built = true; }
  scene.setCitizens(m.citizens);
  S.live = m.state; feedEvents = m.recent || []; buildFilters(); rebuildFeed(); renderLive(); renderGov(); drawChart();
  $('#pop-count').textContent = m.citizens.length;
  $('#loading').classList.add('done');
}

// ---- klok & kpi's -----------------------------------------------------------------
function updateClock() {
  const m = S.minutes, h = (m % 1440) / 60;
  $('#clock-time').textContent = fmtMin(m); $('#clock-day').textContent = `dag ${Math.floor(m / 1440)}`;
  $('#clock-ico').textContent = h >= 6 && h < 19 ? '☀️' : h >= 19 && h < 21 || h >= 5 && h < 6 ? '🌇' : '🌙';
}
function renderLive() {
  const L = S.live; if (!L) return;
  const s = L.stats;
  const k = (label, val, cls = '') => `<div class="kpi ${cls}"><small>${label}</small><b>${val}</b></div>`;
  $('#kpis').innerHTML =
    k('Burgers', `${s.population}${s.dead ? ` <span class="muted">(+${s.dead}†)</span>` : ''}`) +
    k('Voedsel', `${s.foodDays} d`, s.foodDays < 1.5 ? 'bad' : s.foodDays < 3 ? 'warn' : 'good') +
    k('Hongerig', s.starving + s.hungry, s.starving ? 'bad' : s.hungry > s.population * 0.3 ? 'warn' : '') +
    k('Gem. bezit', `${s.avgWeight} u`) + k('Ongelijkheid', s.giniWeight, s.giniWeight > 0.25 ? 'warn' : 'good') +
    k('Ziek', s.sick, s.sick > s.population * 0.2 ? 'warn' : '') + k('Drone-afspraken', L.aptCount);
  const d = L.depot, maxF = s.population * 2200 * 4;
  const items = Object.entries(d.items).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  $('#depot').innerHTML =
    `<div class="row"><span>Voedsel</span><small>${Math.round(d.food).toLocaleString('nl')} kcal · ${s.foodDays} dagen</small></div><div class="bar"><i style="width:${Math.min(100, d.food / maxF * 100)}%;background:${s.foodDays < 1.5 ? 'var(--red)' : s.foodDays < 3 ? 'var(--orange)' : 'var(--green)'}"></i></div>` +
    `<div class="row"><span>Medicijnen</span><small>${d.medicine} eenheden</small></div><div class="bar"><i style="width:${Math.min(100, d.medicine / 60 * 100)}%;background:#c084fc"></i></div>` +
    `<div class="row"><span>Spullen</span><small>${items.reduce((a, [, n]) => a + n, 0)} stuks · maak-voorraad ${d.labor} u</small></div>` +
    `<div class="inv">${items.map(([id, n]) => `<span title="${esc(S.items[id]?.name)}">${S.items[id]?.emoji || ''} ×${n}</span>`).join('') || '<span class="muted">leeg</span>'}</div>` +
    `<div class="kv"><span>Oogstfactor</span><span>${s.harvestFactor}×</span><span>Rantsoenen</span><span>${L.counters.rations}</span><span>Nood-subsidies</span><span>${L.counters.subsidies}</span><span>Ruilingen</span><span>${L.counters.trades}</span><span>Herverdelingen</span><span>${L.counters.rebalances}</span><span>Fraude betrapt</span><span>${L.counters.fraud}</span></div>`;
  const l = L.llm, pct = Math.min(100, (l.tokensToday / l.dailyTokenBudget) * 100);
  $('#llm').innerHTML = `<div class="row"><span class="badge ${l.active ? 'llm' : 'rules'}">${esc(l.mode)}</span><small>${esc(l.model)}</small></div>` +
    `<div class="kv" style="margin-top:8px"><span>Calls (laatste uur)</span><span>${l.callsLastHour} / ${l.maxCallsPerHour}</span><span>Tokens vandaag</span><span>${l.tokensToday.toLocaleString('nl')}</span><span>Geschatte kosten</span><span>$${l.estCostUsd}</span><span>Mislukt</span><span>${l.failed}</span></div>` +
    `<div class="bar"><i style="width:${pct}%;background:var(--accent)"></i></div>` + (l.lastError ? `<div class="muted" style="font-size:11px">${esc(l.lastError)}</div>` : '');
}
function renderGov() {
  const dcs = S.decisions || [], d = dcs[0], L = S.live;
  if (d) {
    $('#gov-badge').textContent = d.source === 'llm' ? 'AI-besluit' : 'regel-besluit'; $('#gov-badge').className = 'badge ' + (d.source === 'llm' ? 'llm' : 'rules');
    $('#gov-analysis').innerHTML = `<b>d${d.day} ${d.time}</b> — ${esc(d.analysis)}`;
  }
  if (L) {
    const p = L.policies, jt = p.jobTargets || {};
    $('#gov-policy').innerHTML = [`🌾 ${jt.farmer ?? '–'} boeren`, `🔧 ${jt.maker ?? '–'} makers`, `⚕️ ${jt.medic ?? '–'} zorg`, `🍽 portie ≤ ${(+p.rationCap).toFixed(2)}×`, `⚖️ tolerantie ${(p.tolerance * 100) | 0}%`, p.restIds?.length ? `🛌 ${p.restIds.length} verplicht rust` : '', ...(p.plan || []).map((x) => `${S.items[x.item]?.emoji || ''} maak ${x.qty}× ${S.items[x.item]?.name || x.item}`)].filter(Boolean).map((t) => `<span class="chip">${esc(t)}</span>`).join('');
    $('#gov-announce').textContent = p.announcement ? '📢 ' + p.announcement : '';
  }
}

// ---- grafieken ----------------------------------------------------------------------
let chart, chartKind = 'hunger';
const CH = {
  hunger: [['Gem. honger', 'hunger', '#f59e0b'], ['Hongerig', 'starving', '#ef4444']],
  food: [['Voedsel (dagen)', 'foodDays', '#22c55e'], ['Gem. energie', 'energy', '#3b82f6']],
  equality: [['Gini (bezit)', 'gini', '#c084fc'], ['Gem. bezit (u)', 'avgWeight', '#7cc4ff']],
  health: [['Ziek', 'sick', '#c084fc'], ['Medicijnen', 'medicine', '#22c55e']],
};
function drawChart() {
  const cfg = CH[chartKind], H = S.history.slice(-180);
  if (!chart) {
    Chart.defaults.color = '#8f9bb5'; Chart.defaults.font.size = 10;
    chart = new Chart($('#chart'), { type: 'line', data: { labels: [], datasets: [] }, options: { responsive: true, maintainAspectRatio: false, animation: false, elements: { point: { radius: 0 }, line: { tension: 0.3, borderWidth: 2 } }, interaction: { intersect: false, mode: 'index' },
      plugins: { legend: { labels: { boxWidth: 8, usePointStyle: true } } }, scales: { x: { ticks: { maxTicksLimit: 6 }, grid: { color: 'rgba(255,255,255,.05)' } }, y: { grid: { color: 'rgba(255,255,255,.05)' } }, y1: { position: 'right', grid: { display: false } } } } });
  }
  chart.data.labels = H.map((p) => `d${p.day}`);
  chart.data.datasets = cfg.map(([label, key, color], i) => ({ label, data: H.map((p) => p[key]), borderColor: color, backgroundColor: color + '33', yAxisID: i ? 'y1' : 'y', fill: !i }));
  chart.update('none');
}
$('#chart-tabs').onclick = (e) => { const c = e.target.dataset?.c; if (!c) return; chartKind = c; document.querySelectorAll('#chart-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.c === c)); drawChart(); };

// ---- burgerlijst & inspector -----------------------------------------------------------
let lastList = [], listTick = 0;
function updateList(frame) {
  for (const [id, , , , mode, flags, hunger] of frame) { const c = S.citizens.get(id); if (c) { c.mode = mode; c.flags = flags; c.hunger = hunger; } }
  if (++listTick % 5 !== 0) return;
  const q = $('#search').value.trim().toLowerCase();
  const rows = [...S.citizens.values()].filter((c) => !q || c.name.toLowerCase().includes(q) || (JOBS[c.job] || '').toLowerCase().includes(q))
    .sort((a, b) => b.hunger - a.hunger);
  $('#list').innerHTML = rows.map((c) => `<div class="li" data-id="${c.id}"><i class="dot" style="background:${hex(MODE_COLORS[c.mode])}"></i><span class="nm">${esc(c.name)}${c.flags & 1 ? ' 🟣' : ''}</span><small>${esc(JOBS[c.job])}</small><span class="hb"><i style="width:${Math.max(0, Math.min(100, c.hunger))}%;background:${c.hunger > 75 ? 'var(--red)' : c.hunger > 45 ? 'var(--orange)' : 'var(--green)'}"></i></span></div>`).join('');
}
$('#list').addEventListener('click', (e) => { const id = e.target.closest('.li')?.dataset.id; if (id) selectCitizen(+id, true); });
$('#search').addEventListener('input', () => { listTick = 4; });

function selectCitizen(id, focus) {
  scene.select(id);
  if (focus && id != null) { scene.focus(id); }
}
scene.onSelect = (id) => { S.selected = id; $('#inspector').hidden = id == null; $('#citizen-list').hidden = id != null; if (id != null) { $('#right').classList.remove('hide'); loadDetail(); } };
let detailTimer;
async function loadDetail() {
  clearTimeout(detailTimer);
  const id = S.selected; if (id == null) return;
  try {
    const d = await (await fetch(`/api/citizens/${id}`)).json();
    if (S.selected === id) renderInspector(d);
  } catch { /* volgende poging */ }
  detailTimer = setTimeout(loadDetail, 2500);
}
const bar = (label, v, good = true) => `<div class="stat"><div class="row"><span>${label}</span><small>${Math.round(v)}</small></div><div class="bar"><i style="width:${Math.max(0, Math.min(100, v))}%;background:${good ? (v < 25 ? 'var(--red)' : v < 50 ? 'var(--orange)' : 'var(--green)') : (v > 75 ? 'var(--red)' : v > 45 ? 'var(--orange)' : 'var(--green)')}"></i></div></div>`;
function renderInspector(d) {
  const inv = Object.entries(d.inv).sort((a, b) => b[1] - a[1]).map(([id, n]) => `<span title="${esc(S.items[id]?.name)} · ${S.items[id]?.weight}u">${S.items[id]?.emoji || '❔'} ${n > 1 ? '×' + n : ''}</span>`).join('');
  const t = d.task ? (TASKS[d.task.kind] || d.task.kind) + (d.task.phase === 'go' ? ' (onderweg)' : '') : 'vrij';
  const w = d.wantReq ? `${S.items[d.wantReq.item]?.emoji || ''} ${esc(S.items[d.wantReq.item]?.name || d.wantReq.item)}` : '–';
  $('#inspector').innerHTML = `
    <button class="x" id="close-insp">✕</button>
    <h2>${esc(d.name)}</h2>
    <div class="sub">${d.age} jaar · ${esc(JOBS[d.job])} · <span style="color:${hex(MODE_COLORS[d.mode])}">● ${MODE_NAMES[d.mode]}</span>${d.dead ? ' †' : ''}</div>
    <div style="display:flex;gap:6px;margin-bottom:8px"><button class="btn ${scene.follow ? 'on' : ''}" id="btn-follow">🎯 Volgen</button><button class="btn" id="btn-focus">🔍 Inzoomen</button></div>
    ${bar('Honger', d.hunger, false)}${bar('Energie', d.energy)}${bar('Gezondheid', d.health)}
    <div class="kv"><span>Doet nu</span><span>${esc(t)}</span><span>Bezit</span><span>${d.weight} arbeidsuren</span><span>Portie</span><span>${(+d.rationPref).toFixed(2)}×</span><span>Wil hebben</span><span>${w}</span><span>Eerlijkheid</span><span>${Math.round(d.traits.honesty * 100)}%</span><span>Eetbehoefte</span><span>${d.traits.appetite} kcal/dag</span><span>Gegeten</span><span>${Math.round(d.stats.eaten).toLocaleString('nl')} kcal</span>${d.sick ? `<span>Ziek</span><span>${esc(d.sick.name)}${d.sick.hospital ? ' (ziekenhuis)' : d.sick.treated ? ' (behandeld)' : ''}</span>` : ''}${d.apt ? `<span>Afspraak</span><span>${esc(d.apt.state)}</span>` : ''}${d.fraudStrikes ? `<span>Fraude</span><span>${d.fraudStrikes}×</span>` : ''}</div>
    ${d.thought ? `<div class="thought">“${esc(d.thought)}”</div>` : ''}
    <h4>Bezit (${Object.values(d.inv).reduce((a, b) => a + b, 0)} stuks)</h4><div class="inv">${inv || '<span class="muted">niets</span>'}</div>
    <h4>Geheugen</h4>${d.memories.slice(0, 14).map((m) => `<div class="mem"><small>d${Math.floor(m.minute / 1440)} ${fmtMin(m.minute)}</small>${esc(m.text)}</div>`).join('')}
    <h4>Ruilgeschiedenis</h4>${d.trades.slice(0, 8).map((t) => `<div class="mem"><small>d${Math.floor(t.minute / 1440)} ${t.kind}</small>${fmtT(t)}</div>`).join('') || '<div class="muted">nog niets geruild</div>'}
    <h4>Laatste ritten</h4>${d.moves.slice(0, 6).map((m) => `<div class="mem"><small>d${Math.floor(m.minute / 1440)} ${fmtMin(m.minute)}</small>${esc(m.purpose)} · ${m.dist.toFixed(0)} cellen</div>`).join('')}`;
  $('#close-insp').onclick = () => selectCitizen(null);
  $('#btn-follow').onclick = (e) => { scene.follow = !scene.follow; e.target.classList.toggle('on', scene.follow); };
  $('#btn-focus').onclick = () => scene.focus(d.id);
}
const fmtT = (t) => { const f = (j) => { try { return JSON.parse(j || '[]').map((id) => S.items[id]?.emoji || id).join(' '); } catch { return ''; } }; return `${f(t.got) ? 'kreeg ' + f(t.got) + ' ' : ''}${f(t.gave) ? 'gaf ' + f(t.gave) : ''}`; };

// ---- knoppen -----------------------------------------------------------------------------
$('#btn-left').onclick = () => $('#left').classList.toggle('hide');
$('#btn-right').onclick = () => $('#right').classList.toggle('hide');
$('#btn-orbit').onclick = (e) => { scene.controls.autoRotate = !scene.controls.autoRotate; e.currentTarget.classList.toggle('on', scene.controls.autoRotate); };
$('#btn-reset').onclick = () => { scene.resetCamera(); scene.select(null); };
addEventListener('keydown', (e) => { if (e.key === 'Escape') scene.select(null); });
if (innerWidth < 900) { $('#left').classList.add('hide'); $('#right').classList.add('hide'); }

connect();
window.__city = { scene, S };
