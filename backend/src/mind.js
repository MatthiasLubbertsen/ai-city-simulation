// De "hersenen": zuinig gebruik van de LLM.
//  - burgers denken in BATCHES (10 burgers per request) en maar eens per paar dagen
//  - de overheid beslist ~2x per dag, of eerder bij alarm
//  - zonder LLM / bij overschreden budget nemen gratis regels het over (de stad blijft draaien)
import { ITEMS, ITEM_BY_ID, itemName, fmtItems } from './items.js';
import { declaredWeight, jobName } from './citizen.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const CATALOG = ITEMS.map((i) => `${i.id}:${i.weight}`).join(' ');

const CITIZEN_SYSTEM = `You control citizens of a moneyless city. Every citizen owns items; the government keeps everyone's total item-weight (hours of labour) equal. To get a new item you must hand in items of at least its weight. Food is rationed by a belly sensor; a citizen may ask for a larger portion (ration 1.0-1.2).
Items id:weight -> ${CATALOG}
For each citizen decide, in character: ration (1.0-1.2), want (one item id they most desire now, or null), give (item ids they would hand in for it, [] = government chooses), thought (Dutch, max 12 words, first person).
Reply ONLY JSON: {"d":[{"id":1,"ration":1.0,"want":null,"give":[],"thought":""}]}`;

const GOV_SYSTEM = `You are the central AI government of a moneyless city of ~40 citizens. You see aggregate statistics. Goals: nobody starves, workers don't collapse, goods are distributed equally, healthcare works. Jobs: farmer (food), maker (goods), medic (medicine). A citizen eats ~2100 kcal/day.
Reply ONLY JSON: {"analysis":"<=40 words Dutch","jobs":{"farmer":n,"maker":n,"medic":n},"ration_cap":1.0-1.3,"tolerance":0.05-0.3,"production":[{"item":"id","qty":1-6}],"rest":[citizen ids],"emergency_food":[citizen ids],"rebalance_now":false,"announcement":"<=20 words Dutch or empty"}
Item ids:weight -> ${CATALOG}`;

export class Mind {
  constructor(sim, llm) {
    this.sim = sim; this.llm = llm; this.cfg = sim.cfg.llm;
    this.pending = []; this.busyCitizens = false; this.busyGov = false;
    this.lastTick = 0; this.firstPendingAt = 0;
  }

  llmReady() { return this.llm.available('citizen'); }
  mode() { return this.llm.configured ? (this.llm.available('government') ? 'llm' : 'budget/backoff → regels') : 'regels (geen LLM ingesteld)'; }

  update() {
    const sim = this.sim, now = Date.now();
    if (now - this.lastTick < 1000) return;
    this.lastTick = now;
    this.scheduleCitizens();
    this.scheduleGov();
  }

  // ---- burgers -------------------------------------------------------------
  scheduleCitizens() {
    const sim = this.sim;
    const period = this.cfg.thinkEveryDays * 1440;
    for (const c of sim.citizens) {
      if (c.dead || c.nextThink > sim.minutes || this.pending.includes(c.id) || c.thinking) continue;
      if (c.inside || c.task?.kind === 'hospital') continue;
      if (this.llm.available('citizen')) { this.pending.push(c.id); if (this.pending.length === 1) this.firstPendingAt = Date.now(); c.nextThink = sim.minutes + period * sim.rng.range(0.8, 1.3); }
      else { this.reflexThink(c); c.nextThink = sim.minutes + 1440 * sim.rng.range(0.8, 1.5); }
    }
    if (this.pending.length && !this.busyCitizens && (this.pending.length >= this.cfg.batchSize || Date.now() - this.firstPendingAt > 20_000)) this.flushCitizens();
  }

