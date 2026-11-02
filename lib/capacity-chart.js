// Draws the load test's "how many players at once?" chart as a standalone 1366 × 768 SVG.
//   1 MEASURE: model calls per minute against players racing, for each run, with a line through the origin.
//   2 PREDICT: the closest run's line extended to the model deployment's capacity, the safety
//              margin kept free below it, and the game server's in-flight cap.

import { DEAD_HEAT_RATIO } from "../public/js/stats.js";

const W = 1366;
const H = 768;
const FONT = "'Segoe UI', 'Segoe UI Variable', 'Helvetica Neue', Arial, sans-serif";
const C = {
  bg: "#1b1b1f",
  grid: "#2e2e34",
  axis: "#55555e",
  tick: "#8f8f99",
  text: "#f4f4f6",
  muted: "#aaaab3",
  footer: "#80808a",
  red: "#f0283c",
  band: "#3d1820",
  near: "#f2f2f4",
  nearLine: "#d2d2d8",
  far: "#9d9da6",
  grayBox: "#6c6c76",
};
// Panel geometry. The framed chart has a title, subtitle and footnote; the bare one leaves them out
// for a slide with its own title, and is shorter and cropped to the panels.
const LAYOUTS = {
  framed: {
    view: { x: 0, y: 0, w: W, h: H },
    headingY: 135,
    boxTop: 106,
    measure: { x: 107, y: 172, w: 483, h: 440 },
    predict: { x: 753, y: 172, w: 570, h: 440 },
    farBox: true,
    fontScale: 1,
    gap: 8, // between callouts
    inset: 6, // between callouts and the plot's edges
  },
  bare: {
    view: { x: 28, y: 0, w: 1312, h: 510 },
    headingY: 28,
    boxTop: 2,
    measure: { x: 107, y: 64, w: 483, h: 380 },
    predict: { x: 753, y: 64, w: 570, h: 380 },
    farBox: false, // no room in the shorter panel; the far run's rate is on the left panel
    fontScale: 1.15, // a slide shows the chart smaller than a page does
    gap: 12,
    inset: 10,
  },
};

// Approximate Segoe UI advance widths (em), to size boxes around their text.
const WIDTH_GROUPS = [
  [0.244, "ijl|"],
  [0.252, ".,:;·'"],
  [0.274, " "],
  [0.29, "!I"],
  [0.32, "()[]f"],
  [0.345, "rt"],
  [0.385, "J-/"],
  [0.425, "s"],
  [0.445, "?z"],
  [0.46, "c"],
  [0.485, "kvxyL"],
  [0.525, "aeE"],
  [0.559, "0123456789"],
  [0.567, "nuh"],
  [0.588, "bdgpqoFPSTYZ"],
  [0.6, "BKXR"],
  [0.645, "ACV"],
  [0.68, "≈+×<>=~"],
  [0.715, "GD"],
  [0.745, "wHNU"],
  [0.775, "OQ"],
  [0.82, "%&"],
  [0.865, "m"],
  [0.92, "M"],
  [0.97, "W"],
];
const WIDTHS = new Map(WIDTH_GROUPS.flatMap(([em, chars]) => [...chars].map((ch) => [ch, em])));

/** Approximate rendered width of `text` in pixels. */
export function textWidth(text, size, bold = false) {
  let em = 0;
  for (const ch of String(text)) em += WIDTHS.get(ch) ?? 0.56;
  return em * size * (bold ? 1.06 : 1);
}

/** A round tick step that splits `span` into about `ticks` parts (1, 2, 2.5 or 5 × 10ⁿ; integers only if asked). */
export function niceStep(span, ticks, integer = false) {
  const raw = span / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const steps = integer && mag < 10 ? [1, 2, 5, 10] : [1, 2, 2.5, 5, 10];
  return Math.max(integer ? 1 : 0, steps.find((s) => norm <= s) * mag);
}

const fx = (v) => Number(v.toFixed(1));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (v) => Math.round(v).toLocaleString("en-US");

function text(x, y, str, { size = 14, weight = 400, fill = C.text, anchor = "start", attrs = "" } = {}) {
  const w = weight === 400 ? "" : ` font-weight="${weight}"`;
  const a = anchor === "start" ? "" : ` text-anchor="${anchor}"`;
  return `<text x="${fx(x)}" y="${fx(y)}" font-size="${fx(size)}"${w} fill="${fill}"${a}${attrs}>${esc(str)}</text>`;
}

