// Rival "brains": each rival periodically asks the Decisions API for a maneuver
// (choice), a pace (score) and whether to fire nitro (predicate). The race
// simulation then executes that decision every frame until the next one arrives.

import { CAR_HALF, NITRO_COST, NITRO_THRESHOLD } from "./config.js";

const CAR_WIDTH_OFFSET = CAR_HALF * 2;
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const BASE_PACE = { aggressive: 2.3, tactical: 1.7, defensive: 1.8, smooth: 1.6, wildcard: 1.9 };

/** Offline fallback that mimics the API's answer shape. */
export function localDecision(payload, personality) {
  const { ahead, behind, alongside, track, race, self } = payload;
  const current = track[0];
  const straightLeft = current?.kind === "straight" ? current.lengthM : 0;
  const sharpSoon = track.some((f) => f.kind === "curve" && f.severity === "sharp" && f.inM < 130);
  const finalLap = race.lap === race.laps;

  let maneuver = "racing_line";
  if (alongside && Math.abs(alongside.offset - self.offset) < CAR_WIDTH_OFFSET * 1.25) {
    maneuver = "back_off";
  } else if (ahead && ahead.gapM < 60 && ahead.relSpeedKmh < 4) {
    if (ahead.gapM > 25 && straightLeft > 120) maneuver = "slipstream";
    else maneuver = ahead.offset > self.offset || (Math.abs(ahead.offset - self.offset) < 0.1 && ahead.offset > 0) ? "overtake_left" : "overtake_right";
  } else if (behind && behind.gapM < 35 && behind.relSpeedKmh > 5 && (personality === "defensive" || race.position <= 2)) {
    maneuver = "defend";
  }

  const base = personality === "wildcard" ? 1 + Math.random() * 2 : (BASE_PACE[personality] ?? 1.8);
  const pace = clamp(base + (finalLap ? 0.6 : 0) - (sharpSoon ? 0.9 : 0), 0, 3);
  const wantsNitro = !sharpSoon && straightLeft > 150 && (finalLap || maneuver.startsWith("overtake") || personality === "aggressive");

  return {
    maneuver: { choice: maneuver, probabilities: { [maneuver]: 1 }, confidence: null },
    pace: { score: pace, probabilities: null, labels: null, confidence: null },
    nitro: { probability: wantsNitro ? 0.8 : 0.15 },
  };
}

export class RivalBrains {
  constructor({ race, api, mode, onDecision }) {
    this.race = race;
    this.api = api;
    this.mode = mode; // "api" | "local"
    this.onDecision = onDecision;
    this.stopped = false;
    this.failures = 0;
    this.apiDownUntil = 0;
    this.lastError = null;
  }

  stop() {
    this.stopped = true;
  }

  get usingApi() {
    return this.mode === "api" && performance.now() >= this.apiDownUntil;
  }

  update(now) {
    const { phase } = this.race;
    if (this.stopped || (phase !== "countdown" && phase !== "racing")) return;
    for (const car of this.race.rivals) {
      const brain = car.brain;
      if (car.finished || brain.pending || now < brain.nextAt) continue;
      this.decide(car, now);
    }
  }

  cadenceMs(car) {
    const near = this.race.surroundings(car);
    const busy =
      near.alongside || (near.ahead && near.ahead.dzM < 80) || (near.behind && near.behind.dzM > -60);
    return (busy ? 650 : 1400) + Math.random() * 400;
  }

  async decide(car, now) {
    const brain = car.brain;
    const payload = this.race.rivalPayload(car);
    if (!this.usingApi) {
      this.apply(car, localDecision(payload, car.personality), "local", null);
      brain.nextAt = now + this.cadenceMs(car);
      return;
    }

    brain.pending = true;
    try {
      const answer = await this.api.rival(payload);
      if (this.stopped) return;
      this.failures = 0;
      const fallback = localDecision(payload, car.personality);
      this.apply(
        car,
        {
          maneuver: answer.maneuver ?? fallback.maneuver,
          pace: answer.pace ?? fallback.pace,
          nitro: answer.nitro ?? fallback.nitro,
        },
        "api",
        answer,
      );
    } catch (err) {
      if (this.stopped) return;
      this.failures++;
      this.lastError = err.message;
      if (err.status === 503 || this.failures >= 4) this.apiDownUntil = performance.now() + 8000;
      this.apply(car, localDecision(payload, car.personality), "local", { error: err.message });
    } finally {
      brain.pending = false;
      brain.nextAt = performance.now() + this.cadenceMs(car);
    }
  }

  apply(car, decision, source, meta) {
    const brain = car.brain;
    brain.maneuver = decision.maneuver.choice;
    brain.maneuverDist = decision.maneuver.probabilities;
    brain.confidence = decision.maneuver.confidence;
    brain.pace = decision.pace.score;
    brain.paceDist = decision.pace.probabilities;
    brain.paceLabels = decision.pace.labels;
    brain.nitroP = decision.nitro.probability;
    brain.source = source;
    brain.latencyMs = meta?.roundTripMs ?? null;
    brain.error = meta?.error ?? null;
    brain.decidedAt = this.race.time;
    brain.decisions++;

    const threshold = NITRO_THRESHOLD[car.personality] ?? 0.6;
    brain.nitroThreshold = threshold;
    brain.nitroFired = brain.nitroP >= threshold && car.nitro >= NITRO_COST && this.race.fireNitro(car);
    this.onDecision?.(car);
  }
}
