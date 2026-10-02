const env = process.env;
const num = (k, d) => (env[k] !== undefined && env[k] !== '' ? Number(env[k]) : d);

// LLM: elke OpenAI-compatibele endpoint werkt (Jev, OpenRouter, ...).
const baseUrl = env.LLM_BASE_URL || env.JEV_ENDPOINT || (env.OPENROUTER_API_KEY ? 'https://openrouter.ai/api/v1' : '');
const apiKey = env.LLM_API_KEY || env.JEV_TOKEN || env.OPENROUTER_API_KEY || '';

let extraHeaders = {};
try { if (env.LLM_EXTRA_HEADERS) extraHeaders = JSON.parse(env.LLM_EXTRA_HEADERS); } catch { /* negeren */ }

export const cfg = {
  port: num('PORT', 1723),
  webPort: num('WEB_PORT', 1724), // zelfde app; 1723 staat op de 'onveilige poorten'-lijst van browsers
  dataDir: env.DATA_DIR || './data',
  publicDir: env.PUBLIC_DIR || '../frontend/dist',
  population: num('POPULATION', 40),
  daySeconds: num('DAY_SECONDS', 360), // echte seconden per simulatiedag
  seed: num('SEED', 1723),
  tickHz: 10,
  broadcastHz: 5,
  posLogSeconds: num('POSITION_LOG_SECONDS', 10),
  snapshotSeconds: num('SNAPSHOT_SECONDS', 30),
  llm: {
    baseUrl,
    apiKey,
    model: env.LLM_MODEL || env.JEV_MODEL || 'google/gemini-2.5-flash-lite',
    extraHeaders,
    // Kostenbeheersing
    maxCallsPerHour: num('LLM_MAX_CALLS_PER_HOUR', 60),
    dailyTokenBudget: num('LLM_DAILY_TOKEN_BUDGET', 400000),
    batchSize: num('LLM_BATCH_SIZE', 10),           // burgers per request
    thinkEveryDays: num('LLM_THINK_EVERY_DAYS', 2), // hoe vaak een burger "echt" nadenkt
    govEveryHours: num('LLM_GOV_EVERY_HOURS', 12),  // reguliere overheidsbeslissing
    govMinGapHours: num('LLM_GOV_MIN_GAP_HOURS', 4),// minimale tussentijd bij alarm
    priceInPerM: num('LLM_PRICE_IN_PER_MTOK', 0.1),
    priceOutPerM: num('LLM_PRICE_OUT_PER_MTOK', 0.4),
    timeoutMs: num('LLM_TIMEOUT_MS', 30000),
  },
};
