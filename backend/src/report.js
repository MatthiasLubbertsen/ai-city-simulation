// Post-mortem: figure out WHY people died and summarise what happened.
//  1. analyze(): deterministic forensics from the database (death causes, food/harvest timeline, government reactions...)
//  2. narrate(): the Hack Club AI chat-completions API (https://docs.ai.hackclub.com/api/chat-completions.html)
//     turns those facts into a readable summary. Jev is a classifier and cannot write text, so a chat model is used here.
//     If no key is set or the call fails, a local summary is composed from the same findings.
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const dayOf = (m) => Math.floor(m / 1440);
const hhmm = (m) => { m = Math.floor(m % 1440); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const when = (m) => `day ${dayOf(m)} ${hhmm(m)}`;

export function analyze(sim, store) {
  store.flush();
  const q = (sql, ...a) => store.db.prepare(sql).all(...a);
  const population = sim.citizens.length;
  const alive = sim.citizens.filter((c) => !c.dead).length;
  const deaths = q("SELECT minute, actor, text, data FROM events WHERE type='death' ORDER BY id").map((r) => ({ minute: r.minute, actor: r.actor, ...parse(r.data) }));
  const stats = q('SELECT data FROM stats ORDER BY rowid').map((r) => parse(r.data)).filter(Boolean);
  const decisions = q('SELECT minute, source, reasoning, input FROM decisions ORDER BY id').map((r) => ({ minute: r.minute, source: r.source, reasoning: r.reasoning, stats: parse(r.input)?.s }));
  const count = (type) => q('SELECT COUNT(*) n, MIN(minute) first FROM events WHERE type=?', type)[0];

  const causes = {}, byJob = {};
  for (const d of deaths) { causes[d.cause?.split(' ')[0] || 'unknown'] = (causes[d.cause?.split(' ')[0] || 'unknown'] || 0) + 1; byJob[d.job] = (byJob[d.job] || 0) + 1; }
  const firstOf = (pred) => stats.find(pred);
  const lowFood = firstOf((p) => p.foodDays < 1.5);
  const noFood = firstOf((p) => p.food < 50);
  const firstStarving = firstOf((p) => p.starving > 0);
  const peakStarving = stats.reduce((m, p) => (p.starving > (m?.starving ?? -1) ? p : m), null);
  const worstHarvest = stats.reduce((m, p) => (p.harvest != null && p.harvest < (m?.harvest ?? 9) ? p : m), null);
  const minMedicine = stats.reduce((m, p) => (p.medicine < (m?.medicine ?? 1e9) ? p : m), null);
  const denied = count('ration_denied'), subsidies = count('subsidy'), sick = count('sick'), fraud = count('lab_fraud');
  const calls = q('SELECT COUNT(*) n, SUM(ok=0) failed, SUM(purpose=\'government\') gov FROM llm_calls')[0];
  const firstDeath = deaths[0], lastDeath = deaths[deaths.length - 1];
  const half = deaths[Math.floor(population / 2) - 1];

  // How did the government react while food was getting low?
  const reaction = decisions.filter((d) => d.stats && d.stats.foodDays < 2.5).map((d) => ({ at: when(d.minute), source: d.source, foodDays: d.stats.foodDays, farmers: d.stats.jobs?.farmer, makers: d.stats.jobs?.maker, note: d.reasoning?.slice(0, 160) })).slice(0, 8);
  const farmersAtStart = decisions[0]?.stats?.jobs?.farmer, farmersAtLowFood = reaction[0]?.farmers;

  const findings = [];
  if (noFood) findings.push(`The depot ran out of food on ${when(noFood.m)} (it was below 1.5 days of food from ${lowFood ? when(lowFood.m) : 'earlier'}).`);
  if (lowFood && !noFood) findings.push(`Food stock dropped below 1.5 days on ${when(lowFood.m)} but never reached zero.`);
  if (noFood && farmersAtLowFood != null) findings.push(`When food got low there were ${farmersAtLowFood} farmers out of ${population} citizens (${Math.round((farmersAtLowFood / population) * 100)}%).`);
  if (worstHarvest && worstHarvest.harvest < 0.75) findings.push(`A bad harvest (factor ${worstHarvest.harvest} on ${when(worstHarvest.m)}) cut food production.`);
  if (reaction.length) findings.push(`The government made ${reaction.length} decision(s) while food was low (${reaction.filter((r) => r.source === 'jev').length} by Jev, ${reaction.filter((r) => r.source !== 'jev').length} by rules); farmers went from ${reaction[0].farmers} to ${reaction[reaction.length - 1].farmers}.`);
  if (denied.n) findings.push(`${denied.n} times a citizen queued for food and found the depot empty (first on ${when(denied.first)}).`);
  if (subsidies.n) findings.push(`${subsidies.n} emergency food drone(s) were sent.`);
  const topCause = Object.entries(causes).sort((a, b) => b[1] - a[1])[0];
  if (topCause) findings.push(`Main cause of death: ${topCause[0]} (${topCause[1]} of ${deaths.length}).`);
  if (causes.illness) findings.push(`${causes.illness} died of illness; medicine stock bottomed out at ${minMedicine?.medicine ?? '?'} units.`);
  if (calls.n) findings.push(`Jev made ${calls.n} calls (${calls.failed || 0} failed); the government used it for ${calls.gov || 0} of them.`);
  else findings.push('Jev was not used (rule-based mode).');
  if (!deaths.length) findings.push('Nobody has died yet.');

  const timeline = [
    firstStarving && { m: firstStarving.m, at: when(firstStarving.m), text: `First citizen starving (avg hunger ${firstStarving.hunger}).` },
    lowFood && { m: lowFood.m, at: when(lowFood.m), text: `Food below 1.5 days (${lowFood.foodDays} days).` },
    noFood && { m: noFood.m, at: when(noFood.m), text: 'Depot out of food.' },
    firstDeath && { m: firstDeath.minute, at: when(firstDeath.minute), text: `First death (${firstDeath.cause}).` },
    half && { m: half.minute, at: when(half.minute), text: 'Half the population dead.' },
    sim.extinct && lastDeath && { m: lastDeath.minute, at: when(lastDeath.minute), text: 'Last citizen died.' },
  ].filter(Boolean).sort((a, b) => a.m - b.m);

  return {
    generatedAt: sim.minutes | 0, extinct: !!sim.extinct, population, alive, dead: deaths.length,
    simulatedDays: +(sim.minutes / 1440).toFixed(1), startedWith: sim.cfg.population,
    causes, byJob, firstDeath: firstDeath && when(firstDeath.minute), lastDeath: lastDeath && when(lastDeath.minute),
    food: { lowFoodAt: lowFood && when(lowFood.m), emptyAt: noFood && when(noFood.m), worstHarvest: worstHarvest && { factor: worstHarvest.harvest, at: when(worstHarvest.m) }, peakStarving: peakStarving && { count: peakStarving.starving, at: when(peakStarving.m) }, rationDenied: denied.n, farmersAtStart, farmersAtLowFood },
    health: { sickEvents: sick.n, fakeSamplesCaught: fraud.n, minMedicine: minMedicine?.medicine },
    government: { decisions: decisions.length, byJev: decisions.filter((d) => d.source === 'jev').length, reactionWhileFoodLow: reaction, emergencyDrones: subsidies.n },
    jev: { calls: calls.n || 0, failed: calls.failed || 0 },
    last10Deaths: deaths.slice(-10).map((d) => ({ at: when(d.minute), cause: d.cause, job: d.job, hunger: d.hunger, depotFood: d.depotFood })),
    findings, timeline,
  };
}

const SYSTEM = `You are the analyst of a moneyless city simulation (citizens farm, make goods, swap items; a central AI government rations food by belly sensor and redistributes goods; drones deliver healthcare).
Write a post-mortem in plain English, 180-260 words, in 4 short paragraphs with these bold lead-ins: **What happened**, **Root cause**, **How the government did**, **What to change**.
Use ONLY the facts provided, never invent numbers. Be specific about days and counts. No preamble, no headings beyond the bold lead-ins.`;

export function localNarrative(f) {
  const lines = [];
  lines.push(`**What happened** ${f.extinct ? 'Everyone died' : `${f.dead} of ${f.startedWith} citizens died`} over ${f.simulatedDays} simulated days${f.firstDeath ? ` (first death ${f.firstDeath}${f.lastDeath ? `, last ${f.lastDeath}` : ''})` : ''}.`);
  lines.push(`**Root cause** ${f.findings.join(' ')}`);
  lines.push(`**How the government did** ${f.government.decisions} decisions (${f.government.byJev} by Jev), ${f.government.emergencyDrones} emergency food drones.`);
  if (f.dead) lines.push('**What to change** Keep more farmers, start shifting workers earlier when food days drop below 3, and raise the food buffer.');
  return lines.join('\n\n');
}

export async function narrate(facts, cfg, apiKey, store) {
  if (!apiKey) return { text: localNarrative(facts), source: 'local', model: null };
  const t0 = Date.now();
  try {
    const res = await fetch(`${cfg.report.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: cfg.report.model, temperature: 0.4, max_tokens: 1800,
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify({ facts: { ...facts, timeline: undefined } }) }],
      }),
      signal: AbortSignal.timeout(cfg.report.timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 150)}`);
    const data = await res.json();
    let text = String(data.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    if (text.length < 40) throw new Error('empty narrative');
    store.llmCall(Date.now(), 'report', cfg.report.model, 1, data.usage?.prompt_tokens || 0, data.usage?.completion_tokens || 0, Date.now() - t0, 0, null);
    return { text, source: 'ai', model: cfg.report.model };
  } catch (e) {
    store.llmCall(Date.now(), 'report', cfg.report.model, 0, 0, 0, Date.now() - t0, 0, String(e.message).slice(0, 200));
    return { text: localNarrative(facts), source: 'local', model: null, error: String(e.message).slice(0, 160) };
  }
}

// Cached so that public viewers can't burn through the Hack Club AI budget.
let inflight = null;
export async function getReport(sim, store, cfg, apiKey, { force = false } = {}) {
  const cached = store.latestReport();
  const fresh = cached && (Date.now() - cached.ts) / 1000 < cfg.report.minIntervalSeconds;
  const needsExtinction = sim.extinct && !(cached && cached.kind === 'extinction');
  if (cached && !needsExtinction && (fresh || !force)) return reportView(cached);
  if (inflight) return inflight;
  inflight = (async () => {
    const facts = analyze(sim, store);
    const n = await narrate(facts, cfg, apiKey, store);
    const kind = sim.extinct ? 'extinction' : 'snapshot';
    store.saveReport(sim.minutes | 0, kind, facts, n.text, n.model, n.source);
    return reportView(store.latestReport());
  })().finally(() => { inflight = null; });
  return inflight;
}
export const reportView = (r) => ({ ts: r.ts, kind: r.kind, narrative: r.narrative, source: r.source, model: r.model, facts: r.facts });
