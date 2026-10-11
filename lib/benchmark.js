// Speed duel & benchmark: race different ways of asking Microsoft-Decision-1 (Foundry) the same
// rival-driver questions about the same race situations, and time them.
//
//   batched:        one call that answers the choice, the score and the noul together.
//   split-parallel: three calls, one question each, sent at the same time.
//   split-serial:   three calls, one question each, one after another.

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

export function decisionsContender(model = "Microsoft-Decision-1") {
  return {
    id: "decisions",
    mode: "batched",
    model,
    label: `${model} · 1 call, 3 questions`,
    short: "1 call · 3 questions",
    detail: "One call answers the choice, score and noul together, with probabilities",
  };
}

// Other ways of asking the same model the same questions (the server only accepts these).
export function opponents(model = "Microsoft-Decision-1") {
  return [
    {
      id: "split-parallel",
      mode: "parallel",
      model,
      label: `${model} · 3 parallel calls`,
      short: "3 parallel calls",
      detail: "One question per call, all three sent at once; done when the slowest answers",
    },
    {
      id: "split-serial",
      mode: "serial",
      model,
      label: `${model} · 3 sequential calls`,
      short: "3 sequential calls",
      detail: "One question per call, each sent after the previous one answers",
    },
  ];
}
export const OPPONENTS = opponents();

function normalize(answers) {
  const maneuver = summarizeChoice(answers.maneuver);
  return {
    maneuver: maneuver?.choice ?? null,
    maneuverP: maneuver ? (maneuver.probabilities[maneuver.choice] ?? null) : null,
    pace: summarizeScore(answers.pace)?.score ?? null,
    nitro: summarizePredicate(answers.nitro)?.probability ?? null,
  };
}

/** Ask one contender about one race situation; returns timing, token usage and a normalized answer. */
export async function runContender({ contender, scenario, decisions }) {
  const situation = SCENARIOS[scenario];
  if (!situation) throw new RangeError(`Unknown scenario: ${scenario}`);
  const request = buildRivalRequest(situation.state);
  const base = { contender: contender.id, mode: contender.mode, scenario };

  const started = performance.now();
  let results;
  if (contender.mode === "batched") {
    results = [await decisions.create(request)];
  } else if (contender.mode === "parallel") {
    results = await Promise.all(request.questions.map((q) => decisions.create({ input: request.input, questions: [q] })));
  } else if (contender.mode === "serial") {
    results = [];
    for (const q of request.questions) results.push(await decisions.create({ input: request.input, questions: [q] }));
  } else {
    throw new TypeError(`Unknown mode: ${contender.mode}`);
  }
  const latencyMs = results.length === 1 ? results[0].latencyMs : Math.round(performance.now() - started);
  const sum = (key) => results.reduce((total, r) => total + (r.usage?.[key] ?? 0), 0);
  return {
    ...base,
    model: results[0].model,
    calls: results.length,
    latencyMs,
    inputTokens: sum("input_tokens"),
    outputTokens: sum("output_tokens"),
    answer: normalize(Object.assign({}, ...results.map((r) => r.answers))),
  };
}
