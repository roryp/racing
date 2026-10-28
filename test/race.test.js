// Headless race simulation: exercises the game logic (no DOM needed) and checks
// that the payloads the browser sends are accepted by the server's prompt builders.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CAR_LENGTH, CENTRIFUGAL, GHOST_TIME, MAX_SPEED, OFF_ROAD_RESCUE, ROAD_WIDTH, SEGMENT_LENGTH, STEP } from "../public/js/config.js";
import { isGhost, Race } from "../public/js/race.js";
import { localDecision, RivalBrains } from "../public/js/rivals.js";
import { SPRITE_TYPES, Track } from "../public/js/track.js";
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

function runRace({ laps = 1, difficulty = "normal", driver = bot } = {}) {
  const track = new Track();
  const race = new Race({ track, laps, difficulty });
  const brains = new RivalBrains({ race, api: null, mode: "local" });
  const events = [];
  race.startCountdown();
  for (let step = 0; race.phase !== "finished" && step < 60 * 400; step++) {
    race.update(STEP, driver(race, step));
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

describe("roadside recovery", () => {
  /** A race where only the player moves (rivals parked half a lap away). */
  function soloRace() {
    const track = new Track();
    const race = new Race({ track, laps: 3 });
    race.phase = "racing";
    race.rivals.forEach((car, i) => {
      car.launchDelay = Infinity;
      car.progress = track.length / 2 + i * CAR_LENGTH * 3;
    });
    return { track, race };
  }

  function drive(race, seconds, controls, until = () => false) {
    const events = [];
    for (let t = 0; t < seconds && !until(); t += STEP) {
      race.update(STEP, typeof controls === "function" ? controls(race) : controls);
      events.push(...race.drainEvents());
    }
    return events;
  }

  it("puts the car back on the road after it hits a tree, then lets it race on", () => {
    const { track, race } = soloRace();
    const p = race.player;
    const seg = track.segments.find((s) => s.index > 200 && s.sprites.some((sp) => sp.kind === "pine" && sp.offset > 1.6 && sp.offset < 2));
    const tree = seg.sprites.find((sp) => sp.kind === "pine" && sp.offset > 1.6 && sp.offset < 2);
    p.progress = seg.index * SEGMENT_LENGTH + 20;
    p.offset = tree.offset + (SPRITE_TYPES.pine.width / ROAD_WIDTH) * 0.5;
    p.speed = MAX_SPEED * 0.25;

    const panic = { up: true, right: true, nitro: true }; // inputs are ignored while recovering
    const crash = drive(race, STEP, panic);
    assert.ok(crash.some((e) => e.type === "wall"), "expected a crash");
    assert.ok(p.recovery?.crashed, "the crash should start a recovery");
    assert.equal(p.speed, 0);

    const start = race.time;
    const events = drive(race, 4, panic, () => !p.recovery);
    assert.equal(p.recovery, null, "the car should be back on the road");
    assert.ok(race.time - start < 3, `recovery took ${(race.time - start).toFixed(2)} s`);
    assert.ok(events.some((e) => e.type === "recovered"));
    assert.ok(Math.abs(p.offset) <= 1, `offset ${p.offset}`);
    assert.equal(p.nitroTime, 0);
    assert.ok(isGhost(p));

    drive(race, 3, bot);
    assert.ok(p.speed > MAX_SPEED * 0.3, `speed ${p.speed}`);
    assert.ok(Math.abs(p.offset) < 1);
    assert.equal(p.wallHits, 1);
    assert.ok(!isGhost(p), `ghost should wear off after ${GHOST_TIME} s`);
  });

  it("rescues a car that has stopped on the grass", () => {
    const { track, race } = soloRace();
    const p = race.player;
    const seg = track.segments.find((s) => s.index > 200 && s.sprites.every((sp) => !SPRITE_TYPES[sp.kind].solid || sp.offset > 0));
    p.progress = seg.index * SEGMENT_LENGTH + 20;
    p.offset = -1.5;
    p.speed = 0;

    const events = drive(race, 4, {}, () => p.recovery === null && p.ghostTime > 0);
    const start = events.find((e) => e.type === "recovering");
    assert.ok(start && !start.crashed, "expected a rescue");
    assert.ok(events.some((e) => e.type === "recovered"));
    assert.ok(Math.abs(p.offset) <= 1, `offset ${p.offset}`);
  });

  it("rescues a car that stays off the road too long", () => {
    const { track, race } = soloRace();
    const p = race.player;
    const seg = track.segments.find((s) => s.index > 200 && s.sprites.every((sp) => !SPRITE_TYPES[sp.kind].solid || sp.offset > 0));
    p.progress = seg.index * SEGMENT_LENGTH + 20;
    p.offset = -1.05;
    p.speed = MAX_SPEED * 0.2;
    p.wallCooldown = Infinity; // only test the timer, not trees further along

    const events = drive(race, OFF_ROAD_RESCUE + 2, { up: true }, () => p.recovery !== null);
    assert.ok(events.some((e) => e.type === "recovering" && !e.crashed));
    assert.ok(p.speed > 0, "a rescued car keeps rolling");
  });

  it("lets rivals pass through a recovering car without a contact", () => {
    const { race } = soloRace();
    const p = race.player;
    const rival = race.rivals[0];
    p.progress = 30_000;
    p.offset = 1.6;
    race.startRecovery(p, true);
    rival.progress = p.progress - CAR_LENGTH * 0.5;
    rival.offset = 0.7;
    rival.speed = MAX_SPEED * 0.5;
    assert.equal(race.blocker(rival), null, "rivals should not brake for a ghost");

    const events = drive(race, 1.5, {});
    assert.ok(!events.some((e) => e.type === "contact"), "no contact with a ghost");
  });

  it("lets a driver who keeps steering into the forest still finish", () => {
    const novice = (race, step) => {
      const t = (step / 60) % 12;
      return t > 6 && t < 8.5 ? { up: true, right: true } : bot(race);
    };
    const { race } = runRace({ laps: 1, driver: novice });
    const p = race.player;
    assert.ok(p.finished && !p.estimated, "the player should cross the line");
    assert.ok(p.recoveries > 0, "expected at least one recovery");
    assert.ok(p.lapTimes[0] < 100, `lap ${p.lapTimes[0]}`);
  });
});
