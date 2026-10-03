// One citizen = one agent. A free "reflex layer" (needs + daily rhythm) runs every tick;
// the LLM layer (mind.js) only influences preferences: portion size, wishes and what you are willing to hand in.
import { ITEMS, ITEM_BY_ID, itemName, weightOf, fmtItems, addItem } from './items.js';
import { roadPath, doorPoint, yardPoint } from './world.js';

export const MODE = { IDLE: 0, WORK: 1, EAT: 2, STARVE: 3, SLEEP: 4, DEAD: 5 };
export const HUNGER_PER_DAY = 66.7; // hunger points a person builds up per day
const FIRST = ['Alex', 'Emma', 'Liam', 'Olivia', 'Noah', 'Ava', 'Ethan', 'Mia', 'Lucas', 'Chloe', 'Mason', 'Grace', 'Owen', 'Ella', 'Jack', 'Lily', 'Henry', 'Zoe', 'Leo', 'Ruby', 'Sam', 'Nora', 'Max', 'Hannah', 'Ben', 'Isla', 'Finn', 'Maya', 'Oscar', 'Alice', 'Eli', 'Iris', 'Hugo', 'Amy', 'Theo', 'Tess', 'Adam', 'Rose', 'Jake', 'Anna', 'Dan', 'Lisa', 'Kai', 'Nina', 'Cole', 'Ivy', 'Cas', 'Vera', 'Rick', 'Sarah'];
const LAST = ['Smith', 'Jones', 'Taylor', 'Brown', 'Williams', 'Wilson', 'Johnson', 'Davies', 'Miller', 'Evans', 'Thomas', 'Roberts', 'Walker', 'Wright', 'Clarke', 'Hall', 'Green', 'Baker', 'Hughes', 'Carter'];
const JOB_NAMES = { farmer: 'Farmer', maker: 'Maker', medic: 'Medic' };
export const jobName = (j) => JOB_NAMES[j] || j;

export function newCitizen(sim, id, job) {
  const r = sim.rng;
  const honesty = r() < 0.12 ? r.range(0.02, 0.25) : r.range(0.6, 1);
  const c = {
    id,
    name: `${FIRST[(id * 7 + 3) % FIRST.length]} ${r.pick(LAST)}`,
    age: r.int(19, 74),
    job,
    home: null,
    traits: {
      appetite: Math.round(r.range(1700, 2700) / 50) * 50, // kcal/day (measured by the belly sensor)
      honesty,
      thrift: r.range(0.1, 1),
      sociability: r.range(0.1, 1),
      skill: r.range(0.8, 1.2),
    },
    likes: Object.fromEntries(ITEMS.map((i) => [i.id, +r().toFixed(2)])), // attachment per item
    x: 0, z: 0, heading: 0, loc: null, inside: false,
    path: null, pi: 0, speed: r.range(1.7, 2.2),
    task: null, orders: [], wantReq: null,
    hunger: r.range(0, 30), energy: r.range(60, 100), health: 100,
    inv: {}, hidden: {},
    sick: null, apt: null, fraudStrikes: 0,
    rationPref: 1.0, rest: false,
    lastRationAt: -9999, lastTradeDay: -1, nextThink: 0,
    thought: '', dead: false, stats: { eaten: 0, produced: 0, walked: 0, trades: 0 },
    memory: [],
  };
  // Starting possessions: very unevenly distributed (which is exactly why the government has to redistribute)
  const k = r() < 0.12 ? r.int(18, 34) : r.int(2, 11);
  for (let i = 0; i < k; i++) {
    const it = ITEMS[Math.min(ITEMS.length - 1, Math.floor(Math.pow(r(), 0.8) * ITEMS.length))];
    addItem(c.inv, it.id);
  }
  return c;
}

// ---- helpers ---------------------------------------------------------
export const declaredInv = (c) => {
  const d = {};
  for (const [id, n] of Object.entries(c.inv)) { const v = n - (c.hidden[id] || 0); if (v > 0) d[id] = v; }
  return d;
};
export const declaredWeight = (c) => weightOf(declaredInv(c));

export function modeOf(c) {
  if (c.dead) return MODE.DEAD;
  if (c.inside) return MODE.SLEEP;
  if (c.hunger >= 75) return MODE.STARVE;
  if (c.task?.phase === 'do') { if (c.task.kind === 'eat') return MODE.EAT; if (c.task.kind === 'work') return MODE.WORK; }
  return MODE.IDLE;
}

// Which items would you rather give up? Low attachment and duplicates first.
export function giveOrder(c, inv = declaredInv(c)) {
  const out = [];
  for (const [id, n] of Object.entries(inv)) for (let i = 0; i < n; i++) out.push({ id, score: c.likes[id] - 0.3 * i });
  return out.sort((a, b) => a.score - b.score).map((o) => o.id);
}

