import { makeRng } from './rng.js';
import { buildWorld, doorPoint } from './world.js';
import { ITEMS, addItem } from './items.js';
import { newCitizen, stepCitizen, modeOf, MODE } from './citizen.js';
import { Government, gini } from './government.js';
import { Health } from './health.js';
import { Mind } from './mind.js';
import { declaredWeight } from './citizen.js';

const r2 = (v) => Math.round(v * 100) / 100;

export class Sim {
  constructor({ cfg, store, llm }) {
    this.cfg = cfg; this.store = store; this.llm = llm;
    this.rng = makeRng(cfg.seed);
    this.world = buildWorld();
    this.tick = 0;
    this.minutes = 6 * 60; // we beginnen op dag 0, 06:00
    this.citizens = [];
    this.byId = new Map();
    this.history = [];
    this.liveEvents = [];
    this.recent = [];
    this.nextEventId = 1;
    this.lastDay = 0;
    this.lastPosLog = 0; this.lastSnap = Date.now(); this.lastStat = -1e9;
    this.emitter = () => {};
    this.gov = new Government(this);
    this.health = new Health(this);
    this.mind = new Mind(this, llm);
    this.minPerSec = 1440 / cfg.daySeconds;
  }

  emit(kind, payload) { this.emitter(kind, payload); }
  hour() { return (this.minutes % 1440) / 60; }
  day() { return Math.floor(this.minutes / 1440); }
  clockStr() { const m = Math.floor(this.minutes % 1440); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; }

  log(type, text, actor = null, data = null, target = null) {
    const ev = { id: this.nextEventId++, tick: this.tick, day: this.day(), time: this.clockStr(), type, actor, text, data };
    this.store.event(this.tick, this.minutes | 0, type, actor, target, text, data);
    this.liveEvents.push(ev);
    this.recent.push(ev);
    if (this.recent.length > 400) this.recent.shift();
  }

  remember(c, kind, text, importance = 0.3) {
    const m = { t: this.minutes | 0, day: this.day(), kind, text, imp: importance };
    c.memory.push(m);
    if (c.memory.length > 40) { // houd de belangrijkste en nieuwste in het werkgeheugen; de database bewaart alles
      const idx = c.memory.reduce((best, x, i) => (x.imp < c.memory[best].imp && i < c.memory.length - 8 ? i : best), 0);
      c.memory.splice(idx, 1);
    }
    this.store.memory(this.tick, this.minutes | 0, c.id, kind, text, importance);
  }

  // ---- setup -----------------------------------------------------------------
  init() {
    const snap = this.store.loadSnapshot();
    this.health.initDrones();
    if (snap && snap.v === 1) { this.restore(snap); console.log(`[sim] hersteld: dag ${this.day()} ${this.clockStr()}, ${this.citizens.length} burgers`); return true; }
    this.fresh();
    return false;
  }

  fresh() {
    const n = this.cfg.population, w = this.world;
    const houses = w.ofType('house');
    const medics = Math.max(2, Math.round(n * 0.08)), makers = Math.round(n * 0.3);
    for (let i = 0; i < n; i++) {
      const job = i < medics ? 'medic' : i < medics + makers ? 'maker' : 'farmer';
      const c = newCitizen(this, i + 1, job);
      const h = houses[i % houses.length];
      c.home = h.id; c.loc = h.id;
      [c.x, c.z] = [h.x + 1.5, h.z + 1.5];
      c.nextThink = this.minutes + this.rng() * this.cfg.llm.thinkEveryDays * 1440;
      this.citizens.push(c); this.byId.set(c.id, c);
    }
    // jobs door elkaar husselen zodat ze niet per huis geclusterd zijn
    for (let i = this.citizens.length - 1; i > 0; i--) { const j = Math.floor(this.rng() * (i + 1)); [this.citizens[i].job, this.citizens[j].job] = [this.citizens[j].job, this.citizens[i].job]; }
    const g = this.gov;
    g.depot.food = n * 2200 * 3;
    g.depot.medicine = 20;
    for (let i = 0; i < 18; i++) addItem(g.depot.items, this.rng.pick(ITEMS).id);
    g.policies.jobTargets = { farmer: n - medics - makers, maker: makers, medic: medics };
    this.log('start', `De stad start met ${n} burgers. Iedereen heeft zijn bezit opgegeven; de overheid rekent het gemiddelde uit.`, null, { population: n });
    for (const c of this.citizens) this.remember(c, 'start', `Ik woon in de stad en werk als ${c.job}.`, 0.4);
    g.census();
    g.rebalance('startverdeling');
    this.health.dailyRolls();
  }

  serialize() {
    return {
      v: 1, tick: this.tick, minutes: this.minutes, rng: this.rng.getState(), nextEventId: this.nextEventId, lastDay: this.lastDay,
      citizens: this.citizens.map((c) => ({ ...c, apt: c.apt?.id ?? null, thinking: false })),
      gov: this.gov.toJSON(), health: this.health.toJSON(), history: this.history.slice(-400),
    };
  }

