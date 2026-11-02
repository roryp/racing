// Command-line load test: races bot players against a LUNA GP game server, stepping up how many
// race at once, then charts how many players the model deployment and the game server can take.
//
//   npm run loadtest -- --target https://aka.ms/racing --label "From Johannesburg" --out far.json
//   npm run loadtest -- chart near.json far.json --rpm 10200 --tpm 10200000 --out load-test.svg

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { busiestStep, predictCapacity } from "./lib/capacity.js";
import { renderCapacityChart } from "./lib/capacity-chart.js";
import { DEFAULT_DAILY_CALL_LIMIT, MAX_IN_FLIGHT } from "./lib/limits.js";
import { findServerPid, networkRoundTrip, resolveTarget, runLoadTest } from "./lib/loadtest.js";
import { formatMs } from "./public/js/stats.js";

// For the up-front estimate only: a race makes roughly this many model calls a minute.
const CALLS_PER_PLAYER_MINUTE = 250;

const USAGE = `Usage:
  npm run loadtest -- [run] [options]              Race bots against a game server and save the results
  npm run loadtest -- chart <results.json>... [options]
                                                   Chart one or two saved runs (e.g. near and far)

Run options:
  --target <url>        Game server (default http://127.0.0.1:3000); redirects such as short links are followed
  --players <list>      Players racing at once, one step each (default 1,2,4,8)
  --step <s>            Seconds per step (default 60), of which the first --settle seconds aren't measured
  --settle <s>          Seconds to let each step settle (default 5)
  --between <s>         Seconds a bot waits between races, on the results screen (default 5)
  --label <text>        Name for where the bots ran, on the chart (default "From this machine")
  --where <text>        How the bots reached the server, for the chart's footnote (default "bots on this machine")
  --out <file>          Results file (default load-test.json)

Chart options:
  --rpm <n>             The model deployment's requests per minute
  --tpm <n>             Its tokens per minute (optional)
  --margin <percent>    Share of the deployment's capacity kept free (default 20)
  --max-in-flight <n>   The game server's in-flight cap (default ${MAX_IN_FLIGHT}, as in lib/limits.js)
  --max-rejected <percent>
                        Share of calls the game server may turn away when it's full (default 1)
  --before <file>       The closest run repeated under the server's previous limits, to compare with
  --before-max-in-flight <n>
                        The game server's in-flight cap during the --before run
  --title, --subtitle, --footer <text>
  --bare                Leave out the title, subtitle and footer and crop to the panels, for a slide with its own title
  --background <color>  Background colour, e.g. #07071a to match the slide deck (default #1b1b1f)
  --no-png              Don't save a PNG next to the SVG (it needs Microsoft Edge or Google Chrome)
  --out <file.svg>      Chart file (default load-test.svg)`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      target: { type: "string", default: "http://127.0.0.1:3000" },
      players: { type: "string", default: "1,2,4,8" },
      step: { type: "string", default: "60" },
      settle: { type: "string", default: "5" },
      between: { type: "string", default: "5" },
      label: { type: "string", default: "From this machine" },
      where: { type: "string", default: "bots on this machine" },
      out: { type: "string" },
      rpm: { type: "string" },
      tpm: { type: "string" },
      margin: { type: "string", default: "20" },
      "max-in-flight": { type: "string", default: String(MAX_IN_FLIGHT) },
      "max-rejected": { type: "string", default: "1" },
      before: { type: "string" },
      "before-max-in-flight": { type: "string" },
      title: { type: "string" },
      subtitle: { type: "string" },
      footer: { type: "string" },
      bare: { type: "boolean", default: false },
      background: { type: "string", default: "#1b1b1f" },
      "no-png": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
} catch (err) {
  fail(`${err.message}\n\n${USAGE}`);
}
const { values: args, positionals } = parsed;
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

function number(name, { min = 0, max = Infinity, integer = false } = {}) {
  const value = Number(args[name]);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    fail(`--${name} must be ${integer ? "a whole number" : "a number"} from ${min}${Number.isFinite(max) ? ` to ${max}` : " up"}`);
  }
  return value;
}

