import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decisionsContender, OPPONENTS, runContender, SCENARIOS } from "../lib/benchmark.js";
import { buildRivalRequest } from "../lib/prompts.js";
import { formatMs, summarize } from "../public/js/stats.js";

const ANSWERS = {
  maneuver: {
    type: "choice",
    name: "maneuver",
    choice: "overtake_left",
    probabilities: [
      { value: "overtake_left", probability: 0.8 },
      { value: "slipstream", probability: 0.2 },
    ],
    confidence: 0.7,
  },
  pace: { type: "score", name: "pace", score: 2.6, probabilities: [], confidence: 0.5 },
  nitro: { type: "predicate", name: "nitro", probability: 0.9 },
};

function fakeDecisions() {
  const sent = [];
  return {
    sent,
    create: async (request) => {
      sent.push(request);
      const answers = Object.fromEntries(request.questions.map((q) => [q.name, ANSWERS[q.name]]));
      return { model: "microsoft-decision-1", answers, usage: { input_tokens: 100, output_tokens: 1 }, latencyMs: 300 };
    },
  };
}

describe("runContender", () => {
  it("asks all three questions in one call for the batched contender", async () => {
    const decisions = fakeDecisions();
    const result = await runContender({ contender: decisionsContender(), scenario: 0, decisions });
    assert.equal(decisions.sent.length, 1);
    assert.equal(decisions.sent[0].questions.length, 3);
    assert.equal(result.calls, 1);
    assert.equal(result.latencyMs, 300);
    assert.equal(result.inputTokens, 100);
    assert.deepEqual(result.answer, { maneuver: "overtake_left", maneuverP: 0.8, pace: 2.6, nitro: 0.9 });
  });

  for (const opponent of OPPONENTS) {
    it(`splits the questions into one call each for ${opponent.id}`, async () => {
      const decisions = fakeDecisions();
      const result = await runContender({ contender: opponent, scenario: 3, decisions });
      assert.equal(decisions.sent.length, 3);
      for (const r of decisions.sent) {
        assert.equal(r.questions.length, 1);
        assert.equal(r.input, buildRivalRequest(SCENARIOS[3].state).input);
      }
      assert.equal(result.calls, 3);
      assert.equal(result.inputTokens, 300);
      assert.deepEqual(result.answer, { maneuver: "overtake_left", maneuverP: 0.8, pace: 2.6, nitro: 0.9 });
    });
  }

  it("rejects unknown race situations", async () => {
    await assert.rejects(
      runContender({ contender: decisionsContender(), scenario: SCENARIOS.length, decisions: null }),
      /Unknown scenario/,
    );
  });

  it("has valid race situations and unique contender ids", () => {
    for (const { label, state } of SCENARIOS) assert.match(buildRivalRequest(state).input, /Driver under review/, label);
    const ids = [decisionsContender(), ...OPPONENTS].map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe("latency stats", () => {
  it("computes percentiles with linear interpolation", () => {
    assert.deepEqual(summarize([500, 100, 300, 200, 400]), { n: 5, p50: 300, p90: 460, mean: 300, min: 100, max: 500 });
  });

  it("ignores missing values and handles empty input", () => {
    assert.equal(summarize([]).p50, null);
    assert.equal(summarize([null, 5, undefined]).p50, 5);
  });

  it("formats milliseconds for people", () => {
    assert.equal(formatMs(305.4), "305 ms");
    assert.equal(formatMs(999.7), "1.00 s");
    assert.equal(formatMs(1620), "1.62 s");
    assert.equal(formatMs(12_345), "12.3 s");
    assert.equal(formatMs(null), "–");
  });
});
