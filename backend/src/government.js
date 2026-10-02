// De centrale AI-overheid: telt alles, verdeelt eten (buiksensor), herverdeelt spullen, regelt werk en productie.
// Geen geld: ruilwaarde = arbeidsuren (item.weight). Elk besluit wordt met reden bewaard.
import { ITEMS, ITEM_BY_ID, itemName, weightOf, countOf, fmtItems, addItem } from './items.js';
import { declaredInv, declaredWeight, pickGive, HUNGER_PER_DAY, jobName } from './citizen.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const gini = (arr) => {
  const a = arr.filter((x) => x >= 0).sort((x, y) => x - y);
  const n = a.length, sum = a.reduce((s, x) => s + x, 0);
  if (!n || !sum) return 0;
  let cum = 0;
  for (let i = 0; i < n; i++) cum += (i + 1) * a[i];
  return (2 * cum) / (n * sum) - (n + 1) / n;
};

export class Government {
  constructor(sim) {
    this.sim = sim;
    this.policies = {
      rationCap: 1.2,
      tolerance: 0.12,
      jobTargets: null, // wordt bij init gezet
      plan: [], // [{item, qty}]
      restIds: [],
      announcement: '',
    };
    this.depot = { food: 0, items: {}, labor: 0, medicine: 0 };
    this.demand = {};       // item -> aantal onvervulde wensen
    this.harvest = 1;       // oogstfactor (weer)
    this.lastDecision = null;
    this.decisions = [];    // laatste beslissingen (UI)
    this.counters = { fraud: 0, rations: 0, kcalServed: 0, produced: 0, trades: 0, rebalances: 0, subsidies: 0, audits: 0, confiscated: 0, foodProduced: 0 };
    this.lastRebalanceDay = -1;
    this.lastEmergencyCheck = 0;
    this.lastDecideAt = -1e9;
  }

  toJSON() { const { sim, ...rest } = this; return rest; }
  load(o) { Object.assign(this, o); }

  get alive() { return this.sim.citizens.filter((c) => !c.dead); }
  get dailyNeed() { return this.alive.reduce((s, c) => s + c.traits.appetite, 0) || 1; }
  get foodDays() { return this.depot.food / this.dailyNeed; }

  // ---- productie -----------------------------------------------------------
  produce(c, hrs) {
    const d = this.depot, k = c.traits.skill;
    if (c.job === 'farmer') { const v = 900 * hrs * k * this.harvest; d.food += v; this.counters.foodProduced += v; return v; }
    if (c.job === 'maker') { const v = hrs * k; d.labor += v; this.convertLabor(); return v; }
    if (c.job === 'medic') { const v = 0.25 * hrs * k; d.medicine = Math.min(60, d.medicine + v); return v; }
    return 0;
  }

  convertLabor() {
    const d = this.depot;
    for (let guard = 0; guard < 5; guard++) {
      let entry = this.policies.plan.find((p) => p.qty > 0 && ITEM_BY_ID[p.item]);
      if (!entry) {
        // standaard: maak wat het minst op voorraad is en het meest gewenst wordt
        const best = ITEMS.map((i) => ({ id: i.id, s: (this.demand[i.id] || 0) * 3 - (d.items[i.id] || 0) + (this.sim.rng() * 0.5) })).sort((a, b) => b.s - a.s)[0];
        entry = { item: best.id, qty: 1 };
        this.policies.plan.push(entry);
      }
      const w = ITEM_BY_ID[entry.item].weight;
      if (d.labor < w) return;
      d.labor -= w; entry.qty--;
      addItem(d.items, entry.item);
      this.counters.produced++;
      this.sim.log('produce', `Werkplaats maakte: ${itemName(entry.item)} (${w} arbeidsuren). Voorraad: ${d.items[entry.item]}.`, null, { item: entry.item });
      this.policies.plan = this.policies.plan.filter((p) => p.qty > 0);
    }
  }

