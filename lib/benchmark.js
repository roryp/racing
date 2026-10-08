// Speed duel & benchmark: ask the Decisions API and the Responses API the same
// rival-driver questions about the same race situations, and time both.
//
//   Decisions API: one POST /v1/decisions call with typed questions (choice, score, predicate).
//   Responses API: one POST /v1/responses call answering the same questions, with the same
//                  options and levels, through Structured Outputs (a strict JSON schema).

import { summarizeChoice, summarizePredicate, summarizeScore } from "./decisions.js";
import { buildRivalRequest } from "./prompts.js";

const VEGA = { name: "Vega", number: 7, personality: "aggressive" };
const NOVA = { name: "Nova", number: 11, personality: "tactical" };
const ORION = { name: "Orion", number: 3, personality: "defensive" };
const LYRA = { name: "Lyra", number: 22, personality: "smooth" };
const RIGEL = { name: "Rigel", number: 9, personality: "wildcard" };
const PLAYER = { name: "You", isPlayer: true };

export const SCENARIOS = [
  {
    label: "Closing on a slower car on a long straight",
    state: {
      driver: VEGA,
      race: { lap: 2, laps: 3, position: 3, cars: 6, gapToLeaderS: 2.3 },
      self: { speedKmh: 262, topSpeedKmh: 285, offset: -0.05, nitro: 0.7 },
      track: [{ kind: "straight", inM: 0, lengthM: 260 }],
      ahead: { name: "Nova", gapM: 14, offset: 0, relSpeedKmh: -22 },
    },
  },
  {
    label: "Leading the final lap, player attacking",
    state: {
      driver: ORION,
      race: { lap: 3, laps: 3, position: 1, cars: 6, gapToNextS: 0.3 },
      self: { speedKmh: 262, topSpeedKmh: 285, offset: 0.4, nitro: 0.7 },
      track: [
        { kind: "straight", inM: 0, lengthM: 120 },
        { kind: "curve", dir: "left", severity: "medium", inM: 120, lengthM: 90 },
      ],
      behind: { ...PLAYER, gapM: 9, offset: -0.2, relSpeedKmh: 25 },
    },
  },
  {
    label: "Alone, braking for a hairpin",
    state: {
      driver: LYRA,
      race: { lap: 2, laps: 3, position: 3, cars: 6, gapToLeaderS: 2.3 },
      self: { speedKmh: 278, topSpeedKmh: 285, offset: 0, nitro: 0.7 },
      track: [
        { kind: "straight", inM: 0, lengthM: 25 },
        { kind: "curve", dir: "right", severity: "sharp", inM: 25, lengthM: 140 },
      ],
    },
  },
  {
    label: "Final-lap chase down a long straight",
    state: {
      driver: NOVA,
      race: { lap: 3, laps: 3, position: 2, cars: 6, gapToLeaderS: 0.6 },
      self: { speedKmh: 262, topSpeedKmh: 285, offset: -0.05, nitro: 0.7 },
      track: [{ kind: "straight", inM: 0, lengthM: 420 }],
      elevation: "downhill",
      ahead: { ...PLAYER, gapM: 35, offset: 0.1, relSpeedKmh: -8 },
    },
  },
  {
    label: "Wheel to wheel in a corner",
    state: {
      driver: LYRA,
      race: { lap: 2, laps: 3, position: 3, cars: 6, gapToLeaderS: 2.3 },
      self: { speedKmh: 240, topSpeedKmh: 285, offset: 0.1, nitro: 0.5 },
      track: [{ kind: "curve", dir: "left", severity: "medium", inM: 0, lengthM: 80 }],
      alongside: { ...PLAYER, gapM: 0, offset: 0.3, relSpeedKmh: 4 },
    },
  },
  {
    label: "Faster car pulling away",
    state: {
      driver: RIGEL,
      race: { lap: 1, laps: 3, position: 4, cars: 6, gapToLeaderS: 3.1 },
      self: { speedKmh: 250, topSpeedKmh: 280, offset: 0.2, nitro: 0.3 },
      track: [
        { kind: "curve", dir: "right", severity: "gentle", inM: 0, lengthM: 90 },
        { kind: "straight", inM: 90, lengthM: 150 },
      ],
      ahead: { name: "Vega", gapM: 40, offset: 0.1, relSpeedKmh: 30 },
    },
  },
  {
    label: "Tucked in behind, straight coming",
    state: {
      driver: NOVA,
      race: { lap: 2, laps: 3, position: 2, cars: 6, gapToLeaderS: 0.5 },
      self: { speedKmh: 270, topSpeedKmh: 285, offset: -0.4, nitro: 0.25 },
      track: [
        { kind: "curve", dir: "left", severity: "gentle", inM: 0, lengthM: 40 },
        { kind: "straight", inM: 40, lengthM: 300 },
      ],
      ahead: { name: "Orion", gapM: 30, offset: -0.38, relSpeedKmh: -3 },
    },
  },
  {
    label: "Blind crest, then a sharp left",
    state: {
      driver: VEGA,
      race: { lap: 1, laps: 3, position: 2, cars: 6, gapToLeaderS: 0.9 },
      self: { speedKmh: 280, topSpeedKmh: 285, offset: 0.3, nitro: 0.9 },
      track: [
        { kind: "straight", inM: 0, lengthM: 60 },
        { kind: "curve", dir: "left", severity: "sharp", inM: 60, lengthM: 110 },
      ],
      elevation: "crest",
      ahead: { name: "Lyra", gapM: 55, offset: -0.3, relSpeedKmh: -5 },
    },
  },
  {
    label: "Defending from a faster rival",
    state: {
      driver: ORION,
      race: { lap: 2, laps: 3, position: 3, cars: 6, gapToLeaderS: 1.8 },
      self: { speedKmh: 255, topSpeedKmh: 280, offset: -0.3, nitro: 0.4 },
      track: [
        { kind: "straight", inM: 0, lengthM: 180 },
        { kind: "curve", dir: "right", severity: "medium", inM: 180, lengthM: 100 },
      ],
      behind: { name: "Rigel", gapM: 12, offset: 0.25, relSpeedKmh: 18 },
    },
  },
  {
    label: "Empty nitro tank, mid-pack",
    state: {
      driver: RIGEL,
      race: { lap: 2, laps: 3, position: 5, cars: 6, gapToLeaderS: 4.2 },
      self: { speedKmh: 268, topSpeedKmh: 280, offset: 0, nitro: 0.05 },
      track: [{ kind: "straight", inM: 0, lengthM: 350 }],
      ahead: { name: "Lyra", gapM: 20, offset: 0.05, relSpeedKmh: -12 },
    },
  },
];

