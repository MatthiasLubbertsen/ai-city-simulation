# 🏙️ AI City — a city without money

A real-time, agent-based simulation of a city **without money**, run by a central AI government.
Anyone can watch in 3D, and the simulation keeps running when nobody has the page open.

```
cp .env.example .env     # add your JEV_API_KEY (optional, see below)
docker compose up --build
# then open http://localhost:1724
```

> ⚠️ **Port 1723** is on the "unsafe ports" list of Chrome and Firefox (it is PPTP), so browsers refuse to open it
> (`ERR_UNSAFE_PORT`). The same app is therefore also served on **1724**. Use 1723 for curl or a reverse proxy, 1724 in the browser.

## How the moneyless system works

| Part | Rule |
|---|---|
| **Census** | Every day everyone declares *everything* they own (`census`). Dishonest citizens sometimes hide an item; drones run random audits and confiscate anything undeclared. |
| **Equality** | The exchange value of a thing is the *labour-hours* that went into it (`weight`). The government computes the average holdings. Citizens far above it hand items in to the depot; citizens below it receive items from the depot (`rebalance`). |
| **Swapping** | Want a new phone? First hand in things of at least the same weight (the laptops from the attic, that yo-yo…). No money, only exchange. |
| **Food** | A belly sensor measures your real need and you get exactly that. If it feels like too little you can ask for 110–120%. What you get, you eat. |
| **Emergency aid** | If someone is close to starving (hunger ≥ 80) a food drone flies straight to them. |
| **Healthcare** | You book an appointment → a drone brings a test kit → you breathe/cough/give a sample → lab. Really sick: medicine delivered at home (drone) or hospital admission. Fake sample: DNA mismatch → fraud recorded. Medics own exactly as much as everyone else; the hospital belongs to the government. |

Citizens are coloured: 🔵 idle · 🟠 working · 🟢 eating · 🔴 starving · ⚪ deceased · 🟣 sick.

## Architecture

```
backend/  (Node 22, Fastify, ws, better-sqlite3)
  sim.js         simulation loop (10 Hz), snapshots, websocket frames
  citizen.js     the citizen agent: needs, daily rhythm, tasks, pathfinding over streets
  government.js  the AI government: census, redistribution, rations, production, jobs, policy
  health.js      appointments, drones, lab, hospital, emergency food drones
  mind.js        Jev questions + answer interpretation, with a free rule-based fallback
  jev.js         Jev API client with budgets, Retry-After handling and a circuit breaker
  db.js          SQLite: events, positions, moves, memories, decisions, trades, llm_calls, stats, snapshot
frontend/ (Vite, three.js, Chart.js)
  scene.js       3D city, citizens, drones, day/night, bloom
  main.js        UI, websocket, charts, inspector, live log
```

* **Every citizen is their own agent** (personality, hunger/energy/health, holdings, memory, wishes). A free reflex layer runs every
  tick; Jev decides *preferences*: portion size, what kind of thing they want, and their mood.
* **The government** is one central agent. It sends Jev the city statistics and gets back classifications that become policy:
  workforce allocation, ration cap, production focus, immediate redistribution, enforced rest, announcements.
  Every decision is stored with its input, Jev's raw answers and the resulting policy. Without Jev, a rule-based government takes over.
* **Everything is stored** (SQLite in the `/data` volume): every event, every trip (including turning points), position samples
  (every 10 s), every memory, every trade, every government decision and every Jev call. The world is snapshotted every 30 s and resumed after a restart.
* **Real time**: the server streams compact frames (5 Hz) plus events and stats over WebSocket; the browser interpolates.

## Jev

