// Pseudo-3D renderer: projects road segments front-to-back (clipping behind
// hills), then draws sprites and cars back-to-front.

import {
  CAMERA_DEPTH,
  CAMERA_HEIGHT,
  CAR_WIDTH,
  COLORS,
  DRAW_DISTANCE,
  FOG_DENSITY,
  HEIGHT,
  LANES,
  M_PER_UNIT,
  MANEUVERS,
  MAX_SPEED,
  PLAYER_Z,
  ROAD_WIDTH,
  SEGMENT_LENGTH,
  WIDTH,
} from "./config.js";
import { CAR_POINTS } from "./art.js";
import { SPRITE_TYPES } from "./track.js";

const HALF_W = WIDTH / 2;
const HALF_H = HEIGHT / 2;
const FOG_LEVELS = 32;

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a, b, t) {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return `rgb(${ca.map((v, i) => Math.round(v + (cb[i] - v) * t)).join(",")})`;
}

function buildPalette(colors) {
  return Array.from({ length: FOG_LEVELS }, (_, level) => {
    const t = level / (FOG_LEVELS - 1);
    const out = {};
    for (const [key, value] of Object.entries(colors)) out[key] = value ? mix(value, COLORS.fog, t) : null;
    return out;
  });
}

function project(p, camX, camY, camZ) {
  p.camera.x = p.world.x - camX;
  p.camera.y = p.world.y - camY;
  p.camera.z = p.world.z - camZ;
  p.screen.scale = CAMERA_DEPTH / p.camera.z;
  p.screen.x = Math.round(HALF_W + p.screen.scale * p.camera.x * HALF_W);
  p.screen.y = Math.round(HALF_H - p.screen.scale * p.camera.y * HALF_H);
  p.screen.w = Math.round(p.screen.scale * ROAD_WIDTH * HALF_W);
}

const lerp = (a, b, t) => a + (b - a) * t;

export class Renderer {
  constructor(canvas, track, art) {
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.track = track;
    this.art = art;
    this.palettes = { light: buildPalette(COLORS.light), dark: buildPalette(COLORS.dark) };
    this.carSegments = [];
  }

  /**
   * @param {object} view
   * @param {number} view.position camera z (world units)
   * @param {object} view.player player car
   * @param {object[]} view.rivals rival cars
   * @param {object} view.parallax background offsets
   * @param {number} view.time seconds, for animation
   * @param {number} view.shake screen shake in px
   * @param {boolean} view.labels draw AI maneuver tags above rivals
   */
  render(view) {
    const { ctx, track } = this;
    const segments = track.segments;
    const N = segments.length;
    const position = track.wrap(view.position);
    const base = track.findSegment(position);
    const basePercent = (position % SEGMENT_LENGTH) / SEGMENT_LENGTH;
    const playerZ = track.wrap(position + PLAYER_Z);
    const playerSeg = track.findSegment(playerZ);
    const playerPercent = (playerZ % SEGMENT_LENGTH) / SEGMENT_LENGTH;
    const playerY = lerp(playerSeg.p1.world.y, playerSeg.p2.world.y, playerPercent);
    const playerX = view.player.offset;

    ctx.save();
    if (view.shake > 0.2) {
      ctx.translate((Math.random() - 0.5) * view.shake, (Math.random() - 0.5) * view.shake);
    }
    this.drawBackground(view.parallax, playerY);

    for (const seg of this.carSegments) seg.cars.length = 0;
    this.carSegments.length = 0;
    for (const car of view.rivals) {
      const seg = track.findSegment(car.progress);
      seg.cars.push(car);
      this.carSegments.push(seg);
    }

    let maxy = HEIGHT;
    let x = 0;
    let dx = -(base.curve * basePercent);
    for (let n = 0; n < DRAW_DISTANCE; n++) {
      const seg = segments[(base.index + n) % N];
      seg.looped = seg.index < base.index;
      seg.fog = 1 - Math.exp(-((n / DRAW_DISTANCE) ** 2) * FOG_DENSITY);
      seg.clip = maxy;
      const camZ = position - (seg.looped ? track.length : 0);
      project(seg.p1, playerX * ROAD_WIDTH - x, playerY + CAMERA_HEIGHT, camZ);
      project(seg.p2, playerX * ROAD_WIDTH - x - dx, playerY + CAMERA_HEIGHT, camZ);
      x += dx;
      dx += seg.curve;
      if (seg.p1.camera.z <= CAMERA_DEPTH || seg.p2.screen.y >= seg.p1.screen.y || seg.p2.screen.y >= maxy) continue;
      this.drawSegment(seg, maxy);
      maxy = seg.p2.screen.y;
    }

    for (let n = DRAW_DISTANCE - 1; n > 0; n--) {
      const seg = segments[(base.index + n) % N];
      if (seg.p1.camera.z <= CAMERA_DEPTH) continue;
      for (const sprite of seg.sprites) this.drawRoadsideSprite(seg, sprite);
      if (seg === playerSeg) {
        const ahead = seg.cars.filter((c) => (track.wrap(c.progress) % SEGMENT_LENGTH) / SEGMENT_LENGTH > playerPercent);
        for (const car of ahead) this.drawRival(seg, car, view);
        this.drawPlayer(view);
        for (const car of seg.cars) if (!ahead.includes(car)) this.drawRival(seg, car, view);
      } else {
        for (const car of seg.cars) this.drawRival(seg, car, view);
      }
    }

    if (view.player.nitroTime > 0) this.drawSpeedLines(view.time);
    this.drawProximity(view);
    ctx.restore();
  }

