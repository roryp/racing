// Thin client for the OpenAI Decisions API (POST /v1/decisions).
// The official SDKs expose this as `client.decisions.create(...)`; we call the
// REST endpoint directly so the game has zero npm dependencies.

export const DEFAULT_MODEL = "gpt-6-luna";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export class DecisionsError extends Error {
  constructor(message, { status = 0, code = null } = {}) {
    super(message);
    this.name = "DecisionsError";
    this.status = status;
    this.code = code;
  }
}

export function createDecisionsClient({
  apiKey,
  model = DEFAULT_MODEL,
  baseURL = DEFAULT_BASE_URL,
  timeoutMs = 10_000,
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  if (!apiKey) throw new Error("createDecisionsClient: apiKey is required");
  const url = `${baseURL.replace(/\/+$/, "")}/decisions`;

  return {
    model,
    /**
     * @param {{ input: string | object[], questions: object[] }} request
     * @returns {Promise<{ answers: Record<string, object>, usage: object|null, model: string,
     *   latencyMs: number, processingMs: number|null, requestId: string|null }>}
     */
    async create({ input, questions }) {
      const started = performance.now();
      let res;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model, input, questions }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const timedOut = err?.name === "TimeoutError";
        throw new DecisionsError(
          timedOut ? `Decisions API timed out after ${timeoutMs} ms` : `Network error: ${err?.message ?? err}`,
          { code: timedOut ? "timeout" : "network_error" },
        );
      }

      const text = await res.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        // Non-JSON body; handled below.
      }

      if (!res.ok) {
        throw new DecisionsError(body?.error?.message ?? `Decisions API returned HTTP ${res.status}`, {
          status: res.status,
          code: body?.error?.code ?? body?.error?.type ?? null,
        });
      }
      if (!body || !Array.isArray(body.answers)) {
        throw new DecisionsError("Decisions API returned an unexpected payload", { status: res.status });
      }

      const processing = Number(res.headers.get("openai-processing-ms"));
      return {
        answers: indexAnswers(body.answers),
        usage: body.usage ?? null,
        model: body.model ?? model,
        latencyMs: Math.round(performance.now() - started),
        processingMs: Number.isFinite(processing) ? processing : null,
        requestId: res.headers.get("x-request-id"),
      };
    },
  };
}

/** Index the `answers` array by question name (the API echoes each question's `name`). */
export function indexAnswers(answers) {
  const byName = {};
  for (const answer of answers ?? []) {
    if (answer && typeof answer.name === "string") byName[answer.name] = answer;
  }
  return byName;
}

/** Compact a `choice` answer into `{ choice, confidence, probabilities: { value: p } }`. */
export function summarizeChoice(answer) {
  if (answer?.type !== "choice") return null;
  const probabilities = {};
  for (const p of answer.probabilities ?? []) probabilities[String(p.value)] = p.probability;
  return { choice: String(answer.choice), confidence: answer.confidence ?? null, probabilities };
}

/** Compact a `score` answer into `{ score, confidence, probabilities: number[], labels: string[] }` (indexed by level). */
export function summarizeScore(answer) {
  if (answer?.type !== "score") return null;
  const probabilities = [];
  const labels = [];
  for (const p of answer.probabilities ?? []) {
    probabilities[p.value] = p.probability;
    labels[p.value] = p.label;
  }
  return { score: answer.score, confidence: answer.confidence ?? null, probabilities, labels };
}

/** Compact a `predicate` answer into `{ probability }`. */
export function summarizePredicate(answer) {
  if (answer?.type !== "predicate") return null;
  return { probability: answer.probability };
}

/** Names of questions the model refused to answer. */
export function refusals(answers) {
  return Object.values(answers)
    .filter((a) => a.type === "refusal")
    .map((a) => a.name);
}