  async flushCitizens() {
    const sim = this.sim;
    const ids = this.pending.splice(0, this.cfg.batchSize);
    const cs = ids.map((id) => sim.byId.get(id)).filter((c) => c && !c.dead);
    if (!cs.length) return;
    this.busyCitizens = true;
    cs.forEach((c) => { c.thinking = true; });
    const alive = sim.citizens.filter((c) => !c.dead);
    const avg = alive.reduce((s, c) => s + declaredWeight(c), 0) / (alive.length || 1);
    const tag = (v) => (v < 0.35 ? 'low' : v < 0.7 ? 'mid' : 'high');
    const lines = cs.map((c) => {
      const mem = c.memory.slice(-3).map((m) => m.text.slice(0, 80)).join(' | ');
      return `${c.id}|${c.name}|${c.age}y|${jobName(c.job)}|honest:${tag(c.traits.honesty)} thrift:${tag(c.traits.thrift)} social:${tag(c.traits.sociability)}|hunger:${Math.round(c.hunger)} energy:${Math.round(c.energy)} health:${Math.round(c.health)}${c.sick ? ' SICK:' + c.sick.name : ''}|owns ${declaredWeight(c)}h (avg ${avg.toFixed(0)}h): ${fmtItems(c.inv)}|recent: ${mem || '-'}`;
    });
    let res = null;
    try {
      res = await this.llm.json({ purpose: 'citizens', system: CITIZEN_SYSTEM, user: lines.join('\n'), maxTokens: 60 * cs.length + 40, temperature: 0.8 });
    } finally { this.busyCitizens = false; cs.forEach((c) => { c.thinking = false; }); }
    const out = Array.isArray(res?.d) ? res.d : [];
    for (const c of cs) {
      const r = out.find((x) => +x.id === c.id);
      if (r) this.applyCitizen(c, r); else this.reflexThink(c);
    }
  }

  applyCitizen(c, r) {
    const sim = this.sim;
    c.rationPref = clamp(+r.ration || 1, 1, 1.2);
    if (r.want && ITEM_BY_ID[r.want] && !c.wantReq) {
      const give = Array.isArray(r.give) ? r.give.filter((id) => ITEM_BY_ID[id]).slice(0, 6) : [];
      c.wantReq = { item: r.want, give, since: sim.day() };
    }
    c.thought = String(r.thought || '').slice(0, 120);
    sim.log('think', `${c.name}: “${c.thought}”${c.rationPref > 1.001 ? ` (vraagt portie ×${c.rationPref.toFixed(2)})` : ''}${c.wantReq ? ` — wil: ${itemName(c.wantReq.item)}` : ''}`, c.id,
      { source: 'llm', ration: c.rationPref, want: c.wantReq?.item || null, give: c.wantReq?.give || [] });
    sim.remember(c, 'thought', `Ik dacht: ${c.thought}`, 0.3);
  }

  // Gratis fallback voor de beslissing van een burger
  reflexThink(c) {
    const sim = this.sim, r = sim.rng;
    c.rationPref = c.hunger > 50 || c.traits.thrift < 0.25 ? (r() < 0.5 ? 1.2 : 1.1) : 1.0;
    if (!c.wantReq && r() < 0.25) c.wantReq = { item: r.pick(ITEMS).id, give: [], since: sim.day() };
    const lines = c.sick ? ['Ik voel me beroerd.', 'Hopelijk komt de drone snel.'] : c.hunger > 50 ? ['Ik heb honger.', 'Wanneer is het eten?'] : c.energy < 30 ? ['Ik ben moe.', 'Even rusten straks.'] : ['Fijne dag vandaag.', 'Ik hou van deze stad.', 'Wat zou ik nog graag willen?'];
    c.thought = r.pick(lines);
    sim.log('think', `${c.name}: “${c.thought}”${c.rationPref > 1.001 ? ` (vraagt portie ×${c.rationPref.toFixed(2)})` : ''}`, c.id, { source: 'rules', ration: c.rationPref });
  }

  // ---- overheid ------------------------------------------------------------
  scheduleGov() {
    const sim = this.sim, gov = sim.gov;
    if (this.busyGov) return;
    const gapH = (sim.minutes - gov.lastDecideAt) / 60;
    const llmOn = this.llm.available('government');
    const regular = gapH >= (llmOn ? this.cfg.govEveryHours : 6);
    if (!regular && !(gapH >= this.cfg.govMinGapHours && gov.alert(gov.stats()))) return;
    this.decideGov(llmOn);
  }

