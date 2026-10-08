# LUNA GP

A pseudo-3D night-time arcade racer in which every rival driver, the race stewards and the post-race debrief are powered by the
[OpenAI Decisions API](https://developers.openai.com/api/docs/guides/decisions) (`POST /v1/decisions`, model `gpt-6-luna`).

You drive. The game engine handles physics. The Decisions API makes the rivals' tactical calls.

Want to see how fast it is? The **Speed Duel** races the Decisions API against the regular Responses API, live, on the
same questions. See [Speed duel](#speed-duel-decisions-api-vs-responses-api).

## Run it

Requirements: Node.js 20+ and an `OPENAI_API_KEY` environment variable. There are no dependencies, so there's nothing to install.

```powershell
npm start
```

Open <http://127.0.0.1:3000> and press **Start race**. For the speed test, open <http://127.0.0.1:3000/duel.html>.

The API key stays on the server; the browser only talks to the local server. On Windows, the server also reads
`OPENAI_API_KEY` from your saved user/system environment variables, so it works in terminals that were opened before
the key was set. Without a key, the game still runs and the rivals use offline heuristics.

## Controls

| Key                  | Action                                          |
| -------------------- | ----------------------------------------------- |
| ← → (or A D)         | Steer                                           |
| ↑ (or W)             | Throttle                                        |
| ↓ (or S)             | Brake                                           |
| Space (or Shift)     | Nitro (recharges faster in a slipstream)        |
| P (or Esc)           | Pause                                           |
| L                    | Toggle the AI decision tags above rival cars    |
| M                    | Mute                                            |
| Enter                | Start / race again                              |

Stay on the road: trees, lamps and billboards stop you dead.

## How the Decisions API is used

The game asks the model **typed questions** about the current race situation and acts on the typed answers:

| Who | When | Questions | What the game does with the answers |
| --- | --- | --- | --- |
| **Each rival driver** (5 cars) | About every 0.65–1.05 s in traffic and every 1.4–1.8 s otherwise | `choice` **maneuver**: racing line, overtake left/right, slipstream, defend, back off<br>`score` **pace**: Conserve → Race → Push → Flat out<br>`predicate` **nitro**: fire now? | Steers toward the chosen line, sets target speed from the pace score, fires nitro when the probability clears the driver's personality threshold |
| **Race Control** | When you make contact with a rival | `choice` **responsible**: player / rival / racing incident<br>`score` **severity**: 0 light touch → 1 careless → 2 dangerous<br>Plus the onboard camera frame as an `input_image` | Penalizes the responsible driver when the model is ≥ 60% sure and severity is ≥ 0.8: +2 s, or +5 s when severity is ≥ 1.5 |
| **Debrief** | After the race | `score` **rating**: Rookie → Champion<br>`choice` **driver of the day**<br>`predicate` **clean racer?** | Shown on the results screen |

A rival request describes the situation from that driver's point of view in plain text, for example:

```text
Arcade circuit race, 3 laps, 6 cars. Driver under review: Nova (#11).
Personality: Tactical: patient, uses the slipstream and saves nitro to time attacks for long straights and the final lap.
Race situation: FINAL LAP (3 of 3); running P2 of 6, 0.6 s behind the leader.
Car: 262 km/h (top speed 285 km/h), in the center of the road, nitro tank 70%.
Track ahead: currently on a straight with 420 m to go.
Car ahead: the human player, 35 m ahead, directly in line, 8 km/h slower (Nova is closing in). Room to pass it: left side wide open, right side wide open.
Car behind: none within 100 m.
```

…and the model answers with `overtake_left` (p = 0.84), pace 2.81 ("Flat out") and nitro p = 0.95.

The **Pit Wall** panel shows the answers live: each rival's maneuver probability distribution, pace score,
nitro probability against its firing threshold, and round-trip latency. It also shows total calls, average latency,
input tokens and cost. Race Control rulings appear below the rival cards.

If the API fails or is unreachable, the affected rivals switch to an offline heuristic. Their cards show
`FALLBACK`/`LOCAL`, and the race carries on. The game reconnects automatically once the API responds again. You can also
choose **Offline heuristics** in the menu.

**Cost:** `/v1/decisions` with `gpt-6-luna` charges only for input tokens ($0.10 per 1M). A rival decision is about 900 tokens,
so racing costs roughly 2 cents per minute, or about 5 cents for a 3-lap race.

## Speed duel: Decisions API vs Responses API

The Decisions API is built for fast typed answers. The speed duel lets you see the difference live, so it's good for
showing friends. Two cars line up on a drag strip:

- **Cyan car:** the Decisions API (`POST /v1/decisions`, `gpt-6-luna`).
- **Orange car:** the regular Responses API (`POST /v1/responses`), with the opponent you pick.

Both cars get the same race situations and the same three rival-driver questions: a `choice` (which maneuver?), a
`score` (how hard to push?) and a `predicate` (fire nitro?). Each answer moves that car one step toward the flag.

### Run the duel

1. Start the game server: `npm start`.
2. Open <http://127.0.0.1:3000/duel.html>, or select **⚡ Speed duel** on the game's main menu.
3. Pick an opponent and how many race decisions each car must answer (5, 10 or 20).
4. Press **Start duel** (or Enter).

After the 3 red lights, both cars start calling their API at the same time, one decision after another. Each answer's
latency pops up above its car, and the cards below show live stats. At the finish, the result banner shows how many
times faster the winner was. Below it you can:

- **Copy result** to paste the numbers into a chat.
- **Show every answer** to compare both APIs' answers and timings for each race situation.

Press **Stop** to end a duel early, for example against the slow default-reasoning opponent. You still get a
per-decision comparison.

| Opponent | Model | Settings |
| --- | --- | --- |
| Responses API · gpt-6-luna (no reasoning) | `gpt-6-luna` | Same model as the Decisions API, at its fastest setting: `reasoning.effort: "none"` |
| Responses API · gpt-5.4-nano (no reasoning) | `gpt-5.4-nano` | The fastest small model we tested, with `reasoning.effort: "none"` |
| Responses API · gpt-6-luna (default reasoning) | `gpt-6-luna` | Same model with its default reasoning |

### How it's kept fair

- **Same work:** every call gets the same evidence text and the same questions, with the same options, levels and
  descriptions. The Responses API answers through Structured Outputs: a strict JSON schema with an enum for the
  maneuver, an integer level for pace and a boolean for nitro (`store: false`).
- **Same clock:** the game server times every call, from sending the request until the last byte of the answer
  arrives. Your browser's connection to the game server doesn't count.
- **Warm connections:** one untimed warm-up call per car runs during the countdown, so HTTPS setup doesn't count.
- **Side by side:** both cars race at the same time, each making one call at a time, so they share the same network
  conditions.

The Decisions API also returns probabilities with every answer, such as p = 0.84 for the chosen maneuver. With
Structured Outputs, the Responses API returns only the values it picked.

### Benchmark from the command line

For more samples, `npm run bench` asks every contender about all 10 race situations. It shuffles the order for each
situation so network hiccups affect everyone equally, then prints a summary table.

```powershell
npm run bench                                          # vs gpt-6-luna and gpt-5.4-nano, both with no reasoning
npm run bench -- --rounds 3                            # 3 samples per race situation
npm run bench -- --opponents responses-luna-default    # vs gpt-6-luna with default reasoning
npm run bench -- --model gpt-5.4-mini --reasoning none # add any model your key can use
npm run bench -- --json                                # machine-readable output
```

If your shell doesn't pass options through `npm run bench --`, run `node bench.js --rounds 3` instead. The table columns are:

- **median / p90 / fastest:** full round trip from your machine.
- **OpenAI time:** the median `openai-processing-ms` response header, which shows the time spent inside OpenAI.
- **same move:** how often the Responses API picked the Decisions API's top maneuver.

### Our results

Measured on 8 October 2026 from the development machine with `npm run bench`. Your numbers depend on your network
distance to OpenAI and on current load.

| Opponent on the Responses API | Decisions API (median) | Opponent (median) | Inside OpenAI (median) | Same move | Decisions API was |
| --- | ---: | ---: | ---: | ---: | ---: |
| `gpt-6-luna`, no reasoning (20 calls each) | 364 ms | 1.43 s | 152 ms vs 1.04 s | 18/20 | **3.9× faster** |
| `gpt-5.4-nano`, no reasoning (20 calls each) | 364 ms | 987 ms | 152 ms vs 618 ms | 16/20 | **2.7× faster** |
| `gpt-6-luna`, default reasoning (10 calls each) | 318 ms | 4.07 s | 124 ms vs 3.70 s | 10/10 | **12.8× faster** |

The Decisions API won even though its requests carried more input tokens (861 vs 665). It produces no output tokens,
while the Responses API generated 24 output tokens per answer, or 183 with default reasoning.

In the browser duel, the Decisions API answered 10 race decisions in **3.86 s**. The Responses API with `gpt-6-luna`
and no reasoning took **16.54 s**, so the Decisions API was **4.3×** faster.

A 10-decision duel makes 22 API calls: 10 per car, plus 1 warm-up each. Decisions API calls cost about $0.0001 each.
Responses API calls are billed at that model's normal input and output token rates.

## Configuration

| Variable          | Default                     | Purpose                                              |
| ----------------- | --------------------------- | ---------------------------------------------------- |
| `OPENAI_API_KEY`  | –                           | Your API key (required for AI rivals)                |
| `PORT`            | `3000`                      | HTTP port                                            |
| `HOST`            | `127.0.0.1`                 | Bind address                                         |
| `DECISIONS_MODEL` | `gpt-6-luna`                | Model sent to `/v1/decisions`                        |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | API base URL                                         |
| `LOG_DECISIONS`   | unset                       | Set to `1` to log every decision and duel call       |

The server binds to localhost. It rejects cross-origin requests and unexpected `Host` headers, and it validates and clamps
every field before building a request. That stops other web pages from spending your key or injecting their own questions.

## Project layout

```text
server.js             Static files + /api/rival, /api/steward, /api/debrief, /api/duel, /api/status
bench.js              Command-line speed test (npm run bench)
lib/openai.js         Shared fetch helper: timeouts, errors, round-trip and openai-processing-ms timing
lib/decisions.js      Minimal /v1/decisions client and answer helpers
lib/responses.js      Minimal /v1/responses client for Structured Outputs (the duel's baseline)
lib/benchmark.js      Duel race situations and opponents; translates a Decisions request into a Responses request
lib/prompts.js        Builds the evidence text and typed questions; validates all browser input
lib/env.js            Finds OPENAI_API_KEY (process env, then the saved Windows environment)
public/js/race.js     Physics, rival driving, contacts, laps, standings and API payloads
public/js/rivals.js   Per-rival decision scheduling, nitro thresholds, offline fallback
public/js/control.js  Race Control reviews and penalties
public/js/render.js   Pseudo-3D road renderer; public/js/art.js draws all sprites in code
public/js/hud.js      HUD, minimap, Pit Wall, results and debrief
public/duel.html      Speed duel page; public/js/duel.js runs and draws it, public/js/stats.js computes latency stats
test/                 node:test suites
```

## Tests

```powershell
npm test
```

The tests cover the API clients, with `fetch` mocked; the prompt builders and input validation; the duel's
Decisions-to-Responses request translation and latency statistics; and a headless race simulation. The simulation checks
that the payloads the game sends are accepted by the server. The tests make no network calls.