  // ---- eten (buiksensor) ---------------------------------------------------
  issueRation(c) {
    const need = c.traits.appetite;
    const sensor = Math.max(0, ((c.hunger - 5) / HUNGER_PER_DAY) * need); // wat de sensor op je buik meet
    let mult = clamp(c.rationPref, 1, this.policies.rationCap);
    const days = this.foodDays;
    if (days < 1.5) mult = 1;
    if (days < 0.6) mult = 0.8; // schaarste: iedereen krijgt wat minder
    let kcal = sensor * mult;
    if (c.hunger >= 75) kcal = Math.max(kcal, need * 0.35);
    kcal = Math.min(kcal, this.depot.food);
    if (kcal < 1) return { kcal: 0 };
    this.depot.food -= kcal;
    this.counters.rations++; this.counters.kcalServed += kcal;
    this.sim.log('ration', `${c.name} krijgt ${Math.round(kcal)} kcal (sensor ${Math.round(sensor)}${mult !== 1 ? `, ×${mult.toFixed(2)}` : ''}). Depot: ${Math.round(this.depot.food)} kcal.`, c.id,
      { kcal: Math.round(kcal), sensor: Math.round(sensor), mult: +mult.toFixed(2), hunger: +c.hunger.toFixed(1), depot: Math.round(this.depot.food) });
    return { kcal, sensor, mult };
  }

  // ---- ruilen & herverdelen ------------------------------------------------
  processVisit(c) {
    const sim = this.sim, d = this.depot;
    const orders = c.orders.splice(0);
    for (const o of orders) {
      // 1. inleveren (surplus)
      let gaveW = 0;
      const given = [];
      for (const id of o.surrender || []) {
        if ((declaredInv(c)[id] || 0) > 0) { addItem(c.inv, id, -1); addItem(d.items, id); given.push(id); gaveW += ITEM_BY_ID[id].weight; }
      }
      if (given.length) {
        sim.store.trade(sim.tick, sim.minutes | 0, c.id, 'surrender', '', JSON.stringify(given), 0, gaveW);
        sim.log('rebalance_give', `${c.name} levert in voor herverdeling: ${fmtItems(count(given))} (${gaveW} uur).`, c.id, { items: given, weight: gaveW });
        sim.remember(c, 'rebalance', `De overheid vroeg mij ${fmtItems(count(given))} in te leveren omdat ik boven het gemiddelde zat.`, 0.6);
      }
      // 2. ontvangen (tekort)
      if (o.receiveWeight > 0) {
        let budget = o.receiveWeight;
        const got = [];
        const cand = ITEMS.filter((i) => (d.items[i.id] || 0) > 0).sort((a, b) => (c.likes[b.id] - c.likes[a.id]) + (this.sim.rng() - 0.5) * 0.2);
        for (const it of cand) {
          while ((d.items[it.id] || 0) > 0 && it.weight <= budget && got.length < 6) { addItem(d.items, it.id, -1); addItem(c.inv, it.id); got.push(it.id); budget -= it.weight; }
        }
        if (got.length) {
          const w = got.reduce((s, id) => s + ITEM_BY_ID[id].weight, 0);
          sim.store.trade(sim.tick, sim.minutes | 0, c.id, 'receive', JSON.stringify(got), '', w, 0);
          sim.log('rebalance_get', `${c.name} ontvangt uit het depot: ${fmtItems(count(got))} (${w} uur) omdat hij/zij onder het gemiddelde zat.`, c.id, { items: got, weight: w });
          sim.remember(c, 'rebalance', `Ik kreeg ${fmtItems(count(got))} van de overheid; ik zat onder het gemiddelde.`, 0.6);
        }
      }
    }
    if (c.wantReq) this.tryTrade(c);
  }

  tryTrade(c) {
    const sim = this.sim, d = this.depot, w = c.wantReq;
    const it = ITEM_BY_ID[w.item];
    if (!it) { c.wantReq = null; return; }
    if ((d.items[it.id] || 0) < 1) {
      this.demand[it.id] = (this.demand[it.id] || 0) + (w.counted ? 0 : 1);
      w.counted = true;
      w.tries = (w.tries || 0) + 1;
      sim.log('trade_denied', `${c.name} wil ${it.name}, maar het depot heeft er geen. Aanvraag genoteerd.`, c.id, { item: it.id, reason: 'no_stock' });
      sim.remember(c, 'trade', `Ik wilde een ${it.name}, maar er is er geen. Ik moet wachten.`, 0.4);
      if (w.tries >= 3) c.wantReq = null;
      return;
    }
    const give = pickGive(c, it.weight, w.give || []);
    if (!give) {
      sim.log('trade_denied', `${c.name} wil ${it.name} (${it.weight} uur) maar heeft niet genoeg om in te leveren.`, c.id, { item: it.id, reason: 'not_enough' });
      sim.remember(c, 'trade', `Ik wilde een ${it.name}, maar ik heb niet genoeg spullen om in te leveren.`, 0.4);
      c.wantReq = null;
      return;
    }
    for (const id of give.items) { addItem(c.inv, id, -1); addItem(d.items, id); }
    addItem(d.items, it.id, -1); addItem(c.inv, it.id);
    this.counters.trades++; c.stats.trades++;
    sim.store.trade(sim.tick, sim.minutes | 0, c.id, 'swap', JSON.stringify([it.id]), JSON.stringify(give.items), it.weight, give.weight);
    sim.log('trade', `${c.name} ruilt: levert in ${fmtItems(count(give.items))} (${give.weight} uur) en krijgt ${it.name} (${it.weight} uur).`, c.id,
      { got: it.id, gave: give.items, weightIn: it.weight, weightOut: give.weight });
    sim.remember(c, 'trade', `Ik ruilde ${fmtItems(count(give.items))} tegen ${it.name}.`, 0.7);
    c.wantReq = null; c.lastTradeDay = sim.day();
  }

