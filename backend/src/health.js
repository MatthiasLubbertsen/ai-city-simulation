// Healthcare without spam: appointment -> drone with test kit -> sample at home -> lab -> medicine at home or hospital.
// Fake complaints are exposed by the lab (DNA mismatch). Also emergency food drones.
import { doorPoint } from './world.js';
import { forceEat } from './citizen.js';

export const DISEASES = [
  { id: 'keelpijn', name: 'throat infection', sev: 1, symptom: 'a sore throat', sample: 'breath and cough sample', w: 0.55 },
  { id: 'buikgriep', name: 'stomach flu', sev: 2, symptom: 'bad diarrhoea', sample: 'stool sample', w: 0.3 },
  { id: 'longontsteking', name: 'pneumonia', sev: 3, symptom: 'coughing and fever', sample: 'breath and blood sample', w: 0.15 },
];
const DRONE_SPEED = 7; // cells per real second

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

  // ---- illness arises -----------------------------------------------------
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
          sim.log('sick', `${c.name} falls ill: ${d.name} (complaint: ${d.symptom}).`, c.id, { disease: d.id, sev: d.sev });
          sim.remember(c, 'health', `I feel ill: ${d.symptom}.`, 0.6);
        } else if (c.traits.honesty < 0.25 && sim.rng() < 0.12) {
          // fraudster: pretends to be ill to get a drone test kit and medicine
          c.fakeAt = sim.minutes + sim.rng.int(30, 200);
        }
      }
    }
  }

  checkFakers() {
    const sim = this.sim;
    for (const c of sim.citizens) {
      if (!c.dead && c.fakeAt && sim.minutes >= c.fakeAt) { c.fakeAt = null; if (!c.sick && !c.apt) this.book(c, 'a sore throat', true); }
    }
  }

  book(c, symptom, fake) {
    const sim = this.sim;
    if (c.apt || c.dead) return;
    if (c.sick) c.sick.reported = true;
    const apt = { id: this.nextApt++, cid: c.id, symptom, fake, state: 'booked', t0: sim.minutes, droneId: null, labAt: 0, releaseAt: 0 };
    this.apts.push(apt);
    c.apt = apt;
    sim.log('appointment', `${c.name} books an appointment (complaint: ${symptom}). A drone will bring a test kit.`, c.id, { apt: apt.id, symptom });
    sim.remember(c, 'health', `I booked an appointment for ${symptom}. A drone is bringing a test kit.`, 0.5);
  }

  cancel(c) { this.apts = this.apts.filter((a) => a.cid !== c.id); c.apt = null; for (const d of this.drones) if (d.job?.cid === c.id) { d.state = 'back'; d.job = null; } }

  finish(apt, c) { this.apts = this.apts.filter((a) => a !== apt); if (c) c.apt = null; }

  recover(c, how) {
    const sim = this.sim;
    const name = c.sick?.name;
    c.sick = null; c.inside = c.inside && c.task?.kind === 'sleep';
    if (c.apt) this.finish(c.apt, c);
    sim.log('recover', `${c.name} has recovered from ${name} (${how === 'hospital' ? 'hospital' : how === 'medicine' ? 'medicine' : 'on their own'}).`, c.id, { how });
    sim.remember(c, 'health', `I'm better again after ${name}.`, 0.5);
  }

  // ---- step ----------------------------------------------------------------
  update(dtReal, dtMin) {
    const sim = this.sim, gov = sim.gov, now = sim.minutes;
    this.checkFakers();
    // Assign
    const idleMed = () => this.drones.find((d) => d.kind === 'med' && d.state === 'idle');
    for (const apt of this.apts) {
      const c = sim.byId.get(apt.cid);
      if (!c || c.dead) continue;
      if (apt.state === 'booked') {
        const d = idleMed();
        if (d) { d.job = { kind: 'sample', cid: c.id, aptId: apt.id }; d.state = 'out'; d.timer = 0; d.wait = 0; apt.state = 'drone_out'; apt.droneId = d.id;
          sim.log('drone_dispatch', `Drone #${d.id} flies to ${c.name} with a test kit.`, c.id, { drone: d.id, apt: apt.id }); }
      } else if (apt.state === 'lab' && now >= apt.labAt) this.labResult(apt, c);
      else if (apt.state === 'medicine_wait' && gov.depot.medicine >= apt.need) {
        const d = idleMed();
        if (d) { gov.depot.medicine -= apt.need; d.job = { kind: 'medicine', cid: c.id, aptId: apt.id }; d.state = 'out'; d.timer = 0; apt.state = 'medicine_out';
          sim.log('drone_dispatch', `Drone #${d.id} is taking medicine to ${c.name}.`, c.id, { drone: d.id }); }
      } else if (apt.state === 'admit' && c.loc === sim.world.ofType('hospital')[0].id && c.task?.kind === 'hospital' && c.task.phase === 'do') {
        c.sick.hospital = true; c.sick.treated = true;
        const need = Math.min(apt.need, gov.depot.medicine); gov.depot.medicine -= need;
        apt.state = 'admitted'; apt.releaseAt = now + (c.sick.sev >= 3 ? 30 : 16) * 60;
        sim.log('admitted', `${c.name} is admitted to hospital (${c.sick.name}).`, c.id, { medicine: need });
      } else if (apt.state === 'admitted' && now >= apt.releaseAt) { c.sick.hospital = false; this.recover(c, 'hospital'); }
    }
    // Food drones
    while (this.foodQueue.length) {
      const d = this.drones.find((x) => x.kind === 'supply' && x.state === 'idle');
      if (!d) break;
      const job = this.foodQueue.shift();
      d.job = { kind: 'food', cid: job.cid, kcal: job.kcal }; d.state = 'out'; d.timer = 0;
    }
    // Move
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
        sim.log('subsidy_delivered', `Drone #${d.id} delivered ${Math.round(job.kcal)} kcal to ${c.name}.`, c.id, { kcal: Math.round(job.kcal) });
        d.state = 'back'; return;
      }
      const apt = c.apt;
      if (!apt) { d.state = 'back'; return; }
      if (job.kind === 'medicine') {
        d.timer += dtMin;
        if (d.timer >= 4) {
          if (c.sick) { c.sick.treated = true; c.sick.recoverAt = sim.minutes + (c.sick.sev === 1 ? 14 : 30) * 60; }
          sim.log('medicine_delivered', `Drone #${d.id} delivered medicine to ${c.name} at home.`, c.id, { drone: d.id });
          sim.remember(c, 'health', "A drone brought medicine. I'm going to rest.", 0.5);
          this.finish(apt, c); d.state = 'back';
        }
        return;
      }
      // taking the sample: the citizen must be home
      const present = c.loc === home.id && !c.path;
      if (!present) { d.wait += dtMin; if (d.wait > 240) { sim.log('no_show', `${c.name} was not home for the test kit; appointment cancelled.`, c.id); this.finish(apt, c); d.state = 'back'; } return; }
      if (apt.state !== 'sampling') {
        apt.state = 'sampling';
        sim.log('sampling', `${c.name} breathes/coughs into the test kit from drone #${d.id}${apt.fake ? '' : ''}.`, c.id, { symptom: apt.symptom });
      }
      d.timer += dtMin;
      if (d.timer >= 10) {
        apt.state = 'lab'; apt.labAt = sim.minutes + 90; d.state = 'back';
        sim.log('sample_sent', `${c.name}'s sample is on its way to the lab.`, c.id, {});
      }
    }
  }

  labResult(apt, c) {
    const sim = this.sim, gov = sim.gov;
    const real = !!c.sick && !c.sick.treated;
    if (real) {
      apt.need = c.sick.sev === 1 ? 1 : 3;
      sim.log('lab_positive', `Lab: ${c.name} really has ${c.sick.name}. ${c.sick.sev === 1 ? 'Medicine at home.' : 'Hospital admission.'}`, c.id, { disease: c.sick.id, sev: c.sick.sev });
      apt.state = c.sick.sev === 1 ? 'medicine_wait' : 'admit';
    } else if (apt.fake && sim.rng() < 0.9) {
      c.fraudStrikes++; gov.counters.fraud++;
      sim.log('lab_fraud', `Lab: ${c.name}'s sample does not match the complaint (fake sample, DNA mismatch). Fraud recorded (warning ${c.fraudStrikes}).`, c.id, { strikes: c.fraudStrikes });
      sim.remember(c, 'fraud', 'I tried to fool healthcare with a fake sample and got caught.', 0.9);
      this.finish(apt, c);
    } else if (apt.fake) {
      apt.need = 1; apt.state = 'medicine_wait';
      sim.log('lab_missed', `Lab: ${c.name}'s sample looks positive (the fraud was missed).`, c.id, {});
    } else {
      sim.log('lab_negative', `Lab: ${c.name} turns out not to be ill. No medicine needed.`, c.id, {});
      sim.remember(c, 'health', 'The lab says there is nothing wrong with me. Phew.', 0.3);
      this.finish(apt, c);
    }
  }

  dispatchFood(c, kcal) { this.foodQueue.push({ cid: c.id, kcal }); }
}
