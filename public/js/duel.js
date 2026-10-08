// Speed Duel: two cars, two OpenAI endpoints. Each time an API answers a
// rival-driver decision about a race situation (a choice, a score and a
// predicate), its car moves one step closer to the flag. The game server times
// every call, so the browser's own connection doesn't count.

import { createArt, shade } from "./art.js";
import { MANEUVERS } from "./config.js";
import { formatMs, summarize } from "./stats.js";

const $ = (id) => document.getElementById(id);

const W = 1280;
const H = 460;
const HORIZON_Y = 206;
const ROAD_TOP = 250;
const ROAD_BOTTOM = 440;
const SEPARATOR_Y = 345;
const START_X = 215;
const FINISH_X = 1130;
const CAR_LENGTH = 170;
const FONT = 'system-ui, "Segoe UI", sans-serif';
const OPPONENT_KEY = "lunagp.duel.opponent";

// Lane 0 (near, bottom) is the Decisions API; lane 1 (far, top) is the opponent.
const LANE_STYLES = [
  { color: "#3dd6ff", accent: "#0b2747", baseY: 432, scale: 1 },
  { color: "#ffb347", accent: "#3a2400", baseY: 334, scale: 0.84 },
];

const canvas = $("strip");
canvas.width = W;
canvas.height = H;
const ctx = canvas.getContext("2d");
const backdrop = drawBackdrop(createArt().background);
let trackLayer = drawTrack(10);

