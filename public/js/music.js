// Background music: an original tune in the style of the 80s/90s arcade racers (synthwave drums,
// an octave bass, arpeggios and a lead with a dotted-eighth echo). Like the rest of the game's
// sound it is sequenced and synthesized live with WebAudio, so there are no audio files.

export const BPM = 140;
export const STEPS_PER_BAR = 16;
const STEP_TIME = 60 / BPM / 4; // one 16th note, in seconds
// Written in A minor, played a tone up in B minor: the engine's cruising note (about F#3) is
// then the key's fifth instead of clashing with the F chords.
const TRANSPOSE = 2;
const VOLUME = 0.3; // sits between the engine's cruising hum and its roar
const LOOKAHEAD = 0.2; // s of music scheduled ahead of the audio clock

const PITCHES = { C: 0, "C#": 1, D: 2, "D#": 3, E: 4, F: 5, "F#": 6, G: 7, "G#": 8, A: 9, "A#": 10, B: 11 };

/** "A4" -> MIDI note number (A4 = 69). */
export function midi(name) {
  const [, pitch, octave] = /^([A-G]#?)(\d)$/.exec(name);
  return 12 * (Number(octave) + 1) + PITCHES[pitch];
}

const hz = (note) => 440 * 2 ** ((note + TRANSPOSE - 69) / 12);

/** "Am", "F", "E" -> the triad as MIDI notes, rooted between E4 and D#5. */
export function chordNotes(symbol) {
  const minor = symbol.endsWith("m");
  const root = 64 + ((PITCHES[minor ? symbol.slice(0, -1) : symbol] + 8) % 12);
  return [root, root + (minor ? 3 : 4), root + 7];
}

// Lead lines: one string per bar of "note:length" tokens (length in 16ths, "-" rests).
const SECTIONS = {
  intro: { chords: "Am Am F G", drums: "intro intro rock rock", bass: "eighths", fill: "..........x.xxXX" },
  verse: {
    chords: "Am F G Em Am F G G",
    drums: "rock",
    bass: "octaves",
    fill: "............XxXX",
    lead: [
      "A3:2 C4:2 E4:2 A4:6 G4:2 E4:2",
      "F4:4 E4:2 C4:2 A3:6 -:2",
      "B3:2 D4:2 G4:4 F4:2 E4:2 D4:4",
      "E4:6 D4:2 B3:4 G3:4",
      "A3:2 C4:2 E4:2 A4:6 B4:2 C5:2",
      "C5:4 B4:2 A4:2 F4:6 -:2",
      "G4:3 A4:3 B4:2 D5:4 B4:4",
      "B4:2 A4:2 G4:2 D4:2 B3:6 -:2",
    ],
  },
  chorus: {
    chords: "F G Em Am F G A A",
    drums: "drive",
    bass: "gallop",
    fill: "............XxXX",
    lead: [
      "C5:3 A4:3 C5:2 D5:3 C5:3 A4:2",
      "B4:3 G4:3 B4:2 D5:3 B4:3 G4:2",
      "G4:3 E4:3 G4:2 B4:4 A4:2 G4:2",
      "A4:6 E4:2 A4:2 B4:2 C5:4",
      "C5:3 A4:3 C5:2 F5:4 E5:2 D5:2",
      "D5:3 B4:3 D5:2 G4:2 A4:2 B4:4",
      "C#5:4 B4:2 C#5:2 E5:8",
      "E5:2 C#5:2 A4:2 E4:2 A4:8",
    ],
  },
  bridge: {
    chords: "Dm Em F G Dm Em F E",
    drums: "half",
    bass: "long",
    fill: "xxxxxxxxXXXXXXXX",
    soft: true,
    lead: [
      "F4:8 A4:8",
      "G4:8 B4:8",
      "A4:8 C5:8",
      "B4:8 D5:8",
      "D5:4 C5:4 A4:8",
      "B4:4 G4:4 E4:8",
      "F4:4 A4:4 C5:8",
      "B4:4 G#4:4 E4:2 G#4:2 B4:4",
    ],
  },
};

// Drum grids, one character per 16th: X accent, x softer, . rest.
const DRUMS = {
  intro: { kick: "X.......X.......", snare: "................", hat: "x.x.x.x.x.x.x.x." },
  rock: { kick: "X.......X.X.....", snare: "....X.......X...", hat: "X.x.X.x.X.x.X.x." },
  drive: { kick: "X...X...X...X...", snare: "....X.......X...", hat: "xxXxxxXxxxXxxxXx" },
  half: { kick: "X...............", snare: "........X.......", hat: "x...x...x...x..." },
};

// Bass lines: L the chord's root, H an octave up, - holds the note, . rest.
const BASS = {
  eighths: "L-L-L-L-L-L-L-L-",
  octaves: "L-H-L-H-L-H-L-H-",
  gallop: "L-LHL-LHL-LHL-LH",
  long: "L-------L---H---",
};

// The running order: the intro plays once, then the song loops from the first verse.
const SONG = [
  { section: "intro" },
  { section: "verse", arp: false },
  { section: "chorus" },
  { section: "verse" },
  { section: "bridge" },
  { section: "chorus", double: true },
];

function parseLead(line) {
  const notes = [];
  let steps = 0;
  for (const token of line.split(" ")) {
    const [name, length] = token.split(":");
    if (name !== "-") notes.push({ step: steps, note: midi(name), len: Number(length) });
    steps += Number(length);
  }
  return { notes, steps };
}

const overlay = (grid, fill) => [...grid].map((hit, i) => (fill && fill[i] !== "." ? fill[i] : hit)).join("");

/** Every bar of the song, in order. */
export const BARS = SONG.flatMap(({ section, arp = true, double = false }) => {
  const { chords, drums, bass, fill, lead, soft = false } = SECTIONS[section];
  const patterns = drums.split(" ");
  return chords.split(" ").map((chord, i, all) => {
    const { kick, snare, hat } = DRUMS[patterns[i % patterns.length]];
    const melody = lead ? parseLead(lead[i]) : { notes: [], steps: STEPS_PER_BAR };
    return {
      section,
      chord,
      first: i === 0,
      kick,
      snare: i === all.length - 1 ? overlay(snare, fill) : snare,
      hat,
      bass: BASS[bass],
      lead: melody.notes,
      steps: melody.steps,
      arp,
      double,
      soft,
    };
  });
});

/** The bar the song loops back to (the first verse). */
export const LOOP_START = SECTIONS.intro.chords.split(" ").length;

function barAt(position) {
  const index = Math.floor(position / STEPS_PER_BAR);
  if (index < BARS.length) return BARS[index];
  return BARS[LOOP_START + ((index - LOOP_START) % (BARS.length - LOOP_START))];
}

/** Everything that starts on one 16th of the song (positions run on forever; the song loops). */
export function eventsAt(position) {
  const bar = barAt(position);
  const step = position % STEPS_PER_BAR;
  const chord = chordNotes(bar.chord);
  const events = [];
  if (step === 0 && bar.first && !bar.soft) events.push({ voice: "crash", vel: 1 });
  for (const voice of ["kick", "snare", "hat"]) {
    const hit = bar[voice][step];
    if (hit !== ".") events.push({ voice, vel: hit === "X" ? 1 : 0.6 });
  }
  const bass = bar.bass[step];
  if (bass === "L" || bass === "H") {
    let len = 1;
    while (bar.bass[step + len] === "-") len++;
    events.push({ voice: "bass", note: chord[0] - (bass === "L" ? 24 : 12), len, vel: 1 });
  }
  if (bar.arp) events.push({ voice: "arp", note: [...chord, chord[0] + 12][step % 4], vel: step % 4 ? 0.7 : 1 });
  for (const { step: start, note, len } of bar.lead) {
    if (start !== step) continue;
    events.push({ voice: "lead", note, len, vel: 1, soft: bar.soft });
    if (bar.double) events.push({ voice: "lead", note: note + 12, len, vel: 0.4, soft: bar.soft });
  }
  return events;
}

/** Plays the song through `destination`, scheduling a little ahead of the audio clock. */
export class Music {
  constructor(ctx, destination) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(destination);

    this.echo = ctx.createDelay(1);
    this.echo.delayTime.value = STEP_TIME * 3;
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 2400;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.3;
    const wet = ctx.createGain();
    wet.gain.value = 0.35;
    this.echo.connect(tone).connect(feedback).connect(this.echo);
    tone.connect(wet).connect(this.out);

    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    this.position = 0;
    this.nextTime = 0;
    this.timer = null;
    this.stopAt = null;
  }

  /** Plays on from the current position (or recovers from a fade-out in progress). */
  play() {
    const t = this.ctx.currentTime;
    this.stopAt = null;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setTargetAtTime(VOLUME, t, 0.03);
    if (this.timer) return;
    this.nextTime = t + 0.05;
    this.timer = setInterval(() => this.schedule(), 25);
    this.schedule();
  }

  /** Fades out over `fade` seconds, then stops scheduling. */
  stop(fade = 0.1) {
    if (!this.timer) return;
    const t = this.ctx.currentTime;
    if (this.stopAt !== null && this.stopAt <= t + fade) return;
    this.stopAt = t + fade;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setTargetAtTime(0, t, fade / 4);
  }

  rewind() {
    this.position = 0;
  }

  schedule() {
    const now = this.ctx.currentTime;
    if (this.nextTime < now) {
      // The page stalled: skip what was missed rather than play it all at once.
      const missed = Math.ceil((now - this.nextTime) / STEP_TIME);
      this.position += missed;
      this.nextTime += missed * STEP_TIME;
    }
    const until = Math.min(now + LOOKAHEAD, this.stopAt ?? Infinity);
    while (this.nextTime < until) {
      for (const event of eventsAt(this.position)) this.trigger(event, this.nextTime);
      this.position++;
      this.nextTime += STEP_TIME;
    }
    if (this.stopAt !== null && now >= this.stopAt) {
      clearInterval(this.timer);
      this.timer = null;
      this.stopAt = null;
    }
  }

  trigger(event, time) {
    const { voice, note, len, vel } = event;
    switch (voice) {
      case "kick":
        return this.kick(time, vel);
      case "snare":
        return this.snare(time, vel);
      case "hat":
        return this.hiss(time, 7000, 0.06 * vel, 0.04);
      case "crash":
        return this.hiss(time, 3500, 0.1, 1.4);
      case "bass":
        return this.pluck(time, { type: "sawtooth", note, dur: len * STEP_TIME * 0.85, level: 0.2, from: 1600, to: 320, q: 5 });
      case "arp":
        return this.pluck(time, { type: "square", note, dur: STEP_TIME * 0.55, level: 0.04 * vel, from: 2800, to: 1800, echo: 0.6 });
      default:
        return this.lead(time, note, len, vel, event.soft);
    }
  }

  send(node, amount) {
    const gain = this.ctx.createGain();
    gain.gain.value = amount;
    node.connect(gain).connect(this.echo);
  }

  kick(time, vel) {
    const { ctx } = this;
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(150, time);
    osc.frequency.exponentialRampToValueAtTime(45, time + 0.12);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.8 * vel, time);
    amp.gain.exponentialRampToValueAtTime(0.001, time + 0.3);
    osc.connect(amp).connect(this.out);
    osc.start(time);
    osc.stop(time + 0.3);
  }

  snare(time, vel) {
    this.hiss(time, 1500, 0.28 * vel, 0.16);
    const { ctx } = this;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(220, time);
    osc.frequency.exponentialRampToValueAtTime(160, time + 0.06);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.22 * vel, time);
    amp.gain.exponentialRampToValueAtTime(0.001, time + 0.08);
    osc.connect(amp).connect(this.out);
    osc.start(time);
    osc.stop(time + 0.08);
  }

  /** High-passed noise: hi-hats, cymbals and the snare's rattle. */
  hiss(time, cutoff, level, decay) {
    const { ctx } = this;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = cutoff;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(level, time);
    amp.gain.exponentialRampToValueAtTime(0.001, time + decay);
    src.connect(filter).connect(amp).connect(this.out);
    src.start(time, Math.random() * 0.9);
    src.stop(time + decay);
  }

  /** One oscillator through a low-pass that closes from `from` to `to` Hz: the bass and arpeggios. */
  pluck(time, { type, note, dur, level, from, to, q = 1, echo = 0 }) {
    const { ctx } = this;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = hz(note);
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = q;
    filter.frequency.setValueAtTime(from, time);
    filter.frequency.exponentialRampToValueAtTime(to, time + 0.15);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0, time);
    amp.gain.linearRampToValueAtTime(level, time + 0.004);
    amp.gain.setTargetAtTime(0, time + dur, 0.025);
    osc.connect(filter).connect(amp).connect(this.out);
    if (echo) this.send(amp, echo);
    osc.start(time);
    osc.stop(time + dur + 0.15);
  }

  /** Two detuned oscillators with vibrato on held notes; the bridge uses a softer voice. */
  lead(time, note, steps, vel, soft) {
    const { ctx } = this;
    const dur = steps * STEP_TIME * 0.92;
    const end = time + dur + 0.25;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0, time);
    amp.gain.linearRampToValueAtTime((soft ? 0.07 : 0.1) * vel, time + (soft ? 0.05 : 0.01));
    amp.gain.setTargetAtTime(0, time + dur, 0.04);
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = soft ? 1600 : 3000;
    filter.Q.value = 2;
    filter.connect(amp).connect(this.out);
    this.send(amp, 0.5);

    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5.5;
    const depth = ctx.createGain();
    depth.gain.setValueAtTime(0, time);
    depth.gain.linearRampToValueAtTime(dur > 0.3 ? 14 : 0, time + Math.min(dur, 0.4)); // cents
    lfo.connect(depth);
    for (const [type, detune] of [
      ["sawtooth", -6],
      [soft ? "triangle" : "square", 6],
    ]) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = hz(note);
      osc.detune.value = detune;
      depth.connect(osc.detune);
      osc.connect(filter);
      osc.start(time);
      osc.stop(end);
    }
    lfo.start(time);
    lfo.stop(end);
  }
}
