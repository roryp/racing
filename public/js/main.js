import { MAX_SPEED, PLAYER_Z, SEGMENT_LENGTH, STEP } from "./config.js";
import { createArt } from "./art.js";
import { Track } from "./track.js";
import { Renderer } from "./render.js";
import { Input, watchTouchUi } from "./input.js";
import { Sound } from "./audio.js";
import { DecisionsApi } from "./api.js";
import { Race } from "./race.js";
import { RivalBrains } from "./rivals.js";
import { RaceControl } from "./control.js";
import { formatTime, Hud } from "./hud.js";

const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = "lunagp.settings";

const canvas = $("game");
const track = new Track();
const renderer = new Renderer(canvas, track, createArt());
const input = new Input();
const touchPad = $("touch");
input.bindTouch(touchPad);
watchTouchUi();
const sound = new Sound();
const api = new DecisionsApi();
const hud = new Hud(track, api);

const settings = {
  brain: "api",
  difficulty: "normal",
  laps: 3,
  stewards: true,
  labels: true,
  ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"),
};

let screen = "menu"; // menu | race | paused
let race = new Race({ track, laps: settings.laps, difficulty: settings.difficulty });
let brains = null;
let control = null;
let apiConfigured = false;
let apiModel = "Microsoft-Decision-1";
let resultsShown = false;
let shake = 0;
const parallax = { mountains: 0, hills: 0, trees: 0 };

// ---- menu & settings ---------------------------------------------------------

const options = {
  brain: $("opt-brain"),
  difficulty: $("opt-difficulty"),
  laps: $("opt-laps"),
  stewards: $("opt-stewards"),
};
options.brain.value = settings.brain;
options.difficulty.value = settings.difficulty;
options.laps.value = String(settings.laps);
options.stewards.checked = settings.stewards;