const state = {
  config: null,
  phase: "loading", // loading | unavailable | idle | countdown | racing | done
  rounds: 10,
  lanes: [],
  duelId: 0,
  startedAt: 0,
  goUntil: 0,
  lightCount: 0,
  warming: false,
  verdict: null,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function formatClock(ms) {
  return ms === null || ms === undefined ? "–" : `${(ms / 1000).toFixed(2)} s`;
}

// ---- API -----------------------------------------------------------------------

async function callDuel(contender, scenario) {
  let res;
  let data;
  try {
    res = await fetch("/api/duel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contender, scenario }),
      signal: AbortSignal.timeout(90_000),
    });
    data = await res.json().catch(() => ({}));
  } catch (err) {
    const message = err?.name === "TimeoutError" ? "Request timed out" : "Game server unreachable";
    throw Object.assign(new Error(message), { status: 0 });
  }
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

// ---- duel flow -----------------------------------------------------------------

function makeLane(contender, style) {
  return {
    contender,
    style,
    results: [],
    target: 0,
    display: 0,
    velocity: 0,
    wheel: 0,
    flame: 0,
    pops: [],
    finishedAt: null,
    endedAt: null,
    place: null,
    error: null,
    view: null,
  };
}

function resetLanes() {
  state.rounds = Number($("opt-rounds").value);
  trackLayer = drawTrack(state.rounds);
  const decisions = state.config.contenders.find((c) => c.api === "decisions");
  const opponent = state.config.contenders.find((c) => c.id === $("opt-opponent").value);
  state.lanes = [makeLane(decisions, LANE_STYLES[0]), makeLane(opponent, LANE_STYLES[1])];
  state.verdict = null;
  $("duel-result").classList.add("hidden");
  buildCards();
}

async function startDuel() {
  const id = ++state.duelId;
  resetLanes();
  state.phase = "countdown";
  state.lightCount = 0;
  syncControls();
  updateCards();

  // Untimed warm-up calls, so setting up the HTTPS connections doesn't count against either car.
  state.warming = true;
  const warmup = Promise.allSettled(state.lanes.map((lane) => callDuel(lane.contender.id, 0))).then(() => {
    if (id === state.duelId) state.warming = false;
  });
  for (let n = 1; n <= 3; n++) {
    await sleep(700);
    if (id !== state.duelId) return;
    state.lightCount = n;
  }
  await warmup;
  await sleep(300 + Math.random() * 500);
  if (id !== state.duelId) return;

  state.phase = "racing";
  state.startedAt = performance.now();
  state.goUntil = state.startedAt + 900;
  syncControls();
  updateCards();
  await Promise.all(state.lanes.map((lane) => runLane(lane, id)));
  if (id === state.duelId) finishDuel(false);
}

async function runLane(lane, id) {
  const situations = state.config.scenarios.length;
  for (let i = 0; i < state.rounds; i++) {
    let result = null;
    for (let attempt = 1; !result; attempt++) {
      try {
        result = await callDuel(lane.contender.id, i % situations);
      } catch (err) {
        if (id !== state.duelId) return;
        if (attempt >= 2 || err.status === 400 || err.status === 503) {
          lane.error = err.message;
          lane.endedAt = performance.now() - state.startedAt;
          updateCard(lane);
          return;
        }
        await sleep(500);
      }
    }
    if (id !== state.duelId) return;
    lane.results.push(result);
    lane.target = lane.results.length / state.rounds;
    lane.flame = 1;
    lane.pops.push({ text: `+${formatMs(result.latencyMs)}`, born: performance.now() });
    addChip(lane, result);
    if (lane.results.length === state.rounds) {
      lane.finishedAt = performance.now() - state.startedAt;
      lane.place = state.lanes.filter((l) => l.finishedAt !== null).length;
    }
    updateCard(lane);
  }
}

function stopDuel() {
  const wasRacing = state.phase === "racing";
  state.duelId++;
  if (wasRacing) {
    const elapsed = performance.now() - state.startedAt;
    for (const lane of state.lanes) {
      if (lane.finishedAt === null && lane.endedAt === null) lane.endedAt = elapsed;
    }
  }
  finishDuel(true);
}

function finishDuel(stopped) {
  state.phase = "done";
  syncControls();
  updateCards();
  showVerdict(stopped);
}

// ---- verdict -------------------------------------------------------------------

function describe(result) {
  if (!result) return "–";
  const { answer } = result;
  const move = MANEUVERS[answer.maneuver]?.label ?? answer.maneuver ?? "?";
  if (result.api === "decisions") {
    const p = answer.maneuverP === null ? "" : ` (${answer.maneuverP.toFixed(2)})`;
    const pace = answer.pace === null ? "–" : answer.pace.toFixed(1);
    const nitro = answer.nitro === null ? "–" : `p ${answer.nitro.toFixed(2)}`;
    return `${move}${p} · pace ${pace} · nitro ${nitro}`;
  }
  const nitro = answer.nitro === null ? "–" : answer.nitro ? "yes" : "no";
  return `${move} · pace ${answer.pace ?? "–"} · nitro ${nitro}`;
}

function showVerdict(stopped) {
  const [a, b] = state.lanes;
  const n = state.rounds;
  const latA = summarize(a.results.map((r) => r.latencyMs));
  const latB = summarize(b.results.map((r) => r.latencyMs));
  const procA = summarize(a.results.map((r) => r.processingMs));
  const procB = summarize(b.results.map((r) => r.processingMs));
  let same = 0;
  let compared = 0;
  for (let i = 0; i < Math.min(a.results.length, b.results.length); i++) {
    compared++;
    if (a.results[i].answer.maneuver === b.results[i].answer.maneuver) same++;
  }
  const complete = a.finishedAt !== null && b.finishedAt !== null;
  const factor = complete ? b.finishedAt / a.finishedAt : latA.p50 && latB.p50 ? latB.p50 / latA.p50 : null;
  const decisionsAhead = factor === null || factor >= 1;
  const times = factor === null ? null : (decisionsAhead ? factor : 1 / factor).toFixed(1);
  const winner = decisionsAhead ? "Decisions API" : "Responses API";

  let headline;
  if (a.error || b.error) {
    const failed = a.error ? a : b;
    headline = `${escapeHtml(failed.contender.short)} hit an error: ${escapeHtml(failed.error)}`;
    state.verdict = { top: "RACE STOPPED", big: "ERROR", bottom: failed.error.slice(0, 90), color: "#f87171" };
  } else if (complete) {
    headline = decisionsAhead
      ? `<b>${times}× faster.</b> The Decisions API answered ${n} race decisions in ${formatClock(a.finishedAt)}. The Responses API needed ${formatClock(b.finishedAt)}.`
      : `<b>${times}× faster.</b> The Responses API won this one: ${formatClock(b.finishedAt)} vs ${formatClock(a.finishedAt)}.`;
    state.verdict = {
      top: winner.toUpperCase(),
      big: `${times}× FASTER`,
      bottom: `${n} race decisions · ${formatClock(a.finishedAt)} vs ${formatClock(b.finishedAt)}`,
      color: decisionsAhead ? LANE_STYLES[0].color : LANE_STYLES[1].color,
    };
  } else if (!a.results.length && !b.results.length) {
    headline = "Stopped before anyone answered.";
    state.verdict = null;
  } else {
    headline =
      `Stopped at ${a.results.length} vs ${b.results.length} answers.` +
      (times ? ` Per decision, the ${winner} was <b>${times}× faster</b> (median).` : "");
    state.verdict = {
      top: stopped ? "STOPPED" : "FINISHED",
      big: times ? `${times}× FASTER` : "–",
      bottom: `median per decision · ${formatMs(latA.p50)} vs ${formatMs(latB.p50)}`,
      color: "#d9d4f0",
    };
  }

  $("result-headline").innerHTML = headline;
  $("result-sub").textContent =
    `Median per decision: ${formatMs(latA.p50)} vs ${formatMs(latB.p50)} · ` +
    `time inside OpenAI (median): ${formatMs(procA.p50)} vs ${formatMs(procB.p50)} · ` +
    `same maneuver in ${same} of ${compared} situations`;

  const total = (lane) => (lane.finishedAt !== null ? `${formatClock(lane.finishedAt)} total` : `${lane.results.length}/${n} answered`);
  const share = [
    `⚡ LUNA GP speed duel: ${n} race decisions, each a choice + score + predicate`,
    `${a.contender.label}: ${total(a)}, median ${formatMs(latA.p50)} per decision`,
    `${b.contender.label}: ${total(b)}, median ${formatMs(latB.p50)} per decision`,
  ];
  if (times) share.push(`The ${winner} was ${times}× faster${complete ? "" : " per decision"}.`);
  $("share").textContent = share.join("\n");

  $("th-a").textContent = a.contender.short;
  $("th-b").textContent = b.contender.short;
  const body = $("answers-body");
  body.replaceChildren();
  for (let i = 0; i < Math.max(a.results.length, b.results.length); i++) {
    const ra = a.results[i];
    const rb = b.results[i];
    const row = document.createElement("tr");
    const cells = [
      [String(i + 1)],
      [state.config.scenarios[i % state.config.scenarios.length]],
      [describe(ra)],
      [ra ? formatMs(ra.latencyMs) : "–", "time"],
      [describe(rb)],
      [rb ? formatMs(rb.latencyMs) : "–", "time"],
    ];
    if (ra && rb) {
      const match = ra.answer.maneuver === rb.answer.maneuver;
      cells.push([match ? "✓" : "✗", match ? "same-yes" : "same-no"]);
    } else {
      cells.push(["–"]);
    }
    for (const [text, cls] of cells) {
      const td = document.createElement("td");
      td.textContent = text;
      if (cls) td.className = cls;
      row.appendChild(td);
    }
    body.appendChild(row);
  }
  $("duel-result").classList.remove("hidden");
}

async function copyResult() {
  const button = $("btn-copy");
  try {
    await navigator.clipboard.writeText($("share").textContent);
    button.textContent = "✅ Copied!";
  } catch {
    const range = document.createRange();
    range.selectNodeContents($("share"));
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    button.textContent = "Press Ctrl+C to copy";
  }
  setTimeout(() => {
    button.textContent = "📋 Copy result";
  }, 2000);
}

// ---- cards & controls ----------------------------------------------------------

function buildCards() {
  const host = $("lane-cards");
  host.replaceChildren();
  for (const lane of state.lanes) {
    const card = document.createElement("div");
    card.className = "lane-card";
    card.style.setProperty("--lane", lane.style.color);
    card.innerHTML = `
      <div class="lc-head"><span class="swatch"></span><b class="lc-label"></b><span class="lc-state"></span></div>
      <div class="lc-detail"></div>
      <div class="lc-stats">
        <div><label>answered</label><span class="lc-count"></span></div>
        <div><label>last</label><span class="lc-last"></span></div>
        <div><label>median</label><span class="lc-median"></span></div>
        <div><label>race time</label><span class="lc-time"></span></div>
      </div>
      <div class="lc-answers"></div>`;
    card.querySelector(".lc-label").textContent = lane.contender.label;
    card.querySelector(".lc-detail").textContent = lane.contender.detail;
    lane.view = {
      state: card.querySelector(".lc-state"),
      count: card.querySelector(".lc-count"),
      last: card.querySelector(".lc-last"),
      median: card.querySelector(".lc-median"),
      time: card.querySelector(".lc-time"),
      answers: card.querySelector(".lc-answers"),
    };
    host.appendChild(card);
    updateCard(lane);
  }
}

function laneStatus(lane) {
  if (lane.error) return ["error", "error"];
  if (lane.finishedAt !== null) return lane.place === 1 ? ["🏆 winner", "winner"] : ["🏁 finished", "finished"];
  if (state.phase === "racing") return ["racing", "racing"];
  if (state.phase === "countdown") return ["on the grid", ""];
  if (state.phase === "done") return ["stopped", ""];
  return ["ready", ""];
}

function updateCard(lane) {
  const view = lane.view;
  if (!view) return;
  const [text, cls] = laneStatus(lane);
  view.state.textContent = text;
  view.state.className = `lc-state ${cls}`;
  view.state.title = lane.error ?? "";
  const latencies = lane.results.map((r) => r.latencyMs);
  view.count.textContent = `${lane.results.length}/${state.rounds}`;
  view.last.textContent = formatMs(latencies.at(-1));
  view.median.textContent = formatMs(summarize(latencies).p50);
}

function updateCards() {
  for (const lane of state.lanes) updateCard(lane);
}

function addChip(lane, result) {
  const maneuver = MANEUVERS[result.answer.maneuver];
  const chip = document.createElement("span");
  chip.className = "chip";
  chip.style.setProperty("--c", maneuver?.color ?? "#cfcaea");
  chip.textContent = maneuver?.label ?? result.answer.maneuver ?? "?";
  chip.title = `${state.config.scenarios[result.scenario]}\n${describe(result)}\n${formatMs(result.latencyMs)}`;
  lane.view?.answers.appendChild(chip);
}

function syncControls() {
  const busy = state.phase === "countdown" || state.phase === "racing";
  $("opt-opponent").disabled = busy || state.phase === "unavailable";
  $("opt-rounds").disabled = busy || state.phase === "unavailable";
  const button = $("btn-duel");
  button.disabled = state.phase === "loading" || state.phase === "unavailable";
  button.classList.toggle("primary", !busy);
  button.innerHTML = busy ? "Stop" : `${state.phase === "done" ? "Race again" : "Start duel"} <kbd>Enter</kbd>`;
}

function setStatus(kind, text) {
  const el = $("duel-status");
  el.className = `status ${kind}`;
  el.textContent = text;
}

async function init() {
  try {
    const res = await fetch("/api/duel", { signal: AbortSignal.timeout(5000) });
    state.config = await res.json();
  } catch {
    state.phase = "unavailable";
    setStatus("warn", "⚠ Can't reach the game server. Start it with npm start, then reload this page.");
    syncControls();
    return;
  }
  if (!state.config.configured) {
    state.phase = "unavailable";
    setStatus("warn", "⚠ OPENAI_API_KEY isn't set on the game server, so there's nothing to race.");
    syncControls();
    return;
  }

  const select = $("opt-opponent");
  for (const contender of state.config.contenders.filter((c) => c.api === "responses")) {
    const option = document.createElement("option");
    option.value = contender.id;
    option.textContent = contender.label;
    select.appendChild(option);
  }
  const saved = localStorage.getItem(OPPONENT_KEY);
  if (saved && [...select.options].some((o) => o.value === saved)) select.value = saved;

  setStatus("ok", "✅ Ready. Both cars call OpenAI through the game server, using your API key.");
  state.phase = "idle";
  resetLanes();
  syncControls();
}

$("btn-duel").addEventListener("click", () => {
  if (state.phase === "countdown" || state.phase === "racing") stopDuel();
  else if (state.phase === "idle" || state.phase === "done") startDuel();
});
$("btn-again").addEventListener("click", () => {
  if (state.phase === "idle" || state.phase === "done") startDuel();
});
$("btn-copy").addEventListener("click", copyResult);
for (const id of ["opt-opponent", "opt-rounds"]) {
  $(id).addEventListener("change", () => {
    localStorage.setItem(OPPONENT_KEY, $("opt-opponent").value);
    if (state.phase === "idle" || state.phase === "done") {
      state.phase = "idle";
      resetLanes();
      syncControls();
    }
  });
}
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.repeat) return;
  if (e.target instanceof Element && e.target.closest("button, select, a, input, textarea, summary")) return;
  if (state.phase !== "idle" && state.phase !== "done") return;
  e.preventDefault();
  startDuel();
});