  restore(o) {
    this.tick = o.tick; this.minutes = o.minutes; this.rng.setState(o.rng); this.nextEventId = o.nextEventId; this.lastDay = o.lastDay;
    this.gov.load(o.gov); this.health.load(o.health); this.history = o.history || [];
    this.citizens = o.citizens;
    for (const c of this.citizens) { this.byId.set(c.id, c); c.apt = c.apt != null ? this.health.apts.find((a) => a.id === c.apt) || null : null; }
  }

  // ---- hoofdlus --------------------------------------------------------------
  step() {
    const dtReal = 1 / this.cfg.tickHz, dtMin = dtReal * this.minPerSec;
    this.tick++;
    this.minutes += dtMin;
    const day = this.day();
    if (day !== this.lastDay) {
      this.lastDay = day;
      this.log('new_day', `Dag ${day} begint.`, null, { day });
      this.gov.dailyEconomy();
      this.health.dailyRolls();
    }
    for (const c of this.citizens) stepCitizen(this, c, dtReal, dtMin);
    this.gov.update(dtMin);
    this.health.update(dtReal, dtMin);
    this.mind.update();
    if (this.minutes - this.lastStat >= 30) { this.lastStat = this.minutes; this.recordStats(); }
    const now = Date.now();
    if (now - this.lastPosLog >= this.cfg.posLogSeconds * 1000) {
      this.lastPosLog = now;
      for (const c of this.citizens) if (!c.dead) this.store.position(this.tick, this.minutes | 0, c.id, r2(c.x), r2(c.z), modeOf(c), r2(c.hunger));
    }
    if (now - this.lastSnap >= this.cfg.snapshotSeconds * 1000) { this.lastSnap = now; this.save(); }
  }

  save() { try { this.store.saveSnapshot(this.tick, this.serialize()); } catch (e) { console.error('snapshot mislukt', e.message); } }

  recordStats() {
    const s = this.gov.stats();
    const pt = { m: this.minutes | 0, day: s.day, food: s.foodKcal, foodDays: s.foodDays, hunger: s.avgHunger, starving: s.starving, hungry: s.hungry, sick: s.sick, gini: s.giniWeight, avgWeight: s.avgWeight, alive: s.population, medicine: s.medicine, energy: s.avgEnergy };
    this.history.push(pt);
    if (this.history.length > 600) this.history.shift();
    this.store.stats(this.tick, this.minutes | 0, JSON.stringify(pt));
    this.emit('stat', pt);
  }

  // ---- netwerk-weergaven ------------------------------------------------------
  frame() {
    return {
      t: this.tick, m: Math.round(this.minutes * 10) / 10,
      c: this.citizens.map((c) => {
        const flags = (c.sick ? 1 : 0) | (c.sick?.hospital ? 2 : 0) | (c.apt?.state === 'sampling' ? 4 : 0) | (c.path ? 8 : 0);
        return [c.id, r2(c.x), r2(c.z), r2(c.heading), modeOf(c), flags, Math.round(c.hunger)];
      }),
      d: this.health.drones.map((d) => [d.id, d.kind === 'med' ? 0 : 1, r2(d.x), r2(d.z), { idle: 0, out: 1, work: 2, back: 3 }[d.state], d.job?.kind === 'food' ? 1 : 0]),
    };
  }

  hello() {
    const w = this.world;
    return {
      type: 'hello',
      world: { size: w.size, cell: w.cell, buildings: w.buildings, blocks: w.blocks },
      items: ITEMS,
      citizens: this.citizens.map((c) => this.brief(c)),
      state: this.liveState(),
      recent: this.recent.slice(-120),
      history: this.history,
      decisions: this.gov.decisions,
    };
  }

  brief(c) { return { id: c.id, name: c.name, age: c.age, job: c.job, home: c.home }; }

  detail(c) {
    return {
      ...this.brief(c), traits: c.traits, hunger: c.hunger, energy: c.energy, health: c.health, mode: modeOf(c), dead: c.dead,
      inv: c.inv, hiddenWeight: undefined, weight: declaredWeight(c), sick: c.sick ? { name: c.sick.name, sev: c.sick.sev, treated: c.sick.treated, hospital: c.sick.hospital } : null,
      apt: c.apt ? { state: c.apt.state, symptom: c.apt.symptom } : null, task: c.task ? { kind: c.task.kind, phase: c.task.phase } : null,
      wantReq: c.wantReq, rationPref: c.rationPref, thought: c.thought, fraudStrikes: c.fraudStrikes, stats: c.stats, memory: c.memory.slice(-12), rest: c.rest, orders: c.orders.length,
    };
  }

  liveState() {
    const s = this.gov.stats();
    return {
      stats: s, policies: this.gov.policies, counters: this.gov.counters,
      depot: { food: Math.round(this.gov.depot.food), medicine: +this.gov.depot.medicine.toFixed(1), items: this.gov.depot.items, labor: +this.gov.depot.labor.toFixed(1) },
      llm: { ...this.llm.status(), mode: this.mind.mode() },
      clock: { minutes: this.minutes, day: this.day(), time: this.clockStr(), daySeconds: this.cfg.daySeconds },
      aptCount: this.health.apts.length,
    };
  }
}
