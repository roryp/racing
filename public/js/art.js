// Procedurally drawn sprites and background layers (no image assets needed).

import { PLAYER, RIVALS, WIDTH, HEIGHT } from "./config.js";

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Lighten (amt > 0) or darken (amt < 0) a hex color. */
export function shade(hex, amt) {
  const target = amt < 0 ? 0 : 255;
  const p = Math.abs(amt);
  const [r, g, b] = rgb(hex).map((v) => Math.round((target - v) * p + v));
  return `rgb(${r},${g},${b})`;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Cars (rear view). Anchor points are exported so the renderer can add brake
// lights and nitro flames on top.

export const CAR_W = 300;
export const CAR_H = 170;
export const CAR_POINTS = {
  tailLights: [
    { x: 61 / CAR_W, y: 98 / CAR_H, w: 70 / CAR_W, h: 12 / CAR_H },
    { x: 239 / CAR_W, y: 98 / CAR_H, w: 70 / CAR_W, h: 12 / CAR_H },
  ],
  exhausts: [
    { x: 112 / CAR_W, y: 136 / CAR_H },
    { x: 188 / CAR_W, y: 136 / CAR_H },
  ],
};

function drawCar(color, accent, number, lean) {
  const c = makeCanvas(CAR_W, CAR_H);
  const ctx = c.getContext("2d");
  const s = lean * 12;

  // Shadow
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.beginPath();
  ctx.ellipse(150, 160, 150, 10, 0, 0, Math.PI * 2);
  ctx.fill();

  // Tyres
  for (const x of [10, 242]) {
    ctx.fillStyle = "#121216";
    roundRect(ctx, x, 106, 48, 58, 9);
    ctx.fill();
    ctx.fillStyle = "#24242b";
    for (let i = 0; i < 4; i++) ctx.fillRect(x + 8 + i * 10, 140, 4, 22);
  }

  // Diffuser
  ctx.fillStyle = "#1a1b21";
  roundRect(ctx, 40, 118, 220, 34, 6);
  ctx.fill();
  ctx.fillStyle = "#2b2d36";
  for (let x = 58; x < 250; x += 22) ctx.fillRect(x, 124, 5, 26);

  // Body
  const body = new Path2D();
  body.moveTo(8, 128);
  body.lineTo(6, 92);
  body.quadraticCurveTo(8 + s * 0.4, 72, 30 + s * 0.5, 70);
  body.lineTo(72 + s, 40);
  body.quadraticCurveTo(150 + s, 28, 228 + s, 40);
  body.lineTo(270 + s * 0.5, 70);
  body.quadraticCurveTo(292 + s * 0.4, 72, 294, 92);
  body.lineTo(292, 128);
  body.quadraticCurveTo(150, 138, 8, 128);
  body.closePath();
  const grad = ctx.createLinearGradient(0, 30, 0, 135);
  grad.addColorStop(0, shade(color, 0.35));
  grad.addColorStop(0.45, color);
  grad.addColorStop(1, shade(color, -0.45));
  ctx.fillStyle = grad;
  ctx.fill(body);

  // Livery stripes, clipped to the body
  ctx.save();
  ctx.clip(body);
  ctx.fillStyle = accent;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.moveTo(132 + s, 30);
  ctx.lineTo(144 + s, 30);
  ctx.lineTo(144, 140);
  ctx.lineTo(132, 140);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(156 + s, 30);
  ctx.lineTo(168 + s, 30);
  ctx.lineTo(168, 140);
  ctx.lineTo(156, 140);
  ctx.fill();
  ctx.restore();

  // Rear window
  ctx.beginPath();
  ctx.moveTo(82 + s, 46);
  ctx.lineTo(218 + s, 46);
  ctx.lineTo(242 + s * 0.8, 72);
  ctx.lineTo(58 + s * 0.8, 72);
  ctx.closePath();
  const glass = ctx.createLinearGradient(0, 46, 0, 72);
  glass.addColorStop(0, "#33405f");
  glass.addColorStop(1, "#0a0e1b");
  ctx.fillStyle = glass;
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.12)";
  ctx.beginPath();
  ctx.moveTo(100 + s, 46);
  ctx.lineTo(130 + s, 46);
  ctx.lineTo(108 + s * 0.8, 72);
  ctx.lineTo(78 + s * 0.8, 72);
  ctx.fill();

  // Roof highlight
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(80 + s, 39);
  ctx.quadraticCurveTo(150 + s, 29, 220 + s, 39);
  ctx.stroke();

  // Rear wing
  const wing = shade(color, -0.6);
  ctx.fillStyle = "#15161b";
  ctx.fillRect(100 + s * 0.3, 82, 6, 12);
  ctx.fillRect(194 + s * 0.3, 82, 6, 12);
  ctx.fillStyle = wing;
  roundRect(ctx, 12 + s * 0.5, 66, 10, 26, 3);
  ctx.fill();
  roundRect(ctx, 278 + s * 0.5, 66, 10, 26, 3);
  ctx.fill();
  roundRect(ctx, 14 + s * 0.5, 74, 272, 10, 3);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.18)";
  ctx.fillRect(16 + s * 0.5, 74, 268, 2);

  // Tail lights
  for (const x of [26, 204]) {
    ctx.fillStyle = "#5c0c14";
    roundRect(ctx, x, 92, 70, 13, 4);
    ctx.fill();
    ctx.fillStyle = "#ff3347";
    roundRect(ctx, x + 4, 95, 62, 6, 3);
    ctx.fill();
  }

  // Number plate
  ctx.fillStyle = "#f2f2f2";
  roundRect(ctx, 124, 105, 52, 18, 3);
  ctx.fill();
  ctx.fillStyle = "#111";
  ctx.font = "bold 15px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(number), 150, 115);

  // Exhausts
  for (const x of [112, 188]) {
    ctx.fillStyle = "#6a6d78";
    ctx.beginPath();
    ctx.arc(x, 136, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#0d0d10";
    ctx.beginPath();
    ctx.arc(x, 136, 5, 0, Math.PI * 2);
    ctx.fill();
  }
  return c;
}