[Jev](https://docs.ai.hackclub.com/api/jev.html) is not a chat model: you send a `state` plus typed `questions`
(`noul` = yes/no probability, `choice` = classification, `score` = ordered scale) and get one structured answer per question,
with probabilities and confidence, back in a few hundred milliseconds. That fits agent decisions well, so:

* each citizen periodically sends a small state (age, job, hunger, energy, holdings, 3 recent memories) with three questions
  (portion size, what kind of item they want, mood);
* the government sends aggregate statistics with seven questions (workforce, ration cap, crisis level, production focus,
  redistribute now?, rest orders?, announcement);
* Jev only classifies, so the government wraps its answers in **safety rails** (enough farmers for the current harvest, no moving farmers away while food is low, emergency food drones stay rule-based) — a bad classification can't starve the city;
* since Jev cannot write text, thoughts and announcements are composed locally from its answers (the log shows Jev's choices and confidence).

Set `JEV_API_KEY` in `.env` (see `.env.example`). Base URL defaults to `https://ai.hackclub.com/proxy/v1/jev`, model to `jev-latest`.
No key? The city runs on free rules and the UI says so.

### Keeping it cheap

Jev is billed per **input token only** and counts toward your Hack Club AI daily spending limit.

* Citizens ask Jev only once every 3 simulated days (`JEV_THINK_EVERY_DAYS`), staggered; reflexes are free.
* The government decides about twice per simulated day, or sooner on alarm with a minimum gap.
* States are compact and every question is short.
* Hard limits: `JEV_MAX_CALLS_PER_HOUR` (400), `JEV_DAILY_INPUT_TOKEN_BUDGET` (600k), max 3 concurrent calls.
  `429` honours `Retry-After`, `402` (daily spending limit) pauses Jev for an hour, repeated failures back off exponentially.
  Whenever Jev is paused the city switches to rules by itself and switches back when Jev is available.
* With the defaults (40 citizens, 1 day = 6 min) that is roughly 130 citizen calls + 4 government calls per hour,
  on the order of 50k input tokens per hour. Visible live in the "Jev engine" panel and at `GET /api/llm`.

## Reset the city / what to do when everyone died

* **Automatic:** when the last citizen dies the world freezes, a **post-mortem** is generated and shown to every viewer, and after
  `AUTO_RESTART_SECONDS` (default 300; `0` = never) a fresh city starts by itself.
* **Manually:** set `ADMIN_TOKEN` in `.env`, then click **Reset city** in the report window, or call
  `curl -X POST http://localhost:1724/api/admin/reset -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"population":40}'`
  (optional body: `seed`, `population`). Without `ADMIN_TOKEN` the endpoint is disabled, because the site is public.
* The old run is never lost: its database is archived in `<data volume>/archive/city-<timestamp>.db`.
* Hard wipe: `docker compose down -v` (deletes the data volume including archives).

### Post-mortem report (📜 button, `GET /api/report`)

1. **Forensics from the database:** causes of death, food/harvest timeline (when the depot ran low or empty, worst harvest, peak starvation),
   how many citizens queued at an empty depot, how the government reacted while food was low (Jev vs. rules, farmer counts), medicine stock,
   Jev call failures.
2. **Narrative:** those facts go to the Hack Club AI chat-completions API ([docs](https://docs.ai.hackclub.com/api/chat-completions.html),
   default model `qwen/qwen3-32b`, same API key as Jev) which writes a short root-cause analysis with suggestions.
   Jev can't write text, so a chat model is used here. Without a key (or if the call fails) a local summary is composed from the same findings.
   The result is cached (`REPORT_MIN_INTERVAL_SECONDS`) so public viewers can't burn through your budget.

## API (read-only, plus the two report/admin POSTs)

`GET /api/state` · `/api/citizens` · `/api/citizens/:id` (incl. memory, events, trades, trips) ·
`/api/events?type=&actor=&before=&limit=` · `/api/decisions` · `/api/moves?citizen=` · `/api/positions?citizen=` ·
`/api/stats/history` · `/api/llm` · `/api/health` · `/api/report` · `POST /api/report/refresh` · `POST /api/admin/reset` (token) — WebSocket at `/ws`.

## Development

```bash
cd backend && npm install && npm start            # simulation + API on :1723 / :1724
cd frontend && npm install && npm run dev         # Vite dev server on :1724 with proxy (or: npm run build, the backend serves ../frontend/dist)
```
Useful variables: `POPULATION`, `DAY_SECONDS`, `SEED`, `POSITION_LOG_SECONDS`, `DATA_DIR`.
