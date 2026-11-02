import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { binomialTail, busiestStep, demandSteps, predictCapacity, serverLimitPlayers, slopeThroughOrigin } from "../lib/capacity.js";
import { niceStep, renderCapacityChart, textWidth } from "../lib/capacity-chart.js";
import { BotApi, BotPlayer, failureReason, findServerPid, processCpuSeconds, runLoadTest, summarizeWindow } from "../lib/loadtest.js";
import { buildDebriefRequest, buildRivalRequest, buildStewardRequest } from "../lib/prompts.js";
import { Track } from "../public/js/track.js";

const ANSWER = {
  maneuver: { choice: "racing_line", probabilities: { racing_line: 1 }, confidence: 1 },
  pace: { score: 2, probabilities: [0, 0, 1, 0], labels: null, confidence: 1 },
  nitro: { probability: 0.2 },
  latencyMs: 120,
  inputTokens: 600,
};

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A game server stand-in: answers every route at once and checks the payloads like the real one. */
function fakeServer() {
  const sent = [];
  const fetchImpl = async (url, init) => {
    const route = new URL(url).pathname;
    const body = JSON.parse(init.body);
    sent.push({ route, body });
    const build = { "/api/rival": buildRivalRequest, "/api/steward": buildStewardRequest, "/api/debrief": buildDebriefRequest }[route];
    build(body); // throws on a payload the server would reject
    return json(200, ANSWER);
  };
  return { sent, fetchImpl };
}

describe("BotApi", () => {
  it("posts the browser's payloads to the game server and records each call", async () => {
    const calls = [];
    const { sent, fetchImpl } = fakeServer();
    const api = new BotApi({ baseUrl: "http://game.test/", fetchImpl, onCall: (c) => calls.push(c) });
    const answer = await api.rival({ driver: { name: "Vega", number: 7, personality: "aggressive" } });
    assert.equal(sent[0].route, "/api/rival");
    assert.equal(answer.maneuver.choice, "racing_line");
    assert.ok(Number.isInteger(answer.roundTripMs));
    assert.equal(calls.length, 1);
    assert.deepEqual(
      { kind: calls[0].kind, ok: calls[0].ok, status: calls[0].status, inputTokens: calls[0].inputTokens, modelMs: calls[0].modelMs },
      { kind: "rival", ok: true, status: 200, inputTokens: 600, modelMs: 120 },
    );
    assert.ok(calls[0].end >= calls[0].start);
  });

  it("throws like the browser client and records why a call failed", async () => {
    const calls = [];
    const busy = new BotApi({ baseUrl: "http://game.test", fetchImpl: async () => json(429, { error: "Too many decisions in flight" }), onCall: (c) => calls.push(c) });
    await assert.rejects(busy.rival({}), (err) => err.status === 429 && /in flight/.test(err.message));
    const slow = new BotApi({
      baseUrl: "http://game.test",
      fetchImpl: async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
      onCall: (c) => calls.push(c),
    });
    await assert.rejects(slow.steward({}), (err) => err.status === 0 && err.message === "Request timed out");
    assert.deepEqual(
      calls.map((c) => [c.kind, c.ok, c.reason]),
      [
        ["rival", false, "busy"],
        ["steward", false, "timeout"],
      ],
    );
  });

  it("classifies failures by status and message", () => {
    assert.equal(failureReason(429, "Too many decisions in flight"), "busy");
    assert.equal(failureReason(429, "Daily AI decision limit reached"), "dailyLimit");
    assert.equal(failureReason(429, "Rate limit is exceeded"), "rateLimited");
    assert.equal(failureReason(502, "Foundry decision API returned HTTP 500"), "upstream");
    assert.equal(failureReason(0, "Request timed out"), "timeout");
    assert.equal(failureReason(0, "Game server unreachable"), "network");
    assert.equal(failureReason(400, "Invalid JSON body"), "other");
  });
});