  rebalance(reason = 'dagelijks') {
    const sim = this.sim, alive = this.alive;
    if (alive.length < 2) return;
    const W = new Map(alive.map((c) => [c.id, declaredWeight(c)]));
    // het depot telt deels mee: groeiende productie komt zo bij de burgers terecht
    const depotW = weightOf(this.depot.items);
    const avg = ([...W.values()].reduce((s, x) => s + x, 0) + 0.5 * depotW) / alive.length;
    const tol = Math.max(3, avg * this.policies.tolerance);
    let givers = 0, getters = 0;
    for (const c of alive) {
      const w = W.get(c.id);
      c.orders = c.orders.filter((o) => !o.rebalance);
      if (w > avg + tol) {
        const inv = declaredInv(c), pick = [];
        let cut = 0;
        const target = w - avg;
        for (const id of giveOrder2(c, inv)) {
          const iw = ITEM_BY_ID[id].weight;
          if (cut + iw <= target + tol * 0.5) { pick.push(id); cut += iw; }
          if (cut >= target) break;
        }
        if (pick.length) { c.orders.push({ rebalance: true, surrender: pick, receiveWeight: 0 }); givers++; }
      } else if (w < avg - tol) {
        c.orders.push({ rebalance: true, surrender: [], receiveWeight: Math.floor(avg - w) });
        getters++;
      }
    }
    this.counters.rebalances++;
    sim.log('rebalance', `Herverdeling (${reason}): gemiddelde bezit ${avg.toFixed(1)} arbeidsuren/persoon. ${givers} burgers moeten inleveren, ${getters} krijgen bij.`, null, { avg: +avg.toFixed(2), tol: +tol.toFixed(2), givers, getters });
  }

  // ---- dagelijkse routines -------------------------------------------------
  census() {
    const sim = this.sim;
    if (!this.alive.length) return;
    let total = 0, hiddenTotal = 0;
    for (const c of this.alive) {
      const decl = declaredInv(c);
      // Oneerlijke burgers houden af en toe iets achter
      if (c.traits.honesty < 0.3 && sim.rng() < 0.5) {
        const ids = Object.keys(c.inv).filter((id) => (c.inv[id] - (c.hidden[id] || 0)) > 0);
        if (ids.length) { const id = sim.rng.pick(ids); c.hidden[id] = (c.hidden[id] || 0) + 1; delete decl[id]; if (c.inv[id] - c.hidden[id] > 0) decl[id] = c.inv[id] - c.hidden[id]; }
      }
      total += weightOf(decl);
      hiddenTotal += weightOf(c.hidden);
      sim.log('census', `${c.name} geeft op: ${fmtItems(decl)} (${weightOf(decl)} uur).`, c.id, { inv: decl, weight: weightOf(decl) });
    }
    sim.log('census_total', `Volkstelling: totaal ${total} arbeidsuren aan bezit bij ${this.alive.length} burgers, gemiddeld ${(total / this.alive.length).toFixed(1)}.`, null, { total });
    // Steekproef: een drone controleert één woning
    const sus = this.alive.filter((c) => weightOf(c.hidden) > 0);
    const target = sus.length && sim.rng() < 0.7 ? sim.rng.pick(sus) : sim.rng.pick(this.alive);
    this.counters.audits++;
    const hid = weightOf(target.hidden);
    if (hid > 0) {
      for (const [id, n] of Object.entries(target.hidden)) { addItem(target.inv, id, -n); addItem(this.depot.items, id, n); }
      const txt = fmtItems(target.hidden);
      target.hidden = {}; target.fraudStrikes++; this.counters.fraud++; this.counters.confiscated += hid;
      sim.log('audit_fraud', `Steekproef bij ${target.name}: niet opgegeven spullen gevonden (${txt}). In beslag genomen.`, target.id, { weight: hid });
      sim.remember(target, 'fraud', `Ik werd betrapt op niet opgegeven spullen (${txt}). Alles is in beslag genomen.`, 0.9);
    } else sim.log('audit_ok', `Steekproef bij ${target.name}: alles klopte.`, target.id);
  }