// ---- callouts ------------------------------------------------------------------------

function boxSize(lines, padX = 12, padY = 8) {
  const w = Math.max(...lines.map((l) => textWidth(l.text, l.size, (l.weight ?? 400) >= 600))) + padX * 2;
  const h = lines.reduce((sum, l) => sum + l.size * 1.3, 0) + padY * 2;
  return { w, h, padX, padY };
}

function drawBox(rect, lines, { stroke = C.red, padX = 12, padY = 8 } = {}) {
  const out = [`<rect x="${fx(rect.x)}" y="${fx(rect.y)}" width="${fx(rect.w)}" height="${fx(rect.h)}" fill="${C.bg}" stroke="${stroke}" stroke-width="2"/>`];
  let y = rect.y + padY;
  for (const l of lines) {
    y += l.size * 1.3;
    out.push(text(rect.x + padX, y - l.size * 0.33, l.text, { size: l.size, weight: l.weight ?? 400, fill: l.fill ?? C.text }));
  }
  return out.join("");
}

/** Where the ray from the box's centre towards `target` leaves the box. */
function edgePoint(rect, target) {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const dx = target.x - cx;
  const dy = target.y - cy;
  const s = Math.min(dx ? rect.w / 2 / Math.abs(dx) : Infinity, dy ? rect.h / 2 / Math.abs(dy) : Infinity);
  return { x: cx + dx * s, y: cy + dy * s };
}

/**
 * Where a callout's arrow starts: straight out of the facing edge when the target is clearly
 * above, below or beside the box (so the arrow can't seem to come from a neighbouring box),
 * otherwise on the way from the box's centre.
 */
function arrowStart(rect, target, minGap = 36) {
  const within = (v, lo, hi) => v >= lo + 6 && v <= hi - 6;
  if (within(target.x, rect.x, rect.x + rect.w)) {
    if (target.y < rect.y - minGap) return { x: target.x, y: rect.y };
    if (target.y > rect.y + rect.h + minGap) return { x: target.x, y: rect.y + rect.h };
  }
  if (within(target.y, rect.y, rect.y + rect.h)) {
    if (target.x < rect.x - minGap) return { x: rect.x, y: target.y };
    if (target.x > rect.x + rect.w + minGap) return { x: rect.x + rect.w, y: target.y };
  }
  return edgePoint(rect, target);
}

function arrow(from, to, stopShort = 0) {
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  if (len < stopShort + 14) return "";
  const ux = (to.x - from.x) / len;
  const uy = (to.y - from.y) / len;
  const tip = { x: to.x - ux * stopShort, y: to.y - uy * stopShort };
  const base = { x: tip.x - ux * 12, y: tip.y - uy * 12 };
  const side = { x: -uy * 5.5, y: ux * 5.5 };
  const points = [tip, { x: base.x + side.x, y: base.y + side.y }, { x: base.x - side.x, y: base.y - side.y }];
  return (
    `<line x1="${fx(from.x)}" y1="${fx(from.y)}" x2="${fx(base.x)}" y2="${fx(base.y)}" stroke="${C.red}" stroke-width="2"/>` +
    `<polygon points="${points.map((p) => `${fx(p.x)},${fx(p.y)}`).join(" ")}" fill="${C.red}"/>`
  );
}

const overlaps = (a, b, gap) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

/** Whether segment `s` passes through rectangle `r` grown by `gap` (Liang–Barsky clipping). */
function segmentHits(s, r, gap) {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [
    [-dx, s.x1 - (r.x - gap)],
    [dx, r.x + r.w + gap - s.x1],
    [-dy, s.y1 - (r.y - gap)],
    [dy, r.y + r.h + gap - s.y1],
  ]) {
    if (p === 0) {
      if (q < 0) return false;
    } else if (p < 0) {
      t0 = Math.max(t0, q / p);
    } else {
      t1 = Math.min(t1, q / p);
    }
    if (t0 > t1) return false;
  }
  return true;
}

