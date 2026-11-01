// Tiny WebAudio synth: engine, contact thumps and start beeps, plus the background music
// (composed and played in music.js).

import { ACCEL, MAX_SPEED, STEP } from "./config.js";
import { Music } from "./music.js";

const STORAGE_KEY = "lunagp.muted";
const MUSIC_KEY = "lunagp.music";

const FULL_THROTTLE = ACCEL / MAX_SPEED; // fraction of top speed gained per second, flat out
// Top of each gear as a fraction of MAX_SPEED. Top gear is long, so cruising sits mid-rev
// and nitro pushes it towards the redline.
const GEARS = [0.18, 0.34, 0.52, 0.72, 1.25];
const DOWNSHIFT_GAP = 0.05; // hysteresis, so hovering around a shift point doesn't flutter
const IDLE_RPM = 0.28;

/**
 * The engine's voice: speed picks the gear and rpm, and the volume follows how hard the
 * engine is pulling. It roars while you accelerate or fire nitro and settles to a lower
 * hum at a steady speed, instead of droning at full volume all race.
 */
export class EngineModel {
  constructor() {
    this.reset();
  }

  reset() {
    this.gear = 0;
    this.load = 0;
    this.lift = 0;
    this.lastSpeed = null;
  }

  update(speedPct, nitro, dt = STEP) {
    const speed = Math.max(0, speedPct);
    const pull = this.lastSpeed === null ? 0 : (speed - this.lastSpeed) / dt / FULL_THROTTLE;
    this.lastSpeed = speed;
    const target = nitro ? 1 : Math.min(1, Math.max(0, pull));
    // Revs up within ~0.1 s, fades back to the hum over ~2 s.
    this.load += (target - this.load) * (1 - Math.exp(-dt / (target > this.load ? 0.08 : 0.9)));

    const gear = this.gear;
    while (this.gear < GEARS.length - 1 && speed > GEARS[this.gear]) this.gear++;
    while (this.gear > 0 && speed < GEARS[this.gear - 1] - DOWNSHIFT_GAP) this.gear--;
    this.lift = this.gear > gear ? 0.09 : Math.max(0, this.lift - dt); // dip the volume on an upshift

    const rpm = Math.max(IDLE_RPM, speed / GEARS[this.gear]);
    const gain = 0.03 + 0.026 * Math.min(1, speed) + 0.1 * this.load;
    return {
      freq: 48 + rpm * 170,
      cutoff: 450 + rpm * 700 + this.load * 1100 + (nitro ? 600 : 0),
      gain: this.lift > 0 ? gain * 0.4 : gain,
    };
  }
}

export class Sound {
  constructor() {
    this.ctx = null;
    this.muted = localStorage.getItem(STORAGE_KEY) === "1";
    this.musicOn = localStorage.getItem(MUSIC_KEY) !== "0";
    this.musicState = "stopped"; // stopped | playing | paused: follows the race
    this.voice = new EngineModel();
  }

  /** Must be called from a user gesture before audio can play. */
  ensure() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") this.ctx.resume();
      return;
    }
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = (this.ctx = new AudioCtx());
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.55;
    this.master.connect(ctx.destination);

    this.filter = ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = 500;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.filter.connect(this.engineGain).connect(this.master);

    this.osc1 = ctx.createOscillator();
    this.osc1.type = "sawtooth";
    this.osc2 = ctx.createOscillator();
    this.osc2.type = "square";
    const sub = ctx.createGain();
    sub.gain.value = 0.35;
    this.osc1.connect(this.filter);
    this.osc2.connect(sub).connect(this.filter);
    this.osc1.start();
    this.osc2.start();

    const length = ctx.sampleRate * 0.4;
    this.noise = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;

    this.music = new Music(ctx, this.master);
  }

  engine(speedPct, nitro, active, dt) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (!active) {
      this.voice.reset();
      this.engineGain.gain.setTargetAtTime(0, t, 0.12);
      return;
    }
    const { freq, cutoff, gain } = this.voice.update(speedPct, nitro, dt);
    this.osc1.frequency.setTargetAtTime(freq, t, 0.04);
    this.osc2.frequency.setTargetAtTime(freq * 0.5, t, 0.04);
    this.filter.frequency.setTargetAtTime(cutoff, t, 0.08);
    this.engineGain.gain.setTargetAtTime(gain, t, 0.05);
  }

  bump(intensity = 1) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const band = this.ctx.createBiquadFilter();
    band.type = "lowpass";
    band.frequency.value = 380;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.5 * Math.min(1, intensity), t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    src.connect(band).connect(gain).connect(this.master);
    src.start(t);
    src.stop(t + 0.4);
  }

  beep(freq = 440, duration = 0.18) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.18, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  setMuted(muted) {
    this.muted = muted;
    localStorage.setItem(STORAGE_KEY, muted ? "1" : "0");
    if (this.master) this.master.gain.value = muted ? 0 : 0.55;
  }

  // The music follows the race: it starts at the green light, pauses with the game and fades
  // out at the finish. Players can switch it off and keep the other sounds.

  playMusic() {
    this.musicState = "playing";
    this.music?.rewind();
    this.syncMusic();
  }

  pauseMusic() {
    if (this.musicState === "playing") this.musicState = "paused";
    this.syncMusic();
  }

  resumeMusic() {
    if (this.musicState === "paused") this.musicState = "playing";
    this.syncMusic();
  }

  stopMusic(fade) {
    this.musicState = "stopped";
    this.syncMusic(fade);
  }

  setMusicOn(on) {
    this.musicOn = on;
    localStorage.setItem(MUSIC_KEY, on ? "1" : "0");
    this.syncMusic();
  }

  syncMusic(fade) {
    if (this.musicOn && this.musicState === "playing") this.music?.play();
    else this.music?.stop(fade);
  }
}