function carSet(driver) {
  return {
    straight: drawCar(driver.color, driver.accent, driver.number, 0),
    left: drawCar(driver.color, driver.accent, driver.number, -1),
    right: drawCar(driver.color, driver.accent, driver.number, 1),
  };
}

// ---------------------------------------------------------------------------
// Roadside sprites

function drawPine() {
  const c = makeCanvas(260, 420);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#3d2618";
  ctx.fillRect(118, 330, 24, 90);
  const tiers = [
    [170, 20, 240, 360, "#173c2b"],
    [110, 35, 225, 285, "#1c4632"],
    [55, 50, 210, 210, "#205038"],
    [0, 70, 190, 135, "#255a3e"],
  ];
  for (const [apex, left, right, base, col] of tiers) {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(130, apex);
    ctx.lineTo(right, base);
    ctx.lineTo(left, base);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "rgba(255,170,150,0.12)";
    ctx.beginPath();
    ctx.moveTo(130, apex);
    ctx.lineTo(right, base);
    ctx.lineTo(150, base);
    ctx.closePath();
    ctx.fill();
  }
  return c;
}

function drawOak() {
  const c = makeCanvas(340, 380);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#3a281c";
  ctx.beginPath();
  ctx.moveTo(150, 380);
  ctx.lineTo(160, 230);
  ctx.lineTo(182, 230);
  ctx.lineTo(192, 380);
  ctx.fill();
  const blobs = [
    [110, 205, 78, "#1f4a30"],
    [232, 205, 78, "#1f4a30"],
    [170, 140, 95, "#24553a"],
    [172, 235, 86, "#225036"],
    [120, 130, 60, "#2a5f41"],
    [222, 125, 62, "#2a5f41"],
  ];
  for (const [x, y, r, col] of blobs) {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "rgba(255,170,150,0.1)";
  ctx.beginPath();
  ctx.arc(205, 115, 60, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

function drawBush() {
  const c = makeCanvas(220, 120);
  const ctx = c.getContext("2d");
  for (const [x, y, r, col] of [
    [60, 80, 45, "#24563a"],
    [150, 78, 50, "#24563a"],
    [105, 55, 52, "#2b6444"],
    [170, 90, 32, "#1f4a32"],
  ]) {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return c;
}

function drawLamp() {
  const c = makeCanvas(90, 540);
  const ctx = c.getContext("2d");
  const glow = ctx.createRadialGradient(45, 40, 2, 45, 40, 44);
  glow.addColorStop(0, "rgba(255,236,190,0.95)");
  glow.addColorStop(0.35, "rgba(255,210,140,0.45)");
  glow.addColorStop(1, "rgba(255,200,120,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 90, 90);
  ctx.fillStyle = "#2b2e38";
  ctx.fillRect(41, 46, 8, 494);
  ctx.fillStyle = "#3a3e4a";
  roundRect(ctx, 30, 30, 30, 16, 5);
  ctx.fill();
  ctx.fillStyle = "#fff2cc";
  ctx.fillRect(34, 44, 22, 4);
  ctx.fillStyle = "#1c1e25";
  ctx.fillRect(33, 520, 24, 20);
  return c;
}

function drawBillboard(lines, neon) {
  const c = makeCanvas(420, 300);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#30333d";
  ctx.fillRect(70, 200, 16, 100);
  ctx.fillRect(334, 200, 16, 100);
  const bg = ctx.createLinearGradient(0, 14, 0, 210);
  bg.addColorStop(0, "#1b1840");
  bg.addColorStop(1, "#0e0c24");
  ctx.fillStyle = bg;
  roundRect(ctx, 14, 14, 392, 192, 10);
  ctx.fill();
  ctx.save();
  ctx.shadowColor = neon;
  ctx.shadowBlur = 16;
  ctx.strokeStyle = neon;
  ctx.lineWidth = 5;
  roundRect(ctx, 20, 20, 380, 180, 8);
  ctx.stroke();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const { text, size, color, y } of lines) {
    ctx.fillStyle = color;
    ctx.font = `italic 900 ${size}px system-ui, "Segoe UI", sans-serif`;
    ctx.fillText(text, 210, y);
  }
  ctx.restore();
  return c;
}

function drawBrakeBoard() {
  const c = makeCanvas(320, 260);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#30333d";
  ctx.fillRect(60, 170, 14, 90);
  ctx.fillRect(246, 170, 14, 90);
  ctx.fillStyle = "#ffcc1f";
  roundRect(ctx, 10, 10, 300, 170, 8);
  ctx.fill();
  ctx.fillStyle = "#121212";
  roundRect(ctx, 20, 20, 280, 150, 6);
  ctx.fill();
  ctx.fillStyle = "#ffcc1f";
  ctx.font = "italic 900 64px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("BRAKE", 160, 98);
  return c;
}

function drawGantry() {
  const c = makeCanvas(1120, 520);
  const ctx = c.getContext("2d");
  const post = ctx.createLinearGradient(0, 0, 40, 0);
  post.addColorStop(0, "#3b3f4c");
  post.addColorStop(0.5, "#8a90a3");
  post.addColorStop(1, "#3b3f4c");
  for (const x of [20, 1060]) {
    ctx.save();
    ctx.translate(x, 0);
    ctx.fillStyle = post;
    ctx.fillRect(0, 60, 40, 460);
    ctx.restore();
  }
  ctx.fillStyle = "#14122c";
  ctx.fillRect(20, 40, 1080, 132);
  const sq = 22;
  for (let row = 0; row < 2; row++) {
    for (let x = 20, i = 0; x < 1100; x += sq, i++) {
      ctx.fillStyle = (i + row) % 2 ? "#f4f4f4" : "#111";
      ctx.fillRect(x, row === 0 ? 40 : 150, sq, 22);
    }
  }
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "#ffb347";
  ctx.shadowBlur = 18;
  ctx.fillStyle = "#ffd166";
  ctx.font = "italic 900 70px system-ui, sans-serif";
  ctx.fillText("LUNA GP", 560, 108);
  ctx.shadowColor = "#3dd6ff";
  ctx.fillStyle = "#bdf2ff";
  ctx.font = "italic 800 30px system-ui, sans-serif";
  ctx.fillText("START", 200, 108);
  ctx.fillText("FINISH", 920, 108);
  ctx.restore();
  return c;
}

// ---------------------------------------------------------------------------
// Background layers (tile horizontally)

function periodicRidge(width, rand, harmonics, roughness) {
  const terms = [];
  for (let k = 1; k <= harmonics; k++) {
    terms.push({ k, a: (rand() + 0.3) / Math.pow(k, roughness), phase: rand() * Math.PI * 2 });
  }
  const norm = terms.reduce((s, t) => s + t.a, 0);
  return (x) => terms.reduce((s, t) => s + t.a * Math.sin((2 * Math.PI * t.k * x) / width + t.phase), 0) / norm;
}

function drawSky() {
  const c = makeCanvas(WIDTH, HEIGHT);
  const ctx = c.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, 0, HEIGHT * 0.56);
  g.addColorStop(0, "#090a26");
  g.addColorStop(0.45, "#2c1a52");
  g.addColorStop(0.78, "#8a3a6c");
  g.addColorStop(1, "#ee8a66");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const rand = mulberry32(7);
  for (let i = 0; i < 160; i++) {
    const y = rand() * HEIGHT * 0.36;
    ctx.fillStyle = `rgba(255,255,255,${(0.15 + rand() * 0.6) * (1 - y / (HEIGHT * 0.4))})`;
    ctx.fillRect(rand() * WIDTH, y, rand() < 0.1 ? 2 : 1, rand() < 0.1 ? 2 : 1);
  }

  // The moon
  const mx = WIDTH * 0.76;
  const my = HEIGHT * 0.17;
  const halo = ctx.createRadialGradient(mx, my, 30, mx, my, 160);
  halo.addColorStop(0, "rgba(255,240,220,0.35)");
  halo.addColorStop(1, "rgba(255,240,220,0)");
  ctx.fillStyle = halo;
  ctx.fillRect(mx - 160, my - 160, 320, 320);
  ctx.fillStyle = "#fbf1e1";
  ctx.beginPath();
  ctx.arc(mx, my, 42, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(170,150,150,0.25)";
  for (const [dx, dy, r] of [
    [-12, -8, 9],
    [10, 6, 12],
    [-4, 18, 6],
    [16, -16, 5],
  ]) {
    ctx.beginPath();
    ctx.arc(mx + dx, my + dy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return c;
}

function drawRidgeLayer({ width, height, seed, harmonics, roughness, top, amplitude, colors, rim, trees }) {
  const c = makeCanvas(width, height);
  const ctx = c.getContext("2d");
  const ridge = periodicRidge(width, mulberry32(seed), harmonics, roughness);
  const path = new Path2D();
  path.moveTo(0, height);
  for (let x = 0; x <= width; x += 2) path.lineTo(x, top + ridge(x) * amplitude);
  path.lineTo(width, height);
  path.closePath();
  const g = ctx.createLinearGradient(0, top - amplitude, 0, height);
  g.addColorStop(0, colors[0]);
  g.addColorStop(1, colors[1]);
  ctx.fillStyle = g;
  ctx.fill(path);
  if (rim) {
    ctx.strokeStyle = rim;
    ctx.lineWidth = 2;
    ctx.stroke(path);
  }
  if (trees) {
    const rand = mulberry32(seed + 1);
    ctx.fillStyle = colors[0];
    for (let x = 0; x < width; x += 6 + rand() * 10) {
      const base = top + ridge(x) * amplitude + 4;
      const h = 14 + rand() * 26;
      ctx.beginPath();
      ctx.moveTo(x, base - h);
      ctx.lineTo(x + h * 0.28, base);
      ctx.lineTo(x - h * 0.28, base);
      ctx.fill();
    }
  }
  return c;
}

// ---------------------------------------------------------------------------

export function createArt() {
  const cars = { player: carSet(PLAYER) };
  for (const r of RIVALS) cars[r.id] = carSet(r);

  const sprites = {
    pine: drawPine(),
    oak: drawOak(),
    bush: drawBush(),
    lamp: drawLamp(),
    billboard_luna: drawBillboard(
      [
        { text: "LUNA GP", size: 84, color: "#ffd166", y: 100 },
        { text: "NIGHT SERIES", size: 26, color: "#ff9bd2", y: 160 },
      ],
      "#ff5fa2",
    ),
    billboard_decisions: drawBillboard(
      [
        { text: "OPENAI", size: 30, color: "#bdf2ff", y: 62 },
        { text: "DECISIONS", size: 76, color: "#3dd6ff", y: 128 },
        { text: "API", size: 30, color: "#bdf2ff", y: 178 },
      ],
      "#3dd6ff",
    ),
    billboard_luna6: drawBillboard(
      [
        { text: "gpt-6-luna", size: 64, color: "#ff7ad9", y: 98 },
        { text: "typed answers at race pace", size: 24, color: "#ffd6f2", y: 158 },
      ],
      "#ff7ad9",
    ),
    billboard_types: drawBillboard(
      [
        { text: "choice", size: 44, color: "#9be564", y: 62 },
        { text: "score", size: 44, color: "#ffd166", y: 112 },
        { text: "predicate", size: 44, color: "#3dd6ff", y: 162 },
      ],
      "#9be564",
    ),
    billboard_brake: drawBrakeBoard(),
    gantry: drawGantry(),
  };

  const W2 = WIDTH * 2;
  const background = {
    sky: drawSky(),
    mountains: drawRidgeLayer({
      width: W2,
      height: 420,
      seed: 11,
      harmonics: 48,
      roughness: 1.05,
      top: 190,
      amplitude: 150,
      colors: ["#4a2d6b", "#24183f"],
      rim: "rgba(255,170,190,0.28)",
    }),
    hills: drawRidgeLayer({
      width: W2,
      height: 360,
      seed: 23,
      harmonics: 10,
      roughness: 1.4,
      top: 200,
      amplitude: 70,
      colors: ["#1d2a4b", "#141d36"],
    }),
    trees: drawRidgeLayer({
      width: W2,
      height: 300,
      seed: 31,
      harmonics: 8,
      roughness: 1.6,
      top: 210,
      amplitude: 30,
      colors: ["#0f1a2a", "#0b1320"],
      trees: true,
    }),
  };

  return { cars, sprites, background };
}