  drawBackground(parallax, playerY) {
    const { ctx } = this;
    const bg = this.art.background;
    ctx.drawImage(bg.sky, 0, 0);
    this.drawLayer(bg.mountains, parallax.mountains, HALF_H - 270 + playerY * 0.0015);
    this.drawLayer(bg.hills, parallax.hills, HALF_H - 235 + playerY * 0.0025);
    const treesY = HALF_H - 228 + playerY * 0.0035;
    this.drawLayer(bg.trees, parallax.trees, treesY);
    ctx.fillStyle = "#0b1320";
    ctx.fillRect(0, treesY + bg.trees.height - 1, WIDTH, HEIGHT);
  }

  drawLayer(img, offset, y) {
    const w = img.width;
    let srcX = Math.floor((((offset % 1) + 1) % 1) * w);
    let destX = 0;
    while (destX < WIDTH) {
      const chunk = Math.min(w - srcX, WIDTH - destX);
      this.ctx.drawImage(img, srcX, 0, chunk, img.height, destX, y, chunk, img.height);
      destX += chunk;
      srcX = 0;
    }
  }

  polygon(x1, y1, x2, y2, x3, y3, x4, y4, color) {
    const { ctx } = this;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineTo(x3, y3);
    ctx.lineTo(x4, y4);
    ctx.closePath();
    ctx.fill();
  }

  drawSegment(seg, maxy) {
    let { x: x1, y: y1, w: w1 } = seg.p1.screen;
    const { x: x2, y: y2, w: w2 } = seg.p2.screen;
    if (y1 > maxy) {
      // Partly hidden behind a nearer crest: cut the trapezoid at the clip line.
      const t = (y1 - maxy) / (y1 - y2);
      x1 += (x2 - x1) * t;
      w1 += (w2 - w1) * t;
      y1 = maxy;
    }
    const level = Math.min(FOG_LEVELS - 1, Math.round(seg.fog * (FOG_LEVELS - 1)));
    const pal = (seg.dark ? this.palettes.dark : this.palettes.light)[level];

    this.ctx.fillStyle = pal.grass;
    this.ctx.fillRect(0, y2, WIDTH, y1 - y2);

    const r1 = w1 / 7;
    const r2 = w2 / 7;
    this.polygon(x1 - w1 - r1, y1, x1 - w1, y1, x2 - w2, y2, x2 - w2 - r2, y2, pal.rumble);
    this.polygon(x1 + w1 + r1, y1, x1 + w1, y1, x2 + w2, y2, x2 + w2 + r2, y2, pal.rumble);

    if (seg.start) {
      const cols = 14;
      for (let i = 0; i < cols; i++) {
        const a = -1 + (2 * i) / cols;
        const b = -1 + (2 * (i + 1)) / cols;
        const white = (i + seg.index) % 2 === 0;
        this.polygon(
          x1 + w1 * a, y1, x1 + w1 * b, y1, x2 + w2 * b, y2, x2 + w2 * a, y2,
          white ? mix("#f4f4f4", COLORS.fog, seg.fog) : mix("#16161a", COLORS.fog, seg.fog),
        );
      }
      return;
    }

    this.polygon(x1 - w1, y1, x1 + w1, y1, x2 + w2, y2, x2 - w2, y2, pal.road);
    if (pal.lane) {
      const l1 = w1 / 32;
      const l2 = w2 / 32;
      const lw1 = (w1 * 2) / LANES;
      const lw2 = (w2 * 2) / LANES;
      for (let lane = 1; lane < LANES; lane++) {
        const lx1 = x1 - w1 + lw1 * lane;
        const lx2 = x2 - w2 + lw2 * lane;
        this.polygon(lx1 - l1 / 2, y1, lx1 + l1 / 2, y1, lx2 + l2 / 2, y2, lx2 - l2 / 2, y2, pal.lane);
      }
    }
  }

