// Builds OpenAI Decisions API requests (input evidence + typed questions) for the
// three ways the game consults the model, and compacts the typed answers.
//
//   rival   -> choice (maneuver) + score (pace) + predicate (nitro)
//   steward -> choice (who is responsible) + score (severity), optionally with an image
//   debrief -> score (player rating) + choice (driver of the day) + predicate (clean race)
//
// All client-supplied values are validated/clamped here so the browser can never
// send arbitrary questions to the API through this server.

import { refusals, summarizeChoice, summarizePredicate, summarizeScore } from "./decisions.js";

export const MANEUVERS = [
  {
    value: "racing_line",
    description:
      "Nothing to fight for right now: no car close by, or the car ahead is faster and pulling away. Follow the fastest line through the upcoming corners.",
  },
  {
    value: "overtake_left",
    description:
      "This driver is closing in on a slower car close ahead: pull out to its LEFT and pass. Needs free road on that side.",
  },
  {
    value: "overtake_right",
    description:
      "This driver is closing in on a slower car close ahead: pull out to its RIGHT and pass. Needs free road on that side.",
  },
  {
    value: "slipstream",
    description: "A car is ahead with a straight coming: tuck in directly behind it to draft and build speed for a later pass.",
  },
  {
    value: "defend",
    description: "A faster car is closing from behind: move across to cover its line and block the pass.",
  },
  {
    value: "back_off",
    description: "A car alongside is wheel to wheel with almost no side gap, or contact is imminent: ease off and leave space.",
  },
];
export const MANEUVER_VALUES = MANEUVERS.map((m) => m.value);

export const PACE_LEVELS = [
  { label: "Conserve", description: "Cruise below the limit: nothing to gain right now, or a sharp corner demands care." },
  { label: "Race", description: "Normal, sustainable race pace." },
  { label: "Push", description: "Push near the limit to close a gap or pull away." },
  { label: "Flat out", description: "Absolute maximum attack: a final-lap battle or a decisive overtake." },
];

export const PERSONALITIES = {
  aggressive: "Aggressive: takes risks, attacks at every opportunity, makes late lunges and burns nitro early.",
  tactical: "Tactical: patient, uses the slipstream and saves nitro to time attacks for long straights and the final lap.",
  defensive: "Defensive: protects track position, covers the line of cars behind, rarely risks contact.",
  smooth: "Smooth: clean and consistent, sticks to the racing line, only overtakes when it is easy.",
  wildcard: "Wildcard: unpredictable and opportunistic, likes bold moves at unexpected moments.",
};

const RIVAL_QUESTIONS = [
  {
    type: "choice",
    name: "maneuver",
    instructions:
      "Which maneuver should this driver commit to for the next one to two seconds? Judge from the cars directly around the driver, the free road on each side, and the track just ahead.",
    choices: MANEUVERS,
  },
  {
    type: "score",
    name: "pace",
    instructions:
      "How hard should this driver push right now, given the personality, the race situation, and the corners just ahead?",
    levels: PACE_LEVELS,
  },
  {
    type: "predicate",
    name: "nitro",
    instructions:
      "Should the driver fire the nitro boost right now? Nitro is best on a long straight, to complete an overtake or escape an attack, or on the final lap. It is wasted right before a sharp corner, when a car blocks the road directly ahead, or when the tank is nearly empty.",
  },
];

export const RESPONSIBILITY = [
  {
    value: "player",
    description: "The human player caused it, e.g. ran into the back of the rival or swerved into it.",
  },
  {
    value: "rival",
    description: "The AI rival caused it, e.g. moved across late into the player or ran into the back of the player.",
  },
  {
    value: "racing_incident",
    description: "Both contributed or it was unavoidable; no driver is predominantly to blame.",
  },
];

export const SEVERITY_LEVELS = [
  { label: "Light touch", description: "Minor contact at a low closing speed; no time or position lost." },
  { label: "Careless", description: "Avoidable contact that cost the other driver time or a position." },
  { label: "Dangerous", description: "Heavy, high-speed or deliberate contact." },
];

const STEWARD_QUESTIONS = [
  {
    type: "choice",
    name: "responsible",
    instructions:
      "Acting as the race steward, who is mainly responsible for this contact? Rely on the telemetry; use the onboard frame, if attached, as supporting evidence.",
    choices: RESPONSIBILITY,
  },
  {
    type: "score",
    name: "severity",
    instructions: "How serious was this contact?",
    levels: SEVERITY_LEVELS,
  },
];