// ---- drawing -------------------------------------------------------------------

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function seeded(seed) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

function drawBackdrop(bg) {
  const c = makeCanvas(W, H);
  const g = c.getContext("2d");

  const sky = g.createLinearGradient(0, 0, 0, HORIZON_Y);
  sky.addColorStop(0, "#090a26");
  sky.addColorStop(0.5, "#2c1a52");
  sky.addColorStop(0.85, "#8a3a6c");
  sky.addColorStop(1, "#ee8a66");
  g.fillStyle = sky;
  g.fillRect(0, 0, W, HORIZON_Y + 40);

  const rand = seeded(42);
  for (let i = 0; i < 140; i++) {
    const y = rand() * HORIZON_Y * 0.7;
    g.fillStyle = `rgba(255,255,255,${(0.2 + rand() * 0.6) * (1 - y / HORIZON_Y)})`;
    g.fillRect(rand() * W, y, rand() < 0.1 ? 2 : 1, rand() < 0.1 ? 2 : 1);
  }

  const mx = 1010;
  const my = 62;
  const halo = g.createRadialGradient(mx, my, 20, mx, my, 120);
  halo.addColorStop(0, "rgba(255,240,220,0.35)");
  halo.addColorStop(1, "rgba(255,240,220,0)");
  g.fillStyle = halo;
  g.fillRect(mx - 120, my - 120, 240, 240);
  g.fillStyle = "#fbf1e1";
  g.beginPath();
  g.arc(mx, my, 30, 0, Math.PI * 2);
  g.fill();

  // Mountains, hills and the tree line from the game's own backdrop.
  g.drawImage(bg.mountains, 300, 0, W, bg.mountains.height, 0, -40, W, bg.mountains.height);
  g.drawImage(bg.hills, 900, 0, W, bg.hills.height, 0, -20, W, bg.hills.height);
  g.drawImage(bg.trees, 500, 0, W, bg.trees.height, 0, -15, W, bg.trees.height);

  const grass = g.createLinearGradient(0, HORIZON_Y, 0, H);
  grass.addColorStop(0, "#3b3045");
  grass.addColorStop(0.18, "#24503a");
  grass.addColorStop(1, "#2a663f");
  g.fillStyle = grass;
  g.fillRect(0, HORIZON_Y, W, H - HORIZON_Y);

  const asphalt = g.createLinearGradient(0, ROAD_TOP, 0, ROAD_BOTTOM);
  asphalt.addColorStop(0, "#45434e");
  asphalt.addColorStop(1, "#5b5967");
  g.fillStyle = asphalt;
  g.fillRect(0, ROAD_TOP, W, ROAD_BOTTOM - ROAD_TOP);

  for (let x = 0, i = 0; x < W; x += 40, i++) {
    g.fillStyle = i % 2 ? "#efe9ea" : "#c9363d";
    g.fillRect(x, ROAD_TOP - 8, 40, 8);
    g.fillRect(x, ROAD_BOTTOM, 40, 8);
  }

  g.fillStyle = "rgba(235,230,240,0.75)";
  for (let x = 0; x < W; x += 70) g.fillRect(x, SEPARATOR_Y - 2, 40, 4);

  g.fillStyle = "#f4f4f4";
  g.fillRect(START_X - 5, ROAD_TOP, 5, ROAD_BOTTOM - ROAD_TOP);

  const sq = 10;
  for (let y = ROAD_TOP, row = 0; y < ROAD_BOTTOM; y += sq, row++) {
    for (let col = 0; col < 2; col++) {
      g.fillStyle = (row + col) % 2 ? "#111" : "#f4f4f4";
      g.fillRect(FINISH_X + col * sq, y, sq, Math.min(sq, ROAD_BOTTOM - y));
    }
  }
  g.fillStyle = "#c9c3d6";
  g.fillRect(FINISH_X + 8, 132, 4, ROAD_TOP - 140);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 5; col++) {
      g.fillStyle = (row + col) % 2 ? "#111" : "#f4f4f4";
      g.fillRect(FINISH_X + 12 + col * 9, 134 + row * 9, 9, 9);
    }
  }
  return c;
}

