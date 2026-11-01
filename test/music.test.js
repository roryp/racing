// The soundtrack is data: these checks keep the score well formed and in key, so a typo can't
// slip a sour note into the music.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BARS, BPM, LOOP_START, STEPS_PER_BAR, chordNotes, eventsAt, midi } from "../public/js/music.js";

const pitchClass = (note) => note % 12;
const A_MINOR = new Set(["A4", "B4", "C4", "D4", "E4", "F4", "G4"].map((name) => pitchClass(midi(name))));
const at = (bar, step) => eventsAt(bar * STEPS_PER_BAR + step);

describe("soundtrack", () => {
  it("fills every bar of the melody exactly", () => {
    for (const [i, bar] of BARS.entries()) assert.equal(bar.steps, STEPS_PER_BAR, `bar ${i + 1} (${bar.section})`);
  });

  it("keeps the melody in key, starting each bar on a chord tone", () => {
    for (const [i, bar] of BARS.entries()) {
      const chord = new Set(chordNotes(bar.chord).map(pitchClass));
      for (const { step, note } of bar.lead) {
        assert.ok(A_MINOR.has(pitchClass(note)) || chord.has(pitchClass(note)), `bar ${i + 1}: ${note} is out of key`);
        if (step === 0) assert.ok(chord.has(pitchClass(note)), `bar ${i + 1}: ${note} isn't in ${bar.chord}`);
      }
    }
  });

  it("plays each chord's root in the bass", () => {
    for (const [i, bar] of BARS.entries()) {
      const root = pitchClass(chordNotes(bar.chord)[0]);
      for (let step = 0; step < STEPS_PER_BAR; step++) {
        for (const event of at(i, step).filter((e) => e.voice === "bass")) assert.equal(pitchClass(event.note), root, `bar ${i + 1}`);
      }
    }
  });

  it("plays the intro once, then loops from the first verse", () => {
    assert.equal(BARS[LOOP_START].section, "verse");
    for (let step = 0; step < STEPS_PER_BAR; step++) assert.deepEqual(at(BARS.length, step), at(LOOP_START, step));
  });

  it("runs over a minute before it repeats", () => {
    const seconds = ((BARS.length - LOOP_START) * STEPS_PER_BAR * 60) / BPM / 4;
    assert.ok(seconds > 60, `${seconds.toFixed(1)} s`);
  });
});
