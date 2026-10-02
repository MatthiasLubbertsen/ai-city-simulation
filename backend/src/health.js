// Zorg zonder spam: afspraak -> drone met testpakketje -> sample thuis -> lab -> medicijnen thuis of ziekenhuis.
// Nep-klachten worden door het lab ontmaskerd (DNA-mismatch). Plus nood-voedseldrones.
import { doorPoint } from './world.js';
import { forceEat } from './citizen.js';

export const DISEASES = [
  { id: 'keelpijn', name: 'keelontsteking', sev: 1, symptom: 'een zere keel', sample: 'adem- en hoestsample', w: 0.55 },
  { id: 'buikgriep', name: 'buikgriep', sev: 2, symptom: 'slechte ontlasting', sample: 'ontlastingsmonster', w: 0.3 },
  { id: 'longontsteking', name: 'longontsteking', sev: 3, symptom: 'hoesten en koorts', sample: 'adem- en bloedsample', w: 0.15 },
];
const DRONE_SPEED = 7; // cellen per echte seconde

export class Health {
  constructor(sim) {
    this.sim = sim;
    this.apts = [];
    this.nextApt = 1;
    this.drones = [];
    this.foodQueue = [];
  }

  initDrones() {
    const w = this.sim.world;
    const bases = { med: doorPoint(w.ofType('hospital')[0]), supply: doorPoint(w.ofType('depot')[0]) };
    this.drones = [];
    let id = 1;
    for (const kind of ['med', 'med', 'supply', 'supply']) this.drones.push({ id: id++, kind, x: bases[kind][0], z: bases[kind][1], base: bases[kind], state: 'idle', job: null, timer: 0, wait: 0 });
  }

  toJSON() { return { apts: this.apts, nextApt: this.nextApt, drones: this.drones, foodQueue: this.foodQueue }; }
  load(o) { Object.assign(this, o); }

  // ---- ziekte ontstaat -----------------------------------------------------
  dailyRolls() {
    const sim = this.sim;
    for (const c of sim.citizens) {
      if (c.dead) continue;
      if (!c.sick && !c.apt) {
        const p = 0.05 + (c.hunger > 60 ? 0.1 : 0);
        if (sim.rng() < p) {
          let r = sim.rng(), d = DISEASES[0];
          for (const x of DISEASES) { if (r < x.w) { d = x; break; } r -= x.w; }
          c.sick = { id: d.id, name: d.name, sev: d.sev, symptom: d.symptom, since: sim.minutes, reported: false, reportAt: sim.minutes + sim.rng.int(30, 240), treated: false, hospital: false,
            recoverAt: d.sev === 1 && sim.rng() < 0.3 ? sim.minutes + sim.rng.int(36, 60) * 60 : null };
          sim.log('sick', `${c.name} wordt ziek: ${d.name} (klacht: ${d.symptom}).`, c.id, { disease: d.id, sev: d.sev });
          sim.remember(c, 'health', `Ik voel me ziek: ${d.symptom}.`, 0.6);
        } else if (c.traits.honesty < 0.25 && sim.rng() < 0.12) {
          // fraudeur: doet alsof hij ziek is om een drone-pakketje en medicijnen te krijgen
          c.fakeAt = sim.minutes + sim.rng.int(30, 200);
        }
      }
    }
  }

  checkFakers() {
    const sim = this.sim;
    for (const c of sim.citizens) {
      if (!c.dead && c.fakeAt && sim.minutes >= c.fakeAt) { c.fakeAt = null; if (!c.sick && !c.apt) this.book(c, 'een zere keel', true); }
    }
  }

  book(c, symptom, fake) {
    const sim = this.sim;
    if (c.apt || c.dead) return;
    if (c.sick) c.sick.reported = true;
    const apt = { id: this.nextApt++, cid: c.id, symptom, fake, state: 'booked', t0: sim.minutes, droneId: null, labAt: 0, releaseAt: 0 };
    this.apts.push(apt);
    c.apt = apt;
    sim.log('appointment', `${c.name} maakt een afspraak (klacht: ${symptom}). Er komt een drone met een testpakketje.`, c.id, { apt: apt.id, symptom });
    sim.remember(c, 'health', `Ik maakte een afspraak voor ${symptom}. Een drone brengt een testpakketje.`, 0.5);
  }