function drawTrack(rounds) {
  const c = makeCanvas(W, H);
  const g = c.getContext("2d");
  g.drawImage(backdrop, 0, 0);
  g.font = `700 12px ${FONT}`;
  g.textAlign = "center";
  for (let i = 1; i < rounds; i++) {
    const x = START_X + ((FINISH_X - START_X) * i) / rounds;
    g.fillStyle = "rgba(255,255,255,0.45)";
    g.fillRect(x - 1, ROAD_TOP, 2, 10);
    g.fillRect(x - 1, ROAD_BOTTOM - 10, 2, 10);
    g.fillStyle = "rgba(255,255,255,0.55)";
    g.fillText(String(i), x, ROAD_TOP - 14);
  }
  return c;
}

function drawWheel(cx, cy, r, angle) {
  ctx.fillStyle = "#0b0b10";
  ctx.beginPath();
  ctx.arc(cx, cy, r + 3, Math.PI, 0);
  ctx.fill();
  ctx.fillStyle = "#16161c";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#9aa3b5";
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.62, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#2b2f3a";
  ctx.lineWidth = 2.5;
  for (let k = 0; k < 5; k++) {
    const a = angle + (k * Math.PI * 2) / 5;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * r * 0.6, cy + Math.sin(a) * r * 0.6);
    ctx.stroke();
  }
  ctx.fillStyle = "#dfe3ec";
  ctx.beginPath();
  ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
  ctx.fill();
}

