const env = process.env;
const num = (k, d) => (env[k] !== undefined && env[k] !== '' ? Number(env[k]) : d);

export const cfg = {
  port: num('PORT', 1723),
  webPort: num('WEB_PORT', 1724), // same app; browsers block port 1723 as an "unsafe port"
  dataDir: env.DATA_DIR || './data',
  publicDir: env.PUBLIC_DIR || '../frontend/dist',
  population: num('POPULATION', 40),
  daySeconds: num('DAY_SECONDS', 360), // real seconds per simulated day
  seed: num('SEED', 1723),
  tickHz: 10,
  broadcastHz: 5,
  posLogSeconds: num('POSITION_LOG_SECONDS', 10),
  snapshotSeconds: num('SNAPSHOT_SECONDS', 30),
  adminToken: env.ADMIN_TOKEN || '',                          // required for POST /api/admin/reset (disabled when empty)
  autoRestartSeconds: num('AUTO_RESTART_SECONDS', 300),       // after everyone died: show the report, then start a new city (0 = never)
  // Hack Club AI chat completions: used ONLY for the post-mortem narrative (Jev can't write text)
  report: {
    baseUrl: env.HC_AI_BASE_URL || 'https://ai.hackclub.com/proxy/v1',
    model: env.HC_CHAT_MODEL || 'qwen/qwen3-32b',
    minIntervalSeconds: num('REPORT_MIN_INTERVAL_SECONDS', 600), // cache the narrative so public viewers can't burn budget
    timeoutMs: num('REPORT_TIMEOUT_MS', 60000),
  },
  // Jev: https://docs.ai.hackclub.com/api/jev.html (structured decisions instead of chat; billed per input token only)
  jev: {
    baseUrl: env.JEV_BASE_URL || 'https://ai.hackclub.com/proxy/v1/jev',
    apiKey: env.JEV_API_KEY || '',
    model: env.JEV_MODEL || 'jev-latest',
    // Cost control
    maxCallsPerHour: num('JEV_MAX_CALLS_PER_HOUR', 400),
    dailyTokenBudget: num('JEV_DAILY_INPUT_TOKEN_BUDGET', 600000),
    maxConcurrent: num('JEV_MAX_CONCURRENT', 3),
    thinkEveryDays: num('JEV_THINK_EVERY_DAYS', 3),  // how often a citizen asks Jev what they feel/want
    govEveryHours: num('JEV_GOV_EVERY_HOURS', 12),   // regular government decision (simulated hours)
    govMinGapHours: num('JEV_GOV_MIN_GAP_HOURS', 4), // minimum gap between alarm-triggered decisions
    priceInPerM: num('JEV_PRICE_PER_MTOK', 0.1),     // only used for the cost estimate in the UI
    timeoutMs: num('JEV_TIMEOUT_MS', 15000),
  },
};
