// Thin client for Microsoft-Decision-1 on Microsoft Foundry
// (POST <foundry-endpoint>/providers/microsoft/v1/systemone).
//
// The game builds requests in the OpenAI Decisions API shape ({ input, questions[] } with
// choice / score / predicate questions). This client translates them to the Foundry shape
// ({ state, questions: { name: { type, instructions, criteria } } } with choice / score / noul)
// and translates the answers back, so the rest of the game is unchanged.

import { DEFAULT_DEPLOYMENT } from "./foundry.js";
import { OpenAIError, postJson } from "./openai.js";

export { OpenAIError, DEFAULT_DEPLOYMENT };
export const MODEL_NAME = "Microsoft-Decision-1";

export function createDecisionsClient({
  endpoint,
  deployment = DEFAULT_DEPLOYMENT,
  getHeaders,
  timeoutMs = 10_000,
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  if (!endpoint) throw new Error("createDecisionsClient: endpoint is required");
  if (typeof getHeaders !== "function") throw new Error("createDecisionsClient: getHeaders is required");
  const url = `${endpoint.replace(/\/+$/, "")}/providers/microsoft/v1/systemone`;

  return {
    model: deployment,
    /**
     * @param {{ input: string | object[], questions: object[] }} request
     * @returns {Promise<{ answers: Record<string, object>, usage: object|null, model: string,
     *   latencyMs: number, startedAt: number, endedAt: number, processingMs: number|null,
     *   requestId: string|null }>}
     */
    async create({ input, questions }) {
      let headers;
      try {
        headers = await getHeaders();
      } catch (err) {
        throw new OpenAIError(err?.message ?? "Authentication failed", { code: "auth_error" });
      }
      const { data, latencyMs, startedAt, endedAt, processingMs, requestId } = await postJson({
        url,
        headers,
        body: { model: deployment, state: toState(input), questions: toFoundryQuestions(questions) },
        timeoutMs,
        fetchImpl,
        label: "Foundry decision API",
      });
      if (!data || typeof data.answers !== "object" || data.answers === null || Array.isArray(data.answers)) {
        throw new OpenAIError("Foundry decision API returned an unexpected payload");
      }
      return {
        answers: fromFoundryAnswers(data.answers, questions),
        usage: data.usage ?? null,
        model: data.model ?? deployment,
        latencyMs,
        startedAt,
        endedAt,
        processingMs,
        requestId,
      };
    },
  };
}

/** Microsoft-Decision-1 is text-only: flatten message-style input to its text parts. */
export function toState(input) {
  if (typeof input === "string") return input;
  const parts = [];
  for (const message of Array.isArray(input) ? input : []) {
    const content = typeof message?.content === "string" ? [{ type: "input_text", text: message.content }] : message?.content;
    for (const part of Array.isArray(content) ? content : []) {
      if (part?.type === "input_text" && typeof part.text === "string") parts.push(part.text);
    }
  }
  return parts.join("\n");
}

/** Translate OpenAI-style question definitions into the Foundry `questions` object. */
export function toFoundryQuestions(questions) {
  const out = {};
  for (const q of questions ?? []) {
    if (q.type === "choice") {
      const criteria = {};
      for (const c of q.choices) criteria[String(c.value)] = c.description || String(c.value);
      out[q.name] = { type: "choice", instructions: q.instructions, criteria };
    } else if (q.type === "score") {
      out[q.name] = {
        type: "score",
        instructions: q.instructions,
        criteria: q.levels.map((l) => (l.description ? `${l.label}: ${l.description}` : l.label)),
      };
    } else if (q.type === "predicate") {
      out[q.name] = { type: "noul", instructions: q.instructions };
    } else {
      throw new TypeError(`Unsupported question type: ${q.type}`);
    }
  }
  return out;
}

/** Translate the Foundry `answers` object back into OpenAI-style answers, indexed by question name. */
export function fromFoundryAnswers(answers, questions = []) {
  const byName = {};
  const defs = Object.fromEntries((questions ?? []).map((q) => [q.name, q]));
  for (const [name, a] of Object.entries(answers ?? {})) {
    if (!a || typeof a !== "object") continue;
    const q = defs[name];
    const probs = a.probabilities && typeof a.probabilities === "object" ? a.probabilities : {};
    if (a.type === "choice") {
      const order = q?.choices?.map((c) => String(c.value)) ?? Object.keys(probs);
      byName[name] = {
        type: "choice",
        name,
        choice: a.choice,
        confidence: a.confidence ?? null,
        probabilities: order.filter((v) => v in probs).map((value) => ({ value, probability: probs[value] })),
      };
    } else if (a.type === "score") {
      byName[name] = {
        type: "score",
        name,
        score: a.score,
        confidence: a.confidence ?? null,
        probabilities: Object.keys(probs)
          .map(Number)
          .sort((x, y) => x - y)
          .map((value) => ({
            value,
            label: q?.levels?.[value]?.label ?? a.legend?.[value] ?? String(value),
            probability: probs[value],
          })),
      };
    } else if (a.type === "noul") {
      byName[name] = { type: "predicate", name, probability: a.noul };
    } else {
      byName[name] = { ...a, name };
    }
  }
  return byName;
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
