// Minimal client for the Responses API (POST /v1/responses) with Structured
// Outputs. The speed duel and benchmark use it as the "normal API" baseline.

import { OpenAIError, postJson } from "./openai.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export function createResponsesClient({
  apiKey,
  baseURL = DEFAULT_BASE_URL,
  timeoutMs = 60_000,
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  if (!apiKey) throw new Error("createResponsesClient: apiKey is required");
  const url = `${baseURL.replace(/\/+$/, "")}/responses`;

  return {
    /**
     * @param {object} body Responses API request body (expects a `json_schema` text format)
     * @returns {Promise<{ output: any, usage: object|null, model: string, latencyMs: number,
     *   processingMs: number|null, requestId: string|null }>}
     */
    async create(body) {
      const { data, latencyMs, processingMs, requestId } = await postJson({
        url,
        apiKey,
        body,
        timeoutMs,
        fetchImpl,
        label: "Responses API",
      });
      return {
        output: parseStructuredOutput(data),
        usage: data?.usage ?? null,
        model: data?.model ?? body.model,
        latencyMs,
        processingMs,
        requestId,
      };
    },
  };
}

/** Extract and parse the JSON text of a Structured Outputs response. */
export function parseStructuredOutput(data) {
  if (!data || !Array.isArray(data.output)) {
    throw new OpenAIError("Responses API returned an unexpected payload");
  }
  if (data.status && data.status !== "completed") {
    const reason = data.incomplete_details?.reason;
    throw new OpenAIError(`Response ${data.status}${reason ? `: ${reason}` : ""}`, { code: data.status });
  }
  const content = data.output.filter((item) => item.type === "message").flatMap((item) => item.content ?? []);
  const refusal = content.find((part) => part.type === "refusal");
  if (refusal) throw new OpenAIError(`Model refused: ${refusal.refusal}`, { code: "refusal" });
  const text = content
    .filter((part) => part.type === "output_text")
    .map((part) => part.text)
    .join("");
  try {
    return JSON.parse(text);
  } catch {
    throw new OpenAIError("Responses API returned output that is not valid JSON");
  }
}
