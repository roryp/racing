import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createDecisionsClient,
  DecisionsError,
  indexAnswers,
  refusals,
  summarizeChoice,
  summarizePredicate,
  summarizeScore,
} from "../lib/decisions.js";

function fakeFetch(status, body, headers = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
  };
  return { impl, calls };
}

describe("createDecisionsClient", () => {
  it("posts model, input and questions to /v1/decisions and indexes answers by name", async () => {
    const { impl, calls } = fakeFetch(
      200,
      {
        model: "gpt-6-luna",
        answers: [
          { type: "predicate", name: "nitro", probability: 0.8 },
          { type: "choice", name: "maneuver", choice: "defend", probabilities: [], confidence: 0.5 },
        ],
        usage: { input_tokens: 123 },
      },
      { "openai-processing-ms": "42", "x-request-id": "req_1" },
    );
    const client = createDecisionsClient({ apiKey: "sk-test", fetchImpl: impl });
    const result = await client.create({ input: "hello", questions: [{ type: "predicate", name: "nitro" }] });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.openai.com/v1/decisions");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      model: "gpt-6-luna",
      input: "hello",
      questions: [{ type: "predicate", name: "nitro" }],
    });
    assert.equal(result.answers.nitro.probability, 0.8);
    assert.equal(result.answers.maneuver.choice, "defend");
    assert.equal(result.usage.input_tokens, 123);
    assert.equal(result.processingMs, 42);
    assert.equal(result.requestId, "req_1");
    assert.ok(result.latencyMs >= 0);
  });

  it("honours a custom base URL and model", async () => {
    const { impl, calls } = fakeFetch(200, { answers: [] });
    const client = createDecisionsClient({ apiKey: "k", model: "m", baseURL: "http://proxy/v1/", fetchImpl: impl });
    await client.create({ input: "x", questions: [] });
    assert.equal(calls[0].url, "http://proxy/v1/decisions");
    assert.equal(JSON.parse(calls[0].init.body).model, "m");
  });

  it("throws DecisionsError with the API error message on HTTP errors", async () => {
    const { impl } = fakeFetch(401, { error: { message: "Incorrect API key", code: "invalid_api_key" } });
    const client = createDecisionsClient({ apiKey: "bad", fetchImpl: impl });
    await assert.rejects(client.create({ input: "x", questions: [] }), (err) => {
      assert.ok(err instanceof DecisionsError);
      assert.equal(err.status, 401);
      assert.equal(err.code, "invalid_api_key");
      assert.equal(err.message, "Incorrect API key");
      return true;
    });
  });

  it("wraps network failures and malformed payloads", async () => {
    const failing = createDecisionsClient({
      apiKey: "k",
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await assert.rejects(failing.create({ input: "x", questions: [] }), { name: "DecisionsError", code: "network_error" });

    const { impl } = fakeFetch(200, "not json");
    const garbled = createDecisionsClient({ apiKey: "k", fetchImpl: impl });
    await assert.rejects(garbled.create({ input: "x", questions: [] }), /unexpected payload/);
  });

  it("requires an API key", () => {
    assert.throws(() => createDecisionsClient({}), /apiKey is required/);
  });
});

describe("answer helpers", () => {
  const answers = indexAnswers([
    {
      type: "choice",
      name: "maneuver",
      choice: "slipstream",
      probabilities: [
        { value: "slipstream", probability: 0.7 },
        { value: "defend", probability: 0.3 },
      ],
      confidence: 0.6,
    },
    {
      type: "score",
      name: "pace",
      score: 1.2,
      probabilities: [
        { value: 0, label: "Low", probability: 0.1 },
        { value: 1, label: "Mid", probability: 0.6 },
        { value: 2, label: "High", probability: 0.3 },
      ],
      confidence: 0.4,
    },
    { type: "predicate", name: "nitro", probability: 0.25 },
    { type: "refusal", name: "other" },
  ]);

  it("summarizes choice answers", () => {
    assert.deepEqual(summarizeChoice(answers.maneuver), {
      choice: "slipstream",
      confidence: 0.6,
      probabilities: { slipstream: 0.7, defend: 0.3 },
    });
  });

  it("summarizes score answers with level labels", () => {
    assert.deepEqual(summarizeScore(answers.pace), {
      score: 1.2,
      confidence: 0.4,
      probabilities: [0.1, 0.6, 0.3],
      labels: ["Low", "Mid", "High"],
    });
  });

  it("summarizes predicates and lists refusals", () => {
    assert.deepEqual(summarizePredicate(answers.nitro), { probability: 0.25 });
    assert.deepEqual(refusals(answers), ["other"]);
  });

  it("returns null for missing or mismatched answer types", () => {
    assert.equal(summarizeChoice(answers.nitro), null);
    assert.equal(summarizeScore(undefined), null);
    assert.equal(summarizePredicate(answers.other), null);
  });
});