describe("BotPlayer", () => {
  function fakeApi() {
    const calls = { rival: 0, steward: 0, debrief: 0 };
    return {
      calls,
      rival: async (payload) => (calls.rival++, buildRivalRequest(payload), ANSWER),
      steward: async (payload) => (calls.steward++, buildStewardRequest(payload), { responsible: null, severity: { score: 0 } }),
      debrief: async (summary) => (calls.debrief++, buildDebriefRequest(summary), {}),
    };
  }

  it("asks for every rival's first decision as the countdown starts", () => {
    const api = fakeApi();
    const sources = [];
    const bot = new BotPlayer({ track: new Track(), api, onDecision: (source) => sources.push(source) });
    bot.start();
    bot.tick(1 / 30);
    assert.equal(api.calls.rival, 5);
    bot.stop();
  });

  it("joins mid-race without calling the API for the skipped part", () => {
    const api = fakeApi();
    const bot = new BotPlayer({ track: new Track(), api });
    bot.start(60);
    assert.equal(bot.race.phase, "racing");
    assert.ok(bot.race.time > 50, `race time ${bot.race.time}`);
    assert.equal(api.calls.rival, 0);
    for (const car of bot.race.rivals) assert.ok(car.brain.nextAt > performance.now() - 1);
    bot.stop();
  });

  it("races to the flag, asks for the debrief and lines up the next race", async () => {
    const api = fakeApi();
    const bot = new BotPlayer({ track: new Track(), api, betweenRacesMs: 0 });
    bot.start();
    const race = bot.race;
    for (let i = 0; i < 4000 && race.phase !== "finished"; i++) bot.tick(0.1);
    assert.equal(race.phase, "finished");
    for (let i = 0; i < 20 && api.calls.debrief === 0; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(api.calls.debrief, 1);
    assert.notEqual(bot.nextRaceAt, null);
    bot.tick(1 / 60);
    assert.notEqual(bot.race, race, "a new race should start");
    bot.stop();
  });
});

describe("summarizeWindow", () => {
  const call = (end, extra = {}) => ({ kind: "rival", start: end - 200, end, ok: true, status: 200, reason: null, inputTokens: 600, modelMs: 150, ...extra });

  it("counts the calls that ended inside the window, per minute", () => {
    const calls = [
      call(500), // before the window
      call(1_500),
      call(20_000),
      call(40_000, { kind: "steward", inputTokens: 400 }),
      call(50_000, { ok: false, status: 429, reason: "busy", inputTokens: null, modelMs: null }),
      call(55_000, { ok: false, status: 429, reason: "rateLimited", inputTokens: null, modelMs: null }),
      call(61_000), // after the window
    ];
    const decisions = [
      { t: 2_000, source: "api" },
      { t: 3_000, source: "local" },
      { t: 70_000, source: "api" },
    ];
    const s = summarizeWindow({ calls, decisions, from: 1_000, to: 31_000 + 30_000, players: 2 });
    assert.equal(s.seconds, 60);
    assert.equal(s.requests, 5);
    assert.equal(s.answered, 3);
    assert.equal(s.errors.busy, 1);
    assert.equal(s.errors.rateLimited, 1);
    assert.deepEqual(s.byKind, { rival: 4, steward: 1 });
    // Answered calls plus the one Azure refused reached the model; the one the server turned away didn't.
    assert.equal(s.modelCallsPerMin, 4);
    assert.equal(s.tokensPerMin, 1600);
    assert.equal(s.tokensPerCall, 533.3);
    assert.equal(s.modelMs.p50, 150);
    assert.equal(s.roundTripMs.p50, 200);
    assert.equal(s.serverInFlight, 0.01);
    assert.deepEqual(s.decisions, { model: 1, fallback: 1 });
  });
});

describe("game server CPU", () => {
  it("finds the node server.js process and reads its CPU time", () => {
    const files = {
      "/proc/12/cmdline": "bash\0-c\0sleep 1\0",
      "/proc/34/cmdline": "/opt/nodejs/22/bin/node\0/home/site/wwwroot/server.js\0",
      "/proc/34/stat": "34 (node server.js) S 1 34 34 0 -1 4194560 1 0 0 0 7378 774 0 0 20 0 11 0",
    };
    const read = (file) => {
      if (!(file in files)) throw new Error("ENOENT");
      return files[file];
    };
    assert.equal(findServerPid({ platform: "linux", list: () => ["self", "12", "34"], read }), 34);
    assert.equal(findServerPid({ platform: "win32", list: () => ["34"], read }), null);
    assert.equal(processCpuSeconds(34, read), 81.52);
    assert.equal(processCpuSeconds(99, read), null);
  });
});

describe("runLoadTest", () => {
  it("races bots against the server and reports each step", async () => {
    const { sent, fetchImpl } = fakeServer();
    const progress = [];
    const { steps, stopReason } = await runLoadTest({
      baseUrl: "http://game.test",
      players: [1, 2],
      stepSeconds: 1.2,
      settleSeconds: 0.1,
      fetchImpl,
      onProgress: (line) => progress.push(line),
    });
    assert.equal(stopReason, null);
    assert.deepEqual(
      steps.map((s) => s.players),
      [1, 2],
    );
    assert.ok(sent.length >= 5, `only ${sent.length} calls`);
    for (const s of steps) {
      assert.ok(s.answered > 0, `no calls answered with ${s.players} players`);
      assert.equal(s.tokensPerCall, 600);
      assert.equal(s.complete, true);
      assert.ok(Number.isFinite(s.botCpuPct));
      assert.equal(s.serverCpuPct, null);
    }
    assert.ok(progress.some((line) => /measuring/.test(line)));
  });
});

describe("capacity model", () => {
  const run = (perPlayer, extra = {}) => ({
    label: "Next to Azure",
    networkRttMs: 1,
    steps: [1, 2, 4, 8].map((players) => ({
      players,
      answered: perPlayer * players,
      modelCallsPerMin: perPlayer * players,
      tokensPerCall: 600,
      serverInFlight: 0.5 * players,
      modelMs: { p50: players === 8 ? 220 : 200 },
      serverCpuPct: players * 0.5,
      ...extra,
    })),
  });

  it("fits a line through the origin", () => {
    assert.equal(slopeThroughOrigin([{ x: 1, y: 2 }, { x: 2, y: 4 }, { x: 4, y: 8 }]), 2);
    assert.equal(slopeThroughOrigin([{ x: 1, y: 1 }, { x: 2, y: 3 }]), 7 / 5);
    assert.equal(slopeThroughOrigin([]), null);
  });

  it("computes binomial tails", () => {
    assert.equal(binomialTail(3, 0.5, 0), 1);
    assert.equal(binomialTail(3, 0.5, 2), 0.5);
    assert.equal(binomialTail(3, 0.5, 4), 0);
    assert.ok(Math.abs(binomialTail(10, 0.3, 3) - 0.6172) < 1e-4);
  });

  it("finds how many players the in-flight cap allows", () => {
    // 0.1 calls in flight per rival: 16 in flight is rare until about 15 players.
    const players = serverLimitPlayers({ inFlightPerPlayer: 0.5, maxInFlight: 16, maxRejected: 0.01 });
    assert.ok(binomialTail(players * 5 - 1, 0.1, 16) <= 0.01);
    assert.ok(binomialTail((players + 1) * 5 - 1, 0.1, 16) > 0.01);
    assert.ok(players > 10 && players < 32, `${players} players`);
    assert.ok(serverLimitPlayers({ inFlightPerPlayer: 0.5, maxInFlight: 64 }) > players * 3);
    assert.equal(serverLimitPlayers({ inFlightPerPlayer: 0, maxInFlight: 16 }), null);
  });

  it("leaves steps the server's in-flight cap saturated out of the fits", () => {
    const r = run(200);
    r.steps.push({ players: 16, requests: 3200, answered: 2400, errors: { busy: 800 }, modelCallsPerMin: 2400, tokensPerCall: 600, serverInFlight: 4, modelMs: { p50: 200 } });
    assert.deepEqual(
      demandSteps(r).map((s) => s.players),
      [1, 2, 4, 8],
    );
    const p = predictCapacity({ near: r, rpm: 10_200, maxInFlight: 16 });
    assert.equal(p.perPlayer, 200);
    assert.equal(p.server.inFlightPerPlayer, 0.5);
  });

  it("predicts capacity from the closest run and keeps a safety margin", () => {
    const p = predictCapacity({ near: run(200), far: run(160), rpm: 10_200, tpm: 10_200_000, margin: 0.2, maxInFlight: 16 });
    assert.equal(p.perPlayer, 200);
    assert.equal(p.farPerPlayer, 160);
    assert.equal(p.azure.binding, "requests");
    assert.equal(p.azure.callsByTokens, 17_000);
    assert.equal(p.azure.players, 51);
    assert.equal(p.afterMargin.callsPerMin, 8160);
    assert.ok(Math.abs(p.afterMargin.players - 40.8) < 1e-9);
    assert.equal(p.afterMargin.farPlayers, 51);
    assert.equal(p.server.inFlightPerPlayer, 0.5);
    assert.equal(p.server.players, serverLimitPlayers({ inFlightPerPlayer: 0.5, maxInFlight: 16 }));
  });

  it("switches to the token limit when it binds first", () => {
    const p = predictCapacity({ near: run(200), rpm: 10_200, tpm: 3_000_000, maxInFlight: 16 });
    assert.equal(p.azure.binding, "tokens");
    assert.equal(p.azure.callsPerMin, 5000);
    assert.throws(() => predictCapacity({ near: run(200), maxInFlight: 16 }), /requests \(or tokens\) per minute/);
  });

  it("notes latency and CPU at the busiest step", () => {
    const note = busiestStep(run(200));
    assert.equal(note.players, 8);
    assert.ok(Math.abs(note.modelSlower - 0.1) < 1e-9);
    assert.equal(note.serverCpuPct, 4);
  });

  it("draws the chart with the measured and predicted numbers", () => {
    const near = run(200);
    const far = { ...run(160), label: "From Johannesburg", where: "bots on the internet", networkRttMs: 246 };
    const prediction = predictCapacity({ near, far, rpm: 10_200, tpm: 10_200_000, margin: 0.2, maxInFlight: 16 });
    const svg = renderCapacityChart({ near, far, prediction, note: busiestStep(near), subtitle: "Full races & more <live>", footer: "One minute per step" });
    assert.match(svg, /^<svg [^>]*viewBox="0 0 1366 768"/);
    assert.match(svg, /<\/svg>\n$/);
    for (const label of [
      "HOW MANY LUNA GP PLAYERS AT ONCE?",
      "Full races &amp; more &lt;live&gt;",
      "1 MEASURE",
      "2 PREDICT",
      "Next to Azure:",
      "≈ 200 per player",
      "From Johannesburg, 246 ms away:",
      "≈ 160 per player",
      "8 players: Decision-1 10% slower,",
      "server CPU under 5%",
      "Azure capacity ≈ 51 players",
      "SAFETY MARGIN 20%",
      "After margin ≈ 40 players",
      `Game server ≈ ${prediction.server.players} players`,
      "16 calls in flight at most",
      "≈ 160 calls a minute, so ≈ 51 players fit",
      "One minute per step",
    ]) {
      assert.ok(svg.includes(label), `missing "${label}"`);
    }
    assert.doesNotMatch(svg, /NaN|undefined|Infinity/);
    assert.equal((svg.match(/<text /g) ?? []).length, (svg.match(/<\/text>/g) ?? []).length);
    // 4 near and 4 far points measured, then the 4 near points again and 3 limits predicted.
    assert.equal((svg.match(/<circle /g) ?? []).length, 15);
    assert.equal((svg.match(/<circle [^>]*r="5"/g) ?? []).length, 4);
  });

  it("charts a single run", () => {
    const near = run(200);
    const prediction = predictCapacity({ near, rpm: 10_200, maxInFlight: 16 });
    const svg = renderCapacityChart({ near, prediction });
    assert.match(svg, /Azure capacity ≈ 51 players/);
    assert.doesNotMatch(svg, /calls a minute, so|NaN|undefined/);
  });

  it("keeps every point on the canvas when the deployment is small", () => {
    const near = run(200);
    const svg = renderCapacityChart({ near, prediction: predictCapacity({ near, rpm: 500, maxInFlight: 16 }) });
    const circles = [...svg.matchAll(/<circle cx="([-\d.]+)" cy="([-\d.]+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
    assert.ok(circles.length > 0);
    for (const [x, y] of circles) assert.ok(x >= 0 && x <= 1366 && y >= 0 && y <= 768, `point at ${x}, ${y}`);
  });

  it("draws a bare chart for a slide with its own title, on the slide's background", () => {
    const near = run(200);
    const far = { ...run(160), label: "From Johannesburg", where: "bots on the internet", networkRttMs: 246 };
    const prediction = predictCapacity({ near, far, rpm: 10_200, tpm: 10_200_000, maxInFlight: 16 });
    const svg = renderCapacityChart({ near, far, prediction, note: busiestStep(near), subtitle: "Subtitle", footer: "Footer", bare: true, background: "#07071a" });
    assert.match(svg, /^<svg [^>]*width="1312" height="510" viewBox="28 0 1312 510"/);
    for (const gone of ["HOW MANY LUNA GP PLAYERS AT ONCE?", "Subtitle", "Footer", "#1b1b1f"]) assert.ok(!svg.includes(gone), `still has "${gone}"`);
    for (const kept of ["1 MEASURE", "2 PREDICT", "≈ 200 per player", "Azure capacity ≈ 51 players", 'fill="#07071a"']) assert.ok(svg.includes(kept), `missing "${kept}"`);
    assert.ok(!svg.includes("calls a minute, so"), "the far run's note is left out of the shorter panel");
    const circles = [...svg.matchAll(/<circle cx="([-\d.]+)" cy="([-\d.]+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
    for (const [x, y] of circles) assert.ok(x >= 28 && x <= 28 + 1312 && y >= 0 && y <= 510, `point at ${x}, ${y}`);
  });

  it("compares the game server's limits before and after raising its in-flight cap", () => {
    // The same test twice; with the lower cap, a fifth of the calls at 16 players were turned away.
    const test = (busyAt16) => ({
      label: "Next to Azure",
      where: "bots inside the app container",
      networkRttMs: 1,
      steps: [1, 2, 4, 8, 16].map((players) => {
        const requests = 200 * players;
        const busy = players === 16 ? requests * busyAt16 : 0;
        return {
          players,
          requests,
          answered: requests - busy,
          errors: { busy },
          modelCallsPerMin: requests - busy,
          tokensPerCall: 600,
          serverInFlight: 0.8 * players,
          modelMs: { p50: 200 },
          serverCpuPct: players,
        };
      }),
    });
    const after = test(0);
    const before = test(0.2);
    const limits = { rpm: 10_200, tpm: 10_200_000, margin: 0.2 };
    const prediction = predictCapacity({ near: after, ...limits, maxInFlight: 64 });
    const beforePrediction = predictCapacity({ near: before, ...limits, maxInFlight: 16 });
    assert.equal(busiestStep(before).turnedAway, 0.2);
    assert.equal(busiestStep(after).turnedAway, 0);
    assert.ok(beforePrediction.server.players < 16, `${beforePrediction.server.players} players`);
    assert.ok(prediction.server.players > prediction.azure.players, "the higher cap leaves Azure as the limit");

    const svg = renderCapacityChart({
      near: after,
      before,
      prediction,
      beforePrediction,
      note: busiestStep(after),
      beforeNote: busiestStep(before),
    });
    for (const label of [
      "16 players, cap 64: none turned away,",
      "Decision-1 just as fast, server CPU under 20%",
      "16 players, cap 16:",
      "20% of calls turned away",
      `Game server now ≈ ${prediction.server.players} players`,
      "64 calls in flight at most",
      `Game server before ≈ ${beforePrediction.server.players} players`,
      "16 calls in flight at most",
      "now the limit",
    ]) {
      assert.ok(svg.includes(label), `missing "${label}"`);
    }
    assert.equal((svg.match(/r="11" fill="none"/g) ?? []).length, 5, "a red ring for each step measured before");
    assert.doesNotMatch(svg, /NaN|undefined|Infinity/);
    const circles = [...svg.matchAll(/<circle cx="([-\d.]+)" cy="([-\d.]+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
    for (const [x, y] of circles) assert.ok(x >= 0 && x <= 1366 && y >= 0 && y <= 768, `point at ${x}, ${y}`);
  });

  it("sizes text and picks round tick steps", () => {
    assert.ok(textWidth("Azure capacity ≈ 51 players", 17) > 180);
    assert.ok(textWidth("W", 20, true) > textWidth("W", 20));
    assert.equal(niceStep(2140, 5), 500);
    assert.equal(niceStep(11_730, 5), 2500);
    assert.equal(niceStep(62, 7, true), 10);
    assert.equal(niceStep(3, 7, true), 1);
  });
});