export const RATING_LEVELS = [
  { label: "Rookie", description: "Struggled: slow, many off-track moments or contacts, finished near the back." },
  { label: "Club racer", description: "Solid but unspectacular: some mistakes, a mid-pack result." },
  { label: "Pro", description: "Fast and mostly clean, with a strong result." },
  { label: "Champion", description: "Dominant: won or fought for the win with clean, decisive driving." },
];

// ---------------------------------------------------------------------------
// Validation helpers

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

function num(value, min, max, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? clamp(n, min, max) : fallback;
}

function int(value, min, max, fallback = min) {
  return Math.round(num(value, min, max, fallback));
}

function text(value, maxLength, fallback = "") {
  if (typeof value !== "string") return fallback;
  // Strip control characters so client text can't break the prompt layout.
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, maxLength);
  return cleaned || fallback;
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Natural-language helpers

const LANE_WIDTH = 2 / 3; // road spans offset -1..+1 with three lanes
const CAR_WIDTH = 0.28; // car width in the same offset units

function roadPosition(offset) {
  if (offset < -0.75) return "on the far left edge of the road";
  if (offset < -0.35) return "in the left lane";
  if (offset < -0.12) return "center-left";
  if (offset <= 0.12) return "in the center of the road";
  if (offset <= 0.35) return "center-right";
  if (offset <= 0.75) return "in the right lane";
  return "on the far right edge of the road";
}

function lateralRelation(otherOffset, selfOffset) {
  const lanes = (otherOffset - selfOffset) / LANE_WIDTH;
  const a = Math.abs(lanes);
  if (a < 0.3) return "directly in line";
  const side = lanes > 0 ? "right" : "left";
  if (a < 0.9) return `slightly to the ${side}`;
  return `${a < 1.6 ? "about one lane" : "two lanes"} to the ${side}`;
}

/** Describe the free road beside a car at `offset` (-1 left edge .. +1 right edge). */
function passingRoom(offset) {
  const describe = (room) => (room > 0.75 ? "wide open" : room > 0.45 ? "tight" : "blocked by the road edge");
  return `left side ${describe(offset + 1)}, right side ${describe(1 - offset)}`;
}

function sideGap(otherOffset, selfOffset) {
  const gap = (Math.abs(otherOffset - selfOffset) - CAR_WIDTH) / CAR_WIDTH;
  if (gap < 0.25) return "wheel to wheel with almost no side gap (contact risk)";
  return `with a clear side gap of ${gap.toFixed(1)} car widths`;
}

function speedRelation(relKmh, subject, other, isAhead) {
  const d = Math.round(Math.abs(relKmh));
  if (d < 4) return "same speed";
  if (isAhead) {
    return relKmh < 0 ? `${d} km/h slower (${subject} is closing in)` : `${d} km/h faster (pulling away from ${subject})`;
  }
  return relKmh > 0 ? `${d} km/h faster (closing in on ${subject})` : `${d} km/h slower (dropping back)`;
}

function describeTrack(features) {
  if (!features.length) return "straight road ahead.";
  const parts = features.map((f, i) => {
    const len = Math.round(f.lengthM);
    if (i === 0 && f.inM < 8) {
      return f.kind === "straight"
        ? `currently on a straight with ${len} m to go`
        : `currently in a ${f.severity} ${f.dir}-hand corner with ${len} m to go`;
    }
    const lead = i === 0 ? `in ${Math.round(f.inM)} m, ` : "";
    return f.kind === "straight" ? `${lead}a ${len} m straight` : `${lead}a ${f.severity} ${f.dir}-hand corner (${len} m long)`;
  });
  return `${parts.join(", then ")}.`;
}

const ELEVATION_TEXT = {
  flat: "",
  uphill: " The road climbs.",
  downhill: " The road drops downhill.",
  crest: " A blind crest is coming up.",
  dip: " The road dips into a compression.",
};

// ---------------------------------------------------------------------------
// Rival driver decisions

function readNeighbour(raw, selfOffset) {
  if (!raw || typeof raw !== "object") return null;
  return {
    name: text(raw.name, 24, "Unknown"),
    isPlayer: raw.isPlayer === true,
    gapM: num(raw.gapM, 0, 2000),
    offset: num(raw.offset, -2, 2, selfOffset),
    relSpeedKmh: num(raw.relSpeedKmh, -400, 400),
  };
}

