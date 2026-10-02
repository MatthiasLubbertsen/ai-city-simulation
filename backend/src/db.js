import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

// Alles wordt bewaard: elk event, elke beweging, elke herinnering, elke overheidsbeslissing, elke LLM-call.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY, ts INTEGER, tick INTEGER, minute INTEGER, type TEXT, actor INTEGER, target INTEGER, text TEXT, data TEXT);
CREATE INDEX IF NOT EXISTS ev_type ON events(type, id);
CREATE INDEX IF NOT EXISTS ev_actor ON events(actor, id);
CREATE TABLE IF NOT EXISTS positions(tick INTEGER, minute INTEGER, cid INTEGER, x REAL, z REAL, mode INTEGER, hunger REAL);
CREATE INDEX IF NOT EXISTS pos_cid ON positions(cid, tick);
CREATE TABLE IF NOT EXISTS moves(
  id INTEGER PRIMARY KEY, tick INTEGER, minute INTEGER, cid INTEGER, purpose TEXT, x0 REAL, z0 REAL, x1 REAL, z1 REAL, dist REAL, path TEXT);
CREATE INDEX IF NOT EXISTS mv_cid ON moves(cid, id);
CREATE TABLE IF NOT EXISTS memories(
  id INTEGER PRIMARY KEY, tick INTEGER, minute INTEGER, cid INTEGER, kind TEXT, text TEXT, importance REAL);
CREATE INDEX IF NOT EXISTS mem_cid ON memories(cid, id);
CREATE TABLE IF NOT EXISTS decisions(
  id INTEGER PRIMARY KEY, tick INTEGER, minute INTEGER, source TEXT, kind TEXT, input TEXT, output TEXT, reasoning TEXT);
CREATE TABLE IF NOT EXISTS trades(
  id INTEGER PRIMARY KEY, tick INTEGER, minute INTEGER, cid INTEGER, kind TEXT, got TEXT, gave TEXT, weight_in REAL, weight_out REAL);
CREATE INDEX IF NOT EXISTS tr_cid ON trades(cid, id);
CREATE TABLE IF NOT EXISTS llm_calls(
  id INTEGER PRIMARY KEY, ts INTEGER, purpose TEXT, model TEXT, ok INTEGER, prompt_tokens INTEGER, completion_tokens INTEGER, ms INTEGER, cost REAL, error TEXT);
CREATE TABLE IF NOT EXISTS stats(tick INTEGER, minute INTEGER, data TEXT);
CREATE TABLE IF NOT EXISTS snapshot(id INTEGER PRIMARY KEY CHECK (id = 1), tick INTEGER, data TEXT);
`;

export function openStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'city.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);

  const st = {
    event: db.prepare('INSERT INTO events(ts,tick,minute,type,actor,target,text,data) VALUES(?,?,?,?,?,?,?,?)'),
    pos: db.prepare('INSERT INTO positions VALUES(?,?,?,?,?,?,?)'),
    move: db.prepare('INSERT INTO moves(tick,minute,cid,purpose,x0,z0,x1,z1,dist,path) VALUES(?,?,?,?,?,?,?,?,?,?)'),
    mem: db.prepare('INSERT INTO memories(tick,minute,cid,kind,text,importance) VALUES(?,?,?,?,?,?)'),
    dec: db.prepare('INSERT INTO decisions(tick,minute,source,kind,input,output,reasoning) VALUES(?,?,?,?,?,?,?)'),
    trade: db.prepare('INSERT INTO trades(tick,minute,cid,kind,got,gave,weight_in,weight_out) VALUES(?,?,?,?,?,?,?,?)'),
    llm: db.prepare('INSERT INTO llm_calls(ts,purpose,model,ok,prompt_tokens,completion_tokens,ms,cost,error) VALUES(?,?,?,?,?,?,?,?,?)'),
    stats: db.prepare('INSERT INTO stats VALUES(?,?,?)'),
    snap: db.prepare('INSERT INTO snapshot(id,tick,data) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET tick=excluded.tick, data=excluded.data'),
  };

  // Schrijven gebeurt in batches (1x per seconde) in één transactie.
  let queue = [];
  const q = (fn) => queue.push(fn);
  const flush = db.transaction((items) => { for (const f of items) f(); });

  return {
    db,
    event: (tick, minute, type, actor, target, text, data) => {
      const row = { ts: Date.now(), tick, minute, type, actor: actor ?? null, target: target ?? null, text, data };
      q(() => st.event.run(row.ts, tick, minute, type, row.actor, row.target, text, data ? JSON.stringify(data) : null));
    },
    position: (...a) => q(() => st.pos.run(...a)),
    move: (...a) => q(() => st.move.run(...a)),
    memory: (...a) => q(() => st.mem.run(...a)),
    decision: (...a) => q(() => st.dec.run(...a)),
    trade: (...a) => q(() => st.trade.run(...a)),
    llmCall: (...a) => q(() => st.llm.run(...a)),
    stats: (...a) => q(() => st.stats.run(...a)),
    saveSnapshot: (tick, obj) => { flushNow(); st.snap.run(tick, JSON.stringify(obj)); },
    loadSnapshot: () => { const r = db.prepare('SELECT data FROM snapshot WHERE id=1').get(); return r ? JSON.parse(r.data) : null; },
    flush: flushNow,
    close: () => { flushNow(); db.close(); },
  };

  function flushNow() {
    if (!queue.length) return;
    const items = queue; queue = [];
    flush(items);
  }
}
