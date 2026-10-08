// Thin client for the OpenAI Decisions API (POST /v1/decisions).
// The official SDKs expose this as `client.decisions.create(...)`; we call the
// REST endpoint directly so the game has zero npm dependencies.

import { OpenAIError, postJson } from "./openai.js";

export { OpenAIError };
export const DEFAULT_MODEL = "gpt-6-luna";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

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
      const { data, latencyMs, processingMs, requestId } = await postJson({
        url,
        apiKey,
        body: { model, input, questions },
        timeoutMs,
        fetchImpl,
        label: "Decisions API",
      });
      if (!data || !Array.isArray(data.answers)) {
        throw new OpenAIError("Decisions API returned an unexpected payload");
      }
      return {
        answers: indexAnswers(data.answers),
        usage: data.usage ?? null,
        model: data.model ?? model,
        latencyMs,
        processingMs,
        requestId,
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