  /** Draw an image anchored at (x, y); returns the destination rect or null when fully clipped. */
  drawImage(img, worldWidth, scale, x, y, offsetX, offsetY, clipY) {
    const destW = worldWidth * scale * HALF_W;
    if (destW < 1 || destW > WIDTH * 4) return null;
    const destH = (destW * img.height) / img.width;
    const dx = x + destW * offsetX;
    const dy = y + destH * offsetY;
    const clipH = clipY ? Math.max(0, dy + destH - clipY) : 0;
    if (clipH >= destH) return null;
    this.ctx.drawImage(img, 0, 0, img.width, img.height * (1 - clipH / destH), dx, dy, destW, destH - clipH);
    return { x: dx, y: dy, w: destW, h: destH, clipped: clipH > 0 };
  }

  drawRoadsideSprite(seg, sprite) {
    const type = SPRITE_TYPES[sprite.kind];
    const img = this.art.sprites[sprite.kind];
    const scale = seg.p1.screen.scale;
    const x = seg.p1.screen.x + scale * sprite.offset * ROAD_WIDTH * HALF_W;
    const offsetX = type.center ? -0.5 : sprite.offset < 0 ? -1 : 0;
    this.drawImage(img, type.width, scale, x, seg.p1.screen.y, offsetX, -1, seg.clip);
  }

  drawRival(seg, car, view) {
    const percent = (this.track.wrap(car.progress) % SEGMENT_LENGTH) / SEGMENT_LENGTH;
    const scale = lerp(seg.p1.screen.scale, seg.p2.screen.scale, percent);
    if (!(scale > 0)) return;
    const x = lerp(seg.p1.screen.x, seg.p2.screen.x, percent) + scale * car.offset * ROAD_WIDTH * HALF_W;
    const y = lerp(seg.p1.screen.y, seg.p2.screen.y, percent);
    const set = this.art.cars[car.id];
    const img = car.steer < 0 ? set.left : car.steer > 0 ? set.right : set.straight;
    const rect = this.drawImage(img, CAR_WIDTH, scale, x, y, -0.5, -1, seg.clip);
    if (!rect || rect.clipped) return;
    this.drawCarEffects(rect, car, view.time);
    if (view.labels && rect.w > 34) this.drawTag(rect, car);
  }

  drawPlayer(view) {
    const car = view.player;
    const scale = CAMERA_DEPTH / PLAYER_Z;
    const speedPct = car.speed / MAX_SPEED;
    const bounce = Math.sin(view.time * 31) * speedPct * 1.5 + (Math.abs(car.offset) > 1 ? (Math.random() - 0.5) * 6 * speedPct : 0);
    const set = this.art.cars.player;
    const img = view.steer < 0 ? set.left : view.steer > 0 ? set.right : set.straight;
    const rect = this.drawImage(img, CAR_WIDTH, scale, HALF_W, HEIGHT - 6 + bounce, -0.5, -1, 0);
    if (rect) this.drawCarEffects(rect, car, view.time);
  }