/** Side view of a car facing right; (x, baseY) is the front bumper at road level. */
function drawCar(x, baseY, scale, style, wheelAngle, flame, streaks) {
  ctx.save();
  ctx.translate(x, baseY);
  ctx.scale(scale, scale);

  if (streaks > 0.05) {
    ctx.strokeStyle = `rgba(220,235,255,${0.4 * streaks})`;
    ctx.lineWidth = 2;
    for (const [y, len] of [
      [-52, 70],
      [-38, 130],
      [-24, 100],
      [-12, 60],
    ]) {
      ctx.beginPath();
      ctx.moveTo(-CAR_LENGTH - 12, y);
      ctx.lineTo(-CAR_LENGTH - 12 - len * streaks, y);
      ctx.stroke();
    }
  }

  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.beginPath();
  ctx.ellipse(-84, 1, 94, 6, 0, 0, Math.PI * 2);
  ctx.fill();

  if (flame > 0.02) {
    const len = 26 + 60 * flame;
    const g = ctx.createLinearGradient(-166, 0, -166 - len, 0);
    g.addColorStop(0, `rgba(220,245,255,${0.95 * flame})`);
    g.addColorStop(0.3, `rgba(80,160,255,${0.85 * flame})`);
    g.addColorStop(0.75, `rgba(255,120,40,${0.5 * flame})`);
    g.addColorStop(1, "rgba(255,80,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-164, -24);
    ctx.quadraticCurveTo(-166 - len * 0.6, -26, -166 - len, -18);
    ctx.quadraticCurveTo(-166 - len * 0.6, -10, -164, -13);
    ctx.closePath();
    ctx.fill();
  }

  const beam = ctx.createLinearGradient(0, 0, 150, 0);
  beam.addColorStop(0, "rgba(255,240,200,0.32)");
  beam.addColorStop(1, "rgba(255,240,200,0)");
  ctx.fillStyle = beam;
  ctx.beginPath();
  ctx.moveTo(-2, -28);
  ctx.lineTo(150, -44);
  ctx.lineTo(150, -2);
  ctx.lineTo(-2, -20);
  ctx.closePath();
  ctx.fill();

  const body = new Path2D();
  body.moveTo(-162, -9);
  body.lineTo(-168, -31);
  body.lineTo(-150, -37);
  body.lineTo(-122, -41);
  body.quadraticCurveTo(-106, -61, -86, -62);
  body.lineTo(-66, -60);
  body.quadraticCurveTo(-52, -58, -38, -42);
  body.lineTo(-10, -34);
  body.quadraticCurveTo(1, -31, 2, -22);
  body.lineTo(1, -13);
  body.quadraticCurveTo(-1, -8, -8, -8);
  body.closePath();
  const paint = ctx.createLinearGradient(0, -62, 0, -8);
  paint.addColorStop(0, shade(style.color, 0.35));
  paint.addColorStop(0.5, style.color);
  paint.addColorStop(1, shade(style.color, -0.5));
  ctx.fillStyle = paint;
  ctx.fill(body);

  ctx.save();
  ctx.clip(body);
  ctx.fillStyle = style.accent;
  ctx.fillRect(-170, -28, 175, 5);
  ctx.fillStyle = "rgba(255,255,255,0.25)";
  ctx.fillRect(-170, -40, 175, 2);
  ctx.restore();

  ctx.beginPath();
  ctx.moveTo(-117, -42);
  ctx.quadraticCurveTo(-103, -58, -86, -58);
  ctx.lineTo(-68, -57);
  ctx.quadraticCurveTo(-56, -55, -45, -42);
  ctx.closePath();
  const glass = ctx.createLinearGradient(0, -58, 0, -42);
  glass.addColorStop(0, "#3a4a6e");
  glass.addColorStop(1, "#0a0e1b");
  ctx.fillStyle = glass;
  ctx.fill();
  ctx.strokeStyle = shade(style.color, -0.55);
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-84, -58);
  ctx.lineTo(-80, -42);
  ctx.stroke();

  ctx.fillStyle = shade(style.color, -0.6);
  ctx.fillRect(-161, -45, 4, 9);
  ctx.fillRect(-178, -51, 36, 6);
  ctx.fillStyle = "#ff3347";
  ctx.fillRect(-169, -32, 4, 9);
  ctx.fillStyle = "#fff4cf";
  ctx.beginPath();
  ctx.ellipse(-2, -26, 3, 4, 0, 0, Math.PI * 2);
  ctx.fill();

  for (const cx of [-134, -36]) drawWheel(cx, -16, 16, wheelAngle);
  ctx.restore();
}

