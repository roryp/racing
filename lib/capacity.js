// Capacity model for the load test: fits how many model calls each player makes a minute, then
// predicts how many players fit within the model deployment's rate limits and the game server's
// in-flight cap.

export const RIVALS_PER_RACE = 5;

/** Least-squares slope of a line through the origin (y ≈ slope · x), or null without data. */
export function slopeThroughOrigin(points) {
  let sxy = 0;
  let sxx = 0;
  for (const { x, y } of points) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    sxy += x * y;
    sxx += x * x;
  }
  return sxx > 0 ? sxy / sxx : null;
}

/** P(X ≥ k) for X ~ Binomial(n, p). */
export function binomialTail(n, p, k) {
  if (k <= 0 || p >= 1) return k <= n ? 1 : 0;
  if (k > n || p <= 0) return 0;
  let pmf = (1 - p) ** n;
  let below = 0;
  for (let i = 0; i < k; i++) {
    below += pmf;
    pmf *= ((n - i) / (i + 1)) * (p / (1 - p));
  }
  return Math.max(0, 1 - below);
}

/**
 * Most players the game server can take while turning away at most `maxRejected` of the calls.
 * Each rival waits for its answer before deciding again, so it has at most one call in flight; a
 * call is turned away when the other rivals already have `maxInFlight` calls in flight.
 * `inFlightPerPlayer` is the measured average number of one player's calls in flight.
 */
export function serverLimitPlayers({ inFlightPerPlayer, maxInFlight, maxRejected = 0.01, rivals = RIVALS_PER_RACE, upTo = 2000 }) {
  const busy = Math.min(1, inFlightPerPlayer / rivals);
  if (!(busy > 0)) return null;
  let players = 0;
  while (players < upTo && binomialTail((players + 1) * rivals - 1, busy, maxInFlight) <= maxRejected) players++;
  return players;
}

const fitOf = (steps, key) => slopeThroughOrigin(steps.map((s) => ({ x: s.players, y: s[key] })));

// A step where the game server turned away more than this share of calls shows its cap, not
// what the players asked for, so the fits leave it out.
export const SATURATED = 0.05;

/** The steps that measure demand: those where the server's in-flight cap turned few calls away. */
export function demandSteps(run) {
  const steps = run.steps.filter((s) => !(s.requests > 0 && (s.errors?.busy ?? 0) / s.requests > SATURATED));
  return steps.length ? steps : run.steps;
}

/**
 * Predicts capacity from the closest run (`near`, which makes the most calls per player) and,
 * optionally, a run from further away (`far`).
 *   rpm, tpm: the model deployment's requests and tokens per minute
 *   margin: share of Azure's capacity kept free, so Azure never has to refuse a call
 *   maxInFlight, maxRejected: the game server's in-flight cap and the share of calls it may turn away
 */
export function predictCapacity({ near, far = null, rpm, tpm = null, margin = 0.2, maxInFlight, maxRejected = 0.01 }) {
  const nearSteps = demandSteps(near);
  const perPlayer = fitOf(nearSteps, "modelCallsPerMin");
  const farPerPlayer = far ? fitOf(demandSteps(far), "modelCallsPerMin") : null;
  if (!(perPlayer > 0)) throw new Error("The load test answered no calls, so there's nothing to predict from.");

  const answered = nearSteps.reduce((sum, s) => sum + s.answered, 0);
  const tokens = nearSteps.reduce((sum, s) => sum + (s.tokensPerCall ?? 0) * s.answered, 0);
  const tokensPerCall = answered ? tokens / answered : null;
  const callsByTokens = tpm && tokensPerCall ? tpm / tokensPerCall : Infinity;
  const callsPerMin = Math.min(rpm ?? Infinity, callsByTokens);
  if (!Number.isFinite(callsPerMin)) throw new Error("Give the model deployment's requests (or tokens) per minute.");
  const usable = callsPerMin * (1 - margin);

  const inFlightPerPlayer = fitOf(nearSteps, "serverInFlight");
  return {
    perPlayer,
    farPerPlayer,
    tokensPerCall,
    azure: {
      callsPerMin,
      binding: callsPerMin === rpm ? "requests" : "tokens",
      callsByTokens: Number.isFinite(callsByTokens) ? callsByTokens : null,
      players: callsPerMin / perPlayer,
    },
    margin,
    afterMargin: { callsPerMin: usable, players: usable / perPlayer, farPlayers: farPerPlayer ? usable / farPerPlayer : null },
    server: {
      maxInFlight,
      maxRejected,
      inFlightPerPlayer,
      players: inFlightPerPlayer > 0 ? serverLimitPlayers({ inFlightPerPlayer, maxInFlight, maxRejected }) : null,
    },
  };
}

/** Latency, CPU and calls turned away at the busiest step, compared with the quietest, for the chart's notes. */
export function busiestStep(run) {
  const steps = [...run.steps].sort((a, b) => a.players - b.players);
  const first = steps[0];
  const last = steps.at(-1);
  if (!first || !last || first === last) return null;
  const slower = first.modelMs.p50 && last.modelMs.p50 ? last.modelMs.p50 / first.modelMs.p50 - 1 : null;
  const turnedAway = last.requests ? (last.errors?.busy ?? 0) / last.requests : null;
  return { players: last.players, modelSlower: slower, serverCpuPct: last.serverCpuPct ?? null, turnedAway, step: last };
}
