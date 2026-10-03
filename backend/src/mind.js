// The "brains". Jev is a classifier, not a chat model, so every agent decision is a set of typed
// questions (choice / noul / score) about a compact `state`. Free-text thoughts are composed
// locally from Jev's answers. Reflex behaviour (walking, eating, working) stays free, and
// whenever Jev is unavailable (no key, budget used up, outage) a rule-based fallback takes over.
import { ITEMS, ITEM_BY_ID, itemName, fmtItems } from './items.js';
import { declaredWeight, jobName } from './citizen.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const CATEGORIES = {
  electronics: ['phone', 'laptop', 'tablet', 'tv', 'camera', 'radio', 'headphones'],
  mobility: ['bicycle', 'skateboard'],
  music_hobby: ['guitar', 'telescope', 'chemistry_set', 'toolkit'],
  home: ['chair', 'kettle', 'lamp', 'blanket', 'vase', 'plant'],
  clothing: ['jacket', 'shoes', 'watch'],
  games_books: ['boardgame', 'book', 'jojo', 'teddy'],
};
const RATIONS = { standard: 1.0, larger: 1.1, maximum: 1.2 };

// ---- question sets (kept short: Jev bills input tokens) ----------------------------
const CITIZEN_QUESTIONS = {
  ration: {
    type: 'choice',
    instructions: 'How big a food portion does this person want, relative to what the belly sensor measures?',
    criteria: {
      standard: 'The sensor amount is enough',
      larger: 'Wants about 10% more (hungry, active or a bit greedy)',
      maximum: 'Wants the maximum 20% extra (very hungry or very greedy)',
    },
  },
  want: {
    type: 'choice',
    instructions: 'Which kind of item would this person most like to obtain by trading away things they own?',
    criteria: {
      nothing: 'Content with what they own',
      electronics: 'Phone, laptop, tablet, TV, camera, radio, headphones',
      mobility: 'Bicycle or skateboard',
      music_hobby: 'Guitar, telescope, chemistry set, toolkit',
      home: 'Furniture, kettle, lamp, blanket, vase, plant',
      clothing: 'Jacket, shoes, watch',
      games_books: 'Board game, book, yo-yo, teddy bear',
    },
  },
  mood: {
    type: 'choice',
    instructions: 'What is this person feeling right now?',
    criteria: {
      content: 'Calm and satisfied', tired: 'Exhausted or worn out', anxious: 'Worried about food, health or fairness',
      hopeful: 'Optimistic about the future', frustrated: 'Annoyed or feels treated unfairly',
    },
  },
};

const GOV_QUESTIONS = {
  workforce: {
    type: 'choice',
    instructions: 'Given the city statistics, how should the workforce be reallocated?',
    criteria: {
      keep: 'Balanced; keep the current allocation',
      more_farming: 'Food is scarce or declining; move workers to farming',
      more_making: 'Food is plentiful; move workers to making goods',
      more_medics: 'Many sick citizens or low medicine stock; move workers to medicine',
    },
  },
  ration_cap: {
    type: 'choice',
    instructions: 'What is the largest extra food portion citizens may claim?',
    criteria: { strict: 'No extra (food is scarce)', moderate: 'Up to +10%', generous: 'Up to +20% (food is plentiful)' },
  },
  crisis: {
    type: 'score',
    instructions: 'How severe is the situation in the city?',
    criteria: ['Calm', 'Concerning', 'Severe crisis'],
  },
  production: {
    type: 'choice',
    instructions: 'Which kind of goods should the workshops prioritise?',
    criteria: {
      none: 'Stock is sufficient',
      electronics: 'Phones, laptops, TVs...', mobility: 'Bicycles, skateboards', music_hobby: 'Instruments and hobby gear',
      home: 'Household goods', clothing: 'Clothing and accessories', games_books: 'Games and books',
    },
  },
  rebalance_now: {
    type: 'noul',
    instructions: 'Should possessions be redistributed immediately (inequality is high)?',
    criteria: { true: 'Inequality is high or some citizens have far too little', false: 'Inequality is acceptable' },
  },
  rest_orders: {
    type: 'noul',
    instructions: 'Should exhausted workers be ordered to rest?',
    criteria: { true: 'Several citizens have very low energy', false: 'Energy levels are fine' },
  },
  announcement: {
    type: 'choice',
    instructions: 'Which public announcement fits the situation best?',
    criteria: {
      none: 'Nothing to announce', praise: 'Things are going well', warn_food: 'Food stock is getting low',
      warn_health: 'Illness is spreading', call_to_work: 'More production is needed',
    },
  },
};
const ANNOUNCEMENTS = {
  praise: 'The city is thriving. Thank you all for your work!',
  warn_food: 'Food stock is getting low. Rations are being monitored closely.',
  warn_health: 'Illness is spreading. Book an appointment early; drones are standing by.',
  call_to_work: 'More goods are needed. Please keep up the good work.',
};

