# LUNA GP

A pseudo-3D night-time arcade racer in which every rival driver, the race stewards and the post-race debrief are powered by the
[OpenAI Decisions API](https://developers.openai.com/api/docs/guides/decisions) (`POST /v1/decisions`, model `gpt-6-luna`).

You drive. The game engine handles physics. The Decisions API makes the rivals' tactical calls.

## Run it

Requirements: Node.js 20+ and an `OPENAI_API_KEY` environment variable. There are no dependencies, so there's nothing to install.

```powershell
npm start
```

Open <http://127.0.0.1:3000> and press **Start race**.

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

## Configuration

| Variable          | Default                     | Purpose                                              |
| ----------------- | --------------------------- | ---------------------------------------------------- |
| `OPENAI_API_KEY`  | –                           | Your API key (required for AI rivals)                |
| `PORT`            | `3000`                      | HTTP port                                            |
| `HOST`            | `127.0.0.1`                 | Bind address                                         |
| `DECISIONS_MODEL` | `gpt-6-luna`                | Model sent to `/v1/decisions`                        |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | API base URL                                         |
| `LOG_DECISIONS`   | unset                       | Set to `1` to log every decision to the console      |

The server binds to localhost. It rejects cross-origin requests and unexpected `Host` headers, and it validates and clamps
every field before building a request. That stops other web pages from spending your key or injecting their own questions.

## Project layout

```text
server.js             Static files + /api/rival, /api/steward, /api/debrief, /api/status
lib/decisions.js      Minimal /v1/decisions client (fetch, timeouts, errors, answer helpers)
lib/prompts.js        Builds the evidence text and typed questions; validates all browser input
lib/env.js            Finds OPENAI_API_KEY (process env, then the saved Windows environment)
public/js/race.js     Physics, rival driving, contacts, laps, standings and API payloads
public/js/rivals.js   Per-rival decision scheduling, nitro thresholds, offline fallback
public/js/control.js  Race Control reviews and penalties
public/js/render.js   Pseudo-3D road renderer; public/js/art.js draws all sprites in code
public/js/hud.js      HUD, minimap, Pit Wall, results and debrief
test/                 node:test suites
```

## Tests

```powershell
npm test
```

The tests cover the API client, with `fetch` mocked; the prompt builders and input validation; and a headless race
simulation. The simulation checks that the payloads the game sends are accepted by the server. The tests make no network calls.