export function decisionsContender(model = "gpt-6-luna") {
  return {
    id: "decisions",
    api: "decisions",
    model,
    reasoning: null,
    label: `Decisions API · ${model}`,
    short: `Decisions API · ${model}`,
    detail: "One /v1/decisions call answers the choice, score and predicate, with probabilities",
  };
}

// Responses API setups the Decisions API can race against (the server only accepts these).
export const OPPONENTS = [
  {
    id: "responses-luna",
    api: "responses",
    model: "gpt-6-luna",
    reasoning: "none",
    label: "Responses API · gpt-6-luna (no reasoning)",
    short: "Responses API · gpt-6-luna",
    detail: "Same model, fastest setting: reasoning none + Structured Outputs",
  },
  {
    id: "responses-nano",
    api: "responses",
    model: "gpt-5.4-nano",
    reasoning: "none",
    label: "Responses API · gpt-5.4-nano (no reasoning)",
    short: "Responses API · gpt-5.4-nano",
    detail: "Smallest GPT-5.4 model: reasoning none + Structured Outputs",
  },
  {
    id: "responses-luna-default",
    api: "responses",
    model: "gpt-6-luna",
    reasoning: null,
    label: "Responses API · gpt-6-luna (default reasoning)",
    short: "Responses API · gpt-6-luna (default)",
    detail: "Same model with its default reasoning + Structured Outputs",
  },
];