const fmt = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString("en-US") : "–");
const pct = (v) => (Number.isFinite(v) ? `${v < 10 ? v.toFixed(1) : Math.round(v)}%` : "–");

function printTable(steps) {
  const header = ["players", "calls/min", "per player", "tokens/call", "model p50", "round trip p50", "in flight", "failed", "server CPU"];
  const rows = steps.map((s) => {
    const failed = Object.values(s.errors).reduce((sum, n) => sum + n, 0);
    return [
      String(s.players),
      fmt(s.modelCallsPerMin),
      fmt(s.modelCallsPerMin / s.players),
      fmt(s.tokensPerCall),
      formatMs(s.modelMs.p50),
      formatMs(s.roundTripMs.p50),
      s.serverInFlight.toFixed(1),
      failed ? `${failed} (${Object.entries(s.errors).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(", ")})` : "0",
      pct(s.serverCpuPct),
    ];
  });
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => `  ${cells.map((c, i) => c.padStart(widths[i])).join("   ")}`;
  console.log(line(header));
  console.log(`  ${widths.map((w) => "─".repeat(w)).join("   ")}`);
  for (const row of rows) console.log(line(row));
}

async function run() {
  const players = args.players.split(",").map((s) => Number(s.trim()));
  if (!players.length || players.some((n) => !Number.isInteger(n) || n < 1 || n > 200)) fail("--players must list whole numbers from 1 to 200");
  const stepSeconds = number("step", { min: 15, max: 3600 });
  const settleSeconds = number("settle", { min: 0, max: stepSeconds - 10 });
  const betweenRacesSeconds = number("between", { min: 0, max: 600 });
  const out = args.out ?? "load-test.json";

  let target;
  try {
    target = await resolveTarget(args.target);
  } catch (err) {
    fail(`Can't reach the game server at ${args.target}: ${err.message}`);
  }
  if (!target.status?.configured) fail("The game server has no model configured (FOUNDRY_ENDPOINT), so bots would only test offline heuristics.");
  let rttMs;
  try {
    rttMs = await networkRoundTrip(target.baseUrl);
  } catch (err) {
    fail(`Can't time the round trip to the game server: ${err.message}`);
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(new URL(target.baseUrl).hostname);
  const serverPid = loopback ? findServerPid() : null;

  const estimate = players.reduce((sum, n) => sum + (n * stepSeconds * CALLS_PER_PLAYER_MINUTE) / 60, 0);
  const minutes = (players.length * stepSeconds) / 60;
  console.log(`\nLUNA GP load test · ${args.target} · ${target.status.model} · ${formatMs(rttMs)} away`);
  console.log(`Steps: ${players.join(", ")} players, ${stepSeconds} s each (about ${minutes.toFixed(1)} minutes).`);
  console.log(
    `Expect about ${fmt(estimate)} model calls: ${Math.round((estimate / DEFAULT_DAILY_CALL_LIMIT) * 100)}% of the server's default daily cap of ${fmt(DEFAULT_DAILY_CALL_LIMIT)}.`,
  );
  console.log(serverPid ? `Measuring the CPU of the game server (PID ${serverPid}).\n` : "Server CPU isn't measured (only when the bots run next to the game server, on Linux).\n");

  let stopRequested = false;
  process.once("SIGINT", () => {
    stopRequested = true;
    console.log("\nStopping after this step's measurements so far…");
  });
  const showProgress = process.stdout.isTTY;
  let lastLog = 0;
  const startedAt = new Date().toISOString();
  const { steps, stopReason } = await runLoadTest({
    baseUrl: target.baseUrl,
    players,
    stepSeconds,
    settleSeconds,
    betweenRacesSeconds,
    serverPid,
    shouldStop: () => stopRequested,
    onProgress: (status) => {
      if (showProgress) process.stdout.write(`\r  ${status.padEnd(100).slice(0, 100)}`);
      else if (performance.now() - lastLog > 15_000) {
        lastLog = performance.now();
        console.log(`  ${status}`);
      }
    },
  });
  if (showProgress) process.stdout.write(`\r${" ".repeat(104)}\r`);

  const results = {
    tool: "luna-gp-loadtest",
    version: 1,
    label: args.label,
    where: args.where,
    target: args.target,
    model: target.status.model,
    networkRttMs: rttMs,
    startedAt,
    settings: { players, stepSeconds, settleSeconds, betweenRacesSeconds, laps: 3 },
    host: { cpus: os.cpus().length, node: process.version, serverCpuMeasured: Boolean(serverPid) },
    stopReason,
    steps,
  };
  mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);

  if (steps.length) printTable(steps);
  if (stopReason) console.log(`\n  Stopped early: ${stopReason}.`);
  console.log(`\n  calls/min: model calls a minute (answered, or refused by Azure); in flight: the server's average calls in flight`);
  console.log(`  Saved ${out}\n`);
  if (!steps.length) process.exitCode = 1;
}