function drawTag(text, cx, y, color) {
  ctx.save();
  ctx.font = `800 15px ${FONT}`;
  const w = ctx.measureText(text).width + 20;
  const x = Math.max(w / 2 + 6, Math.min(W - w / 2 - 6, cx));
  ctx.fillStyle = "rgba(10,10,28,0.82)";
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - 26, w, 24, 7);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y - 13);
  ctx.restore();
}

function drawLane(lane, now) {
  const { style } = lane;
  const x = START_X + lane.display * (FINISH_X - START_X);
  const waiting = state.phase === "racing" && lane.finishedAt === null && !lane.error;
  const idle = waiting ? Math.sin(now / 35 + style.baseY) * 0.8 : 0;
  const streaks = Math.min(1, Math.abs(lane.velocity) / 700);
  drawCar(x, style.baseY + idle, style.scale, style, lane.wheel, lane.flame, streaks);

  const centerX = x - (CAR_LENGTH * style.scale) / 2;
  const tagY = style.baseY - 70 * style.scale;
  drawTag(lane.contender.short, centerX, tagY, style.color);

  for (const pop of lane.pops) {
    const age = (now - pop.born) / 1000;
    const alpha = Math.max(0, 1 - age / 1.6);
    if (alpha <= 0) continue;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.textAlign = "center";
    ctx.font = `italic 900 ${Math.round(20 * style.scale + 4)}px ${FONT}`;
    ctx.shadowColor = style.color;
    ctx.shadowBlur = 10;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(pop.text, centerX, tagY - 32 - age * 26);
    ctx.restore();
  }
  lane.pops = lane.pops.filter((p) => now - p.born < 1600);

  const labelX = FINISH_X + 34;
  if (lane.finishedAt !== null || lane.error) {
    ctx.save();
    ctx.textAlign = "left";
    ctx.shadowColor = "rgba(0,0,0,0.7)";
    ctx.shadowBlur = 6;
    ctx.fillStyle = lane.error ? "#f87171" : "#ffffff";
    ctx.font = `800 13px ${FONT}`;
    ctx.fillText(lane.error ? "✗ ERROR" : lane.place === 1 ? "🏆 WINNER" : "🏁 FINISH", labelX, style.baseY - 46 * style.scale);
    if (lane.finishedAt !== null) {
      ctx.fillStyle = style.color;
      ctx.font = `italic 900 ${Math.round(28 * style.scale)}px ${FONT}`;
      ctx.fillText(formatClock(lane.finishedAt), labelX, style.baseY - 18 * style.scale);
    }
    ctx.restore();
  }
}

