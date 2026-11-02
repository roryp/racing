// Load test bots. Each bot is a headless LUNA GP player: it runs the game's own race simulation
// (public/js) in real time and calls the game server exactly like the browser does: rival
// decisions on the rivals' own schedule, a Race Control review after contact with a rival, and a
// debrief after every race.

import { readdirSync, readFileSync } from "node:fs";
import { DecisionsApi } from "../public/js/api.js";
import { CAR_LENGTH, CENTRIFUGAL, MAX_SPEED, STEP } from "../public/js/config.js";
import { RaceControl } from "../public/js/control.js";
import { Race } from "../public/js/race.js";
import { RivalBrains } from "../public/js/rivals.js";
import { summarize } from "../public/js/stats.js";
import { Track } from "../public/js/track.js";

// A 3-lap race takes about 2.5 minutes; bots join at a random point in their first race.
const SECONDS_PER_LAP = 50;
const ERROR_REASONS = ["busy", "rateLimited", "dailyLimit", "upstream", "timeout", "network", "other"];

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (v, digits = 0) => (Number.isFinite(v) ? Number(v.toFixed(digits)) : null);

/** Drives the player's car: slows for corners, follows the inside line, steers around cars ahead. */
export function botDriver(race) {
  const { player: p, track } = race;
  const curve = track.maxCurveAhead(p.progress, 40);
  const safe = curve > 0 ? 1 / (CENTRIFUGAL * curve) + 0.22 : 2;
  const speedPct = p.speed / MAX_SPEED;
  let target = clamp(track.avgCurveAhead(p.progress, 30) * 0.1, -0.5, 0.5);
  const block = race.blocker(p, CAR_LENGTH * 4);
  if (block) target = block.car.offset > 0 ? block.car.offset - 0.6 : block.car.offset + 0.6;
  return {
    left: p.offset > target + 0.04,
    right: p.offset < target - 0.04,
    up: speedPct < safe,
    down: speedPct > safe + 0.08,
    nitro: curve < 2 && p.nitro > 0.6,
  };
}

/** Why a call failed, from the game server's HTTP status (0: no answer) and error message. */
export function failureReason(status, message = "") {
  if (status === 429) {
    if (/in flight/i.test(message)) return "busy";
    if (/daily/i.test(message)) return "dailyLimit";
    return "rateLimited";
  }
  if (status === 0) return /timed out/i.test(message) ? "timeout" : "network";
  if (status >= 500) return "upstream";
  return "other";
}

/**
 * The browser's API client (same routes and timeouts), pointed at a game server URL. Reports every
 * call to `onCall`: when it was sent and answered, the tokens it used and why it failed.
 */
export class BotApi extends DecisionsApi {
  constructor({ baseUrl, onCall = null, fetchImpl = (...args) => globalThis.fetch(...args) }) {
    super();
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.onCall = onCall;
    this.fetchImpl = fetchImpl;
  }

  async post(url, payload, timeoutMs) {
    const start = performance.now();
    let status = 0;
    let data = {};
    let error = null;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${url}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = res.status;
      data = await res.json().catch(() => ({}));
      if (!res.ok) error = data.error || `HTTP ${res.status}`;
    } catch (err) {
      error = err?.name === "TimeoutError" ? "Request timed out" : "Game server unreachable";
    }
    const end = performance.now();
    this.onCall?.({
      kind: url.split("/").pop(),
      start,
      end,
      ok: !error,
      status,
      reason: error ? failureReason(status, error) : null,
      inputTokens: error ? null : (data.inputTokens ?? null),
      modelMs: error ? null : (data.latencyMs ?? null),
    });
    if (error) throw Object.assign(new Error(error), { status });
    return { ...data, roundTripMs: Math.round(end - start) };
  }
}

/** A headless player who races back to back, like someone who keeps pressing "Race again". */
export class BotPlayer {
  constructor({ track, api, laps = 3, difficulty = "normal", betweenRacesMs = 5000, onDecision = null }) {
    Object.assign(this, { track, api, laps, difficulty, betweenRacesMs, onDecision });
    this.race = null;
    this.brains = null;
    this.control = null;
    this.live = false;
    this.stopped = false;
    this.nextRaceAt = null;
    this.accumulator = 0;
  }

  /**
   * Starts racing. With `joinAtS`, the first race is driven offline (no API calls) to that many
   * seconds in, so a group of bots mixes race starts, mid-race traffic and finishes.
   */
  start(joinAtS = 0) {
    this.newRace();
    if (joinAtS > 0 && !this.fastForward(joinAtS)) this.newRace();
    this.live = true;
  }

  stop() {
    this.stopped = true;
    this.brains?.stop();
    this.control?.stop();
  }

  newRace() {
    const race = new Race({ track: this.track, laps: this.laps, difficulty: this.difficulty });
    this.race = race;
    this.brains = new RivalBrains({
      race,
      api: this.api,
      mode: "api",
      onDecision: (car) => {
        if (this.live) this.onDecision?.(car.brain.source);
      },
    });
    this.control = new RaceControl({ race, api: this.api, enabled: true, captureFrame: () => null });
    this.accumulator = 0;
    race.startCountdown();
  }