function normalizeRivalState(raw) {
  requireObject(raw, "rival state");
  const driver = requireObject(raw.driver, "driver");
  const race = raw.race && typeof raw.race === "object" ? raw.race : {};
  const self = raw.self && typeof raw.self === "object" ? raw.self : {};
  const offset = num(self.offset, -2, 2);

  const laps = int(race.laps, 1, 20, 3);
  const track = Array.isArray(raw.track)
    ? raw.track.slice(0, 4).map((f) => ({
        kind: oneOf(f?.kind, ["straight", "curve"], "straight"),
        dir: oneOf(f?.dir, ["left", "right"], "right"),
        severity: oneOf(f?.severity, ["gentle", "medium", "sharp"], "medium"),
        inM: num(f?.inM, 0, 5000),
        lengthM: num(f?.lengthM, 0, 5000),
      }))
    : [];

  return {
    name: text(driver.name, 24, "Rival"),
    number: int(driver.number, 0, 99, 0),
    personality: oneOf(driver.personality, Object.keys(PERSONALITIES), "smooth"),
    lap: int(race.lap, 1, laps, 1),
    laps,
    position: int(race.position, 1, 12, 1),
    cars: int(race.cars, 1, 12, 6),
    gapToLeaderS: num(race.gapToLeaderS, 0, 600),
    gapToNextS: num(race.gapToNextS, 0, 600),
    speedKmh: num(self.speedKmh, 0, 600),
    topSpeedKmh: num(self.topSpeedKmh, 1, 600, 300),
    offset,
    nitro: num(self.nitro, 0, 1),
    nitroActive: self.nitroActive === true,
    lastManeuver: oneOf(self.lastManeuver, MANEUVER_VALUES, null),
    lastManeuverAgoS: num(self.lastManeuverAgoS, 0, 600),
    track,
    elevation: oneOf(raw.elevation, Object.keys(ELEVATION_TEXT), "flat"),
    ahead: readNeighbour(raw.ahead, offset),
    behind: readNeighbour(raw.behind, offset),
    alongside: readNeighbour(raw.alongside, offset),
  };
}

function neighbourName(n) {
  return n.isPlayer ? "the human player" : `${n.name} (AI rival)`;
}

export function buildRivalRequest(raw) {
  const s = normalizeRivalState(raw);
  const finalLap = s.lap === s.laps;
  const lines = [];

  lines.push(`Arcade circuit race, ${s.laps} laps, ${s.cars} cars. Driver under review: ${s.name} (#${s.number}).`);
  lines.push(`Personality: ${PERSONALITIES[s.personality]}`);

  const lapText = finalLap ? `FINAL LAP (${s.lap} of ${s.laps})` : `lap ${s.lap} of ${s.laps}`;
  const standing =
    s.position === 1
      ? `leading the race${s.gapToNextS > 0 ? `, ${s.gapToNextS.toFixed(1)} s ahead of P2` : ""}`
      : `running P${s.position} of ${s.cars}, ${s.gapToLeaderS.toFixed(1)} s behind the leader`;
  lines.push(`Race situation: ${lapText}; ${standing}.`);

  const nitroState = s.nitroActive ? "nitro currently firing" : `nitro tank ${Math.round(s.nitro * 100)}%`;
  lines.push(
    `Car: ${Math.round(s.speedKmh)} km/h (top speed ${Math.round(s.topSpeedKmh)} km/h), ${roadPosition(s.offset)}, ${nitroState}.`,
  );
  lines.push(`Track ahead: ${describeTrack(s.track)}${ELEVATION_TEXT[s.elevation]}`);

  if (s.ahead) {
    lines.push(
      `Car ahead: ${neighbourName(s.ahead)}, ${Math.round(s.ahead.gapM)} m ahead, ${lateralRelation(s.ahead.offset, s.offset)}, ` +
        `${speedRelation(s.ahead.relSpeedKmh, s.name, s.ahead.name, true)}. Room to pass it: ${passingRoom(s.ahead.offset)}.`,
    );
  } else {
    lines.push("Car ahead: none within 150 m.");
  }
  if (s.behind) {
    lines.push(
      `Car behind: ${neighbourName(s.behind)}, ${Math.round(s.behind.gapM)} m behind, ${lateralRelation(s.behind.offset, s.offset)}, ` +
        `${speedRelation(s.behind.relSpeedKmh, s.name, s.behind.name, false)}.`,
    );
  } else {
    lines.push("Car behind: none within 100 m.");
  }
  if (s.alongside) {
    lines.push(
      `Alongside: ${neighbourName(s.alongside)} is side by side, ${lateralRelation(s.alongside.offset, s.offset)}, ${sideGap(s.alongside.offset, s.offset)}.`,
    );
  }
  if (s.lastManeuver) {
    lines.push(`Previous maneuver: ${s.lastManeuver} (chosen ${s.lastManeuverAgoS.toFixed(1)} s ago).`);
  }

  return { input: lines.join("\n"), questions: RIVAL_QUESTIONS };
}