  drawCarEffects(rect, car, time) {
    const { ctx } = this;
    if (car.braking) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (const t of CAR_POINTS.tailLights) {
        const cx = rect.x + t.x * rect.w;
        const cy = rect.y + t.y * rect.h;
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, t.w * rect.w * 0.9);
        g.addColorStop(0, "rgba(255,60,60,0.9)");
        g.addColorStop(1, "rgba(255,0,0,0)");
        ctx.fillStyle = g;
        ctx.fillRect(cx - t.w * rect.w, cy - t.w * rect.w, t.w * rect.w * 2, t.w * rect.w * 2);
      }
      ctx.restore();
    }
    if (car.nitroTime > 0) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (const e of CAR_POINTS.exhausts) {
        const cx = rect.x + e.x * rect.w;
        const cy = rect.y + e.y * rect.h;
        const len = rect.w * (0.16 + 0.06 * Math.sin(time * 60 + e.x * 10));
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy + len * 0.2, len);
        g.addColorStop(0, "rgba(220,240,255,0.95)");
        g.addColorStop(0.3, "rgba(80,160,255,0.8)");
        g.addColorStop(0.7, "rgba(255,120,40,0.45)");
        g.addColorStop(1, "rgba(255,80,0,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(cx, cy + len * 0.15, len * 0.35, len * 0.55, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  drawTag(rect, car) {
    const { ctx } = this;
    const maneuver = MANEUVERS[car.brain?.maneuver] ?? null;
    const text = `${car.name.toUpperCase()}${maneuver ? ` · ${maneuver.tag}` : ""}${car.nitroTime > 0 ? " ⚡" : ""}`;
    const size = Math.max(10, Math.min(16, rect.w * 0.1));
    ctx.save();
    ctx.font = `800 ${size}px system-ui, "Segoe UI", sans-serif`;
    const tw = ctx.measureText(text).width;
    const px = rect.x + rect.w / 2 - tw / 2 - 7;
    const py = rect.y - size - 14;
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = "rgba(10,10,28,0.78)";
    ctx.beginPath();
    ctx.roundRect(px, py, tw + 14, size + 8, 6);
    ctx.fill();
    ctx.strokeStyle = car.color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = maneuver ? maneuver.color : "#ffffff";
    ctx.textBaseline = "middle";
    ctx.fillText(text, px + 7, py + (size + 8) / 2 + 1);
    ctx.restore();
  }

  drawSpeedLines(time) {
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = "rgba(200,230,255,0.22)";
    ctx.lineWidth = 2;
    const seed = Math.floor(time * 30);
    for (let i = 0; i < 28; i++) {
      const a = ((i * 137.5 + seed * 17) % 360) * (Math.PI / 180);
      const r0 = 260 + ((i * 53 + seed * 29) % 120);
      const r1 = r0 + 140;
      ctx.beginPath();
      ctx.moveTo(HALF_W + Math.cos(a) * r0, HALF_H + Math.sin(a) * r0 * 0.6);
      ctx.lineTo(HALF_W + Math.cos(a) * r1, HALF_H + Math.sin(a) * r1 * 0.6);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Chevrons at the bottom of the screen for rivals right behind the player. */
  drawProximity(view) {
    const { ctx, track } = this;
    const half = track.length / 2;
    for (const car of view.rivals) {
      let dz = car.progress - view.player.progress;
      dz = ((dz % track.length) + track.length) % track.length;
      if (dz > half) dz -= track.length;
      const meters = -dz * M_PER_UNIT;
      if (meters <= 0 || meters > 22) continue;
      const side = Math.max(-1, Math.min(1, (car.offset - view.player.offset) / 0.5));
      const cx = HALF_W + side * 250;
      const alpha = 0.35 + 0.6 * (1 - meters / 22);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = car.color;
      ctx.beginPath();
      ctx.moveTo(cx, HEIGHT - 44);
      ctx.lineTo(cx + 18, HEIGHT - 22);
      ctx.lineTo(cx - 18, HEIGHT - 22);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }
}