// Pick items to hand in with total weight >= need (as little overshoot as possible).
export function pickGive(c, need, hint = []) {
  const inv = declaredInv(c);
  const chosen = [];
  let sum = 0;
  const take = (id) => { if (!inv[id]) return false; inv[id]--; chosen.push(id); sum += ITEM_BY_ID[id].weight; return true; };
  for (const id of hint) { if (sum >= need) break; take(id); }
  for (const id of giveOrder(c, inv)) { if (sum >= need) break; take(id); }
  if (sum < need) return null;
  // drop surplus items again
  for (let i = chosen.length - 1; i >= 0; i--) {
    const w = ITEM_BY_ID[chosen[i]].weight;
    if (sum - w >= need) { sum -= w; chosen.splice(i, 1); }
  }
  return { items: chosen, weight: sum };
}

export const mealWindow = (h) => (h >= 7 && h < 9.5) || (h >= 12 && h < 14.5) || (h >= 18 && h < 20.5);

// ---- main step ------------------------------------------------------------
export function stepCitizen(sim, c, dtReal, dtMin) {
  if (c.dead) return;
  vitals(sim, c, dtMin);
  if (c.dead) return;
  if (c.path) {
    moveAlong(c, dtReal);
    if (!c.path) arrive(sim, c);
    return;
  }
  if (!c.task) chooseTask(sim, c);
  if (c.task) runTask(sim, c, dtMin);
}

function vitals(sim, c, dtMin) {
  const hrs = dtMin / 60;
  const working = c.task?.kind === 'work' && c.task.phase === 'do';
  c.hunger = Math.min(100, Math.max(-25, c.hunger + (HUNGER_PER_DAY / 24) * (working ? 1.25 : 1) * hrs));
  if (c.inside || c.task?.kind === 'rest') c.energy += 9 * hrs;
  else if (working) c.energy -= 3.5 * hrs;
  else if (c.path) c.energy -= 1.5 * hrs;
  else c.energy -= 0.8 * hrs;
  c.energy = Math.max(0, Math.min(100, c.energy));

  if (c.hunger > 90) c.health -= 3 * hrs;
  else if (c.hunger > 75) c.health -= 0.8 * hrs;
  else if (!c.sick) c.health += 0.8 * hrs;
  if (c.sick) c.health += c.sick.treated ? 0.3 * hrs : -0.35 * c.sick.sev * hrs;
  if (c.energy <= 0) c.health -= 0.5 * hrs;
  c.health = Math.min(100, c.health);
  if (c.health <= 0) return die(sim, c);

  if (c.sick) {
    if (c.sick.recoverAt && sim.minutes >= c.sick.recoverAt && !c.sick.hospital) sim.health.recover(c, 'natural');
    else if (!c.sick.reported && sim.minutes >= c.sick.reportAt) sim.health.book(c, c.sick.symptom, false);
  }
}

function die(sim, c) {
  c.dead = true; c.path = null; c.task = null; c.inside = false;
  const cause = c.hunger > 85 ? 'hunger' : c.sick ? `illness (${c.sick.name})` : 'exhaustion';
  sim.log('death', `${c.name} has died of ${cause}.`, c.id, {
    cause, hunger: Math.round(c.hunger), energy: Math.round(c.energy), job: c.job, sick: c.sick?.name || null,
    depotFood: Math.round(sim.gov.depot.food), foodDays: +sim.gov.foodDays.toFixed(2), medicine: +sim.gov.depot.medicine.toFixed(1),
    aliveBefore: sim.citizens.filter((x) => !x.dead).length + 1,
  });
  for (const o of sim.citizens) if (!o.dead && o.traits.sociability > 0.5) sim.remember(o, 'death', `${c.name} has died of ${cause}.`, 0.9);
  if (c.apt) sim.health.cancel(c);
}

function moveAlong(c, dt) {
  let d = c.speed * dt * (c.sick ? 0.7 : 1) * (c.hunger > 85 ? 0.6 : 1);
  c.stats.walked += d;
  while (d > 0 && c.path && c.pi < c.path.length) {
    const [tx, tz] = c.path[c.pi];
    const dx = tx - c.x, dz = tz - c.z, dist = Math.hypot(dx, dz);
    if (dist <= d) { c.x = tx; c.z = tz; d -= dist; c.pi++; }
    else { c.x += (dx / dist) * d; c.z += (dz / dist) * d; c.heading = Math.atan2(dx, dz); d = 0; }
  }
  if (c.pi >= c.path.length) { c.path = null; c.pi = 0; }
}

