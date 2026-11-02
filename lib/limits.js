// Game server limits, shared by server.js and the load test's capacity model.

// Most model calls the server has in flight at once; more are turned away with HTTP 429.
// 16 turned calls away from about 8 players; 64 covers more players than the model deployment
// allows (see the load test in README.md), and the daily cap below still bounds the spend.
export const MAX_IN_FLIGHT = 64;

// Default cap on model calls per UTC day (DAILY_CALL_LIMIT overrides it).
export const DEFAULT_DAILY_CALL_LIMIT = 20_000;
