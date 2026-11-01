// The engine sound should follow the driving instead of droning: it revs as the car
// accelerates, shifts gear, and settles to a lower hum while the speed holds steady.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ACCEL, BRAKING, MAX_SPEED, NITRO_BOOST, STEP } from "../public/js/config.js";
import { EngineModel } from "../public/js/audio.js";

const FLAT_OUT = ACCEL / MAX_SPEED; // fraction of top speed gained per second
const BRAKE = BRAKING / MAX_SPEED;

/** `seconds` of physics steps changing speed by `rate` per second until it reaches `limit`. */
function trace(from, seconds, rate, limit = rate < 0 ? 0 : 1) {
  const speeds = [];
  for (let i = 1; i <= Math.round(seconds / STEP); i++) {
    const speed = from + rate * i * STEP;
    speeds.push(rate < 0 ? Math.max(limit, speed) : Math.min(limit, speed));
  }
  return speeds;
}

function run(engine, speeds, nitro = false) {
  return speeds.map((speed) => ({ ...engine.update(speed, nitro, STEP), gear: engine.gear }));
}

const peakGain = (frames) => Math.max(...frames.map((f) => f.gain));

describe("engine sound", () => {
  it("revs while accelerating, then settles to a lower but audible hum at a steady speed", () => {
    const engine = new EngineModel();
    const launch = run(engine, trace(0, 5, FLAT_OUT));
    const cruise = run(engine, trace(1, 6, 0));
    const peak = peakGain(launch);
    const hum = cruise.at(-1).gain;
    assert.ok(cruise[Math.round(3 / STEP)].gain < peak / 2, "settled within 3 s of reaching top speed");
    // 6-12 dB under the roar: quiet enough not to drone, loud enough not to get lost.
    assert.ok(hum < peak / 2 && hum > peak / 4, `steady hum ${hum} vs peak ${peak}`);
  });

  it("shifts up through the gears, dropping the pitch at each shift", () => {
    const engine = new EngineModel();
    const launch = run(engine, trace(0, 5, FLAT_OUT));
    const shifts = launch.flatMap((f, i) => (i > 0 && f.gear > launch[i - 1].gear ? [i] : []));
    assert.ok(shifts.length >= 3, `only ${shifts.length} upshifts`);
    for (const i of shifts) assert.ok(launch[i].freq < launch[i - 1].freq, `pitch rose at the shift on step ${i}`);
  });

  it("roars again for nitro and when accelerating out of a corner", () => {
    const engine = new EngineModel();
    run(engine, trace(0, 5, FLAT_OUT));
    const hum = run(engine, trace(1, 6, 0)).at(-1).gain;
    const nitro = run(engine, trace(1, 0.5, FLAT_OUT * 1.8, NITRO_BOOST), true);
    assert.ok(nitro.at(-1).gain > hum * 2, "nitro is loud");

    run(engine, trace(NITRO_BOOST, 3, BRAKE, 0.6)); // brake for a corner, then hold the speed
    const corner = run(engine, trace(0.6, 2, 0)).at(-1).gain;
    const exit = run(engine, trace(0.6, 0.5, FLAT_OUT));
    assert.ok(peakGain(exit) > corner * 2, "accelerating out of the corner is loud");
  });

  it("doesn't flutter between gears while the speed hovers around a shift point", () => {
    const engine = new EngineModel();
    run(engine, trace(0, 3.5, FLAT_OUT, 0.7));
    const speeds = Array.from({ length: 240 }, (_, i) => 0.72 + 0.02 * Math.sin(i / 6));
    const frames = run(engine, speeds);
    const changes = frames.filter((f, i) => i > 0 && f.gear !== frames[i - 1].gear).length;
    assert.ok(changes <= 1, `${changes} gear changes`);
  });
});
