import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { cfg } from './config.js';
import { openStore } from './db.js';
import { LLM } from './llm.js';
import { Sim } from './sim.js';

const store = openStore(cfg.dataDir);
const llm = new LLM(cfg, store);
const sim = new Sim({ cfg, store, llm });
sim.init();

const app = Fastify({ logger: false });

// ---- REST (alleen lezen, publiek) ---------------------------------------------
const lim = (v, d = 100, max = 1000) => Math.max(1, Math.min(max, Number(v) || d));
app.get('/api/health', async () => ({ ok: true, tick: sim.tick, day: sim.day(), time: sim.clockStr(), llm: llm.status() }));
app.get('/api/state', async () => sim.liveState());
app.get('/api/citizens', async () => sim.citizens.map((c) => sim.detail(c)));
app.get('/api/citizens/:id', async (req, rep) => {
  const c = sim.byId.get(Number(req.params.id));
  if (!c) return rep.code(404).send({ error: 'onbekende burger' });
  const id = c.id;
  const q = (sql, ...a) => store.db.prepare(sql).all(...a);
  return {
    ...sim.detail(c),
    memories: q('SELECT minute,kind,text,importance FROM memories WHERE cid=? ORDER BY id DESC LIMIT 60', id),
    events: q('SELECT id,minute,type,text FROM events WHERE actor=? ORDER BY id DESC LIMIT 60', id),
    trades: q('SELECT minute,kind,got,gave,weight_in,weight_out FROM trades WHERE cid=? ORDER BY id DESC LIMIT 30', id),
    moves: q('SELECT minute,purpose,x0,z0,x1,z1,dist FROM moves WHERE cid=? ORDER BY id DESC LIMIT 30', id),
  };
});
app.get('/api/events', async (req) => {
  const { type, actor, before } = req.query;
  const where = [], args = [];
  if (type) { where.push('type=?'); args.push(type); }
  if (actor) { where.push('actor=?'); args.push(Number(actor)); }
  if (before) { where.push('id<?'); args.push(Number(before)); }
  store.flush();
  return store.db.prepare(`SELECT id,tick,minute,type,actor,text,data FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`).all(...args, lim(req.query.limit));
});
app.get('/api/decisions', async (req) => { store.flush(); return store.db.prepare('SELECT id,minute,source,kind,reasoning,output FROM decisions ORDER BY id DESC LIMIT ?').all(lim(req.query.limit, 30, 200)); });
app.get('/api/moves', async (req) => { store.flush(); return store.db.prepare('SELECT * FROM moves WHERE (? IS NULL OR cid=?) ORDER BY id DESC LIMIT ?').all(req.query.citizen ?? null, req.query.citizen ?? null, lim(req.query.limit)); });
app.get('/api/positions', async (req) => { store.flush(); return store.db.prepare('SELECT * FROM positions WHERE cid=? ORDER BY tick DESC LIMIT ?').all(Number(req.query.citizen), lim(req.query.limit, 200, 5000)); });
app.get('/api/stats/history', async () => sim.history);
app.get('/api/llm', async () => ({ ...llm.status(), calls: (store.flush(), store.db.prepare('SELECT ts,purpose,ok,prompt_tokens,completion_tokens,ms,cost,error FROM llm_calls ORDER BY id DESC LIMIT 50').all()) }));

const pub = path.resolve(cfg.publicDir);
if (fs.existsSync(pub)) await app.register(fastifyStatic, { root: pub });
else app.get('/', async () => 'Frontend niet gebouwd (zie frontend/).');

await app.listen({ port: cfg.port, host: '0.0.0.0' });
// Browsers (Chrome/Firefox) blokkeren poort 1723 als "onveilige poort" (PPTP). Daarom bedient dezelfde app ook poort 1724.
const servers = [app.server];
if (cfg.webPort && cfg.webPort !== cfg.port) {
  const extra = http.createServer((req, res) => app.routing(req, res));
  await new Promise((ok) => extra.listen(cfg.webPort, '0.0.0.0', ok));
  servers.push(extra);
}
console.log(`[server] poort ${servers.length > 1 ? `${cfg.port} + ${cfg.webPort}` : cfg.port}  — LLM: ${llm.configured ? llm.c.model : 'niet ingesteld (regel-modus)'}`);

// ---- WebSocket ---------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 512 } });
for (const srv of servers) srv.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
const send = (ws, msg) => { if (ws.readyState === 1 && ws.bufferedAmount < 1e6) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); };
const broadcast = (msg) => { const s = JSON.stringify(msg); for (const ws of wss.clients) send(ws, s); };

wss.on('connection', (ws) => {
  send(ws, sim.hello());
  ws.on('message', (raw) => {
    try {
      const m = JSON.parse(raw);
      if (m.type === 'citizen') { const c = sim.byId.get(Number(m.id)); if (c) send(ws, { type: 'citizen', data: sim.detail(c) }); }
    } catch { /* negeren */ }
  });
});
sim.emitter = (kind, payload) => broadcast({ type: kind, data: payload });

// ---- de simulatie draait altijd door, ook zonder kijkers --------------------
let last = performance.now(), acc = 0, bc = 0, slow = 0;
setInterval(() => {
  const now = performance.now();
  acc += Math.min(now - last, 1000); last = now;
  const stepMs = 1000 / cfg.tickHz;
  while (acc >= stepMs) { sim.step(); acc -= stepMs; if (++bc >= cfg.tickHz / cfg.broadcastHz) { bc = 0; if (wss.clients.size) broadcast({ type: 'frame', ...sim.frame() }); } }
  if (++slow % 10 === 0) { // ~1x/s
    store.flush();
    if (sim.liveEvents.length) { if (wss.clients.size) broadcast({ type: 'events', data: sim.liveEvents }); sim.liveEvents = []; }
  }
  if (slow % 20 === 0 && wss.clients.size) broadcast({ type: 'state', data: sim.liveState() });
}, 50);

const shutdown = () => { console.log('[server] afsluiten, snapshot opslaan...'); sim.save(); store.close(); process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
