// Tiny WebAudio synth: engine drone, contact thumps and start beeps.

const STORAGE_KEY = "lunagp.muted";

export class Sound {
  constructor() {
    this.ctx = null;
    this.muted = localStorage.getItem(STORAGE_KEY) === "1";
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
    this.filter.frequency.value = 700;
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
  }

  engine(speedPct, nitro, active) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const f = 50 + speedPct * 175 + (nitro ? 45 : 0);
    this.osc1.frequency.setTargetAtTime(f, t, 0.06);
    this.osc2.frequency.setTargetAtTime(f * 0.5, t, 0.06);
    this.filter.frequency.setTargetAtTime(500 + speedPct * 1700 + (nitro ? 900 : 0), t, 0.1);
    this.engineGain.gain.setTargetAtTime(active ? 0.05 + speedPct * 0.07 : 0, t, 0.12);
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
}
