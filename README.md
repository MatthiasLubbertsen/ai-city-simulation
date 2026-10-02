# 🏙️ AI City — een stad zonder geld

Een realtime, agent-based simulatie van een stad **zonder geld**, bestuurd door een centrale AI-overheid.
Iedereen kan meekijken in 3D; de simulatie draait gewoon door als niemand de site open heeft.

```
docker compose up --build        # daarna: http://localhost:1724   (poort 1723 werkt ook voor API/WebSocket)
```

> ⚠️ **Poort 1723** staat op de "onveilige poorten"-lijst van Chrome/Firefox (PPTP) — de browser weigert die te openen
> (`ERR_UNSAFE_PORT`). Daarom bedient dezelfde app óók **1724**. Gebruik 1723 voor curl / reverse proxy, en 1724 in de browser.

## Hoe werkt het geldloze systeem?

| Onderdeel | Regel |
|---|---|
| **Volkstelling** | Elke dag geeft iedereen *alles* op wat hij bezit (`census`). Oneerlijke burgers houden soms iets achter; drones doen steekproeven (`audit`) en nemen verzwegen spullen in beslag. |
| **Gelijkheid** | Ruilwaarde = *arbeidsuren* die in een ding zitten (`weight`). De overheid rekent het gemiddelde bezit uit. Wie er ruim boven zit moet inleveren in het depot, wie eronder zit krijgt uit het depot (`rebalance`). |
| **Ruilen** | Wil je een nieuwe telefoon? Dan lever je eerst spullen in (laptops van zolder, die jojo…) met minimaal hetzelfde gewicht. Er is geen geld, alleen ruil. |
| **Eten** | Een buiksensor meet je werkelijke behoefte; je krijgt precies zoveel. Vind je het te weinig, dan vraag je 110–120 %. Wat je krijgt eet je ook op. |
| **Nood-subsidie** | Staat iemand er slecht voor (honger ≥ 80), dan vliegt er direct een voedseldrone naartoe. |
| **Zorg** | Geen spreekkamers vol spam: je maakt een afspraak → drone brengt een testpakketje → je ademt/hoest/poept erin → lab. Écht ziek: medicijnen thuis (drone) of ziekenhuisopname. Nep-sample: DNA-mismatch → fraude geregistreerd. Zorgverleners hebben thuis precies evenveel als iedereen; het ziekenhuis is van de overheid. |

Mensjes zijn gekleurd: 🔵 idle · 🟠 werkt · 🟢 eet · 🔴 hongerig · ⚪ overleden · 🟣 ziek.

## Architectuur

```
backend/  (Node 22, Fastify, ws, better-sqlite3)
  sim.js         simulatielus (10 Hz), snapshots, websocket-frames
  citizen.js     de burger-agent: behoeften, dagritme, taken, pathfinding over straten
  government.js  de AI-overheid: volkstelling, herverdeling, rantsoenen, productie, banen, beleid
  health.js      afspraken, drones, lab, ziekenhuis, nood-voedseldrones
  mind.js        LLM-laag (batching, prompts) + gratis regel-fallback
  llm.js         OpenAI-compatibele client met budgetten en circuit breaker
  db.js          SQLite: events, positions, moves, memories, decisions, trades, llm_calls, stats, snapshot
frontend/ (Vite, three.js, Chart.js)
  scene.js       3D stad, burgers, drones, dag/nacht, bloom
  main.js        UI, websocket, grafieken, inspector, live logboek
```

* **Elk mensje is een eigen agent** (eigen persoonlijkheid, honger/energie/gezondheid, bezit, geheugen, wensen).
  Een gratis reflex-laag draait elke tick; de LLM bepaalt *voorkeuren* (portiegrootte, wat ze willen hebben,
  wat ze willen inleveren, een gedachte).
* **De overheid** is één centrale agent. Ze krijgt compacte statistieken en antwoordt met JSON: banenverdeling,
  portie-plafond, productieplan, verplichte rust, nood-voedsel, aankondigingen. Elk besluit staat met
  invoer + uitvoer + reden in de database. Zonder LLM neemt een regel-overheid het over.
* **Alles wordt bewaard** (SQLite in het volume `/data`): elk event, elke rit (inclusief afslagpunten), positie-samples
  (elke 10 s), elke herinnering, elke ruil, elk overheidsbesluit en elke LLM-call. De wereld wordt elke 30 s
  gesnapshot en na een herstart hervat.
* **Realtime**: de server streamt compacte frames (5 Hz) + events + stats via WebSocket; de browser interpoleert.

## LLM instellen (Jev of OpenRouter)

Kopieer `.env.example` naar `.env` en vul in:

```env
LLM_BASE_URL=https://<jouw-jev-endpoint>/v1   # alles dat /chat/completions in OpenAI-formaat praat
LLM_API_KEY=<token>
LLM_MODEL=<modelnaam>
```
of `OPENROUTER_API_KEY=…` met bijv. `LLM_MODEL=google/gemini-2.5-flash-lite`.
Geen sleutel? Dan draait alles op regels; de UI toont "regels (geen LLM ingesteld)".

### Waarom dit goedkoop blijft

* Burgers denken **in batches van 10 per request** en maar eens per 2 simulatiedagen; reflexen zijn gratis.
* De overheid beslist ~2× per simulatiedag (of eerder bij alarm, met minimale tussentijd).
* Korte prompts, `max_tokens` strak begrensd, JSON-modus, vaste systeemprompt (prompt-cache vriendelijk).
* Harde limieten: `LLM_MAX_CALLS_PER_HOUR` (60), `LLM_DAILY_TOKEN_BUDGET` (400k), circuit breaker met backoff
  bij fouten. Is het budget op, dan schakelt de stad vanzelf terug naar regels.
* Met de standaardinstellingen (40 burgers, dag = 6 min) zijn dat ≈ 30–40 calls/uur, ruwweg 40–60k tokens/uur.
  Live zichtbaar in het paneel "AI-motor" en in `GET /api/llm`.

## API (alleen lezen)

`GET /api/state` · `/api/citizens` · `/api/citizens/:id` (incl. geheugen, events, ruilen, ritten) ·
`/api/events?type=&actor=&before=&limit=` · `/api/decisions` · `/api/moves?citizen=` · `/api/positions?citizen=` ·
`/api/stats/history` · `/api/llm` · `/api/health` — WebSocket op `/ws`.

## Ontwikkelen

```bash
cd backend && npm install && npm start            # simulatie + API op :1723 / :1724
cd frontend && npm install && npm run dev         # Vite dev-server op :1724 met proxy (of: npm run build, backend serveert ../frontend/dist)
```
Handige variabelen: `POPULATION`, `DAY_SECONDS`, `SEED`, `POSITION_LOG_SECONDS`, `DATA_DIR`.
