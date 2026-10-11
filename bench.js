// Command-line speed test: different ways of asking Microsoft-Decision-1 (Foundry) the
// same race situations with the same typed questions.
//
//   npm run bench                         1 batched call vs 3 parallel and 3 sequential single-question calls
//   npm run bench -- --rounds 3           more samples per race situation
//   npm run bench -- --opponents split-parallel
//   npm run bench -- --json               machine-readable output

import { parseArgs } from "node:util";
import { decisionsContender, OPPONENTS, runContender, SCENARIOS } from "./lib/benchmark.js";
import { createDecisionsClient, MODEL_NAME } from "./lib/decisions.js";
import { foundryAuth, resolveFoundryConfig } from "./lib/foundry.js";
import { formatMs, summarize } from "./public/js/stats.js";

const USAGE = `Usage: npm run bench -- [options]

  --rounds <n>         Times to run each of the ${SCENARIOS.length} race situations (1-10, default 1)
  --opponents <ids>    Comma-separated setups to race against the single batched call
                       Available: ${OPPONENTS.map((o) => o.id).join(", ")} (default: all)
  --json               Print the results as JSON`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      rounds: { type: "string", default: "1" },
      opponents: { type: "string", default: OPPONENTS.map((o) => o.id).join(",") },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  }));
} catch (err) {
  fail(`${err.message}\n\n${USAGE}`);
}
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const rounds = Number(args.rounds);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) fail("--rounds must be a whole number from 1 to 10");

const opponents = [];
for (const id of args.opponents.split(",").map((s) => s.trim()).filter(Boolean)) {
  const opponent = OPPONENTS.find((o) => o.id === id);
  if (!opponent) fail(`Unknown opponent "${id}". Available: ${OPPONENTS.map((o) => o.id).join(", ")}`);
  opponents.push(opponent);
}
if (!opponents.length) fail("Pick at least one opponent.");

const foundry = resolveFoundryConfig();
if (!foundry.endpoint) fail("FOUNDRY_ENDPOINT is not set.");

const clients = {
  decisions: createDecisionsClient({
    endpoint: foundry.endpoint,
    deployment: foundry.deployment,
    getHeaders: foundryAuth(foundry),
    timeoutMs: 30_000,
  }),
};
const contenders = [decisionsContender(MODEL_NAME), ...opponents];

const say = (text = "") => {
  if (!args.json) console.log(text);
};
const showProgress = !args.json && process.stdout.isTTY;
const progress = (text) => {
  if (showProgress) process.stdout.write(`\r${text.padEnd(110).slice(0, 110)}`);
};

function shuffled(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function attempt(contender, scenario) {
  try {
    return await runContender({ contender, scenario, ...clients });
  } catch (err) {
    return { error: err.message };
  }
}

say(`\nLUNA GP speed test · ${MODEL_NAME} (${foundry.deployment}) · ${SCENARIOS.length} race situations × ${rounds} round${rounds > 1 ? "s" : ""}`);
say("Each contender gets the same situation and the same 3 questions: a choice (maneuver), a score (pace), a noul (nitro).\n");

// Warm up the HTTPS connections so the TLS handshake doesn't count against anyone.
progress("  warming up connections…");
await Promise.all(contenders.map((c) => attempt(c, 0)));

const runs = new Map(contenders.map((c) => [c.id, []]));
const total = rounds * SCENARIOS.length * contenders.length;
let done = 0;
for (let round = 0; round < rounds; round++) {
  for (let scenario = 0; scenario < SCENARIOS.length; scenario++) {
    // Interleave contenders in random order so network hiccups hit everyone alike.
    for (const contender of shuffled(contenders)) {
      const result = await attempt(contender, scenario);
      runs.get(contender.id).push({ round, scenario, ...result });
      done++;
      progress(`  ${done}/${total} · ${contender.label}: ${result.error ? "error" : formatMs(result.latencyMs)}`);
    }
  }
}
if (showProgress) process.stdout.write(`\r${" ".repeat(110)}\r`);

const mean = (values) => {
  const v = values.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((sum, x) => sum + x, 0) / v.length : null;
};
const reference = runs.get("decisions");
const report = contenders.map((c) => {
  const all = runs.get(c.id);
  const ok = all.filter((r) => !r.error);
  let same = 0;
  let compared = 0;
  if (c.id !== "decisions") {
    for (const r of ok) {
      const ref = reference.find((d) => d.round === r.round && d.scenario === r.scenario && !d.error);
      if (!ref) continue;
      compared++;
      if (ref.answer.maneuver === r.answer.maneuver) same++;
    }
  }
  return {
    id: c.id,
    label: c.label,
    model: c.model,
    calls: all.length,
    errors: all.length - ok.length,
    firstError: all.find((r) => r.error)?.error ?? null,
    latencyMs: summarize(ok.map((r) => r.latencyMs)),
    avgInputTokens: mean(ok.map((r) => r.inputTokens)),
    avgOutputTokens: mean(ok.map((r) => r.outputTokens)),
    sameManeuver: c.id === "decisions" ? null : { same, compared },
  };
});
const base = report[0];
for (const r of report.slice(1)) {
  r.speedup = base.latencyMs.p50 && r.latencyMs.p50 ? r.latencyMs.p50 / base.latencyMs.p50 : null;
}

if (args.json) {
  console.log(JSON.stringify({ rounds, scenarios: SCENARIOS.length, contenders: report }, null, 2));
} else {
  const header = ["Contender", "median", "p90", "fastest", "tokens in/out", "same move", "errors"];
  const rows = report.map((r) => [
    r.label,
    formatMs(r.latencyMs.p50),
    formatMs(r.latencyMs.p90),
    formatMs(r.latencyMs.min),
    r.avgInputTokens === null ? "–" : `${Math.round(r.avgInputTokens)} / ${Math.round(r.avgOutputTokens ?? 0)}`,
    r.sameManeuver ? `${r.sameManeuver.same}/${r.sameManeuver.compared}` : "–",
    String(r.errors),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cells) => `  ${cells.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join("   ")}`;
  say(line(header));
  say(`  ${widths.map((w) => "─".repeat(w)).join("   ")}`);
  for (const row of rows) say(line(row));
  say();
  for (const r of report.slice(1)) {
    if (!r.speedup) {
      say(`  ✗ ${r.label}: no successful calls (${r.firstError ?? "unknown error"})`);
    } else if (r.speedup >= 1) {
      say(`  ⚡ ${base.label} was ${r.speedup.toFixed(1)}× faster than ${r.label} (median ${formatMs(base.latencyMs.p50)} vs ${formatMs(r.latencyMs.p50)})`);
    } else {
      say(`  ${r.label} was ${(1 / r.speedup).toFixed(1)}× faster than ${base.label} (median ${formatMs(r.latencyMs.p50)} vs ${formatMs(base.latencyMs.p50)})`);
    }
  }
  say();
  say("  median / p90 / fastest: full round trip from this machine, including the network");
  say("  same move: how often the opponent picked the same top maneuver as the single batched call");
  for (const r of report.filter((x) => x.errors)) say(`  ! ${r.label}: ${r.errors} failed call(s), e.g. ${r.firstError}`);
  say();
}
if (!base.latencyMs.n) process.exitCode = 1;
