// Client for Jev (https://docs.ai.hackclub.com/api/jev.html).
// Jev is NOT a chat model: you send a `state` plus typed `questions` (noul = yes/no probability,
// choice = classification, score = ordered scale) and get one structured answer per question back.
// Billing is per INPUT token only, so we keep states and instructions short, and we protect
// the budget with call limits, a daily token cap, Retry-After handling and a circuit breaker.
export class Jev {
  constructor(cfg, store) {
    this.c = cfg.jev;
    this.store = store;
    this.calls = [];            // timestamps of calls in the last hour
    this.day = new Date().toISOString().slice(0, 10);
    this.tokensToday = 0;
    this.totals = { calls: 0, failed: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
    this.failStreak = 0;
    this.pausedUntil = 0;
    this.pauseReason = '';
    this.inflight = 0;
    this.lastError = '';
  }

  get configured() { return !!this.c.apiKey; }
  get url() { return `${this.c.baseUrl.replace(/\/+$/, '')}/systemone`; }
  get slots() { return Math.max(0, this.c.maxConcurrent - this.inflight); }

  _roll() {
    const now = Date.now();
    this.calls = this.calls.filter((t) => now - t < 3600_000);
    const day = new Date().toISOString().slice(0, 10);
    if (day !== this.day) { this.day = day; this.tokensToday = 0; }
  }

  // Some of the hourly budget is reserved for the government.
  available(purpose) {
    if (!this.configured) return false;
    this._roll();
    if (Date.now() < this.pausedUntil) return false;
    if (this.tokensToday >= this.c.dailyTokenBudget) return false;
    const cap = purpose === 'government' ? this.c.maxCallsPerHour : Math.floor(this.c.maxCallsPerHour * 0.85);
    if (this.calls.length >= cap) return false;
    return this.inflight < this.c.maxConcurrent;
  }

  status() {
    this._roll();
    const paused = Math.max(0, this.pausedUntil - Date.now());
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
      estCostUsd: +this.totals.cost.toFixed(5),
      pausedForMs: paused,
      pauseReason: paused ? this.pauseReason : '',
      lastError: this.lastError,
    };
  }

  // Returns `answers` ({ questionId: {type, choice|noul|score, probabilities, confidence} }) or null.
  async ask({ purpose, state, questions }) {
    if (!this.available(purpose)) return null;
    const t0 = Date.now();
    this.calls.push(t0);
    this.inflight++;
    let usage = {};
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.c.apiKey}` },
        body: JSON.stringify({ model: this.c.model, state, questions }),
        signal: AbortSignal.timeout(this.c.timeoutMs),
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 200);
        const err = new Error(`HTTP ${res.status}: ${body}`);
        err.status = res.status; err.retryAfter = Number(res.headers.get('retry-after')) || 0;
        throw err;
      }
      const data = await res.json();
      usage = data.usage || {};
      if (!data.answers || typeof data.answers !== 'object') throw new Error('Response has no answers');
      this._record(purpose, true, usage, Date.now() - t0, '');
      this.failStreak = 0;
      return data.answers;
    } catch (e) {
      this.lastError = String(e.message || e).slice(0, 200);
      this._record(purpose, false, usage, Date.now() - t0, this.lastError);
      this._backoff(e);
      return null;
    } finally {
      this.inflight--;
    }
  }

  _backoff(e) {
    const now = Date.now();
    if (e.status === 402) { // Hack Club AI daily spending limit reached: wait until the next UTC day (max 1h per retry)
      this.pausedUntil = now + 3600_000; this.pauseReason = 'daily spending limit reached (402)';
    } else if (e.status === 429) {
      this.pausedUntil = now + Math.max(5, e.retryAfter || 30) * 1000; this.pauseReason = 'rate limited (429)';
    } else if (e.status === 401 || e.status === 403) {
      this.pausedUntil = now + 600_000; this.pauseReason = 'API key rejected';
    } else if (e.status === 422) {
      this.pauseReason = 'validation error (422)'; // our bug, don't hammer: tiny pause
      this.pausedUntil = now + 10_000;
    } else if (++this.failStreak >= 3) {
      this.pausedUntil = now + Math.min(600_000, 30_000 * 2 ** (this.failStreak - 3)); this.pauseReason = 'repeated failures (backing off)';
    }
  }

  _record(purpose, ok, usage, ms, error) {
    const pi = usage.input_tokens || 0, co = usage.output_tokens || 0;
    const cost = (pi * this.c.priceInPerM) / 1e6; // output tokens are free
    this.tokensToday += pi;
    this.totals.calls++;
    if (!ok) this.totals.failed++;
    this.totals.inputTokens += pi; this.totals.outputTokens += co; this.totals.cost += cost;
    this.store.llmCall(Date.now(), purpose, this.c.model, ok ? 1 : 0, pi, co, ms, cost, error || null);
  }
}