  /** Drives the current race offline for `seconds`; false if it finished meanwhile. */
  fastForward(seconds) {
    const { race, brains } = this;
    brains.mode = "local";
    let clockMs = 0;
    for (let i = 0; i < seconds / STEP && race.phase !== "finished"; i++) {
      race.update(STEP, botDriver(race));
      clockMs += STEP * 1000;
      brains.update(clockMs);
      race.drainEvents();
    }
    if (race.phase === "finished") return false;
    brains.mode = "api";
    // Mid-race, the rivals' next decisions are spread out rather than all due at once.
    const now = performance.now();
    for (const car of race.rivals) car.brain.nextAt = now + Math.random() * 1400;
    return true;
  }

  /** Advances the race by `dt` seconds of wall-clock time in fixed steps, like the browser's game loop. */
  tick(dt) {
    if (this.stopped) return;
    if (this.nextRaceAt !== null) {
      if (performance.now() < this.nextRaceAt) return;
      this.nextRaceAt = null;
      this.newRace();
    }
    const race = this.race;
    this.accumulator += Math.min(dt, 0.1);
    while (this.accumulator >= STEP && race.phase !== "finished") {
      this.accumulator -= STEP;
      race.update(STEP, botDriver(race));
      this.brains.update(performance.now());
      for (const event of race.drainEvents()) {
        if (event.type === "contact") this.control.review(event.incident);
        else if (event.type === "classified") this.finish(race);
      }
    }
  }

  /** Like the results screen: wait (up to 6 s) for Race Control's verdicts, then ask for the debrief. */
  async finish(race) {
    const control = this.control;
    const deadline = performance.now() + 6000;
    while (control.pending > 0 && performance.now() < deadline && !this.stopped) await sleep(200);
    if (this.stopped) return;
    await this.api.debrief(race.summary()).catch(() => {});
    if (!this.stopped && race === this.race) this.nextRaceAt = performance.now() + this.betweenRacesMs;
  }
}

/**
 * Summarizes the calls answered (or failed) and the rival decisions made between `from` and `to`
 * (performance.now() times) while `players` bots were racing.
 */
export function summarizeWindow({ calls, decisions = [], from, to, players }) {
  const minutes = (to - from) / 60_000;
  const inWindow = calls.filter((c) => c.end >= from && c.end < to);
  const answered = inWindow.filter((c) => c.ok);
  const errors = Object.fromEntries(ERROR_REASONS.map((reason) => [reason, 0]));
  for (const c of inWindow) if (!c.ok) errors[c.reason in errors ? c.reason : "other"]++;
  const byKind = {};
  for (const c of inWindow) byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
  // Calls that reached the model: answered, or refused/failed by Azure rather than by the game server.
  const modelCalls = answered.length + errors.rateLimited + errors.upstream;
  const tokens = answered.reduce((sum, c) => sum + (c.inputTokens ?? 0), 0);
  // Little's law: the server holds each answered call for about the model's latency.
  const inFlightMs = answered.reduce((sum, c) => sum + (c.modelMs ?? 0), 0);
  const made = decisions.filter((d) => d.t >= from && d.t < to);
  const latency = (values) => {
    const s = summarize(values);
    return { p50: round(s.p50), p90: round(s.p90), mean: round(s.mean) };
  };
  return {
    players,
    seconds: round((to - from) / 1000, 1),
    requests: inWindow.length,
    answered: answered.length,
    errors,
    byKind,
    modelCallsPerMin: round(modelCalls / minutes, 1),
    tokensPerMin: round(tokens / minutes),
    tokensPerCall: answered.length ? round(tokens / answered.length, 1) : null,
    modelMs: latency(answered.map((c) => c.modelMs)),
    roundTripMs: latency(answered.map((c) => c.end - c.start)),
    serverInFlight: round(inFlightMs / (to - from), 2),
    decisions: {
      model: made.filter((d) => d.source === "api").length,
      fallback: made.filter((d) => d.source !== "api").length,
    },
  };
}

/** CPU seconds a Linux process has used (user + system), or null when it can't be read. */
export function processCpuSeconds(pid, read = readFileSync) {
  try {
    const stat = read(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return (Number(fields[11]) + Number(fields[12])) / 100; // utime + stime, in USER_HZ ticks
  } catch {
    return null;
  }
}

/** On Linux, the PID of the game server (`node … server.js`) running next to the bots, if any. */
export function findServerPid({ platform = process.platform, list = readdirSync, read = readFileSync } = {}) {
  if (platform !== "linux") return null;
  for (const entry of list("/proc")) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      const args = read(`/proc/${entry}/cmdline`, "utf8").split("\0").filter(Boolean);
      if (/(^|\/)node$/.test(args[0] ?? "") && args.slice(1).some((a) => /(^|\/)server\.js$/.test(a))) return Number(entry);
    } catch {
      // The process ended or isn't ours to read.
    }
  }
  return null;
}