function saveSettings() {
  settings.brain = options.brain.value;
  settings.difficulty = options.difficulty.value;
  settings.laps = Number(options.laps.value);
  settings.stewards = options.stewards.checked;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

for (const el of Object.values(options)) el.addEventListener("change", saveSettings);

async function checkApiStatus() {
  const status = await api.status();
  apiConfigured = Boolean(status.configured);
  apiModel = status.model ?? apiModel;
  const box = $("menu-status");
  if (apiConfigured) {
    box.className = "status ok";
    box.innerHTML = `✅ Foundry configured (${status.keySource ?? "environment"}) · model <code>${apiModel}</code>`;
    hud.setApiStatus("ok", `● ${apiModel} ready`);
  } else {
    box.className = "status warn";
    box.textContent = status.unreachable
      ? "⚠ Game server unreachable. Start it with npm start."
      : "⚠ FOUNDRY_ENDPOINT not set on the server. Rivals will use offline heuristics.";
    options.brain.value = "local";
    options.brain.querySelector('option[value="api"]').disabled = true;
    hud.setApiStatus("warn", "● offline heuristics");
  }
}

function setOverlay(id, visible) {
  $(id).classList.toggle("hidden", !visible);
}

/** On-screen driving controls show only while a race is on (and only on touch screens, via CSS). */
function setTouchControls(visible) {
  touchPad.classList.toggle("hidden", !visible);
}

// ---- sound, AI tags & full screen (keys on desktop, buttons in the pause menu) -------

function syncToggles() {
  const soundButton = $("btn-sound");
  soundButton.textContent = sound.muted ? "🔇 Sound off" : "🔊 Sound on";
  soundButton.setAttribute("aria-pressed", String(!sound.muted));
  const labelsButton = $("btn-labels");
  labelsButton.textContent = settings.labels ? "🏷️ AI tags on" : "🏷️ AI tags off";
  labelsButton.setAttribute("aria-pressed", String(settings.labels));
}

function toggleSound() {
  sound.setMuted(!sound.muted);
  syncToggles();
}

function toggleLabels() {
  settings.labels = !settings.labels;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  syncToggles();
}

const fullscreenButtons = document.querySelectorAll(".btn-fullscreen");
const canFullscreen = Boolean(document.fullscreenEnabled || document.webkitFullscreenEnabled);
const fullscreenElement = () => document.fullscreenElement ?? document.webkitFullscreenElement ?? null;

function syncFullscreen() {
  for (const button of fullscreenButtons) {
    button.classList.toggle("hidden", !canFullscreen);
    button.textContent = fullscreenElement() ? "Exit full screen" : "⛶ Full screen";
  }
}

async function toggleFullscreen() {
  const root = document.documentElement;
  try {
    if (fullscreenElement()) {
      await (document.exitFullscreen ?? document.webkitExitFullscreen).call(document);
    } else {
      await (root.requestFullscreen ?? root.webkitRequestFullscreen).call(root, { navigationUI: "hide" });
      // Race sideways: phones that allow it (Android) lock to landscape while in full screen.
      await screen.orientation?.lock?.("landscape")?.catch(() => {});
    }
  } catch {
    // The browser refused full screen; the game still works in the page.
  }
}

/** Short vibration on touch devices that support it (Android); a no-op elsewhere. */
function buzz(pattern) {
  if (document.documentElement.classList.contains("touch-ui")) navigator.vibrate?.(pattern);
}

// ---- race lifecycle --------------------------------------------------------------

function captureFrame() {
  const c = document.createElement("canvas");
  c.width = 480;
  c.height = 270;
  c.getContext("2d").drawImage(canvas, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.72);
}

function startRace() {
  saveSettings();
  sound.ensure();
  document.activeElement?.blur?.();
  brains?.stop();
  control?.stop();

  race = new Race({ track, laps: settings.laps, difficulty: settings.difficulty });
  const useApi = settings.brain === "api" && apiConfigured;
  brains = new RivalBrains({
    race,
    api,
    mode: useApi ? "api" : "local",
    onDecision: (car) => {
      hud.rivalDecision(car);
      if (car.brain.error) hud.setApiStatus("err", "● API error · using fallback");
      else if (car.brain.source === "api") hud.setApiStatus("ok", `● ${apiModel} live`);
    },
  });
  control = new RaceControl({
    race,
    api,
    enabled: useApi && settings.stewards,
    captureFrame,
    onVerdict: (event) => {
      hud.raceControl(event);
      if (resultsShown && event.status === "verdict") hud.renderResults(race);
    },
  });

  hud.setupRace(race);
  hud.setApiStatus(useApi ? "ok" : "warn", useApi ? `● ${apiModel} live` : "● offline heuristics");
  hud.show(true);
  setOverlay("menu", false);
  setOverlay("pause", false);
  setOverlay("results", false);
  setTouchControls(true);
  // On phones the page scrolls (Pit Wall below the race): bring the race view back into view.
  window.scrollTo(0, 0);
  resultsShown = false;
  shake = 0;
  input.reset();
  screen = "race";
  race.startCountdown();
}

function quitToMenu() {
  brains?.stop();
  control?.stop();
  race = new Race({ track, laps: settings.laps, difficulty: settings.difficulty });
  screen = "menu";
  resultsShown = false;
  hud.show(false);
  setOverlay("pause", false);
  setOverlay("results", false);
  setOverlay("menu", true);
  setTouchControls(false);
  sound.engine(0, false, false);
}

function togglePause(force) {
  if (screen === "race" && force !== false && !resultsShown) {
    screen = "paused";
    setOverlay("pause", true);
    sound.engine(0, false, false);
  } else if (screen === "paused" && force !== true) {
    screen = "race";
    setOverlay("pause", false);
    document.activeElement?.blur?.();
    input.reset();
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function showResults() {
  resultsShown = true;
  const thisRace = race;
  hud.renderResults(race);
  setOverlay("results", true);
  setTouchControls(false);
  sound.engine(0, false, false);

  if (!(brains?.mode === "api")) {
    hud.debriefPending("The AI debrief uses the Decisions API. It's unavailable in offline mode.");
    return;
  }
  hud.debriefPending("Race Control is preparing your debrief…");
  const deadline = performance.now() + 6000;
  while (control.pending > 0 && performance.now() < deadline) await sleep(200);
  if (race !== thisRace) return;
  hud.renderResults(race);
  try {
    const result = await api.debrief(race.summary());
    if (race === thisRace) hud.renderDebrief(result);
  } catch (err) {
    if (race === thisRace) hud.debriefPending(`Debrief unavailable: ${err.message}`);
  }
  hud.updateStats();
}

function handleEvent(event) {
  switch (event.type) {
    case "countdown":
      hud.countdown(event.value);
      sound.beep(440, 0.2);
      break;
    case "go":
      hud.countdown(0);
      sound.beep(880, 0.5);
      break;
    case "lap":
      hud.flash(
        `${event.final ? "FINAL LAP" : `LAP ${event.lap + 1}`} · ${formatTime(event.lapTime)}${event.best ? " ★" : ""}`,
        2200,
        event.final ? "final" : "",
      );
      break;
    case "nitro":
      if (event.car.isPlayer) {
        sound.beep(180, 0.3);
        buzz(35);
      }
      break;
    case "contact":
      shake = Math.max(shake, 12 * event.intensity);
      sound.bump(event.intensity);
      buzz(Math.round(20 + 40 * event.intensity));
      control?.review(event.incident);
      break;
    case "wall":
      if (event.car.isPlayer) {
        shake = 16;
        sound.bump(1);
        buzz(80);
        hud.flash("CRASH!", 800, "bad");
      }
      break;
    case "recovering":
      if (event.car.isPlayer && !event.crashed) hud.flash("BACK TO THE TRACK", 1200);
      break;
    case "recovered":
      if (event.car.isPlayer) hud.flash("GO!", 900, "go");
      break;
    case "finish":
      if (event.car.isPlayer) hud.flash(`FINISH · P${event.car.position}`, 4000, "go");
      break;
    case "penalty":
      if (event.car.isPlayer) {
        buzz([60, 60, 120]);
        hud.flash(`+${event.seconds}s PENALTY`, 2500, "bad");
      }
      break;
    case "classified":
      showResults();
      break;
  }
}

// ---- loop ------------------------------------------------------------------------

function step(dt) {
  const player = race.player;
  const before = player.progress;
  const held = input.held;
  race.update(dt, { ...held, nitro: input.consume("nitro") || held.nitro });
  brains?.update(performance.now());

  const moved = (player.progress - before) / SEGMENT_LENGTH;
  const curve = track.findSegment(player.progress).curve;
  parallax.mountains += 0.0004 * curve * moved;
  parallax.hills += 0.0008 * curve * moved;
  parallax.trees += 0.0014 * curve * moved;

  for (const event of race.drainEvents()) handleEvent(event);
  shake = Math.max(0, shake - dt * 30);
  if (!resultsShown) sound.engine(player.speed / MAX_SPEED, player.nitroTime > 0, race.phase !== "grid");
}

function handleKeys() {
  if (input.consume("pause") && (screen === "race" || screen === "paused")) togglePause();
  if (input.consume("mute")) {
    toggleSound();
    hud.ticker(sound.muted ? "Sound off (M)" : "Sound on (M)");
  }
  if (input.consume("labels")) {
    toggleLabels();
    hud.ticker(settings.labels ? "AI decision tags on (L)" : "AI decision tags off (L)");
  }
  if (input.consume("confirm")) {
    if (screen === "menu" || resultsShown) startRace();
    else if (screen === "paused") togglePause(false);
  }
}

let last = performance.now();
let accumulator = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  handleKeys();
  if (screen === "race") {
    accumulator += dt;
    while (accumulator >= STEP) {
      step(STEP);
      accumulator -= STEP;
    }
  } else {
    accumulator = 0;
  }
  const player = race.player;
  renderer.render({
    position: player.progress - PLAYER_Z,
    player,
    rivals: race.rivals,
    parallax,
    time: now / 1000,
    shake,
    labels: settings.labels,
    steer: player.steer,
  });
  if (screen !== "menu") hud.update(race);
  requestAnimationFrame(frame);
}

// ---- wiring ------------------------------------------------------------------------

$("btn-start").addEventListener("click", startRace);
$("btn-resume").addEventListener("click", () => togglePause(false));
$("btn-restart").addEventListener("click", startRace);
$("btn-quit").addEventListener("click", quitToMenu);
$("btn-again").addEventListener("click", startRace);
$("btn-menu").addEventListener("click", quitToMenu);
$("btn-sound").addEventListener("click", toggleSound);
$("btn-labels").addEventListener("click", toggleLabels);
for (const button of fullscreenButtons) button.addEventListener("click", toggleFullscreen);
document.addEventListener("fullscreenchange", syncFullscreen);
document.addEventListener("webkitfullscreenchange", syncFullscreen);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) togglePause(true);
});

syncToggles();
syncFullscreen();
checkApiStatus();
requestAnimationFrame(frame);

// Opt-in hook for automated playtesting: http://127.0.0.1:3000/?debug
if (new URLSearchParams(location.search).has("debug")) {
  window.lunagp = { get race() { return race; }, api, settings };
}
