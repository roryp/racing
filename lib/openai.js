// Minimal HTTP helper for the Foundry decision client
// (plain fetch, so the game needs no npm dependencies).

export class OpenAIError extends Error {
  constructor(message, { status = 0, code = null } = {}) {
    super(message);
    this.name = "OpenAIError";
    this.status = status;
    this.code = code;
  }
}

/**
 * POST a JSON body and time the full round trip, until the whole response body has arrived.
 * `startedAt` and `endedAt` are the `performance.now()` readings around that round trip.
 * @returns {Promise<{ data: any, latencyMs: number, startedAt: number, endedAt: number,
 *   processingMs: number|null, requestId: string|null }>}
 */
export async function postJson({ url, apiKey, headers, body, timeoutMs, fetchImpl, label = "API" }) {
  const started = performance.now();
  let res;
  let text;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        ...(headers ?? { Authorization: `Bearer ${apiKey}` }),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (err) {
    const timedOut = err?.name === "TimeoutError";
    throw new OpenAIError(timedOut ? `${label} timed out after ${timeoutMs} ms` : `Network error: ${err?.message ?? err}`, {
      code: timedOut ? "timeout" : "network_error",
    });
  }
  const endedAt = performance.now();
  const latencyMs = Math.round(endedAt - started);

  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON; reported below.
  }
  if (!res.ok) {
    throw new OpenAIError(data?.error?.message ?? `${label} returned HTTP ${res.status}`, {
      status: res.status,
      code: data?.error?.code ?? data?.error?.type ?? null,
    });
  }

  const header = res.headers.get("openai-processing-ms");
  const processingMs = header === null ? null : Number(header);
  return {
    data,
    latencyMs,
    startedAt: started,
    endedAt,
    processingMs: Number.isFinite(processingMs) ? processingMs : null,
    requestId: res.headers.get("x-request-id"),
  };
}