// Route to a building; logs the movement (including turning points) in the database.
export function goTo(sim, c, b, purpose) {
  if (c.loc === b.id) return false;
  const w = sim.world;
  const pts = [];
  let start;
  if (c.loc != null) { const cb = w.byId[c.loc]; start = doorPoint(cb); pts.push(start); c.inside = false; }
  else start = [c.x, c.z];
  const cells = roadPath(w, start, doorPoint(b));
  const ox = (c.id % 5 - 2) * 0.12, oz = (c.id % 3 - 1) * 0.15; // each person walks in their own "lane"
  for (const [x, z] of cells) pts.push([x + ox, z + oz]);
  pts.push(yardPoint(b, sim.rng));
  c.loc = null;
  c.path = pts; c.pi = 0;
  let dist = 0;
  for (let i = 1; i < pts.length; i++) dist += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const turns = pts.filter((p, i) => i === 0 || i === pts.length - 1 || (pts[i + 1] && (pts[i + 1][0] - p[0] !== p[0] - pts[i - 1][0] || pts[i + 1][1] - p[1] !== p[1] - pts[i - 1][1]))).map((p) => [+p[0].toFixed(1), +p[1].toFixed(1)]);
  const last = pts[pts.length - 1];
  sim.store.move(sim.tick, sim.minutes | 0, c.id, purpose, +c.x.toFixed(2), +c.z.toFixed(2), +last[0].toFixed(2), +last[1].toFixed(2), +dist.toFixed(1), JSON.stringify(turns));
  c.dest = b.id;
  return true;
}

function arrive(sim, c) {
  const t = c.task;
  if (t && c.dest != null) c.loc = c.dest;
  c.dest = null;
  if (t) beginDo(sim, c, t);
}

function startTask(sim, c, task) {
  c.task = task;
  task.phase = 'go';
  const b = task.bid != null ? sim.world.byId[task.bid] : null;
  if (b && c.loc !== b.id) goTo(sim, c, b, task.kind);
  else beginDo(sim, c, task);
}

function beginDo(sim, c, t) {
  t.phase = 'do';
  t.started = sim.minutes;
  if (t.kind === 'sleep' || t.kind === 'hospital') c.inside = true;
  if (t.kind === 'ration') claimRation(sim, c);
  else if (t.kind === 'depot_visit') { sim.gov.processVisit(c, t); c.task = null; }
  else if (t.kind === 'work') { t.out = 0; t.hrs = 0; }
}

const endTask = (c) => { c.task = null; c.inside = false; };

function claimRation(sim, c) {
  c.lastRationAt = sim.minutes;
  const r = sim.gov.issueRation(c);
  if (r.kcal <= 1) {
    // Only log a denial when the depot really is (nearly) empty, and not more than once per 2 simulated hours per citizen.
    if (sim.gov.depot.food < 50 && sim.minutes - (c.lastDeniedLog ?? -1e9) > 120) {
      c.lastDeniedLog = sim.minutes;
      sim.log('ration_denied', `${c.name} queued for food but the depot is empty (hunger ${Math.round(c.hunger)}).`, c.id, { hunger: Math.round(c.hunger) });
    }
    c.task = null; return;
  }
  c.task = { kind: 'eat', phase: 'do', kcal: r.kcal, left: r.kcal, dur: Math.max(10, Math.min(40, r.kcal / 40)), started: sim.minutes, bid: c.loc };
}

// A person can get "food aid" from a drone anywhere.
export function forceEat(sim, c, kcal) {
  c.path = null; c.inside = false;
  c.task = { kind: 'eat', phase: 'do', kcal, left: kcal, dur: 15, started: sim.minutes, bid: c.loc, subsidy: true };
}

