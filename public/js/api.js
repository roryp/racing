// Browser-side calls to our server, which forwards them to the OpenAI Decisions API.

const PRICE_PER_INPUT_TOKEN = 0.1 / 1e6; // gpt-6-luna on /v1/decisions: $0.10 per 1M input tokens

export class DecisionsApi {
  constructor() {
    this.stats = { calls: 0, errors: 0, totalMs: 0, lastMs: 0, tokens: 0 };
  }

  get averageMs() {
    return this.stats.calls ? Math.round(this.stats.totalMs / this.stats.calls) : 0;
  }

  get cost() {
    return this.stats.tokens * PRICE_PER_INPUT_TOKEN;
  }

  async status() {
    try {
      const res = await fetch("/api/status", { signal: AbortSignal.timeout(4000) });
      return await res.json();
    } catch {
      return { configured: false, model: null, unreachable: true };
    }
  }

  rival(payload) {
    return this.post("/api/rival", payload, 4000);
  }

  steward(payload) {
    return this.post("/api/steward", payload, 9000);
  }

  debrief(payload) {
    return this.post("/api/debrief", payload, 12000);
  }

  async post(url, payload, timeoutMs) {
    const started = performance.now();
    let res;
    let data;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      data = await res.json().catch(() => ({}));
    } catch (err) {
      this.stats.errors++;
      throw Object.assign(new Error(err?.name === "TimeoutError" ? "Request timed out" : "Game server unreachable"), {
        status: 0,
      });
    }
    if (!res.ok) {
      this.stats.errors++;
      throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
    }
    const ms = Math.round(performance.now() - started);
    this.stats.calls++;
    this.stats.totalMs += ms;
    this.stats.lastMs = ms;
    this.stats.tokens += data.inputTokens ?? 0;
    return { ...data, roundTripMs: ms };
  }
}
