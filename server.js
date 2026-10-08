// LUNA GP server: serves the game, proxies typed questions to the OpenAI
// Decisions API so the API key never reaches the browser, and runs the speed
// duel that times the Decisions API against the Responses API.

import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decisionsContender, OPPONENTS, runContender, SCENARIOS } from "./lib/benchmark.js";
import { createDecisionsClient, DEFAULT_MODEL } from "./lib/decisions.js";
import { resolveApiKey } from "./lib/env.js";
import { OpenAIError } from "./lib/openai.js";
import {
  buildDebriefRequest,
  buildRivalRequest,
  buildStewardRequest,
  parseDebriefDecision,
  parseRivalDecision,
  parseStewardDecision,
} from "./lib/prompts.js";
import { createResponsesClient } from "./lib/responses.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const MODEL = process.env.DECISIONS_MODEL || DEFAULT_MODEL;
const VERBOSE = process.env.LOG_DECISIONS === "1";
const MAX_IN_FLIGHT = 16;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const ROUTES = {
  "/api/rival": { build: buildRivalRequest, parse: parseRivalDecision, maxBytes: 16 * 1024 },
  "/api/steward": { build: buildStewardRequest, parse: parseStewardDecision, maxBytes: 1024 * 1024 },
  "/api/debrief": { build: buildDebriefRequest, parse: parseDebriefDecision, maxBytes: 32 * 1024 },
};

const { key, source: keySource } = resolveApiKey();
const decisions = key
  ? createDecisionsClient({
      apiKey: key,
      model: MODEL,
      baseURL: process.env.OPENAI_BASE_URL || undefined,
      timeoutMs: 8000,
    })
  : null;
const responses = key
  ? createResponsesClient({ apiKey: key, baseURL: process.env.OPENAI_BASE_URL || undefined, timeoutMs: 60_000 })
  : null;
const DUEL_CONTENDERS = [decisionsContender(MODEL), ...OPPONENTS];

const LOOPBACK = ["127.0.0.1", "localhost", "::1"].includes(HOST);
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);