/**
 * Translate a Decisions API request into the equivalent Responses API request:
 * same evidence, same questions, same options and levels, answered through a strict JSON schema.
 */
export function toResponsesRequest({ input, questions }, { model, reasoning }) {
  const properties = {};
  const lines = ["Answer every question about the situation. Reply with JSON only."];
  for (const q of questions) {
    if (q.type === "choice") {
      properties[q.name] = { type: "string", enum: q.choices.map((c) => String(c.value)) };
      const options = q.choices.map((c) => `"${c.value}"${c.description ? `: ${c.description}` : ""}`).join(" | ");
      lines.push(`- ${q.name}: ${q.instructions} Options: ${options}`);
    } else if (q.type === "score") {
      properties[q.name] = { type: "integer", enum: q.levels.map((_, i) => i) };
      const levels = q.levels.map((l, i) => `${i} = ${l.label}${l.description ? ` (${l.description})` : ""}`).join("; ");
      lines.push(`- ${q.name}: ${q.instructions} Answer with the level number: ${levels}.`);
    } else if (q.type === "predicate") {
      properties[q.name] = { type: "boolean" };
      lines.push(`- ${q.name}: ${q.instructions} Answer true or false.`);
    } else {
      throw new TypeError(`Unsupported question type: ${q.type}`);
    }
  }

  const body = {
    model,
    instructions: lines.join("\n"),
    input,
    text: {
      format: {
        type: "json_schema",
        name: "decision",
        strict: true,
        schema: { type: "object", additionalProperties: false, required: Object.keys(properties), properties },
      },
    },
    store: false,
  };
  if (reasoning) body.reasoning = { effort: reasoning };
  return body;
}

/** Ask one contender about one race situation; returns timing, token usage and a normalized answer. */
export async function runContender({ contender, scenario, decisions, responses }) {
  const situation = SCENARIOS[scenario];
  if (!situation) throw new RangeError(`Unknown scenario: ${scenario}`);
  const request = buildRivalRequest(situation.state);
  const base = { contender: contender.id, api: contender.api, scenario };

  if (contender.api === "decisions") {
    const result = await decisions.create(request);
    const maneuver = summarizeChoice(result.answers.maneuver);
    return {
      ...base,
      model: result.model,
      latencyMs: result.latencyMs,
      processingMs: result.processingMs,
      inputTokens: result.usage?.input_tokens ?? null,
      outputTokens: result.usage?.output_tokens ?? 0,
      reasoningTokens: 0,
      answer: {
        maneuver: maneuver?.choice ?? null,
        maneuverP: maneuver ? (maneuver.probabilities[maneuver.choice] ?? null) : null,
        pace: summarizeScore(result.answers.pace)?.score ?? null,
        nitro: summarizePredicate(result.answers.nitro)?.probability ?? null,
      },
    };
  }

  if (contender.api !== "responses") throw new TypeError(`Unknown API: ${contender.api}`);
  const result = await responses.create(toResponsesRequest(request, contender));
  const output = result.output ?? {};
  return {
    ...base,
    model: result.model,
    latencyMs: result.latencyMs,
    processingMs: result.processingMs,
    inputTokens: result.usage?.input_tokens ?? null,
    outputTokens: result.usage?.output_tokens ?? null,
    reasoningTokens: result.usage?.output_tokens_details?.reasoning_tokens ?? 0,
    answer: {
      maneuver: typeof output.maneuver === "string" ? output.maneuver : null,
      maneuverP: null,
      pace: Number.isInteger(output.pace) ? output.pace : null,
      nitro: typeof output.nitro === "boolean" ? output.nitro : null,
    },
  };
}