/** Microsoft Edge or Google Chrome, to turn the SVG into a PNG; null when neither is installed. */
function findBrowser() {
  const env = process.env;
  const candidates =
    process.platform === "win32"
      ? [
          `${env["ProgramFiles(x86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
          `${env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
          `${env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
          `${env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
        ]
      : process.platform === "darwin"
        ? ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
        : ["/usr/bin/microsoft-edge", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find((p) => !p.startsWith("undefined") && existsSync(p)) ?? null;
}

/** Renders the SVG at 2× with a headless browser; returns the PNG's path, or null. */
function savePng(svgPath, { width, height }) {
  const browser = findBrowser();
  if (!browser) return null;
  const pngPath = path.resolve(svgPath.replace(/\.svg$/i, "") + ".png");
  rmSync(pngPath, { force: true });
  const profile = mkdtempSync(path.join(os.tmpdir(), "lunagp-chart-"));
  try {
    execFileSync(
      browser,
      [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-first-run",
        `--user-data-dir=${profile}`,
        "--force-device-scale-factor=2",
        `--window-size=${width},${height}`,
        `--screenshot=${pngPath}`,
        pathToFileURL(path.resolve(svgPath)).href,
      ],
      { stdio: "ignore", timeout: 60_000 },
    );
  } catch {
    // Reported below as "no PNG".
  } finally {
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // A browser process may still hold its temporary profile; it's in the temp folder either way.
    }
  }
  return existsSync(pngPath) ? pngPath : null;
}

/** Reads a results file, including one saved by Windows PowerShell's `>` (UTF-16) or with a byte-order mark. */
function readResults(file) {
  const bytes = readFileSync(file);
  const text = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.toString("utf16le") : bytes.toString("utf8");
  return JSON.parse(text.replace(/^\uFEFF/, ""));
}

function chart() {
  const files = positionals.slice(1);
  if (files.length < 1 || files.length > 2) fail(`Chart one or two results files.\n\n${USAGE}`);
  const runs = files.map((file) => {
    try {
      return readResults(file);
    } catch (err) {
      return fail(`Can't read ${file}: ${err.message}`);
    }
  });
  for (const [i, r] of runs.entries()) if (!r?.steps?.length) fail(`${files[i]} has no measured steps.`);
  // The run closest to the server makes the most calls per player: it sets the prediction.
  runs.sort((a, b) => a.networkRttMs - b.networkRttMs);
  const [near, far = null] = runs;

  if (!args.rpm && !args.tpm) fail("Give the model deployment's limits: --rpm (requests per minute) and optionally --tpm.");
  if (!/^#[0-9a-f]{6}$/i.test(args.background)) fail("--background must be a colour like #07071a");
  const limits = {
    rpm: args.rpm ? number("rpm", { min: 1 }) : null,
    tpm: args.tpm ? number("tpm", { min: 1 }) : null,
    margin: number("margin", { min: 0, max: 90 }) / 100,
    maxRejected: number("max-rejected", { min: 0, max: 50 }) / 100,
  };
  const prediction = predictCapacity({ near, far, ...limits, maxInFlight: number("max-in-flight", { min: 1, integer: true }) });

  // The same test as `near`, run under the server's previous limits.
  let before = null;
  let beforePrediction = null;
  if (args.before) {
    try {
      before = readResults(args.before);
    } catch (err) {
      fail(`Can't read ${args.before}: ${err.message}`);
    }
    if (!before?.steps?.length) fail(`${args.before} has no measured steps.`);
    if (!args["before-max-in-flight"]) fail("Give --before-max-in-flight: the game server's in-flight cap during the --before run.");
    beforePrediction = predictCapacity({ near: before, ...limits, maxInFlight: number("before-max-in-flight", { min: 1, integer: true }) });
  }

  const s = near.settings ?? {};
  const place = (run) => run.label.replace(/^from\s+/i, "");
  const method = `Full ${s.laps ?? 3}-lap races, ${s.stepSeconds === 60 ? "one minute" : `${s.stepSeconds} s`} per step`;
  const footer =
    args.footer ??
    [
      method,
      `${near.label}: ${near.where}`,
      before ? `Red rings: the same test before, with at most ${beforePrediction.server.maxInFlight} calls in flight` : null,
      far ? `${place(far)}: ${far.where}, ${fmt(far.networkRttMs)} ms away` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  const subtitle =
    args.subtitle ??
    (before
      ? `Full races on the game server · in-flight cap raised from ${beforePrediction.server.maxInFlight} to ${prediction.server.maxInFlight}`
      : `Full races on the game server · ${near.model}`);
  const svg = renderCapacityChart({
    near,
    far,
    before,
    prediction,
    beforePrediction,
    note: busiestStep(near),
    beforeNote: before ? busiestStep(before) : null,
    title: args.title,
    subtitle,
    footer,
    bare: args.bare,
    background: args.background,
  });

  const out = args.out ?? "load-test.svg";
  mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  writeFileSync(out, svg);
  const [, width, height] = /width="(\d+)" height="(\d+)"/.exec(svg);
  const png = args["no-png"] ? null : savePng(out, { width, height });

  const p = prediction;
  console.log(`\nPer player: ${fmt(p.perPlayer)} model calls a minute (${near.label})${far ? `, ${fmt(p.farPerPlayer)} (${far.label})` : ""}`);
  console.log(
    `Azure: ${fmt(p.azure.callsPerMin)} calls a minute (${p.azure.binding} limit${p.azure.callsByTokens ? `; tokens allow ${fmt(p.azure.callsByTokens)}` : ""}) → ${Math.floor(p.azure.players)} players, ${Math.floor(p.afterMargin.players)} after a ${Math.round(p.margin * 100)}% margin${far ? ` (${Math.floor(p.afterMargin.farPlayers)} ${far.label.replace(/^From\b/, "from")})` : ""}`,
  );
  console.log(
    `Game server: at most ${p.server.maxInFlight} calls in flight, ${p.server.inFlightPerPlayer.toFixed(2)} per player on average → ${p.server.players} players with at most ${Math.round(p.server.maxRejected * 100)}% of calls turned away`,
  );
  if (beforePrediction) {
    const turned = (run) => {
      const n = busiestStep(run);
      return n?.turnedAway === null || n?.turnedAway === undefined ? "" : `; ${(n.turnedAway * 100).toFixed(1)}% turned away at ${n.players} players`;
    };
    const b = beforePrediction.server;
    console.log(`  before, at most ${b.maxInFlight} in flight: ${b.players} players${turned(before)}`);
    console.log(`  now, at most ${p.server.maxInFlight} in flight: ${p.server.players} players${turned(near)}`);
  }
  console.log(`Daily cap: ${fmt(DEFAULT_DAILY_CALL_LIMIT)} calls (default) ≈ ${fmt(DEFAULT_DAILY_CALL_LIMIT / p.perPlayer)} player-minutes of racing a day`);
  console.log(`\nSaved ${out}${png ? ` and ${path.relative(process.cwd(), png)}` : " (no PNG: install Microsoft Edge or Google Chrome, or open the SVG in a browser)"}\n`);
}

const command = positionals[0] ?? "run";
if (command === "run") await run();
else if (command === "chart") chart();
else fail(`Unknown command "${command}".\n\n${USAGE}`);
