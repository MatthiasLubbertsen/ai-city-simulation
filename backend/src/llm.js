// OpenAI-compatibele chat client met harde kostenbeperking:
//  - max aantal calls per uur, dagelijks tokenbudget, circuit breaker bij fouten
//  - kleine max_tokens, JSON-modus, burgers worden in batches per request verwerkt
export class LLM {
  constructor(cfg, store) {
    this.c = cfg.llm;
    this.store = store;
    this.calls = []; // timestamps laatste uur
    this.day = new Date().toISOString().slice(0, 10);
    this.tokensToday = 0;
    this.totals = { calls: 0, failed: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
    this.failStreak = 0;
    this.pausedUntil = 0;
    this.inflight = 0;
    this.lastError = '';
  }

  get configured() { return !!(this.c.baseUrl && this.c.apiKey); }
  get url() {
    const b = this.c.baseUrl.replace(/\/+$/, '');
    return /\/chat\/completions$/.test(b) ? b : `${b}/chat/completions`;
  }

  _roll() {
    const now = Date.now();
    this.calls = this.calls.filter((t) => now - t < 3600_000);
    const day = new Date().toISOString().slice(0, 10);
    if (day !== this.day) { this.day = day; this.tokensToday = 0; }
  }

  // reserve: een deel van de uurlimiet is gereserveerd voor de overheid
  available(purpose) {
    if (!this.configured) return false;
    this._roll();
    if (Date.now() < this.pausedUntil) return false;
    if (this.tokensToday >= this.c.dailyTokenBudget) return false;
    const cap = purpose === 'government' ? this.c.maxCallsPerHour : Math.floor(this.c.maxCallsPerHour * 0.75);
    if (this.calls.length >= cap) return false;
    if (this.inflight >= 2) return false;
    return true;
  }

  status() {
    this._roll();
    return {
      configured: this.configured,
      model: this.c.model,
      active: this.available('government'),
      callsLastHour: this.calls.length,
      maxCallsPerHour: this.c.maxCallsPerHour,
      tokensToday: this.tokensToday,
      dailyTokenBudget: this.c.dailyTokenBudget,
      totalCalls: this.totals.calls,
      failed: this.totals.failed,
      estCostUsd: +this.totals.cost.toFixed(4),
      pausedForMs: Math.max(0, this.pausedUntil - Date.now()),
      lastError: this.lastError,
    };
  }

  async json({ purpose, system, user, maxTokens = 600, temperature = 0.7 }) {
    if (!this.available(purpose)) return null;
    const t0 = Date.now();
    this.calls.push(t0);
    this.inflight++;
    let usage = {};
    try {
      const body = {
        model: this.c.model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
      };
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.c.apiKey}`, ...this.c.extraHeaders },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.c.timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      usage = data.usage || {};
      const text = data.choices?.[0]?.message?.content ?? '';
      const parsed = parseJson(text);
      if (!parsed) throw new Error(`Geen geldige JSON: ${String(text).slice(0, 120)}`);
      this._record(purpose, true, usage, Date.now() - t0, '');
      this.failStreak = 0;
      return parsed;
    } catch (e) {
      this.lastError = String(e.message || e).slice(0, 200);
      this._record(purpose, false, usage, Date.now() - t0, this.lastError);
      this.failStreak++;
      if (this.failStreak >= 3) this.pausedUntil = Date.now() + Math.min(600_000, 30_000 * 2 ** (this.failStreak - 3)); // backoff
      return null;
    } finally {
      this.inflight--;
    }
  }

  _record(purpose, ok, usage, ms, error) {
    const pi = usage.prompt_tokens || 0, co = usage.completion_tokens || 0;
    const cost = (pi * this.c.priceInPerM + co * this.c.priceOutPerM) / 1e6;
    this.tokensToday += pi + co;
    this.totals.calls++;
    if (!ok) this.totals.failed++;
    this.totals.promptTokens += pi; this.totals.completionTokens += co; this.totals.cost += cost;
    this.store.llmCall(Date.now(), purpose, this.c.model, ok ? 1 : 0, pi, co, ms, cost, error || null);
  }
}

export function parseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* val terug op extractie */ }
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch { /* */ } }
  return null;
}