  cancel(c) { this.apts = this.apts.filter((a) => a.cid !== c.id); c.apt = null; for (const d of this.drones) if (d.job?.cid === c.id) { d.state = 'back'; d.job = null; } }

  finish(apt, c) { this.apts = this.apts.filter((a) => a !== apt); if (c) c.apt = null; }

  recover(c, how) {
    const sim = this.sim;
    const name = c.sick?.name;
    c.sick = null; c.inside = c.inside && c.task?.kind === 'sleep';
    if (c.apt) this.finish(c.apt, c);
    sim.log('recover', `${c.name} is hersteld van ${name} (${how === 'hospital' ? 'ziekenhuis' : how === 'medicine' ? 'medicijnen' : 'vanzelf'}).`, c.id, { how });
    sim.remember(c, 'health', `Ik ben weer beter van ${name}.`, 0.5);
  }

  // ---- stap ----------------------------------------------------------------
  update(dtReal, dtMin) {
    const sim = this.sim, gov = sim.gov, now = sim.minutes;
    this.checkFakers();
    // Toewijzen
    const idleMed = () => this.drones.find((d) => d.kind === 'med' && d.state === 'idle');
    for (const apt of this.apts) {
      const c = sim.byId.get(apt.cid);
      if (!c || c.dead) continue;
      if (apt.state === 'booked') {
        const d = idleMed();
        if (d) { d.job = { kind: 'sample', cid: c.id, aptId: apt.id }; d.state = 'out'; d.timer = 0; d.wait = 0; apt.state = 'drone_out'; apt.droneId = d.id;
          sim.log('drone_dispatch', `Drone #${d.id} vliegt met testpakketje naar ${c.name}.`, c.id, { drone: d.id, apt: apt.id }); }
      } else if (apt.state === 'lab' && now >= apt.labAt) this.labResult(apt, c);
      else if (apt.state === 'medicine_wait' && gov.depot.medicine >= apt.need) {
        const d = idleMed();
        if (d) { gov.depot.medicine -= apt.need; d.job = { kind: 'medicine', cid: c.id, aptId: apt.id }; d.state = 'out'; d.timer = 0; apt.state = 'medicine_out';
          sim.log('drone_dispatch', `Drone #${d.id} brengt medicijnen naar ${c.name}.`, c.id, { drone: d.id }); }
      } else if (apt.state === 'admit' && c.loc === sim.world.ofType('hospital')[0].id && c.task?.kind === 'hospital' && c.task.phase === 'do') {
        c.sick.hospital = true; c.sick.treated = true;
        const need = Math.min(apt.need, gov.depot.medicine); gov.depot.medicine -= need;
        apt.state = 'admitted'; apt.releaseAt = now + (c.sick.sev >= 3 ? 30 : 16) * 60;
        sim.log('admitted', `${c.name} is opgenomen in het ziekenhuis (${c.sick.name}).`, c.id, { medicine: need });
      } else if (apt.state === 'admitted' && now >= apt.releaseAt) { c.sick.hospital = false; this.recover(c, 'hospital'); }
    }
    // Voedseldrones
    while (this.foodQueue.length) {
      const d = this.drones.find((x) => x.kind === 'supply' && x.state === 'idle');
      if (!d) break;
      const job = this.foodQueue.shift();
      d.job = { kind: 'food', cid: job.cid, kcal: job.kcal }; d.state = 'out'; d.timer = 0;
    }
    // Bewegen
    for (const d of this.drones) this.stepDrone(d, dtReal, dtMin);
  }

