// Microsoft Foundry configuration and authentication for the Microsoft-Decision-1 deployment.
// Auth, in order of preference:
//   1. FOUNDRY_API_KEY, when set;
//   2. the managed identity of the hosting Azure App Service (IDENTITY_ENDPOINT / IDENTITY_HEADER);
//   3. the local Azure CLI login (`az login`).
// Entra ID tokens are cached and refreshed shortly before they expire.

import { exec, execFileSync } from "node:child_process";
import { resolveEnv } from "./env.js";

export const DEFAULT_DEPLOYMENT = "decision-1-dz";
const TOKEN_RESOURCE = "https://cognitiveservices.azure.com";
const REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * Resolve FOUNDRY_ENDPOINT, FOUNDRY_DEPLOYMENT and FOUNDRY_API_KEY (process env, then on
 * Windows the persisted user/system environment).
 */
export function resolveFoundryConfig(env = process.env, platform = process.platform, run = execFileSync) {
  const endpoint = resolveEnv("FOUNDRY_ENDPOINT", env, platform, run);
  const deployment = resolveEnv("FOUNDRY_DEPLOYMENT", env, platform, run).value || DEFAULT_DEPLOYMENT;
  const apiKey = resolveEnv("FOUNDRY_API_KEY", env, platform, run).value;
  const managedIdentity = Boolean(env.IDENTITY_ENDPOINT && env.IDENTITY_HEADER);
  return {
    endpoint: endpoint.value?.replace(/\/+$/, "") || null,
    endpointSource: endpoint.source,
    deployment,
    apiKey,
    managedIdentity,
    authSource: apiKey ? "FOUNDRY_API_KEY" : managedIdentity ? "managed identity" : "Entra ID (Azure CLI login)",
  };
}

function runAzCli() {
  return new Promise((resolve, reject) => {
    // A fixed command string: `az` is a .cmd script on Windows, so it has to run through the shell.
    exec(
      `az account get-access-token --resource ${TOKEN_RESOURCE} --output json`,
      { windowsHide: true, timeout: 60_000 },
      (err, stdout) => {
        if (err) return reject(new Error("Azure CLI token request failed. Run `az login` and try again."));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error("Azure CLI returned an unreadable token response"));
        }
      },
    );
  });
}

/** Fetch a token from the App Service managed identity endpoint. */
export function managedIdentityToken({ env = process.env, fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
  return async () => {
    const url = new URL(env.IDENTITY_ENDPOINT);
    url.searchParams.set("resource", TOKEN_RESOURCE);
    url.searchParams.set("api-version", "2019-08-01");
    if (env.AZURE_CLIENT_ID) url.searchParams.set("client_id", env.AZURE_CLIENT_ID);
    const res = await fetchImpl(url, {
      headers: { "X-IDENTITY-HEADER": env.IDENTITY_HEADER },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Managed identity token request failed (HTTP ${res.status})`);
    const t = await res.json();
    return { accessToken: t.access_token, expires_on: t.expires_on };
  };
}

/** Returns an async function that yields cached `Authorization: Bearer` headers. */
export function azureCliTokenProvider({ fetchToken = runAzCli, now = Date.now } = {}) {
  let cached = null;
  let pending = null;
  return async function getHeaders() {
    if (cached && cached.expiresAt - now() > REFRESH_MARGIN_MS) return cached.headers;
    pending ??= fetchToken()
      .then((t) => {
        const epoch = Number(t.expires_on);
        const expiresAt = Number.isFinite(epoch) && epoch > 0 ? epoch * 1000 : Date.parse(t.expiresOn);
        cached = {
          headers: { Authorization: `Bearer ${t.accessToken}` },
          expiresAt: Number.isFinite(expiresAt) ? expiresAt : now() + 30 * 60_000,
        };
        return cached.headers;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}

/** Auth-header provider for the resolved config: API key, else managed identity, else the Azure CLI. */
export function foundryAuth({ apiKey, managedIdentity } = {}, env = process.env) {
  if (apiKey) {
    const headers = { "api-key": apiKey };
    return async () => headers;
  }
  return azureCliTokenProvider(managedIdentity ? { fetchToken: managedIdentityToken({ env }) } : undefined);
}
