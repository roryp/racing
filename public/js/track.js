// Segment-based circuit (classic pseudo-3D technique): each segment carries a
// curvature and an elevation; the renderer projects them back-to-front.

import { M_PER_UNIT, RUMBLE_LENGTH, SEGMENT_LENGTH } from "./config.js";

export const SPRITE_TYPES = {
  pine: { width: 1000, solid: 0.3 },
  oak: { width: 1300, solid: 0.3 },
  bush: { width: 700, solid: 0 },
  lamp: { width: 380, solid: 0.45 },
  billboard_luna: { width: 2000, solid: 0.9 },
  billboard_decisions: { width: 2000, solid: 0.9 },
  billboard_luna6: { width: 2000, solid: 0.9 },
  billboard_types: { width: 2000, solid: 0.9 },
  billboard_brake: { width: 1500, solid: 0.9 },
  gantry: { width: 5600, solid: 0, center: true },
};

const LEN = { SHORT: 25, MEDIUM: 50, LONG: 100 };
const CURVE = { EASY: 2, MEDIUM: 4, HARD: 6 };
const HILL = { LOW: 20, MEDIUM: 40, HIGH: 60 };

const easeIn = (a, b, p) => a + (b - a) * p * p;
const easeInOut = (a, b, p) => a + (b - a) * (-Math.cos(p * Math.PI) / 2 + 0.5);

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Track {
  constructor() {
    this.segments = [];
    this.build();
    this.length = this.segments.length * SEGMENT_LENGTH;
    this.decorate();
    this.minimap = this.buildMinimap();
  }

  // ---- construction --------------------------------------------------------

  lastY() {
    const n = this.segments.length;
    return n === 0 ? 0 : this.segments[n - 1].p2.world.y;
  }

  addSegment(curve, y) {
    const n = this.segments.length;
    this.segments.push({
      index: n,
      p1: { world: { x: 0, y: this.lastY(), z: n * SEGMENT_LENGTH }, camera: {}, screen: {} },
      p2: { world: { x: 0, y, z: (n + 1) * SEGMENT_LENGTH }, camera: {}, screen: {} },
      curve,
      sprites: [],
      cars: [],
      dark: Math.floor(n / RUMBLE_LENGTH) % 2 === 1,
      start: n < 2,
      clip: 0,
      fog: 0,
      looped: false,
    });
  }

  addRoad(enter, hold, leave, curve, hill = 0) {
    const startY = this.lastY();
    const endY = startY + hill * SEGMENT_LENGTH;
    const total = enter + hold + leave;
    for (let n = 0; n < enter; n++) this.addSegment(easeIn(0, curve, n / enter), easeInOut(startY, endY, n / total));
    for (let n = 0; n < hold; n++) this.addSegment(curve, easeInOut(startY, endY, (enter + n) / total));
    for (let n = 0; n < leave; n++) {
      this.addSegment(easeInOut(curve, 0, n / leave), easeInOut(startY, endY, (enter + hold + n) / total));
    }
  }

  addStraight(num = LEN.MEDIUM, hill = 0) {
    this.addRoad(num, num, num, 0, hill);
  }

  addSCurves() {
    this.addRoad(LEN.SHORT, LEN.MEDIUM, LEN.SHORT, -CURVE.MEDIUM, 0);
    this.addRoad(LEN.SHORT, LEN.MEDIUM, LEN.SHORT, CURVE.MEDIUM, HILL.LOW);
    this.addRoad(LEN.SHORT, LEN.MEDIUM, LEN.SHORT, -CURVE.EASY, -HILL.LOW);
  }

  addRollingHills() {
    this.addRoad(LEN.SHORT, LEN.SHORT, LEN.SHORT, 0, HILL.LOW / 2);
    this.addRoad(LEN.SHORT, LEN.SHORT, LEN.SHORT, 0, -HILL.LOW);
    this.addRoad(LEN.SHORT, LEN.SHORT, LEN.SHORT, CURVE.EASY, HILL.LOW);
    this.addRoad(LEN.SHORT, LEN.SHORT, LEN.SHORT, 0, 0);
    this.addRoad(LEN.SHORT, LEN.SHORT, LEN.SHORT, -CURVE.EASY, HILL.LOW / 2);
  }

  addBumps() {
    for (const h of [5, -2, -5, 8, 5, -7, 5, -2]) this.addRoad(10, 10, 10, 0, h);
  }

  build() {
    this.addRoad(LEN.MEDIUM, LEN.MEDIUM, LEN.MEDIUM, 0, 0); // start/finish straight
    this.addRoad(LEN.MEDIUM, LEN.MEDIUM, LEN.MEDIUM, CURVE.MEDIUM, HILL.LOW); // T1
    this.addRoad(LEN.SHORT, LEN.MEDIUM, LEN.SHORT, -CURVE.EASY, HILL.MEDIUM);
    this.addRoad(LEN.MEDIUM, LEN.SHORT, LEN.MEDIUM, CURVE.HARD, -HILL.MEDIUM); // downhill hairpin
    this.addSCurves();
    this.addStraight(LEN.SHORT);
    this.addRollingHills();
    this.addRoad(LEN.MEDIUM, LEN.LONG, LEN.MEDIUM, CURVE.MEDIUM, 0); // long sweeper
    this.addRoad(LEN.SHORT, LEN.MEDIUM, LEN.SHORT, -CURVE.MEDIUM, HILL.HIGH); // climbing left
    this.addStraight(LEN.SHORT, -HILL.LOW);
    this.addRoad(LEN.MEDIUM, LEN.MEDIUM, LEN.MEDIUM, CURVE.HARD, -HILL.MEDIUM); // plunging right
    this.addBumps();
    this.addRoad(LEN.MEDIUM, LEN.MEDIUM, LEN.MEDIUM, -CURVE.EASY, HILL.LOW);
    this.addRoad(LEN.MEDIUM, LEN.MEDIUM, LEN.LONG, CURVE.MEDIUM, 0); // long right onto the back straight
    this.addRoad(LEN.MEDIUM, LEN.MEDIUM, LEN.MEDIUM, 0, -this.lastY() / SEGMENT_LENGTH); // back to sea level
    this.addRoad(LEN.MEDIUM, LEN.MEDIUM, LEN.MEDIUM, 0, 0); // grid straight
    const last = this.segments[this.segments.length - 1];
    last.p2.world.y = 0;
  }

  decorate() {
    const rand = mulberry32(1337);
    const N = this.segments.length;
    const add = (index, kind, offset) => this.segments[((index % N) + N) % N].sprites.push({ kind, offset });

    add(1, "gantry", 0);
    for (let n = 6; n < 150; n += 12) {
      add(n, "lamp", -1.15);
      add(n, "lamp", 1.15);
    }
    for (let n = N - 150; n < N; n += 12) {
      add(n, "lamp", -1.15);
      add(n, "lamp", 1.15);
    }

    // Billboards, with brake warnings before the hardest corners.
    const boards = ["billboard_luna", "billboard_decisions", "billboard_luna6", "billboard_types"];
    for (let i = 0, n = 40; n < N - 60; n += 260, i++) {
      add(n, boards[i % boards.length], i % 2 ? 1.3 : -1.3);
    }
    let previous = 0;
    for (const seg of this.segments) {
      if (Math.abs(seg.curve) >= 5 && Math.abs(previous) < 5) {
        add(seg.index - 70, "billboard_brake", seg.curve > 0 ? -1.25 : 1.25);
        add(seg.index - 45, "billboard_brake", seg.curve > 0 ? -1.25 : 1.25);
      }
      previous = seg.curve;
    }

    // Forest & shrubs, denser away from the start straight.
    for (let n = 160; n < N - 160; n += 3) {
      if (rand() < 0.55) {
        const side = rand() < 0.5 ? -1 : 1;
        add(n, rand() < 0.6 ? "pine" : "oak", side * (1.6 + rand() * 5));
      }
      if (rand() < 0.18) {
        const side = rand() < 0.5 ? -1 : 1;
        add(n, "bush", side * (1.2 + rand() * 0.6));
      }
    }
  }

  buildMinimap() {
    const total = this.segments.reduce((sum, s) => sum + s.curve, 0);
    const k = (2 * Math.PI) / total; // scale curvature so the circuit turns exactly once
    const points = [];
    let heading = 0;
    let x = 0;
    let y = 0;
    for (const seg of this.segments) {
      points.push({ x, y });
      heading += seg.curve * k;
      x += Math.sin(heading);
      y -= Math.cos(heading);
    }
    const n = points.length;
    points.forEach((p, i) => {
      p.x -= (x * i) / n;
      p.y -= (y * i) / n;
    });
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const span = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY);
    return points.map((p) => ({ x: (p.x - minX) / span, y: (p.y - minY) / span }));
  }

  // ---- queries -------------------------------------------------------------

  wrap(z) {
    return ((z % this.length) + this.length) % this.length;
  }

  findSegment(z) {
    return this.segments[Math.floor(this.wrap(z) / SEGMENT_LENGTH) % this.segments.length];
  }

  heightAt(z) {
    const seg = this.findSegment(z);
    const p = (this.wrap(z) % SEGMENT_LENGTH) / SEGMENT_LENGTH;
    return seg.p1.world.y + (seg.p2.world.y - seg.p1.world.y) * p;
  }

  /** Largest |curve| within the next `count` segments. */
  maxCurveAhead(z, count) {
    const start = this.findSegment(z).index;
    let max = 0;
    for (let i = 0; i < count; i++) {
      max = Math.max(max, Math.abs(this.segments[(start + i) % this.segments.length].curve));
    }
    return max;
  }

  /** Average signed curve within the next `count` segments (positive = right-hander). */
  avgCurveAhead(z, count) {
    const start = this.findSegment(z).index;
    let sum = 0;
    for (let i = 0; i < count; i++) sum += this.segments[(start + i) % this.segments.length].curve;
    return sum / count;
  }

  /** Summarize the next `meters` of road as straights and corners for the AI prompt. */
  describeAhead(z, meters = 320) {
    const segM = SEGMENT_LENGTH * M_PER_UNIT;
    const count = Math.round(meters / segM);
    const start = this.findSegment(z).index;
    const features = [];
    let current = null;
    for (let i = 0; i < count; i++) {
      const seg = this.segments[(start + i) % this.segments.length];
      const kind = Math.abs(seg.curve) < 1 ? "straight" : "curve";
      const key = kind === "straight" ? kind : `curve-${seg.curve > 0 ? "right" : "left"}`;
      if (!current || current.key !== key) {
        current = { key, kind, dir: seg.curve > 0 ? "right" : "left", maxCurve: 0, inM: i * segM, lengthM: 0 };
        features.push(current);
      }
      current.lengthM += segM;
      current.maxCurve = Math.max(current.maxCurve, Math.abs(seg.curve));
    }
    return features.slice(0, 3).map((f) => {
      const out = { kind: f.kind, inM: Math.round(f.inM), lengthM: Math.round(f.lengthM) };
      if (f.kind === "curve") {
        out.dir = f.dir;
        out.severity = f.maxCurve >= 5 ? "sharp" : f.maxCurve >= 3 ? "medium" : "gentle";
      }
      return out;
    });
  }

  /** Classify the elevation over the next ~200 m. */
  elevationAhead(z) {
    const unitsPerM = 1 / M_PER_UNIT;
    const h0 = this.heightAt(z);
    const h1 = this.heightAt(z + 100 * unitsPerM);
    const h2 = this.heightAt(z + 200 * unitsPerM);
    const d1 = h1 - h0;
    const d2 = h2 - h1;
    const t = SEGMENT_LENGTH * 6;
    if (d1 > t && d2 < -t) return "crest";
    if (d1 < -t && d2 > t) return "dip";
    if (d1 + d2 > t) return "uphill";
    if (d1 + d2 < -t) return "downhill";
    return "flat";
  }
}