const THOUGHTS = {
  content: ['Life in this city is good.', 'I have everything I need today.', 'A calm day. I like that.'],
  tired: ['I could use a long sleep.', 'My legs feel heavy today.', 'Rest soon, then back to it.'],
  anxious: ['I hope the food lasts.', 'Is everyone getting their fair share?', 'I worry about tomorrow.'],
  hopeful: ['Tomorrow will be even better.', 'This city is getting stronger every day.', 'I feel good about the future.'],
  frustrated: ['This swap system is slow.', 'Why does the sensor think I need so little?', 'I wish things were simpler.'],
};

export class Mind {
  constructor(sim, jev) {
    this.sim = sim; this.jev = jev; this.cfg = sim.cfg.jev;
    this.busyGov = false; this.lastTick = 0;
  }

  llmReady() { return this.jev.available('citizen'); }
  mode() {
    if (!this.jev.configured) return 'rules (no Jev API key set)';
    const s = this.jev.status();
    if (s.active) return `Jev (${this.cfg.model})`;
    return `rules (Jev paused: ${s.pauseReason || (s.tokensToday >= s.dailyTokenBudget ? 'daily token budget used' : 'call limit reached')})`;
  }

  update() {
    const now = Date.now();
    if (now - this.lastTick < 500) return;
    this.lastTick = now;
    this.scheduleCitizens();
    this.scheduleGov();
  }

  // ---- citizens: one small Jev request per citizen, a few at a time ----------------
  scheduleCitizens() {
    const sim = this.sim;
    const period = this.cfg.thinkEveryDays * 1440;
    let slots = this.jev.slots;
    for (const c of sim.citizens) {
      if (c.dead || c.nextThink > sim.minutes || c.thinking) continue;
      if (c.inside || c.task?.kind === 'hospital') continue;
      if (slots > 0 && this.jev.available('citizen')) {
        slots--;
        c.nextThink = sim.minutes + period * sim.rng.range(0.8, 1.3);
        this.thinkWithJev(c);
      } else if (!this.jev.configured || !this.jev.available('citizen')) {
        this.reflexThink(c);
        c.nextThink = sim.minutes + 1440 * sim.rng.range(0.8, 1.5);
      } // else: all slots busy; try again next tick
    }
  }

