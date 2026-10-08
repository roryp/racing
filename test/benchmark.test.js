import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decisionsContender, OPPONENTS, runContender, SCENARIOS, toResponsesRequest } from "../lib/benchmark.js";
import { buildRivalRequest, MANEUVER_VALUES } from "../lib/prompts.js";
import { createResponsesClient, parseStructuredOutput } from "../lib/responses.js";
import { formatMs, summarize } from "../public/js/stats.js";

const message = (text) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });

describe("toResponsesRequest", () => {
  const request = buildRivalRequest(SCENARIOS[0].state);

  it("asks the same questions through a strict JSON schema", () => {
    const body = toResponsesRequest(request, { model: "gpt-6-luna", reasoning: "none" });
    assert.equal(body.model, "gpt-6-luna");
    assert.equal(body.input, request.input);
    assert.deepEqual(body.reasoning, { effort: "none" });
    assert.equal(body.store, false);

    const { format } = body.text;
    assert.equal(format.type, "json_schema");
    assert.equal(format.strict, true);
    assert.equal(format.schema.additionalProperties, false);
    assert.deepEqual(format.schema.required, ["maneuver", "pace", "nitro"]);
    assert.deepEqual(format.schema.properties.maneuver, { type: "string", enum: MANEUVER_VALUES });
    assert.deepEqual(format.schema.properties.pace, { type: "integer", enum: [0, 1, 2, 3] });
    assert.deepEqual(format.schema.properties.nitro, { type: "boolean" });
  });

  it("includes every option and level description, like the Decisions request", () => {
    const { instructions } = toResponsesRequest(request, { model: "m", reasoning: "none" });
    for (const q of request.questions) assert.ok(instructions.includes(q.instructions), q.name);
    for (const c of request.questions[0].choices) assert.ok(instructions.includes(c.description), c.value);
    for (const l of request.questions[1].levels) assert.ok(instructions.includes(`${l.label} (${l.description})`), l.label);
  });

  it("leaves reasoning at the model default when none is given", () => {
    assert.equal(toResponsesRequest(request, { model: "m", reasoning: null }).reasoning, undefined);
  });
});

describe("runContender", () => {
  it("normalizes Decisions API answers", async () => {
    const decisions = {
      create: async () => ({
        model: "gpt-6-luna",
        answers: {
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
        },
        usage: { input_tokens: 850, output_tokens: 0 },
        latencyMs: 300,
        processingMs: 90,
      }),
    };
    const result = await runContender({ contender: decisionsContender(), scenario: 0, decisions, responses: null });
    assert.equal(result.api, "decisions");
    assert.equal(result.latencyMs, 300);
    assert.equal(result.processingMs, 90);
    assert.equal(result.inputTokens, 850);
    assert.deepEqual(result.answer, { maneuver: "overtake_left", maneuverP: 0.8, pace: 2.6, nitro: 0.9 });
  });

  it("sends the Responses API the equivalent request and normalizes its JSON", async () => {
    let sent = null;
    const responses = {
      create: async (body) => {
        sent = body;
        return {
          model: "gpt-6-luna",
          output: { maneuver: "slipstream", pace: 3, nitro: true },
          usage: { input_tokens: 700, output_tokens: 28, output_tokens_details: { reasoning_tokens: 0 } },
          latencyMs: 1600,
          processingMs: 1300,
        };
      },
    };
    const opponent = OPPONENTS.find((o) => o.id === "responses-luna");
    const result = await runContender({ contender: opponent, scenario: 3, decisions: null, responses });
    assert.equal(sent.model, "gpt-6-luna");
    assert.equal(sent.input, buildRivalRequest(SCENARIOS[3].state).input);
    assert.equal(result.api, "responses");
    assert.equal(result.outputTokens, 28);
    assert.deepEqual(result.answer, { maneuver: "slipstream", maneuverP: null, pace: 3, nitro: true });
  });

  it("rejects unknown race situations", async () => {
    await assert.rejects(
      runContender({ contender: decisionsContender(), scenario: SCENARIOS.length, decisions: null, responses: null }),
      /Unknown scenario/,
    );
  });

  it("has valid race situations and unique contender ids", () => {
    for (const { label, state } of SCENARIOS) assert.match(buildRivalRequest(state).input, /Driver under review/, label);
    const ids = [decisionsContender(), ...OPPONENTS].map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe("Responses API client", () => {
  it("posts to /v1/responses and parses the structured output", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      const body = {
        status: "completed",
        model: "gpt-6-luna",
        output: [{ type: "reasoning", summary: [] }, message('{"maneuver":"defend","pace":1,"nitro":false}')],
        usage: { input_tokens: 10, output_tokens: 5 },
      };
      return new Response(JSON.stringify(body), { status: 200, headers: { "openai-processing-ms": "120" } });
    };
    const client = createResponsesClient({ apiKey: "sk-test", fetchImpl });
    const result = await client.create({ model: "gpt-6-luna", input: "x" });
    assert.equal(calls[0].url, "https://api.openai.com/v1/responses");
    assert.deepEqual(result.output, { maneuver: "defend", pace: 1, nitro: false });
    assert.equal(result.processingMs, 120);
    assert.equal(result.usage.output_tokens, 5);
  });

  it("reports refusals, incomplete responses and invalid JSON", () => {
    const refusal = { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] };
    assert.throws(() => parseStructuredOutput(refusal), /refused/);
    const incomplete = { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] };
    assert.throws(() => parseStructuredOutput(incomplete), /incomplete: max_output_tokens/);
    assert.throws(() => parseStructuredOutput({ status: "completed", output: [message("{oops")] }), /not valid JSON/);
    assert.throws(() => parseStructuredOutput(null), /unexpected payload/);
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