const DIRECTIONS = {
  left: (s, t, d) => ({ x: t.x - d - s.w, y: t.y - s.h / 2 }),
  right: (s, t, d) => ({ x: t.x + d, y: t.y - s.h / 2 }),
  above: (s, t, d) => ({ x: t.x - s.w / 2, y: t.y - d - s.h }),
  below: (s, t, d) => ({ x: t.x - s.w / 2, y: t.y + d }),
  "above-left": (s, t, d) => ({ x: t.x - d * 0.7 - s.w, y: t.y - d * 0.7 - s.h }),
  "above-right": (s, t, d) => ({ x: t.x + d * 0.7, y: t.y - d * 0.7 - s.h }),
  "below-left": (s, t, d) => ({ x: t.x - d * 0.7 - s.w, y: t.y + d * 0.7 }),
  "below-right": (s, t, d) => ({ x: t.x + d * 0.7, y: t.y + d * 0.7 }),
};

/** A panel's free space: callouts are placed one by one, clear of the plot's marks and of each other. */
class Scene {
  constructor(bounds, { gap = 8, fontScale = 1 } = {}) {
    this.bounds = bounds;
    this.gap = gap;
    this.fontScale = fontScale;
    this.rects = [];
    this.segments = [];
  }

  fits(r) {
    const b = this.bounds;
    if (r.x < b.x || r.y < b.y || r.x + r.w > b.x + b.w || r.y + r.h > b.y + b.h) return false;
    return !this.rects.some((o) => overlaps(r, o, this.gap)) && !this.segments.some((s) => segmentHits(s, r, 7));
  }

  /**
   * Places a box of `size` near `target`, trying the preferred directions at growing distances.
   * A candidate that sticks out of the panel slides back inside it before it's tested.
   */
  place(size, target, prefs) {
    const b = this.bounds;
    const inside = (r) => ({
      ...r,
      x: Math.min(Math.max(r.x, b.x), b.x + b.w - r.w),
      y: Math.min(Math.max(r.y, b.y), b.y + b.h - r.h),
    });
    const candidate = (dir, d) => inside({ ...DIRECTIONS[dir](size, target, d), w: size.w, h: size.h });
    for (const d of [30, 45, 60, 80, 100, 125, 150, 175, 200, 230, 260, 300]) {
      for (const dir of prefs) {
        const rect = candidate(dir, d);
        if (this.fits(rect)) return this.claim(rect);
      }
    }
    return this.claim(candidate(prefs[0], 30));
  }

  claim(rect) {
    this.rects.push(rect);
    return rect;
  }
}

function callout(scene, target, lines, prefs, { radius = 7 } = {}) {
  const scaled = lines.map((l) => ({ ...l, size: l.size * scene.fontScale }));
  const size = boxSize(scaled);
  const rect = scene.place(size, target, prefs);
  return drawBox(rect, scaled) + arrow(arrowStart(rect, target), target, radius + 4);
}

// ---- plots ------------------------------------------------------------------------------

function axes(plot, xMax, yMax, xTicks, yTicks, { yLabel = null, xLabel, fontScale = 1 }) {
  const sx = (v) => plot.x + (v / xMax) * plot.w;
  const sy = (v) => plot.y + plot.h - (v / yMax) * plot.h;
  const tick = 14 * fontScale;
  const out = [];
  for (const t of xTicks) out.push(`<line x1="${fx(sx(t))}" y1="${plot.y}" x2="${fx(sx(t))}" y2="${plot.y + plot.h}" stroke="${C.grid}"/>`);
  for (const t of yTicks) out.push(`<line x1="${plot.x}" y1="${fx(sy(t))}" x2="${plot.x + plot.w}" y2="${fx(sy(t))}" stroke="${C.grid}"/>`);
  out.push(`<polyline points="${plot.x},${plot.y} ${plot.x},${plot.y + plot.h} ${plot.x + plot.w},${plot.y + plot.h}" fill="none" stroke="${C.axis}"/>`);
  for (const t of xTicks) out.push(text(sx(t), plot.y + plot.h + 26, fmt(t), { size: tick, fill: C.tick, anchor: "middle" }));
  for (const t of yTicks) out.push(text(plot.x - 12, sy(t) + 5 * fontScale, fmt(t), { size: tick, fill: C.tick, anchor: "end" }));
  out.push(text(plot.x + plot.w / 2, plot.y + plot.h + 56, xLabel, { size: 16 * fontScale, fill: C.muted, anchor: "middle" }));
  if (yLabel) {
    const cy = plot.y + plot.h / 2;
    out.push(text(plot.x - 58, cy, yLabel, { size: 15 * fontScale, fill: C.tick, anchor: "middle", attrs: ` transform="rotate(-90 ${plot.x - 58} ${cy})"` }));
  }
  return { out, sx, sy };
}