function runTask(sim, c, dtMin) {
  const t = c.task;
  if (t.phase !== 'do') return;
  const hrs = dtMin / 60;
  const hour = sim.hour();
  const needMeal = c.hunger >= 80 || (c.hunger > 25 && mealWindow(hour) && sim.minutes - c.lastRationAt > 150);
  switch (t.kind) {
    case 'eat': {
      const part = Math.min(t.left, t.kcal * (dtMin / t.dur));
      t.left -= part;
      c.hunger -= (part / c.traits.appetite) * HUNGER_PER_DAY;
      c.stats.eaten += part;
      if (t.left <= 0.5) {
        sim.log('eat', `${c.name} ate ${Math.round(t.kcal)} kcal${t.subsidy ? ' (emergency pack)' : ''}.`, c.id, { kcal: Math.round(t.kcal), hunger: +c.hunger.toFixed(1) });
        sim.remember(c, 'eat', `I ate ${Math.round(t.kcal)} kcal${t.subsidy ? ' from an emergency pack from a drone' : ''}. Hunger is now ${Math.round(c.hunger)}.`, 0.2);
        endTask(c);
      }
      break;
    }
    case 'work': {
      const g = sim.gov;
      const out = g.produce(c, hrs);
      t.out += out; t.hrs += hrs;
      c.energy -= 0; // energy is already spent in vitals()
      if (sim.minutes >= t.until || c.energy < 12 || c.rest || needMeal || c.sick?.sev >= 2 || c.apt) {
        if (t.hrs > 0.2) {
          const unit = c.job === 'farmer' ? `${Math.round(t.out)} kcal of food` : c.job === 'maker' ? `${t.out.toFixed(1)} labour-hours of goods` : `${t.out.toFixed(1)} medicine units`;
          sim.log('work', `${c.name} (${jobName(c.job)}) worked ${t.hrs.toFixed(1)}h and produced ${unit}.`, c.id, { job: c.job, hours: +t.hrs.toFixed(2), out: +t.out.toFixed(2) });
          c.stats.produced += t.out;
        }
        endTask(c);
      }
      break;
    }
    case 'sleep':
      if (sim.minutes >= t.until || (c.energy >= 98 && sim.hour() >= 6 && sim.hour() < 12) || c.hunger >= 85) { if (sim.minutes - t.started > 120) sim.log('wake', `${c.name} is awake.`, c.id); endTask(c); }
      break;
    case 'rest':
      if (sim.minutes >= t.until) endTask(c);
      break;
    case 'leisure':
      if (sim.minutes >= t.until || needMeal) endTask(c);
      break;
    case 'await_drone':
      // Waiting for the drone with the sample kit / medicine. The health module ends this.
      if (!c.apt || sim.minutes >= t.until) endTask(c);
      break;
    case 'sample':
      if (!c.apt || c.apt.state !== 'sampling') endTask(c);
      break;
    case 'hospital':
      c.inside = true;
      if (!c.sick?.hospital) endTask(c);
      break;
    default: endTask(c);
  }
}

function chooseTask(sim, c) {
  const hour = sim.hour();
  const day = sim.day();
  const r = sim.rng;
  const world = sim.world;
  const depot = world.ofType('depot')[0];
  const home = world.byId[c.home];
  const now = sim.minutes;

  // 1. A medical appointment comes first
  if (c.apt) {
    if (c.apt.state === 'admit') { startTask(sim, c, { kind: 'hospital', bid: world.ofType('hospital')[0].id }); return; }
    if (['booked', 'drone_out', 'sampling', 'medicine_wait', 'medicine_out'].includes(c.apt.state)) {
      startTask(sim, c, { kind: c.apt.state === 'sampling' ? 'sample' : 'await_drone', bid: home.id, until: now + 240 });
      return;
    }
  }
  // 2. Eating: sensor + meal windows
  const canClaim = now - c.lastRationAt > 150 || c.hunger >= 70;
  if (canClaim && (c.hunger >= 55 || (mealWindow(hour) && c.hunger > 12))) {
    startTask(sim, c, { kind: 'ration', bid: depot.id });
    return;
  }
  // 3. Sleeping / exhausted
  if (hour >= 22 || hour < 6 || c.energy < 12) {
    const dayStart = Math.floor(now / 1440) * 1440;
    const wake = hour >= 6 && hour < 22 ? now + 300 : dayStart + (hour >= 22 ? 1440 : 0) + 6 * 60 + 1;
    startTask(sim, c, { kind: 'sleep', bid: home.id, until: wake });
    return;
  }
  // 4. Ill: recover at home
  if (c.sick && c.sick.sev >= 2) { startTask(sim, c, { kind: 'rest', bid: home.id, until: now + 120 }); return; }
  // 5. Ordered rest
  if (c.rest) { startTask(sim, c, { kind: 'rest', bid: home.id, until: now + 120 }); return; }
  // 6. Work (08:00 - 17:00)
  if (hour >= 8 && hour < 17 && c.job && c.energy > 25 && c.health > 35) {
    const bt = c.job === 'farmer' ? 'farm' : c.job === 'maker' ? 'workshop' : 'hospital';
    const options = world.ofType(bt);
    const bld = options[(c.id + day) % options.length];
    startTask(sim, c, { kind: 'work', bid: bld.id, until: Math.floor(now / 1440) * 1440 + 17 * 60 });
    return;
  }
  // 7. Depot: redistribution orders and trade wishes (evening)
  if ((c.orders.length || c.wantReq) && hour >= 15.5 && hour < 22) {
    startTask(sim, c, { kind: 'depot_visit', bid: depot.id });
    return;
  }
  // 8. Leisure
  const spots = [...world.ofType('park'), home, depot];
  const spot = r() < 0.55 ? world.ofType('park')[0] : r.pick(spots);
  startTask(sim, c, { kind: 'leisure', bid: spot.id, until: now + r.int(30, 90) });
}

export { fmtItems, itemName };