function drawLights(count, go) {
  const cx = W / 2;
  const cy = 70;
  ctx.save();
  ctx.fillStyle = "rgba(10,10,20,0.85)";
  ctx.beginPath();
  ctx.roundRect(cx - 105, cy - 36, 210, 72, 36);
  ctx.fill();
  for (let i = 0; i < 3; i++) {
    const on = go || i < count;
    ctx.fillStyle = go ? "#3dff7a" : on ? "#ff2d3d" : "#2a1414";
    ctx.shadowColor = on ? ctx.fillStyle : "transparent";
    ctx.shadowBlur = on ? 24 : 0;
    ctx.beginPath();
    ctx.arc(cx - 62 + i * 62, cy, 22, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function centerText(text, y, { size = 16, weight = 700, italic = false, color = "#d9d4f0" } = {}) {
  ctx.save();
  ctx.textAlign = "center";
  ctx.font = `${italic ? "italic " : ""}${weight} ${size}px ${FONT}`;
  ctx.shadowColor = "rgba(0,0,0,0.7)";
  ctx.shadowBlur = size > 30 ? 14 : 8;
  ctx.fillStyle = color;
  ctx.fillText(text, W / 2, y);
  ctx.restore();
}

function drawOverlay(now) {
  if (state.phase === "countdown") {
    drawLights(state.lightCount, false);
    centerText(state.warming && state.lightCount === 3 ? "warming up connections…" : "get ready…", 138);
  } else if (state.phase === "racing" && now < state.goUntil) {
    drawLights(3, true);
    centerText("GO!", 138, { size: 20, weight: 900, color: "#3dff7a" });
  } else if (state.phase === "racing") {
    centerText(formatClock(now - state.startedAt), 96, { size: 58, weight: 900, italic: true, color: "#ffffff" });
    centerText(`first to ${state.rounds} race decisions wins`, 128);
  } else if (state.verdict) {
    const v = state.verdict;
    centerText(v.top, 50, { size: 22, weight: 800, color: v.color });
    centerText(v.big, 124, { size: 74, weight: 900, italic: true, color: "#ffd166" });
    centerText(v.bottom, 158, { size: 18, color: "#ffffff" });
  } else if (state.phase === "idle" || state.phase === "done") {
    centerText("Who answers faster?", 92, { size: 46, weight: 900, italic: true, color: "#ffffff" });
    centerText(`${state.rounds} race decisions each · press Start duel`, 126);
  } else {
    centerText(state.phase === "loading" ? "connecting…" : "unavailable", 100, { size: 22 });
  }
}

function updateClocks(now) {
  for (const lane of state.lanes) {
    if (!lane.view) continue;
    const ms = lane.finishedAt ?? lane.endedAt ?? (state.phase === "racing" ? now - state.startedAt : null);
    const text = formatClock(ms);
    if (lane.view.time.textContent !== text) lane.view.time.textContent = text;
  }
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, Math.max(0, now - last) / 1000);
  last = now;
  for (const lane of state.lanes) {
    const before = lane.display;
    lane.display += (lane.target - lane.display) * (1 - Math.exp(-dt * 6));
    if (Math.abs(lane.target - lane.display) < 1e-4) lane.display = lane.target;
    const moved = (lane.display - before) * (FINISH_X - START_X);
    lane.velocity = moved / Math.max(dt, 1e-3);
    lane.wheel += moved / (16 * lane.style.scale);
    lane.flame = Math.max(0, lane.flame - dt * 1.6);
  }
  ctx.drawImage(trackLayer, 0, 0);
  for (let i = state.lanes.length - 1; i >= 0; i--) drawLane(state.lanes[i], now);
  drawOverlay(now);
  updateClocks(now);
  requestAnimationFrame(frame);
}

syncControls();
init();
requestAnimationFrame(frame);

// Opt-in hook for automated testing: http://127.0.0.1:3000/duel.html?debug
if (new URLSearchParams(location.search).has("debug")) {
  window.lunaDuel = { state };
}