export function parseRivalDecision(result) {
  const maneuver = summarizeChoice(result.answers.maneuver);
  return {
    maneuver: maneuver && MANEUVER_VALUES.includes(maneuver.choice) ? maneuver : null,
    pace: summarizeScore(result.answers.pace),
    nitro: summarizePredicate(result.answers.nitro),
    refusals: refusals(result.answers),
  };
}

// ---------------------------------------------------------------------------
// Race Control (steward) decisions

const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;
const MAX_FRAME_LENGTH = 900_000;

function lateralMove(value, mover, target) {
  const lanes = num(value, -3, 3) / LANE_WIDTH;
  const a = Math.abs(lanes);
  if (a < 0.08) return `${mover} held its line`;
  return `${mover} moved ${a.toFixed(2)} lane widths ${lanes > 0 ? "toward" : "away from"} ${target}`;
}

export function buildStewardRequest(raw) {
  requireObject(raw, "incident");
  const rival = raw.rival && typeof raw.rival === "object" ? raw.rival : {};
  const name = text(rival.name, 24, "the rival");
  const number = int(rival.number, 0, 99, 0);
  const laps = int(raw.laps, 1, 20, 3);
  const lap = int(raw.lap, 1, laps, 1);
  const kind = oneOf(raw.kind, ["rear", "side"], "side");
  const front = oneOf(raw.front, ["player", "rival", "level"], "level");
  const playerKmh = num(raw.playerSpeedKmh, 0, 600);
  const rivalKmh = num(raw.rivalSpeedKmh, 0, 600);
  const closing = Math.round(Math.abs(playerKmh - rivalKmh));
  const maneuver = oneOf(raw.rivalManeuver, MANEUVER_VALUES, null);

  let contact;
  if (kind === "rear" && front === "rival") {
    contact = `rear-end: the player ran into the back of ${name} with a closing speed of ${closing} km/h.`;
  } else if (kind === "rear" && front === "player") {
    contact = `rear-end: ${name} ran into the back of the player with a closing speed of ${closing} km/h.`;
  } else {
    contact = `side-by-side contact while the cars were alongside each other (speed difference ${closing} km/h).`;
  }

  const lines = [
    `Race Control incident review. Arcade circuit race, lap ${lap} of ${laps}.`,
    `Contact between the human player (#1) and AI rival ${name} (#${number}).`,
    `Type: ${contact}`,
    `Speeds at contact: player ${Math.round(playerKmh)} km/h, ${name} ${Math.round(rivalKmh)} km/h.`,
    `In the 0.6 s before contact: ${lateralMove(raw.playerLateral, "the player", name)}; ${lateralMove(raw.rivalLateral, name, "the player")}.`,
    `${name}'s active maneuver: ${maneuver ?? "unknown"}.`,
    `Player inputs: braking ${raw.playerBraking === true ? "yes" : "no"}, nitro ${raw.playerNitro === true ? "yes" : "no"}, off track ${raw.playerOffTrack === true ? "yes" : "no"}.`,
  ];

  const frame = typeof raw.frame === "string" ? raw.frame : null;
  if (frame && frame.length <= MAX_FRAME_LENGTH && IMAGE_DATA_URL.test(frame)) {
    lines.push(
      `The attached image is the player's onboard camera at the moment of contact: the player's car is in the foreground and ${name} is labeled above its car.`,
    );
    return {
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: lines.join("\n") },
            { type: "input_image", image_url: frame },
          ],
        },
      ],
      questions: STEWARD_QUESTIONS,
    };
  }
  return { input: lines.join("\n"), questions: STEWARD_QUESTIONS };
}