function cpuSample(serverPid) {
  return { wall: performance.now(), self: process.cpuUsage(), server: serverPid ? processCpuSeconds(serverPid) : null };
}

/** CPU used between two samples, as % of one core (the game server is a single Node.js thread). */
function cpuBetween(a, b) {
  const wallS = (b.wall - a.wall) / 1000;
  const selfS = (b.self.user - a.self.user + b.self.system - a.self.system) / 1e6;
  return {
    serverCpuPct: a.server !== null && b.server !== null ? round(((b.server - a.server) / wallS) * 100, 1) : null,
    botCpuPct: round((selfS / wallS) * 100, 1),
  };
}

/** Follows redirects (such as a short link) to the game server's origin, then reads its /api/status. */
export async function resolveTarget(target, { fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  const res = await fetchImpl(target, { signal: AbortSignal.timeout(15_000) });
  await res.text();
  const baseUrl = new URL(res.url || target).origin;
  const statusRes = await fetchImpl(`${baseUrl}/api/status`, { signal: AbortSignal.timeout(15_000) });
  return { baseUrl, status: await statusRes.json() };
}

/** Median round trip of GET /api/status, after one call to open the connection: the network distance. */
export async function networkRoundTrip(baseUrl, { samples = 10, fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  const times = [];
  for (let i = 0; i <= samples; i++) {
    const start = performance.now();
    const res = await fetchImpl(`${baseUrl}/api/status`, { signal: AbortSignal.timeout(10_000) });
    await res.text();
    if (i > 0) times.push(performance.now() - start);
  }
  return round(summarize(times).p50, 1);
}

/**
 * Races bots against the game server at `baseUrl`, one step per entry in `players` (bots are added
 * or removed between steps), and measures each step after `settleSeconds`. `onProgress` gets a
 * status line about once a second; `shouldStop()` ends the run early with the steps measured so far.
 */
export async function runLoadTest({
  baseUrl,
  players = [1, 2, 4, 8],
  stepSeconds = 60,
  settleSeconds = 5,
  betweenRacesSeconds = 5,
  laps = 3,
  serverPid = null,
  fetchImpl,
  onProgress = null,
  shouldStop = () => false,
}) {
  const calls = [];
  const decisions = [];
  const track = new Track();
  const api = new BotApi({ baseUrl, fetchImpl, onCall: (call) => calls.push(call) });
  const bots = [];
  const steps = [];
  let stopReason = null;

  let last = performance.now();
  const ticker = setInterval(() => {
    const now = performance.now();
    for (const bot of bots) bot.tick((now - last) / 1000);
    last = now;
  }, 1000 / 60);

  // Waits `ms`, reporting progress each second; false when the run should end early.
  const wait = async (ms, status) => {
    const until = performance.now() + ms;
    while (performance.now() < until) {
      if (shouldStop()) {
        stopReason ??= "stopped";
        return false;
      }
      if (calls.some((c) => c.reason === "dailyLimit")) {
        stopReason = "the game server's daily call limit was reached";
        return false;
      }
      await sleep(Math.min(1000, until - performance.now()));
      onProgress?.(status(until - performance.now()));
    }
    return true;
  };
  const recent = () => {
    const since = performance.now() - 10_000;
    const window = calls.filter((c) => c.end >= since);
    return { perMin: window.length * 6, failed: window.filter((c) => !c.ok).length };
  };

  try {
    for (const count of players) {
      while (bots.length > count) bots.pop().stop();
      while (bots.length < count) {
        const bot = new BotPlayer({
          track,
          api,
          laps,
          betweenRacesMs: betweenRacesSeconds * 1000,
          onDecision: (source) => decisions.push({ t: performance.now(), source }),
        });
        bot.start(Math.random() * laps * SECONDS_PER_LAP);
        bots.push(bot);
        await sleep(0);
      }
      const status = (phase) => (leftMs) => {
        const r = recent();
        return `${count} player${count === 1 ? "" : "s"} · ${phase} ${Math.ceil(leftMs / 1000)} s · ${r.perMin} calls/min · ${r.failed} failed in the last 10 s`;
      };
      if (!(await wait(settleSeconds * 1000, status("settling")))) break;
      const from = cpuSample(serverPid);
      const startedAt = new Date().toISOString();
      const finished = await wait((stepSeconds - settleSeconds) * 1000, status("measuring"));
      const to = cpuSample(serverPid);
      if (!finished && to.wall - from.wall < 10_000) break;
      steps.push({
        ...summarizeWindow({ calls, decisions, from: from.wall, to: to.wall, players: count }),
        ...cpuBetween(from, to),
        startedAt,
        complete: finished,
      });
      if (!finished) break;
    }
  } finally {
    clearInterval(ticker);
    for (const bot of bots) bot.stop();
  }
  return { steps, stopReason };
}
