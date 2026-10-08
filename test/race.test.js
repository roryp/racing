// Headless race simulation: exercises the game logic (no DOM needed) and checks
// that the payloads the browser sends are accepted by the server's prompt builders.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CAR_LENGTH, CENTRIFUGAL, MAX_SPEED, STEP } from "../public/js/config.js";
import { Race } from "../public/js/race.js";
import { localDecision, RivalBrains } from "../public/js/rivals.js";
import { Track } from "../public/js/track.js";
import { buildDebriefRequest, buildRivalRequest, buildStewardRequest } from "../lib/prompts.js";

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/** A simple driver: slows for corners, follows the inside line, dodges cars ahead. */
function bot(race) {
  const { player: p, track } = race;
  const curve = track.maxCurveAhead(p.progress, 40);
  const safe = curve > 0 ? 1 / (CENTRIFUGAL * curve) + 0.22 : 2;
  const speedPct = p.speed / MAX_SPEED;
  let target = clamp(track.avgCurveAhead(p.progress, 30) * 0.1, -0.5, 0.5);
  const block = race.blocker(p, CAR_LENGTH * 4);
  if (block) target = block.car.offset > 0 ? block.car.offset - 0.6 : block.car.offset + 0.6;
  return {
    left: p.offset > target + 0.04,
    right: p.offset < target - 0.04,
    up: speedPct < safe,
    down: speedPct > safe + 0.08,
    nitro: curve < 2 && p.nitro > 0.6,
  };
}

function runRace({ laps = 1, difficulty = "normal" } = {}) {
  const track = new Track();
  const race = new Race({ track, laps, difficulty });
  const brains = new RivalBrains({ race, api: null, mode: "local" });
  const events = [];
  race.startCountdown();
  for (let step = 0; race.phase !== "finished" && step < 60 * 400; step++) {
    race.update(STEP, bot(race));
    brains.update(race.time * 1000 + step);
    events.push(...race.drainEvents());
  }
  return { race, events };
}

describe("race simulation", () => {
  const { race, events } = runRace({ laps: 1 });

  it("runs the countdown, the race and the classification", () => {
    const types = new Set(events.map((e) => e.type));
    for (const type of ["countdown", "go", "finish", "classified"]) assert.ok(types.has(type), `missing ${type} event`);
    assert.equal(race.phase, "finished");
  });

  it("classifies every car exactly once with finite times", () => {
    const standings = race.classify();
    assert.equal(standings.length, 6);
    assert.deepEqual(
      standings.map((s) => s.position),
      [1, 2, 3, 4, 5, 6],
    );
    for (const { car, total } of standings) {
      assert.ok(Number.isFinite(total), `${car.name} has no finish time`);
      assert.ok(Number.isFinite(car.offset) && Number.isFinite(car.speed));
    }
  });

  it("produces plausible lap times", () => {
    const lap = race.player.lapTimes[0];
    assert.ok(lap > 35 && lap < 80, `player lap ${lap}`);
    for (const car of race.rivals.filter((c) => c.lapTimes.length)) {
      assert.ok(car.lapTimes[0] > 35 && car.lapTimes[0] < 90, `${car.name} lap ${car.lapTimes[0]}`);
    }
  });

  it("sends debrief summaries the server accepts", () => {
    const { input, questions } = buildDebriefRequest(race.summary());
    assert.match(input, /PLAYER You/);
    assert.equal(questions[1].choices.length, 6);
  });
});

describe("rival decision payloads", () => {
  it("are accepted by the server prompt builder for every rival", () => {
    const race = new Race({ track: new Track(), laps: 3 });
    for (const car of race.rivals) {
      const payload = race.rivalPayload(car);
      const { input } = buildRivalRequest(payload);
      assert.match(input, new RegExp(`Driver under review: ${car.name} \\(#${car.number}\\)`));
      const fallback = localDecision(payload, car.personality);
      assert.ok(fallback.maneuver.choice && Number.isFinite(fallback.pace.score));
    }
  });

  it("fires nitro when the API's predicate clears the personality threshold", () => {
    const race = new Race({ track: new Track(), laps: 3 });
    race.phase = "racing";
    const brains = new RivalBrains({ race, api: null, mode: "local" });
    const vega = race.rivals.find((c) => c.id === "vega");
    vega.nitro = 1;
    const decision = (p) => ({
      maneuver: { choice: "racing_line", probabilities: { racing_line: 1 }, confidence: 1 },
      pace: { score: 2, probabilities: [0, 0, 1, 0], labels: null, confidence: 1 },
      nitro: { probability: p },
    });
    brains.apply(vega, decision(0.3), "api", { roundTripMs: 300 });
    assert.equal(vega.nitroTime, 0);
    brains.apply(vega, decision(0.9), "api", { roundTripMs: 300 });
    assert.ok(vega.nitroTime > 0);
    assert.equal(vega.brain.source, "api");
    assert.equal(vega.brain.latencyMs, 300);
  });
});

describe("contacts", () => {
  it("raise an incident the steward endpoint accepts", () => {
    const race = new Race({ track: new Track(), laps: 3 });
    race.phase = "racing";
    const rival = race.rivals[0];
    for (const car of race.cars) car.progress = 50_000 + race.cars.indexOf(car) * 5000;
    rival.progress = 20_000;
    rival.offset = 0;
    rival.speed = MAX_SPEED * 0.6;
    race.player.progress = rival.progress - CAR_LENGTH * 1.2;
    race.player.offset = 0.05;
    race.player.speed = MAX_SPEED * 0.95;

    race.update(STEP, { up: true });
    const contact = race.drainEvents().find((e) => e.type === "contact");
    assert.ok(contact, "expected a contact event");
    assert.equal(contact.incident.kind, "rear");
    assert.equal(contact.incident.front, "rival");
    assert.ok(race.player.speed < MAX_SPEED * 0.95, "the rear car should lose speed");
    const { input } = buildStewardRequest(contact.incident);
    assert.match(input, new RegExp(`the player ran into the back of ${rival.name}`));
  });
});