  stepDrone(d, dtReal, dtMin) {
    const sim = this.sim;
    if (d.state === 'idle') return;
    const fly = (tx, tz) => {
      const dx = tx - d.x, dz = tz - d.z, dist = Math.hypot(dx, dz), step = DRONE_SPEED * dtReal;
      if (dist <= step) { d.x = tx; d.z = tz; return true; }
      d.x += (dx / dist) * step; d.z += (dz / dist) * step; return false;
    };
    if (d.state === 'back') { if (fly(d.base[0], d.base[1])) { d.state = 'idle'; d.job = null; } return; }
    const job = d.job;
    const c = job && sim.byId.get(job.cid);
    if (!job || !c || c.dead) { d.state = 'back'; if (job?.kind === 'food' && c) c.foodDrone = false; return; }
    const home = sim.world.byId[c.home];
    const target = job.kind === 'food' ? [c.x, c.z] : doorPoint(home);
    if (d.state === 'out') { if (fly(target[0], target[1])) { d.state = 'work'; d.timer = 0; d.wait = 0; } return; }
    if (d.state === 'work') {
      if (job.kind === 'food') {
        c.foodDrone = false; forceEat(sim, c, job.kcal);
        sim.log('subsidy_delivered', `Drone #${d.id} leverde ${Math.round(job.kcal)} kcal bij ${c.name}.`, c.id, { kcal: Math.round(job.kcal) });
        d.state = 'back'; return;
      }
      const apt = c.apt;
      if (!apt) { d.state = 'back'; return; }
      if (job.kind === 'medicine') {
        d.timer += dtMin;
        if (d.timer >= 4) {
          if (c.sick) { c.sick.treated = true; c.sick.recoverAt = sim.minutes + (c.sick.sev === 1 ? 14 : 30) * 60; }
          sim.log('medicine_delivered', `Drone #${d.id} leverde medicijnen thuis bij ${c.name}.`, c.id, { drone: d.id });
          sim.remember(c, 'health', 'Een drone bracht medicijnen. Ik ga rusten.', 0.5);
          this.finish(apt, c); d.state = 'back';
        }
        return;
      }
      // sample afnemen: de burger moet thuis zijn
      const present = c.loc === home.id && !c.path;
      if (!present) { d.wait += dtMin; if (d.wait > 240) { sim.log('no_show', `${c.name} was niet thuis voor het testpakket; afspraak vervalt.`, c.id); this.finish(apt, c); d.state = 'back'; } return; }
      if (apt.state !== 'sampling') {
        apt.state = 'sampling';
        sim.log('sampling', `${c.name} ademt/hoest in het testpakket van drone #${d.id}${apt.fake ? '' : ''}.`, c.id, { symptom: apt.symptom });
      }
      d.timer += dtMin;
      if (d.timer >= 10) {
        apt.state = 'lab'; apt.labAt = sim.minutes + 90; d.state = 'back';
        sim.log('sample_sent', `Sample van ${c.name} gaat naar het lab.`, c.id, {});
      }
    }
  }

  labResult(apt, c) {
    const sim = this.sim, gov = sim.gov;
    const real = !!c.sick && !c.sick.treated;
    if (real) {
      apt.need = c.sick.sev === 1 ? 1 : 3;
      sim.log('lab_positive', `Lab: ${c.name} heeft écht ${c.sick.name}. ${c.sick.sev === 1 ? 'Medicijnen thuis.' : 'Opname in het ziekenhuis.'}`, c.id, { disease: c.sick.id, sev: c.sick.sev });
      apt.state = c.sick.sev === 1 ? 'medicine_wait' : 'admit';
    } else if (apt.fake && sim.rng() < 0.9) {
      c.fraudStrikes++; gov.counters.fraud++;
      sim.log('lab_fraud', `Lab: sample van ${c.name} klopt niet met de klacht (nep-sample, DNA-mismatch). Fraude geregistreerd (waarschuwing ${c.fraudStrikes}).`, c.id, { strikes: c.fraudStrikes });
      sim.remember(c, 'fraud', 'Ik probeerde de zorg te foppen met een nep-sample en werd betrapt.', 0.9);
      this.finish(apt, c);
    } else if (apt.fake) {
      apt.need = 1; apt.state = 'medicine_wait';
      sim.log('lab_missed', `Lab: sample van ${c.name} lijkt positief (de fraude werd gemist).`, c.id, {});
    } else {
      sim.log('lab_negative', `Lab: ${c.name} blijkt niet ziek te zijn. Geen medicijnen nodig.`, c.id, {});
      sim.remember(c, 'health', 'Het lab zegt dat ik niets heb. Gelukkig.', 0.3);
      this.finish(apt, c);
    }
  }

  dispatchFood(c, kcal) { this.foodQueue.push({ cid: c.id, kcal }); }
}