  dailyEconomy() {
    const sim = this.sim;
    this.harvest = clamp(this.harvest + (sim.rng() - 0.5) * 0.35, 0.55, 1.25);
    // spontane wensen (de LLM-laag doet dit rijker als die beschikbaar is)
    const p = sim.mind.llmReady() ? 0.06 : 0.2;
    for (const c of this.alive) {
      if (!c.wantReq && sim.rng() < p) {
        const it = sim.rng.pick(ITEMS.filter((i) => (c.inv[i.id] || 0) < 2));
        c.wantReq = { item: it.id, give: null, since: sim.day() };
        sim.remember(c, 'want', `Ik zou graag een ${it.name} willen hebben.`, 0.3);
      }
      if (c.wantReq && sim.day() - (c.wantReq.since ?? 0) > 4) c.wantReq = null;
    }
    this.census();
  }

  // ---- besluitvorming ------------------------------------------------------
  stats() {
    const sim = this.sim, al = this.alive;
    const n = al.length || 1;
    const W = al.map(declaredWeight);
    const jobs = { farmer: 0, maker: 0, medic: 0 };
    al.forEach((c) => { jobs[c.job] = (jobs[c.job] || 0) + 1; });
    const demandTop = Object.entries(this.demand).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 4);
    return {
      day: sim.day(), time: sim.clockStr(),
      population: n, dead: sim.citizens.length - al.length,
      starving: al.filter((c) => c.hunger >= 75).length,
      hungry: al.filter((c) => c.hunger >= 45 && c.hunger < 75).length,
      avgHunger: +(al.reduce((s, c) => s + c.hunger, 0) / n).toFixed(1),
      avgEnergy: +(al.reduce((s, c) => s + c.energy, 0) / n).toFixed(1),
      foodKcal: Math.round(this.depot.food), foodDays: +this.foodDays.toFixed(2),
      harvestFactor: +this.harvest.toFixed(2),
      jobs, jobTargets: this.policies.jobTargets,
      sick: al.filter((c) => c.sick).length, medicine: +this.depot.medicine.toFixed(1),
      pendingAppointments: sim.health.apts.length,
      avgWeight: +(W.reduce((s, x) => s + x, 0) / n).toFixed(1), giniWeight: +gini(W).toFixed(3),
      minWeight: Math.min(...W), maxWeight: Math.max(...W),
      depotItems: Object.values(this.depot.items).reduce((s, x) => s + x, 0),
      unmetDemand: demandTop,
      fraudCases: this.counters.fraud, tolerance: this.policies.tolerance, rationCap: this.policies.rationCap,
    };
  }

  alert(s) {
    return s.starving > 0 || s.foodDays < 2 || s.sick > s.population * 0.2 || (s.medicine < 2 && s.sick > 0);
  }

  // Elke 30 sim-minuten: noodhulp-controle (altijd regel-gebaseerd, geen LLM nodig) en beslismomenten.
  update(dtMin) {
    const sim = this.sim;
    if (sim.minutes - this.lastEmergencyCheck >= 30) {
      this.lastEmergencyCheck = sim.minutes;
      for (const c of this.alive) {
        if (c.hunger >= 80 && !c.foodDrone && this.depot.food > 800 && c.task?.kind !== 'eat') this.emergencyFood(c, 'regels');
      }
    }
    // dagelijks 17:00 herverdelen, na de volkstelling van middernacht
    if (sim.hour() >= 15 && this.lastRebalanceDay !== sim.day()) { this.lastRebalanceDay = sim.day(); this.rebalance('dagelijks'); }
    const s = null; // beslissingen worden door mind.js aangestuurd (async)
    return s;
  }

  emergencyFood(c, by) {
    const kcal = Math.min(this.depot.food, c.traits.appetite * 0.4);
    if (kcal < 100) return;
    this.depot.food -= kcal;
    c.foodDrone = true;
    this.counters.subsidies++;
    this.sim.health.dispatchFood(c, kcal);
    this.sim.log('subsidy', `Nood-subsidie: drone met ${Math.round(kcal)} kcal onderweg naar ${c.name} (honger ${Math.round(c.hunger)}, besloten door ${by}).`, c.id, { kcal: Math.round(kcal), by });
    this.sim.remember(c, 'subsidy', `Ik was bijna uitgehongerd. De overheid stuurde een drone met voedsel.`, 0.9);
  }

  // Past een (gevalideerde) beslissing toe, afkomstig van de LLM of van de regels.
  apply(d, source) {
    const sim = this.sim, pol = this.policies;
    if (typeof d.ration_cap === 'number') pol.rationCap = clamp(d.ration_cap, 1, 1.3);
    if (typeof d.tolerance === 'number') pol.tolerance = clamp(d.tolerance, 0.05, 0.3);
    if (d.jobs && typeof d.jobs === 'object') {
      const t = { farmer: +d.jobs.farmer, maker: +d.jobs.maker, medic: +d.jobs.medic };
      if (Object.values(t).every((v) => Number.isFinite(v) && v >= 0)) {
        const total = t.farmer + t.maker + t.medic || 1;
        const n = this.alive.length;
        const norm = { farmer: Math.round((t.farmer / total) * n), maker: Math.round((t.maker / total) * n), medic: Math.max(1, Math.round((t.medic / total) * n)) };
        norm.farmer = Math.max(1, n - norm.maker - norm.medic);
        pol.jobTargets = norm;
        this.reassignJobs();
      }
    }
    if (Array.isArray(d.production)) {
      pol.plan = d.production.filter((p) => p && ITEM_BY_ID[p.item]).map((p) => ({ item: p.item, qty: clamp(Math.round(+p.qty || 1), 1, 6) })).slice(0, 5);
    }
    if (Array.isArray(d.rest)) {
      for (const c of this.sim.citizens) c.rest = false;
      pol.restIds = d.rest.map(Number).filter((id) => sim.byId.get(id) && !sim.byId.get(id).dead).slice(0, 12);
      for (const id of pol.restIds) { const c = sim.byId.get(id); c.rest = true; sim.log('order_rest', `Bevel: ${c.name} moet rusten (energie ${Math.round(c.energy)}).`, c.id, { by: source }); sim.remember(c, 'order', 'De overheid beval mij te rusten.', 0.5); }
    }
    if (Array.isArray(d.emergency_food)) {
      for (const id of d.emergency_food.map(Number).slice(0, 8)) { const c = sim.byId.get(id); if (c && !c.dead && !c.foodDrone) this.emergencyFood(c, source); }
    }
    if (d.rebalance_now) this.rebalance('op bevel');
    if (typeof d.announcement === 'string' && d.announcement.trim()) {
      pol.announcement = d.announcement.trim().slice(0, 200);
      sim.log('announcement', `📢 Overheid: ${pol.announcement}`, null, { by: source });
      for (const c of this.alive) if (sim.rng() < 0.25) sim.remember(c, 'announcement', `Omroep: ${pol.announcement}`, 0.3);
    }
  }

  reassignJobs() {
    const t = this.policies.jobTargets, sim = this.sim;
    if (!t) return;
    const al = this.alive;
    const count = (j) => al.filter((c) => c.job === j).length;
    let moved = 0;
    for (let guard = 0; guard < 6 && moved < 6; guard++) {
      const jobs = ['farmer', 'maker', 'medic'];
      const over = jobs.filter((j) => count(j) > t[j]).sort((a, b) => count(b) - t[b] - (count(a) - t[a]))[0];
      const under = jobs.filter((j) => count(j) < t[j]).sort((a, b) => (t[b] - count(b)) - (t[a] - count(a)))[0];
      if (!over || !under) break;
      const c = al.filter((x) => x.job === over && x.task?.kind !== 'work').sort((a, b) => b.traits.skill - a.traits.skill)[0] || al.find((x) => x.job === over);
      if (!c) break;
      sim.log('job_change', `${c.name} gaat van ${jobName(over)} naar ${jobName(under)} (herplaatsing door overheid).`, c.id, { from: over, to: under });
      sim.remember(c, 'job', `De overheid verplaatste mij van ${jobName(over)} naar ${jobName(under)}.`, 0.6);
      c.job = under; moved++;
    }
  }
}

const count = (arr) => arr.reduce((m, id) => { m[id] = (m[id] || 0) + 1; return m; }, {});
function giveOrder2(c, inv) {
  const out = [];
  for (const [id, n] of Object.entries(inv)) for (let i = 0; i < n; i++) out.push({ id, score: c.likes[id] - 0.3 * i + ITEM_BY_ID[id].weight * -0.01 });
  return out.sort((a, b) => a.score - b.score).map((o) => o.id);
}