let inFlight = 0;
const stats = { calls: 0, errors: 0, inputTokens: 0, latencyMs: 0 };

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": MIME[".json"],
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function readJson(req, maxBytes) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
      req.resume();
      reject(httpError(415, "Expected Content-Type: application/json"));
      return;
    }
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return reject(httpError(413, "Payload too large"));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(httpError(400, "Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// Only the game page itself may spend the API key: block other origins and DNS rebinding.
function isTrustedRequest(req) {
  const host = req.headers.host ?? "";
  if (LOOPBACK && !ALLOWED_HOSTS.has(host)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function handleDecision(name, route, req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
  if (!isTrustedRequest(req)) return sendJson(res, 403, { error: "Forbidden origin" });
  if (!decisions) return sendJson(res, 503, { error: "OPENAI_API_KEY is not configured on the server" });
  if (inFlight >= MAX_IN_FLIGHT) return sendJson(res, 429, { error: "Too many decisions in flight" });

  let request;
  try {
    request = route.build(await readJson(req, route.maxBytes));
  } catch (err) {
    return sendJson(res, err.status ?? 400, { error: err.message });
  }

  inFlight++;
  try {
    const result = await decisions.create(request);
    stats.calls++;
    stats.latencyMs += result.latencyMs;
    stats.inputTokens += result.usage?.input_tokens ?? 0;
    const parsed = route.parse(result);
    if (VERBOSE) console.log(`[decisions] ${name} ${result.latencyMs}ms ${JSON.stringify(parsed)}`);
    return sendJson(res, 200, {
      ...parsed,
      latencyMs: result.latencyMs,
      processingMs: result.processingMs,
      inputTokens: result.usage?.input_tokens ?? null,
      model: result.model,
    });
  } catch (err) {
    stats.errors++;
    const upstream = err instanceof OpenAIError;
    console.warn(`[decisions] ${name} failed: ${err.message}${upstream && err.status ? ` (HTTP ${err.status})` : ""}`);
    const status = upstream ? (err.status === 429 ? 429 : 502) : 500;
    return sendJson(res, status, { error: err.message, code: upstream ? err.code : null });
  } finally {
    inFlight--;
  }
}

// Speed duel: GET lists the contenders and race situations; POST times one
// contender on one situation. Only the predefined setups can be requested.
async function handleDuel(req, res) {
  if (req.method === "GET") {
    return sendJson(res, 200, {
      configured: Boolean(decisions),
      contenders: DUEL_CONTENDERS.map(({ id, api, model, reasoning, label, short, detail }) => ({
        id,
        api,
        model,
        reasoning,
        label,
        short,
        detail,
      })),
      scenarios: SCENARIOS.map((s) => s.label),
    });
  }
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
  if (!isTrustedRequest(req)) return sendJson(res, 403, { error: "Forbidden origin" });
  if (!decisions) return sendJson(res, 503, { error: "OPENAI_API_KEY is not configured on the server" });
  if (inFlight >= MAX_IN_FLIGHT) return sendJson(res, 429, { error: "Too many requests in flight" });

  let body;
  try {
    body = await readJson(req, 1024);
  } catch (err) {
    return sendJson(res, err.status ?? 400, { error: err.message });
  }
  const contender = DUEL_CONTENDERS.find((c) => c.id === body?.contender);
  if (!contender) return sendJson(res, 400, { error: "Unknown contender" });
  const scenario = body.scenario;
  if (!Number.isInteger(scenario) || scenario < 0 || scenario >= SCENARIOS.length) {
    return sendJson(res, 400, { error: "Unknown scenario" });
  }

  inFlight++;
  try {
    const result = await runContender({ contender, scenario, decisions, responses });
    if (VERBOSE) console.log(`[duel] ${contender.id} #${scenario} ${result.latencyMs}ms ${JSON.stringify(result.answer)}`);
    return sendJson(res, 200, result);
  } catch (err) {
    const upstream = err instanceof OpenAIError;
    console.warn(`[duel] ${contender.id} failed: ${err.message}${upstream && err.status ? ` (HTTP ${err.status})` : ""}`);
    return sendJson(res, upstream ? (err.status === 429 ? 429 : 502) : 500, { error: err.message });
  } finally {
    inFlight--;
  }
}

async function serveStatic(pathname, req, res) {
  let relative;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    return sendJson(res, 400, { error: "Bad path" });
  }
  if (relative.endsWith("/")) relative += "index.html";
  const filePath = path.resolve(PUBLIC_DIR, `.${relative}`);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: "Forbidden" });

  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (pathname === "/api/status") {
      return sendJson(res, 200, { configured: Boolean(decisions), model: MODEL, keySource });
    }
    if (pathname === "/api/duel") return await handleDuel(req, res);
    const route = ROUTES[pathname];
    if (route) return await handleDecision(pathname.slice(5), route, req, res);
    if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "Method not allowed" });
    return await serveStatic(pathname, req, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: "Internal server error" });
  }
});

server.listen(PORT, HOST, () => {
  const where = `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`;
  console.log(`LUNA GP is running at ${where}`);
  if (decisions) {
    console.log(`Decisions API: enabled (model ${MODEL}, key from ${keySource})`);
    console.log(`Speed duel: ${where}/duel.html`);
  } else {
    console.log("Decisions API: OPENAI_API_KEY not found - rivals will fall back to offline heuristics.");
  }
});

const summary = setInterval(() => {
  if (!stats.calls && !stats.errors) return;
  const avg = stats.calls ? Math.round(stats.latencyMs / stats.calls) : 0;
  const cost = (stats.inputTokens / 1e6) * 0.1;
  console.log(
    `[decisions] ${stats.calls} calls, ${stats.errors} errors, avg ${avg} ms, ${stats.inputTokens} input tokens (~$${cost.toFixed(4)})`,
  );
  Object.assign(stats, { calls: 0, errors: 0, inputTokens: 0, latencyMs: 0 });
}, 30_000);
summary.unref();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