  citizenState(c) {
    const sim = this.sim;
    const alive = sim.citizens.filter((x) => !x.dead);
    const avg = alive.reduce((s, x) => s + declaredWeight(x), 0) / (alive.length || 1);
    const tag = (v) => (v < 0.35 ? 'low' : v < 0.7 ? 'medium' : 'high');
    const own = Object.entries(c.inv).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id, n]) => `${n}x ${itemName(id)}`);
    return {
      citizen: { age: c.age, job: jobName(c.job), honesty: tag(c.traits.honesty), thrift: tag(c.traits.thrift), sociability: tag(c.traits.sociability) },
      body: { hunger_0_to_100: Math.round(c.hunger), energy_0_to_100: Math.round(c.energy), health_0_to_100: Math.round(c.health), sick_with: c.sick?.name || null },
      holdings: { labour_hours: declaredWeight(c), city_average: Math.round(avg), items: own },
      city_food_days: +sim.gov.foodDays.toFixed(1),
      recent_events: c.memory.slice(-3).map((m) => m.text.slice(0, 70)),
    };
  }

  async thinkWithJev(c) {
    c.thinking = true;
    let answers = null;
    try {
      answers = await this.jev.ask({ purpose: 'citizen', state: this.citizenState(c), questions: CITIZEN_QUESTIONS });
    } finally { c.thinking = false; }
    if (!answers || c.dead) { if (!c.dead) this.reflexThink(c); return; }
    this.applyCitizen(c, answers);
  }

  applyCitizen(c, a) {
    const sim = this.sim;
    const ration = RATIONS[a.ration?.choice] ?? 1;
    c.rationPref = clamp(ration, 1, 1.2);
    let wantId = null;
    const cat = a.want?.choice;
    if (!c.wantReq && CATEGORIES[cat]) {
      const options = CATEGORIES[cat].filter((id) => (c.inv[id] || 0) < 2);
      if (options.length) { wantId = options.sort((x, y) => c.likes[y] - c.likes[x] + (sim.rng() - 0.5) * 0.4)[0]; c.wantReq = { item: wantId, give: [], since: sim.day() }; }
    }
    const mood = THOUGHTS[a.mood?.choice] ? a.mood.choice : 'content';
    c.mood = mood;
    c.thought = this.composeThought(c, mood, c.wantReq?.item);
    const conf = (q) => (a[q]?.confidence != null ? ` ${Math.round(a[q].confidence * 100)}%` : '');
    sim.log('think', `${c.name}: "${c.thought}" [Jev: mood=${mood}${conf('mood')}, portion=${a.ration?.choice}${conf('ration')}, wants=${cat}${conf('want')}]`, c.id,
      { source: 'jev', mood, ration: c.rationPref, want: c.wantReq?.item || null, answers: { ration: a.ration?.choice, want: cat, mood } });
    sim.remember(c, 'thought', `I thought: ${c.thought}`, 0.3);
  }

  composeThought(c, mood, wantItem) {
    const r = this.sim.rng;
    if (c.sick) return r() < 0.5 ? 'I feel terrible. I hope the drone comes soon.' : 'I really should get tested.';
    if (c.hunger > 55) return r() < 0.5 ? "I'm really hungry." : 'When is the next meal?';
    if (wantItem && r() < 0.6) return `I would love to trade for a ${itemName(wantItem).toLowerCase()}.`;
    return r.pick(THOUGHTS[mood] || THOUGHTS.content);
  }

  // Free fallback for a citizen's decision
  reflexThink(c) {
    const sim = this.sim, r = sim.rng;
    c.rationPref = c.hunger > 50 || c.traits.thrift < 0.25 ? (r() < 0.5 ? 1.2 : 1.1) : 1.0;
    if (!c.wantReq && r() < 0.25) c.wantReq = { item: r.pick(ITEMS).id, give: [], since: sim.day() };
    const mood = c.sick ? 'anxious' : c.energy < 30 ? 'tired' : c.hunger > 50 ? 'anxious' : r.pick(['content', 'hopeful']);
    c.mood = mood;
    c.thought = this.composeThought(c, mood, null);
    sim.log('think', `${c.name}: "${c.thought}"${c.rationPref > 1.001 ? ` (asks for a x${c.rationPref.toFixed(2)} portion)` : ''}`, c.id, { source: 'rules', ration: c.rationPref });
  }

  // ---- government ---------------------------------------------------------------
  scheduleGov() {
    const sim = this.sim, gov = sim.gov;
    if (this.busyGov) return;
    const gapH = (sim.minutes - gov.lastDecideAt) / 60;
    const jevOn = this.jev.available('government');
    const regular = gapH >= (jevOn ? this.cfg.govEveryHours : 6);
    if (!regular && !(gapH >= this.cfg.govMinGapHours && gov.alert(gov.stats()))) return;
    this.decideGov(jevOn);
  }

  async decideGov(useJev) {
    const sim = this.sim, gov = sim.gov;
    this.busyGov = true;
    gov.lastDecideAt = sim.minutes;
    const s = gov.stats();
    let d = null, source = 'rules', answers = null;
    try {
      if (useJev) {
        answers = await this.jev.ask({ purpose: 'government', state: this.govState(s), questions: GOV_QUESTIONS });
        if (answers) { d = this.decisionFromAnswers(s, answers); source = 'jev'; }
      }
      if (!d) d = this.ruleDecision(s);
      gov.apply(d, source);
      const rec = { day: s.day, time: s.time, source, analysis: String(d.analysis || '').slice(0, 300), jobs: gov.policies.jobTargets, rationCap: gov.policies.rationCap,
        production: gov.policies.plan.slice(0, 5), rest: gov.policies.restIds, emergency: d.emergency_food || [], announcement: gov.policies.announcement, stats: s };
      gov.lastDecision = rec;
      gov.decisions.unshift(rec); gov.decisions.length = Math.min(gov.decisions.length, 25);
      sim.store.decision(sim.tick, sim.minutes | 0, source, 'policy', JSON.stringify({ s }), JSON.stringify({ decision: d, jev: answers }), rec.analysis);
      sim.log('decision', `🏛️ Government decision (${source === 'jev' ? 'Jev' : 'rules'}): ${rec.analysis}`, null, { source });
      sim.emit('gov', rec);
    } finally { this.busyGov = false; }
  }

  govState(s) {
    const gov = this.sim.gov;
    const worst = gov.alive.filter((c) => c.hunger >= 60 || c.energy < 20 || c.health < 40).length;
    return {
      day: s.day, population: s.population, deaths: s.dead,
      food: { days_of_food_in_depot: s.foodDays, harvest_factor: s.harvestFactor, starving: s.starving, hungry: s.hungry, avg_hunger_0_to_100: s.avgHunger },
      workforce: { ...s.jobs },
      health: { sick: s.sick, medicine_units: s.medicine, pending_appointments: s.pendingAppointments },
      equality: { gini_of_holdings: s.giniWeight, avg_holdings: s.avgWeight, min: s.minWeight, max: s.maxWeight },
      avg_energy_0_to_100: s.avgEnergy, citizens_in_trouble: worst,
      unmet_item_demand: s.unmetDemand.map(([id, n]) => `${itemName(id)} x${n}`),
    };
  }

  // Turn Jev's classifications into a concrete policy.
  decisionFromAnswers(s, a) {
    const gov = this.sim.gov, n = s.population;
    const t = { ...s.jobs };
    const minMakers = Math.max(4, Math.round(n * 0.15));
    const w = a.workforce?.choice;
    if (w === 'more_farming') { const m = Math.min(3, Math.max(0, t.maker - minMakers)); t.maker -= m; t.farmer += m; }
    else if (w === 'more_making' && t.farmer > n * 0.3) { t.farmer -= 2; t.maker += 2; }
    else if (w === 'more_medics') { const m = Math.min(2, Math.max(0, t.maker - minMakers)); t.maker -= m; t.medic += m; }
    t.medic = clamp(t.medic, 2, Math.ceil(n * 0.2));
    t.farmer = Math.max(1, n - t.maker - t.medic);

    const cap = { strict: 1.0, moderate: 1.1, generous: 1.2 }[a.ration_cap?.choice] ?? 1.1;
    const demand = s.unmetDemand.map(([id]) => ({ item: id, qty: 1 }));
    const cat = a.production?.choice;
    let production = demand;
    if (!demand.length && CATEGORIES[cat]) {
      const stock = gov.depot.items;
      const id = [...CATEGORIES[cat]].sort((x, y) => (stock[x] || 0) - (stock[y] || 0))[0];
      production = [{ item: id, qty: 2 }];
    }
    const crisis = a.crisis?.score;
    const rest = a.rest_orders?.noul > 0.5 ? gov.alive.filter((c) => c.energy < 20).slice(0, 8).map((c) => c.id) : [];
    const pct = (q) => (a[q]?.confidence != null ? ` (${Math.round(a[q].confidence * 100)}%)` : '');
    return {
      analysis: `Jev says: workforce=${w}${pct('workforce')}, portion cap=${a.ration_cap?.choice}, crisis=${crisis != null ? crisis.toFixed(1) : '?'}/2, production=${cat}, redistribute=${Math.round((a.rebalance_now?.noul ?? 0) * 100)}%. ${s.sick} sick, ${s.starving} starving, Gini ${s.giniWeight}.`,
      jobs: t,
      ration_cap: s.foodDays < 1.5 ? 1.0 : cap,
      tolerance: 0.12,
      production,
      rest,
      emergency_food: gov.alive.filter((c) => c.hunger >= 80).map((c) => c.id),
      rebalance_now: (a.rebalance_now?.noul ?? 0) > 0.6,
      announcement: ANNOUNCEMENTS[a.announcement?.choice] || '',
    };
  }

  // Free rule-based fallback (used without an API key, when the budget is used up, or when Jev is down)
  ruleDecision(s) {
    const n = s.population;
    const t = { ...s.jobs };
    const why = [];
    if (s.foodDays < 2.5 || s.starving > 0) { const m = Math.min(3, Math.max(0, t.maker - Math.max(4, Math.round(n * 0.15)))); t.maker -= m; t.farmer += m; why.push(`food is low (${s.foodDays} days) -> more farmers`); }
    else if (s.foodDays > 5 && t.farmer > n * 0.35) { t.farmer -= 2; t.maker += 2; why.push('plenty of food -> more makers'); }
    t.medic = clamp(Math.round(n * 0.06 + s.sick * 0.3), 2, Math.ceil(n * 0.15));
    t.farmer = Math.max(1, n - t.maker - t.medic);
    const dem = s.unmetDemand.map(([id]) => ({ item: id, qty: 1 }));
    const al = this.sim.gov.alive;
    return {
      analysis: `Rules: ${why.join('; ') || 'stable'}. Avg holdings ${s.avgWeight}h, Gini ${s.giniWeight}, ${s.sick} sick, ${s.starving} starving.`,
      jobs: t,
      ration_cap: s.foodDays > 5 ? 1.2 : s.foodDays > 2.5 ? 1.1 : 1.0,
      tolerance: 0.12,
      production: dem,
      rest: al.filter((c) => c.energy < 15).slice(0, 6).map((c) => c.id),
      emergency_food: al.filter((c) => c.hunger >= 80).map((c) => c.id),
      rebalance_now: false,
      announcement: s.starving > 0 ? 'People are going hungry; emergency drones are on their way.' : s.foodDays < 2 ? 'Food stock is low; rations are tight.' : '',
    };
  }
}