export function parseStewardDecision(result) {
  return {
    responsible: summarizeChoice(result.answers.responsible),
    severity: summarizeScore(result.answers.severity),
    refusals: refusals(result.answers),
  };
}

// ---------------------------------------------------------------------------
// Post-race debrief

function formatTime(seconds) {
  if (seconds === null) return "did not finish";
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

export function buildDebriefRequest(raw) {
  requireObject(raw, "race summary");
  if (!Array.isArray(raw.drivers) || raw.drivers.length < 2) {
    throw new TypeError("race summary needs at least two drivers");
  }
  const laps = int(raw.laps, 1, 20, 3);
  const difficulty = oneOf(raw.difficulty, ["easy", "normal", "hard"], "normal");

  const seen = new Set();
  const drivers = raw.drivers.slice(0, 8).map((d, i) => {
    let name = text(d?.name, 24, `Driver ${i + 1}`);
    while (seen.has(name)) name = `${name}*`;
    seen.add(name);
    const finishedTime = d?.timeS === null || d?.timeS === undefined ? null : num(d.timeS, 0, 36_000);
    return {
      name,
      isPlayer: d?.isPlayer === true,
      personality: oneOf(d?.personality, Object.keys(PERSONALITIES), null),
      start: int(d?.start, 1, 12, i + 1),
      finish: int(d?.finish, 1, 12, i + 1),
      timeS: finishedTime,
      penaltyS: num(d?.penaltyS, 0, 600),
      bestLapS: num(d?.bestLapS, 0, 3600, 0) || null,
      overtakes: int(d?.overtakes, 0, 999, 0),
      contacts: int(d?.contacts, 0, 999, 0),
    };
  });
  if (!drivers.some((d) => d.isPlayer)) throw new TypeError("race summary must include the player");

  const p = raw.player && typeof raw.player === "object" ? raw.player : {};
  const player = {
    offTrackS: num(p.offTrackS, 0, 3600),
    wallHits: int(p.wallHits, 0, 999, 0),
    nitroUses: int(p.nitroUses, 0, 999, 0),
    topSpeedKmh: num(p.topSpeedKmh, 0, 600),
  };

  const describeDriver = (d) =>
    `${d.isPlayer ? "PLAYER" : "AI"} ${d.name}${d.personality ? ` (${d.personality})` : ""}: started P${d.start}, finished P${d.finish}, ` +
    `total ${formatTime(d.timeS)}${d.penaltyS > 0 ? ` incl. ${d.penaltyS} s penalties` : ""}, best lap ${d.bestLapS ? formatTime(d.bestLapS) : "n/a"}, ` +
    `${d.overtakes} overtakes, ${d.contacts} contacts`;

  const ordered = [...drivers].sort((a, b) => a.finish - b.finish);
  const lines = [
    `Post-race debrief. Arcade circuit race: ${laps} laps, ${drivers.length} cars, ${difficulty} difficulty.`,
    "Final classification:",
    ...ordered.map((d) => `- ${describeDriver(d)}`),
    `Player driving stats: ${player.offTrackS.toFixed(1)} s off track, ${player.wallHits} crashes into roadside objects, ` +
      `${player.nitroUses} nitro boosts, top speed ${Math.round(player.topSpeedKmh)} km/h.`,
  ];

  const questions = [
    {
      type: "score",
      name: "rating",
      instructions: "Rate the PLAYER's overall race performance: result, pace, racecraft and cleanliness.",
      levels: RATING_LEVELS,
    },
    {
      type: "choice",
      name: "driver_of_the_day",
      instructions:
        "Who is driver of the day? Reward positions gained from the start, overtakes, a strong result and clean driving.",
      choices: drivers.map((d) => ({
        value: d.name,
        description: `${d.isPlayer ? "The human player" : "AI rival"}: P${d.start} to P${d.finish}, ${d.overtakes} overtakes, ${d.contacts} contacts.`,
      })),
    },
    {
      type: "predicate",
      name: "clean_racer",
      instructions:
        "Did the PLAYER race cleanly: no penalties, very few contacts with other cars, and little time off track?",
    },
  ];

  return { input: lines.join("\n"), questions };
}

export function parseDebriefDecision(result) {
  return {
    rating: summarizeScore(result.answers.rating),
    driverOfTheDay: summarizeChoice(result.answers.driver_of_the_day),
    cleanRacer: summarizePredicate(result.answers.clean_racer),
    refusals: refusals(result.answers),
  };
}
