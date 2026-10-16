import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createDecisionsClient,
  indexAnswers,
  OpenAIError,
  refusals,
  summarizeChoice,
  summarizePredicate,
  summarizeScore,
  toFoundryQuestions,
  toState,
} from "../lib/decisions.js";

function fakeFetch(status, body, headers = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
  };
  return { impl, calls };
}

const ENDPOINT = "https://res.cognitiveservices.azure.com/";
const auth = (headers = { Authorization: "Bearer tok" }) => async () => headers;

describe("createDecisionsClient", () => {
  it("posts state and keyed questions to the Foundry systemone endpoint and translates answers back", async () => {
    const { impl, calls } = fakeFetch(
      200,
      {
        model: "microsoft-decision-1",
        answers: {
          nitro: { type: "noul", noul: 0.8 },
          maneuver: { type: "choice", choice: "defend", confidence: 0.5, probabilities: { slip: 0.25, defend: 0.75 } },
          pace: { type: "score", score: 1.4, confidence: 0.3, legend: { 0: "a", 1: "b" }, probabilities: { 1: 0.4, 0: 0.6 } },
        },
        usage: { input_tokens: 123, output_tokens: 3 },
      },
      { "x-request-id": "req_1" },
    );
    const client = createDecisionsClient({ endpoint: ENDPOINT, getHeaders: auth(), fetchImpl: impl });
    const questions = [
      { type: "predicate", name: "nitro", instructions: "Fire?" },
      {
        type: "choice",
        name: "maneuver",
        instructions: "Which?",
        choices: [{ value: "defend", description: "Block" }, { value: "slip" }],
      },
      { type: "score", name: "pace", instructions: "How hard?", levels: [{ label: "Low", description: "Easy" }, { label: "High" }] },
    ];
    const result = await client.create({ input: "hello", questions });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://res.cognitiveservices.azure.com/providers/microsoft/v1/systemone");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers.Authorization, "Bearer tok");
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      model: "decision-1-dz",
      state: "hello",
      questions: {
        nitro: { type: "noul", instructions: "Fire?" },
        maneuver: { type: "choice", instructions: "Which?", criteria: { defend: "Block", slip: "slip" } },
        pace: { type: "score", instructions: "How hard?", criteria: ["Low: Easy", "High"] },
      },
    });
    assert.deepEqual(result.answers.nitro, { type: "predicate", name: "nitro", probability: 0.8 });
    assert.deepEqual(summarizeChoice(result.answers.maneuver), {
      choice: "defend",
      confidence: 0.5,
      probabilities: { defend: 0.75, slip: 0.25 },
    });
    assert.deepEqual(summarizeScore(result.answers.pace), {
      score: 1.4,
      confidence: 0.3,
      probabilities: [0.6, 0.4],
      labels: ["Low", "High"],
    });
    assert.equal(result.model, "microsoft-decision-1");
    assert.equal(result.usage.input_tokens, 123);
    assert.equal(result.processingMs, null);
    assert.equal(result.requestId, "req_1");
    assert.ok(result.latencyMs >= 0);
    assert.ok(Number.isFinite(result.startedAt) && result.endedAt >= result.startedAt);
  });

  it("honours a custom deployment and API-key headers", async () => {
    const { impl, calls } = fakeFetch(200, { answers: {} });
    const client = createDecisionsClient({
      endpoint: "http://proxy",
      deployment: "my-dep",
      getHeaders: auth({ "api-key": "k" }),
      fetchImpl: impl,
    });
    await client.create({ input: "x", questions: [] });
    assert.equal(calls[0].url, "http://proxy/providers/microsoft/v1/systemone");
    assert.equal(calls[0].init.headers["api-key"], "k");
    assert.equal(calls[0].init.headers.Authorization, undefined);
    assert.equal(JSON.parse(calls[0].init.body).model, "my-dep");
  });

  it("throws OpenAIError with the API error message on HTTP errors", async () => {
    const { impl } = fakeFetch(401, { error: { message: "Bad token", code: "Unauthorized" } });
    const client = createDecisionsClient({ endpoint: ENDPOINT, getHeaders: auth(), fetchImpl: impl });
    await assert.rejects(client.create({ input: "x", questions: [] }), (err) => {
      assert.ok(err instanceof OpenAIError);
      assert.equal(err.status, 401);
      assert.equal(err.code, "Unauthorized");
      assert.equal(err.message, "Bad token");
      return true;
    });
  });

  it("wraps auth failures, network failures and malformed payloads", async () => {
    const noAuth = createDecisionsClient({
      endpoint: ENDPOINT,
      getHeaders: async () => {
        throw new Error("Run az login");
      },
      fetchImpl: fakeFetch(200, {}).impl,
    });
    await assert.rejects(noAuth.create({ input: "x", questions: [] }), { name: "OpenAIError", code: "auth_error" });

    const failing = createDecisionsClient({
      endpoint: ENDPOINT,
      getHeaders: auth(),
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await assert.rejects(failing.create({ input: "x", questions: [] }), { name: "OpenAIError", code: "network_error" });

    for (const body of ["not json", { answers: [] }]) {
      const garbled = createDecisionsClient({ endpoint: ENDPOINT, getHeaders: auth(), fetchImpl: fakeFetch(200, body).impl });
      await assert.rejects(garbled.create({ input: "x", questions: [] }), /unexpected payload/);
    }
  });

  it("requires an endpoint and an auth header provider", () => {
    assert.throws(() => createDecisionsClient({}), /endpoint is required/);
    assert.throws(() => createDecisionsClient({ endpoint: ENDPOINT }), /getHeaders is required/);
  });
});

describe("toState", () => {
  it("passes text through and flattens message input to its text parts", () => {
    assert.equal(toState("plain"), "plain");
    assert.equal(
      toState([{ role: "user", content: [{ type: "input_text", text: "a" }, { type: "input_image", image_url: "x" }] }]),
      "a",
    );
  });
});

describe("toFoundryQuestions", () => {
  it("rejects unknown question types", () => {
    assert.throws(() => toFoundryQuestions([{ type: "essay", name: "x" }]), /Unsupported question type/);
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