  async decideGov(useLlm) {
    const sim = this.sim, gov = sim.gov;
    this.busyGov = true;
    gov.lastDecideAt = sim.minutes;
    const s = gov.stats();
    const watch = gov.alive.filter((c) => c.hunger >= 60 || c.energy < 20 || c.health < 40).slice(0, 12)
      .map((c) => `${c.id}:${c.name.split(' ')[0]} h${Math.round(c.hunger)} e${Math.round(c.energy)} hp${Math.round(c.health)}`);
    let d = null, source = 'rules', raw = null;
    try {
      if (useLlm) {
        const user = `STATS ${JSON.stringify(s)}\nWATCHLIST ${watch.join('; ') || 'none'}\nLAST ${gov.lastDecision?.analysis || '-'}`;
        raw = await this.llm.json({ purpose: 'government', system: GOV_SYSTEM, user, maxTokens: 500, temperature: 0.5 });
        if (raw) { d = raw; source = 'llm'; }
      }
      if (!d) d = this.ruleDecision(s);
      gov.apply(d, source);
      const rec = { day: s.day, time: s.time, source, analysis: String(d.analysis || '').slice(0, 300), jobs: gov.policies.jobTargets, rationCap: gov.policies.rationCap,
        production: gov.policies.plan.slice(0, 5), rest: gov.policies.restIds, emergency: d.emergency_food || [], announcement: gov.policies.announcement, stats: s };
      gov.lastDecision = rec;
      gov.decisions.unshift(rec); gov.decisions.length = Math.min(gov.decisions.length, 25);
      sim.store.decision(sim.tick, sim.minutes | 0, source, 'policy', JSON.stringify({ s, watch }), JSON.stringify(d), rec.analysis);
      sim.log('decision', `🏛️ Overheidsbesluit (${source === 'llm' ? 'AI' : 'regels'}): ${rec.analysis}`, null, { source });
      sim.emit('gov', rec);
    } finally { this.busyGov = false; }
  }

  ruleDecision(s) {
    const n = s.population;
    const t = { ...s.jobs };
    const why = [];
    if (s.foodDays < 2.5 || s.starving > 0) { const m = Math.min(3, Math.max(0, t.maker - Math.max(4, Math.round(n * 0.15)))); t.maker -= m; t.farmer += m; why.push(`voedsel krap (${s.foodDays} dagen) → meer boeren`); }
    else if (s.foodDays > 5 && t.farmer > n * 0.35) { t.farmer -= 2; t.maker += 2; why.push('voedsel ruim → meer makers'); }
    t.medic = clamp(Math.round(n * 0.06 + s.sick * 0.3), 2, Math.ceil(n * 0.15));
    t.farmer = Math.max(1, n - t.maker - t.medic);
    const dem = s.unmetDemand.map(([id]) => ({ item: id, qty: 1 }));
    const watch = this.sim.gov.alive;
    const d = {
      analysis: `Regels: ${why.join('; ') || 'stabiel'}. Gemiddeld bezit ${s.avgWeight}u, Gini ${s.giniWeight}, ${s.sick} zieken, ${s.starving} hongerigen.`,
      jobs: t,
      ration_cap: s.foodDays > 5 ? 1.2 : s.foodDays > 2.5 ? 1.1 : 1.0,
      tolerance: 0.12,
      production: dem,
      rest: watch.filter((c) => c.energy < 15).slice(0, 6).map((c) => c.id),
      emergency_food: watch.filter((c) => c.hunger >= 80).map((c) => c.id),
      rebalance_now: false,
      announcement: s.starving > 0 ? 'Er is honger in de stad; nood-drones onderweg.' : s.foodDays < 2 ? 'Voedselvoorraad laag, rantsoenen strak.' : '',
    };
    return d;
  }
}