/** End of a line through the origin with `slope`, kept inside the plot. */
function lineEnd(slope, xMax, yMax, xCap = xMax) {
  const x = Math.min(xCap, (yMax * 0.97) / slope);
  return { x, y: slope * x };
}

const dot = (p, r, fill, stroke = "none", width = 0) =>
  `<circle cx="${fx(p.x)}" cy="${fx(p.y)}" r="${r}" fill="${fill}"${stroke === "none" ? "" : ` stroke="${stroke}" stroke-width="${width}"`}/>`;

const segment = (a, b) => ({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
const pointRect = (p, r) => ({ x: p.x - r, y: p.y - r, w: r * 2, h: r * 2 });

function slowerText(model, change) {
  if (change === null) return model;
  // Less than 5% apart is a dead heat, as in the speed duel.
  if (Math.abs(change) < DEAD_HEAT_RATIO - 1) return `${model} just as fast`;
  return `${model} ${Math.round(Math.abs(change) * 100)}% ${change > 0 ? "slower" : "faster"}`;
}

function cpuText(pct) {
  const bound = [1, 2, 5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100].find((b) => pct < b);
  return bound ? `server CPU under ${bound}%` : `server CPU ${Math.round(pct)}%`;
}

/** "0.5%" below 1%, "23%" above. */
function shareText(share) {
  const pct = share * 100;
  return `${pct > 0 && pct < 1 ? pct.toFixed(1) : Math.round(pct)}%`;
}

function measurePanel({ lay, near, far, before, prediction: p, nearLabel, farLabel, model, note, beforeNote, caps }) {
  const MEASURE = lay.measure;
  const runs = [near, far, before].filter(Boolean);
  const maxPlayers = Math.max(...runs.flatMap((r) => r.steps.map((s) => s.players)));
  const maxCalls = Math.max(...runs.flatMap((r) => r.steps.map((s) => s.modelCallsPerMin)));
  const xMax = maxPlayers + 1;
  const xStep = maxPlayers <= 10 ? 1 : niceStep(maxPlayers, 8, true);
  const yStep = niceStep(maxCalls * 1.15, 5);
  const yMax = Math.ceil((maxCalls * 1.15) / yStep) * yStep;
  const xTicks = [];
  for (let t = xStep; t <= maxPlayers; t += xStep) xTicks.push(t);
  const yTicks = [];
  for (let t = 0; t <= yMax + 1e-9; t += yStep) yTicks.push(t);
  const { out, sx, sy } = axes(MEASURE, xMax, yMax, xTicks, yTicks, { xLabel: "Players racing at once", yLabel: "Model calls per minute", fontScale: lay.fontScale });
  const at = (x, y) => ({ x: sx(x), y: sy(y) });

  // Callouts may rise above a plot, into the space beside the panel heading.
  const scene = new Scene({ x: MEASURE.x + lay.inset, y: lay.boxTop, w: MEASURE.w - lay.inset, h: MEASURE.y + MEASURE.h - lay.inset - lay.boxTop }, lay);
  scene.rects.push({ x: 40, y: lay.boxTop, w: MEASURE.x + 120 - 40, h: lay.headingY - lay.boxTop + 11 }); // the panel heading

  const origin = at(0, 0);
  const lines = [];
  // Each line runs just past its own run's busiest step.
  const lastStep = (run) => Math.max(...run.steps.map((s) => s.players)) + 0.6;
  if (far) {
    const end = lineEnd(p.farPerPlayer, xMax, yMax, lastStep(far));
    const e = at(end.x, end.y);
    lines.push(`<line x1="${fx(origin.x)}" y1="${fx(origin.y)}" x2="${fx(e.x)}" y2="${fx(e.y)}" stroke="${C.far}" stroke-width="2" stroke-dasharray="7 6"/>`);
    scene.segments.push(segment(origin, e));
  }
  const end = lineEnd(p.perPlayer, xMax, yMax, lastStep(near));
  const e = at(end.x, end.y);
  lines.push(`<line x1="${fx(origin.x)}" y1="${fx(origin.y)}" x2="${fx(e.x)}" y2="${fx(e.y)}" stroke="${C.nearLine}" stroke-width="2"/>`);
  scene.segments.push(segment(origin, e));

  const dots = [];
  const point = (run, players) => {
    const s = run?.steps.find((x) => x.players === players);
    return s ? at(s.players, s.modelCallsPerMin) : null;
  };
  for (const s of far?.steps ?? []) {
    const q = at(s.players, s.modelCallsPerMin);
    dots.push(dot(q, 7, C.bg, C.far, 2.5));
    scene.rects.push(pointRect(q, 9));
  }
  for (const s of near.steps) {
    const q = at(s.players, s.modelCallsPerMin);
    dots.push(dot(q, 7.5, C.near));
    scene.rects.push(pointRect(q, 9));
  }
  // The same test before the change: red rings, around the white points where nothing changed.
  for (const s of before?.steps ?? []) {
    const q = at(s.players, s.modelCallsPerMin);
    dots.push(dot(q, 11, "none", C.red, 2));
    scene.rects.push(pointRect(q, 12));
  }

  // Label the lines at the second-busiest step (as the reference slide does), and note the busiest.
  const counts = [...new Set(near.steps.map((s) => s.players))].sort((a, b) => a - b);
  const labelAt = counts.length > 1 ? counts.at(-2) : counts[0];
  const callouts = [];
  const nearPoint = point(near, labelAt);
  callouts.push(
    callout(scene, nearPoint, [
      { text: `${nearLabel}:`, size: 17 },
      { text: `≈ ${fmt(p.perPlayer)} per player`, size: 17 },
    ], ["above-left", "left", "above"]),
  );
  if (far) {
    const farPoint = point(far, labelAt) ?? nearPoint;
    callouts.push(
      callout(scene, farPoint, [
        { text: `${farLabel}, ${fmt(far.networkRttMs)} ms away:`, size: 16 },
        { text: `≈ ${fmt(p.farPerPlayer)} per player`, size: 16 },
      ], ["below-right", "right", "below", "below-left"]),
    );
  }
  if (before) {
    // Busiest step with the new cap and with the old one: what each turned away.
    if (note && note.players !== labelAt) {
      const lines = [{ text: `${note.players} players, cap ${caps.after}: ${note.turnedAway ? `${shareText(note.turnedAway)} turned away` : "none turned away"},`, size: 15 }];
      lines.push({ text: [slowerText(model, note.modelSlower), note.serverCpuPct === null ? null : cpuText(note.serverCpuPct)].filter(Boolean).join(", "), size: 15 });
      callouts.push(callout(scene, point(near, note.players), lines, ["above", "above-left", "left", "below-right", "below"]));
    }
    if (beforeNote?.turnedAway !== null && beforeNote?.turnedAway !== undefined) {
      callouts.push(
        callout(scene, point(before, beforeNote.players), [
          { text: `${beforeNote.players} players, cap ${caps.before}:`, size: 15 },
          { text: `${shareText(beforeNote.turnedAway)} of calls turned away`, size: 15 },
        ], ["below-left", "below", "left", "right", "below-right"], { radius: 11 }),
      );
    }
  } else if (note && note.players !== labelAt) {
    const notePoint = point(near, note.players);
    const noteLines = [{ text: `${note.players} players: ${slowerText(model, note.modelSlower)}${note.serverCpuPct === null ? "" : ","}`, size: 15 }];
    if (note.serverCpuPct !== null) noteLines.push({ text: cpuText(note.serverCpuPct), size: 15 });
    callouts.push(callout(scene, notePoint, noteLines, ["above", "above-left", "left", "below-right", "below"]));
  }
  return [...out, ...lines, ...dots, ...callouts].join("\n");
}

function predictPanel({ lay, near, far, prediction: p, beforePrediction: bp, farLabel }) {
  const PREDICT = lay.predict;
  const capacity = p.azure.callsPerMin;
  const usable = p.afterMargin.callsPerMin;
  const serverPlayers = p.server.players;
  // Make room for the game server's limit when it's past Azure's capacity (unless it's far past).
  const reach = serverPlayers !== null && serverPlayers <= p.azure.players * 2 ? serverPlayers : 0;
  const xSpan = Math.max(p.azure.players * 1.25, reach * 1.12);
  const xStep = niceStep(xSpan, 7, true);
  const xMax = Math.ceil(xSpan / xStep) * xStep;
  const ySpan = Math.max(capacity * 1.15, reach * p.perPlayer * 1.08);
  const yStep = niceStep(ySpan, 6);
  const yMax = Math.ceil(ySpan / yStep) * yStep;
  const xTicks = [];
  for (let t = 0; t <= xMax + 1e-9; t += xStep) xTicks.push(t);
  const yTicks = [];
  for (let t = 0; t <= yMax + 1e-9; t += yStep) yTicks.push(t);
  const { out, sx, sy } = axes(PREDICT, xMax, yMax, xTicks, yTicks, { xLabel: "Players racing at once", fontScale: lay.fontScale });
  const at = (x, y) => ({ x: sx(x), y: sy(y) });

  const scene = new Scene({ x: PREDICT.x + lay.inset, y: lay.boxTop, w: PREDICT.w - lay.inset, h: PREDICT.y + PREDICT.h - lay.inset - lay.boxTop }, lay);
  scene.rects.push({ x: PREDICT.x - 60, y: lay.boxTop, w: 180, h: lay.headingY - lay.boxTop + 11 }); // the panel heading

  // The safety margin: a band between Azure's capacity and what's planned for.
  const yCap = sy(capacity);
  const yUse = sy(usable);
  const band = [
    `<rect x="${PREDICT.x}" y="${fx(yCap)}" width="${PREDICT.w}" height="${fx(yUse - yCap)}" fill="${C.band}" fill-opacity="0.85"/>`,
    `<line x1="${PREDICT.x}" y1="${fx(yCap)}" x2="${PREDICT.x + PREDICT.w}" y2="${fx(yCap)}" stroke="${C.red}" stroke-width="2.5"/>`,
    `<line x1="${PREDICT.x}" y1="${fx(yUse)}" x2="${PREDICT.x + PREDICT.w}" y2="${fx(yUse)}" stroke="${C.red}" stroke-width="2" stroke-dasharray="8 6"/>`,
  ];
  scene.rects.push({ x: PREDICT.x, y: yCap - 3, w: PREDICT.w, h: yUse - yCap + 6 });
  const pct = Math.round(p.margin * 100);
  const bandLines = [
    { text: `SAFETY MARGIN ${pct}%`, size: 17, weight: 700, fill: C.text },
    { text: "Kept free so Azure never refuses a call", size: 13, fill: C.muted },
    { text: p.azure.binding === "tokens" ? "Azure counts tokens, so leave room for longer calls" : "Room for bursts, such as many races starting at once", size: 13, fill: C.muted },
  ];
  let ty = yCap + 6;
  for (const [i, l] of bandLines.entries()) {
    const size = l.size * lay.fontScale;
    ty += size * (i === 0 ? 1.25 : 1.35);
    // Only lines whose descenders clear the dashed line.
    if (ty + size * 0.25 > yUse - 6) break;
    band.push(text(PREDICT.x + 16, ty, l.text, { size, weight: l.weight ?? 400, fill: l.fill }));
  }

  const origin = at(0, 0);
  const endData = lineEnd(p.perPlayer, xMax, yMax, xMax * 0.985);
  const end = at(endData.x, endData.y);
  const line = `<line x1="${fx(origin.x)}" y1="${fx(origin.y)}" x2="${fx(end.x)}" y2="${fx(end.y)}" stroke="${C.nearLine}" stroke-width="2"/>`;
  scene.segments.push(segment(origin, end));

  const dots = [];
  for (const s of near.steps) {
    if (s.players > xMax || s.modelCallsPerMin > yMax) continue;
    const q = at(s.players, s.modelCallsPerMin);
    dots.push(dot(q, 5, C.near));
    scene.rects.push(pointRect(q, 6));
  }
  const capDot = at(p.azure.players, capacity);
  const useDot = at(p.afterMargin.players, usable);
  const onLine = (players) => (players !== null && players <= xMax && players * p.perPlayer <= yMax ? at(players, players * p.perPlayer) : null);
  const serverDot = onLine(serverPlayers);
  const beforePlayers = bp?.server.players ?? null;
  const beforeDot = onLine(beforePlayers);
  for (const q of [capDot, useDot, serverDot].filter(Boolean)) {
    dots.push(dot(q, 8, C.red, C.bg, 2));
    scene.rects.push(pointRect(q, 10));
  }
  if (beforeDot) {
    dots.push(dot(beforeDot, 7, C.bg, C.red, 2.5));
    scene.rects.push(pointRect(beforeDot, 10));
  }

  // Callouts first, then the note about the far run in whatever corner is left.
  const boxes = [];
  boxes.push(callout(scene, capDot, [{ text: `Azure capacity ≈ ${Math.floor(p.azure.players)} players`, size: 17 }], ["above-left", "left", "above"], { radius: 8 }));
  const marginLines = [{ text: `After margin ≈ ${Math.floor(p.afterMargin.players)} players`, size: 17 }];
  if (bp && serverPlayers !== null && serverPlayers > p.afterMargin.players) marginLines.push({ text: "now the limit", size: 13, fill: C.muted });
  boxes.push(callout(scene, useDot, marginLines, ["below-right", "right", "below"], { radius: 8 }));
  if (serverDot) {
    boxes.push(
      callout(scene, serverDot, [
        { text: `Game server${bp ? " now" : ""} ≈ ${serverPlayers} players`, size: 17 },
        { text: `${p.server.maxInFlight} calls in flight at most`, size: 13, fill: C.muted },
      ], ["left", "above-left", "above", "right", "below-right"], { radius: 8 }),
    );
  }
  if (beforeDot) {
    boxes.push(
      callout(scene, beforeDot, [
        { text: `Game server before ≈ ${beforePlayers} players`, size: 15 },
        { text: `${bp.server.maxInFlight} calls in flight at most`, size: 13, fill: C.muted },
      ], ["left", "above-left", "above", "right", "below-right"], { radius: 7 }),
    );
  }
  if (far && p.afterMargin.farPlayers && lay.farBox) {
    const lines = [
      { text: `${farLabel}: each player makes`, size: 15, fill: C.muted },
      { text: `≈ ${fmt(p.farPerPlayer)} calls a minute, so ≈ ${Math.floor(p.afterMargin.farPlayers)} players fit`, size: 15, fill: C.muted },
    ];
    const corner = { x: PREDICT.x + PREDICT.w - 22, y: PREDICT.y + PREDICT.h - 30 };
    const rect = scene.place(boxSize(lines), corner, ["above-left", "left", "above"]);
    boxes.push(drawBox(rect, lines, { stroke: C.grayBox }));
  }
  return [...out, ...band, line, ...dots, ...boxes].join("\n");
}

/**
 * The chart as an SVG string. `near` and `far` are load test results (`far` is optional),
 * `prediction` comes from predictCapacity(), and `note` from busiestStep(). To compare with
 * the server's previous limits, add `before` (the same test as `near`, run under them) with its
 * `beforePrediction` and `beforeNote`. `bare` leaves out the title, subtitle and footer, for a
 * slide with its own title; `background` replaces the dark background colour.
 */
export function renderCapacityChart({
  near,
  far = null,
  before = null,
  prediction,
  beforePrediction = null,
  note = null,
  beforeNote = null,
  title = "How many LUNA GP players at once?",
  subtitle = "",
  footer = "",
  model = "Decision-1",
  bare = false,
  background = C.bg,
}) {
  const lay = bare ? LAYOUTS.bare : LAYOUTS.framed;
  const { x: vx, y: vy, w: vw, h: vh } = lay.view;
  const nearLabel = near.label ?? "Next to the server";
  const farLabel = far?.label ?? "From afar";
  const compare = before && beforePrediction ? { before, beforeNote, caps: { before: beforePrediction.server.maxInFlight, after: prediction.server.maxInFlight } } : {};
  return (
    [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${vw}" height="${vh}" viewBox="${vx} ${vy} ${vw} ${vh}" font-family="${esc(FONT)}">`,
      `<rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="${C.bg}"/>`,
      bare ? "" : text(30, 57, title.toUpperCase(), { size: 38, weight: 600 }),
      bare || !subtitle ? "" : text(30, 90, subtitle, { size: 19, fill: "#d8d8de" }),
      text(62, lay.headingY, "1 MEASURE", { size: 19 * lay.fontScale, weight: 700, fill: C.red }),
      text(lay.predict.x - 45, lay.headingY, "2 PREDICT", { size: 19 * lay.fontScale, weight: 700, fill: C.red }),
      measurePanel({ lay, near, far, prediction, nearLabel, farLabel, model, note, ...compare }),
      predictPanel({ lay, near, far, prediction, beforePrediction: compare.before ? beforePrediction : null, farLabel }),
      bare || !footer ? "" : text(30, 737, footer, { size: 13, fill: C.footer }),
      "</svg>",
    ]
      .filter(Boolean)
      .join("\n")
      .concat("\n")
      // Boxes and hollow points are filled with the background colour, so they mask the lines behind them.
      .replaceAll(C.bg, background)
  );
}
