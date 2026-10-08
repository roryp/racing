// DOM HUD: race telemetry, minimap, the Pit Wall (live Decisions API answers),
// the Race Control log and the results/debrief screen.

import { MANEUVERS, NITRO_COST, toKmh } from "./config.js";

const $ = (id) => document.getElementById(id);
const PACE_LABELS = ["Conserve", "Race", "Push", "Flat out"];
const SEVERITY_LABELS = ["Light touch", "Careless", "Dangerous"];

export function formatTime(t) {
  if (t === null || t === undefined || !Number.isFinite(t)) return "--:--.--";
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const pct = (p) => `${Math.round((p ?? 0) * 100)}%`;

export class Hud {
  constructor(track, api) {
    this.track = track;
    this.api = api;
    this.el = {
      hud: $("hud"),
      pos: $("hud-pos"),
      cars: $("hud-cars"),
      lap: $("hud-lap"),
      laps: $("hud-laps"),
      time: $("hud-time"),
      lapTime: $("hud-laptime"),
      best: $("hud-best"),
      penaltyRow: $("hud-penalty-row"),
      penalty: $("hud-penalty"),
      speed: $("hud-speed"),
      nitroFill: $("hud-nitro-fill"),
      nitroBox: $("hud-nitro"),
      draft: $("hud-draft"),
      center: $("hud-center"),
      lights: $("start-lights"),
      ticker: $("ticker"),
      minimap: $("minimap"),
      cards: $("rival-cards"),
      rcLog: $("rc-log"),
      apiStatus: $("api-status"),
      statCalls: $("stat-calls"),
      statLatency: $("stat-latency"),
      statTokens: $("stat-tokens"),
      statCost: $("stat-cost"),
      legend: $("legend"),
    };
    this.minimapCtx = this.el.minimap.getContext("2d");
    this.minimapBase = this.drawMinimapBase();
    this.cards = new Map();
    this.flashTimeout = null;
    this.tickerTimeout = null;
    this.frame = 0;
    this.rcEntries = new Map();
    this.el.legend.innerHTML = Object.values(MANEUVERS)
      .map((m) => `<span><i style="background:${m.color}"></i>${m.label}</span>`)
      .join("");
  }

  // ---- race setup -----------------------------------------------------------

  setupRace(race) {
    this.race = race;
    this.el.cars.textContent = race.cars.length;
    this.el.laps.textContent = race.laps;
    this.el.rcLog.innerHTML = '<li class="muted">No incidents yet. Contact between you and a rival triggers a review.</li>';
    this.rcEntries.clear();
    this.el.cards.innerHTML = "";
    this.cards.clear();
    for (const car of race.rivals) {
      const card = document.createElement("div");
      card.className = "card";
      card.style.setProperty("--team", car.color);
      card.innerHTML = `
        <div class="card-head">
          <span class="swatch"></span><b>${escapeHtml(car.name)}</b><span class="num">#${car.number}</span>
          <span class="persona">${car.personality}</span><span class="cpos">P${car.position}</span>
        </div>
        <div class="maneuver"><span class="m-label">Waiting for first decision…</span><span class="src"></span></div>
        <div class="dist" title="choice: maneuver probabilities"></div>
        <div class="metrics">
          <div class="metric pace" title="score: pace (0 = Conserve … 3 = Flat out)">
            <div class="mhead"><label>pace</label><span class="val">–</span></div>
            <div class="meter"><div class="fill"></div></div>
          </div>
          <div class="metric nitro" title="predicate: probability that firing nitro now is right (line = threshold)">
            <div class="mhead"><label>nitro</label><span class="val">–</span></div>
            <div class="meter"><div class="fill"></div><div class="thresh"></div></div>
          </div>
        </div>`;
      this.el.cards.appendChild(card);
      this.cards.set(car.id, {
        root: card,
        pos: card.querySelector(".cpos"),
        label: card.querySelector(".m-label"),
        src: card.querySelector(".src"),
        dist: card.querySelector(".dist"),
        paceFill: card.querySelector(".pace .fill"),
        paceVal: card.querySelector(".pace .val"),
        nitroFill: card.querySelector(".nitro .fill"),
        nitroThresh: card.querySelector(".nitro .thresh"),
        nitroVal: card.querySelector(".nitro .val"),
      });
    }
    this.el.lights.className = "lights hidden";
    this.el.center.textContent = "";
    this.el.ticker.className = "ticker hidden";
  }

  show(visible) {
    this.el.hud.classList.toggle("hidden", !visible);
  }

  // ---- Pit Wall -------------------------------------------------------------

  rivalDecision(car) {
    const view = this.cards.get(car.id);
    if (!view) return;
    const b = car.brain;
    const m = MANEUVERS[b.maneuver];
    view.label.textContent = m ? m.label : b.maneuver;
    view.label.style.color = m?.color ?? "";
    if (b.confidence !== null && b.confidence !== undefined) view.label.dataset.conf = `conf ${b.confidence.toFixed(2)}`;
    else delete view.label.dataset.conf;

    if (b.source === "api") {
      view.src.className = "src api";
      view.src.textContent = `API ${b.latencyMs ?? "?"} ms`;
      view.src.title = "Answered by the OpenAI Decisions API";
    } else {
      view.src.className = `src ${b.error ? "err" : "local"}`;
      view.src.textContent = b.error ? "FALLBACK" : "LOCAL";
      view.src.title = b.error ? `Decisions API error: ${b.error}` : "Offline heuristic";
    }

    const dist = b.maneuverDist ?? {};
    view.dist.innerHTML = Object.entries(MANEUVERS)
      .map(([key, def]) => {
        const p = dist[key] ?? 0;
        return p > 0.004
          ? `<span style="width:${(p * 100).toFixed(1)}%;background:${def.color}" title="${def.label}: ${p.toFixed(2)}"></span>`
          : "";
      })
      .join("");

    const pace = Math.max(0, Math.min(3, b.pace ?? 0));
    const labels = b.paceLabels ?? PACE_LABELS;
    view.paceFill.style.width = `${(pace / 3) * 100}%`;
    view.paceVal.textContent = `${pace.toFixed(2)} ${labels[Math.round(pace)] ?? ""}`;

    view.nitroFill.style.width = pct(b.nitroP);
    view.nitroFill.classList.toggle("hot", b.nitroP >= b.nitroThreshold);
    view.nitroThresh.style.left = pct(b.nitroThreshold);
    view.nitroVal.textContent = `p=${(b.nitroP ?? 0).toFixed(2)}${b.nitroFired ? " 🔥" : ""}`;

    view.root.classList.remove("pulse");
    void view.root.offsetWidth; // restart the CSS animation
    view.root.classList.add("pulse");
  }

  setApiStatus(kind, text) {
    this.el.apiStatus.className = `pill ${kind}`;
    this.el.apiStatus.textContent = text;
  }

  updateStats() {
    const s = this.api.stats;
    this.el.statCalls.textContent = `${s.calls}${s.errors ? ` (${s.errors} err)` : ""}`;
    this.el.statLatency.textContent = s.calls ? `${this.api.averageMs} ms` : "–";
    this.el.statTokens.textContent = s.tokens.toLocaleString();
    this.el.statCost.textContent = `$${this.api.cost.toFixed(4)}`;
  }

  // ---- Race Control -----------------------------------------------------------

  raceControl(event) {
    const { incident, rival } = event;
    const key = `${incident.rivalId}-${incident.lap}-${incident.playerSpeedKmh}-${incident.rivalSpeedKmh}`;
    let li = this.rcEntries.get(key);
    if (!li) {
      const empty = this.el.rcLog.querySelector(".muted");
      if (empty) empty.remove();
      li = document.createElement("li");
      this.el.rcLog.prepend(li);
      this.rcEntries.set(key, li);
    }
    const who = `<b style="color:${rival.color}">${escapeHtml(rival.name)}</b>`;
    const head = `Lap ${incident.lap} · ${incident.kind === "rear" ? "rear-end" : "side"} contact with ${who}`;

    if (event.status === "reviewing") {
      li.className = "pending";
      li.innerHTML = `<div>${head}</div><div class="verdict">Stewards reviewing${incident.front === "player" ? "" : " (with onboard frame)"}…</div>`;
      return;
    }
    if (event.status === "error") {
      li.className = "error";
      li.innerHTML = `<div>${head}</div><div class="verdict">Review failed: ${escapeHtml(event.error)}</div>`;
      return;
    }

    const { verdict, penalty, target } = event;
    const r = verdict.responsible;
    const sev = verdict.severity;
    const names = { player: "You", rival: rival.name, racing_incident: "Racing incident" };
    const chips = r
      ? Object.entries(r.probabilities)
          .map(([k, p]) => `<span class="chip ${k === r.choice ? "on" : ""}">${escapeHtml(names[k] ?? k)} ${p.toFixed(2)}</span>`)
          .join("")
      : "";
    const sevText = sev ? `${sev.score.toFixed(2)} · ${SEVERITY_LABELS[Math.round(sev.score)] ?? ""}` : "n/a";
    const outcome = penalty
      ? `<b class="pen">+${penalty} s penalty → ${target.isPlayer ? "YOU" : escapeHtml(target.name)}</b>`
      : "No further action";
    li.className = penalty ? (target.isPlayer ? "bad" : "good") : "";
    li.innerHTML = `<div>${head}</div>
      <div class="chips" title="choice: who is responsible">${chips}</div>
      <div class="verdict" title="score: severity (0 = light touch … 2 = dangerous)">Severity ${sevText}${event.withFrame ? " · 📷 frame reviewed" : ""}</div>
      <div class="verdict">${outcome}</div>`;

    this.ticker(
      penalty
        ? `RACE CONTROL: +${penalty}s penalty for ${target.isPlayer ? "YOU" : target.name.toUpperCase()}`
        : `RACE CONTROL: contact with ${rival.name} — no further action`,
      penalty && target.isPlayer ? "bad" : "info",
    );
  }

  ticker(text, kind = "info") {
    this.el.ticker.textContent = text;
    this.el.ticker.className = `ticker ${kind}`;
    clearTimeout(this.tickerTimeout);
    this.tickerTimeout = setTimeout(() => this.el.ticker.classList.add("hidden"), 4500);
  }

  // ---- in-race HUD ------------------------------------------------------------

  countdown(value) {
    const lights = this.el.lights;
    lights.classList.remove("hidden");
    if (value > 0) {
      lights.className = `lights on-${4 - value}`;
      this.el.center.textContent = "";
    } else {
      lights.className = "lights go";
      this.flash("GO!", 900, "go");
      setTimeout(() => lights.classList.add("hidden"), 1200);
    }
  }

  flash(text, ms = 1500, cls = "") {
    const el = this.el.center;
    el.textContent = text;
    el.className = `center show ${cls}`;
    clearTimeout(this.flashTimeout);
    this.flashTimeout = setTimeout(() => {
      el.className = "center";
    }, ms);
  }

  update(race) {
    const p = race.player;
    this.frame++;
    this.drawMinimap(race);
    this.el.speed.textContent = Math.round(toKmh(p.speed));
    this.el.nitroFill.style.width = `${Math.round(p.nitro * 100)}%`;
    this.el.nitroBox.classList.toggle("ready", p.nitro >= NITRO_COST && p.nitroTime <= 0);
    this.el.nitroBox.classList.toggle("active", p.nitroTime > 0);
    this.el.draft.classList.toggle("hidden", !p.drafting);
    if (this.frame % 4 !== 0) return;

    // Once everyone is classified, show official positions (time penalties included).
    const official = race.phase === "finished" ? new Map(race.classify().map((r) => [r.car, r.position])) : null;
    const positionOf = (car) => official?.get(car) ?? car.position;

    this.el.pos.textContent = positionOf(p);
    this.el.lap.textContent = race.lapOf(p);
    const raceTime = p.finished ? p.finishTime : race.time;
    this.el.time.textContent = formatTime(raceTime);
    this.el.lapTime.textContent = formatTime(p.finished ? p.lapTimes.at(-1) : Math.max(0, race.time - p.lapStart));
    this.el.best.textContent = formatTime(p.bestLap);
    this.el.penaltyRow.classList.toggle("hidden", p.penalty <= 0);
    this.el.penalty.textContent = `+${p.penalty}s`;
    for (const car of race.rivals) {
      const view = this.cards.get(car.id);
      if (view) view.pos.textContent = car.finished ? `P${positionOf(car)} 🏁` : `P${car.position}`;
    }
    if (this.frame % 30 === 0) this.updateStats();
  }

  drawMinimapBase() {
    const size = this.el.minimap.width;
    const pad = 14;
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const ctx = c.getContext("2d");
    const pts = this.track.minimap;
    this.mapPoint = (i) => {
      const p = pts[((i % pts.length) + pts.length) % pts.length];
      return [pad + p.x * (size - pad * 2), pad + p.y * (size - pad * 2)];
    };
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const [w, color] of [
      [9, "rgba(0,0,0,0.55)"],
      [5, "#c9c3d6"],
    ]) {
      ctx.lineWidth = w;
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (let i = 0; i <= pts.length; i += 4) {
        const [x, y] = this.mapPoint(i);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
    }
    const [sx, sy] = this.mapPoint(0);
    ctx.fillStyle = "#ffd166";
    ctx.fillRect(sx - 4, sy - 4, 8, 8);
    return c;
  }

  drawMinimap(race) {
    const ctx = this.minimapCtx;
    const size = this.el.minimap.width;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(this.minimapBase, 0, 0);
    const segCount = this.track.segments.length;
    const segOf = (car) => Math.floor(this.track.wrap(car.progress) / (this.track.length / segCount));
    for (const car of [...race.rivals, race.player]) {
      const [x, y] = this.mapPoint(segOf(car));
      ctx.beginPath();
      ctx.arc(x, y, car.isPlayer ? 6 : 4.5, 0, Math.PI * 2);
      ctx.fillStyle = car.color;
      ctx.fill();
      ctx.lineWidth = car.isPlayer ? 2.5 : 1.5;
      ctx.strokeStyle = car.isPlayer ? "#2f6bff" : "#000";
      ctx.stroke();
    }
  }

  // ---- results ------------------------------------------------------------------

  renderResults(race) {
    const rows = race.classify();
    const winnerTotal = rows[0].total;
    $("results-body").innerHTML = rows
      .map(({ car, total, position }) => {
        const gap = position === 1 ? formatTime(total) : `+${(total - winnerTotal).toFixed(2)}s`;
        const pen = car.penalty ? `<span class="pen">+${car.penalty}s</span>` : "";
        const delta = car.startPosition - position;
        const moved = delta > 0 ? `<span class="up">▲${delta}</span>` : delta < 0 ? `<span class="down">▼${-delta}</span>` : "";
        return `<tr class="${car.isPlayer ? "me" : ""}">
          <td>${position}</td>
          <td><i class="dot" style="background:${car.color}"></i>${escapeHtml(car.name)} ${moved}</td>
          <td>${gap}${car.estimated ? " *" : ""}</td>
          <td>${pen}</td>
          <td>${formatTime(car.bestLap)}</td>
          <td>${car.overtakes}</td>
          <td>${car.contacts}</td>
        </tr>`;
      })
      .join("");
    const me = rows.find((r) => r.car.isPlayer);
    $("results-title").textContent = me.position === 1 ? "🏆 Victory!" : `You finished P${me.position}`;
  }

  debriefPending(text) {
    $("debrief").innerHTML = `<div class="muted">${escapeHtml(text)}</div>`;
  }

  renderDebrief(result) {
    const rating = result.rating;
    const dotd = result.driverOfTheDay;
    const clean = result.cleanRacer;
    const labels = rating?.labels ?? ["Rookie", "Club racer", "Pro", "Champion"];
    const ratingHtml = rating
      ? `<div class="db-block">
          <h4>Your rating <small>score</small></h4>
          <div class="big">${escapeHtml(labels[Math.round(rating.score)] ?? "")} <small>${rating.score.toFixed(2)} / 3</small></div>
          <div class="levels">${labels
            .map((l, i) => `<div><span>${escapeHtml(l)}</span><div class="meter"><div class="fill" style="width:${pct(rating.probabilities[i])}"></div></div><em>${(rating.probabilities[i] ?? 0).toFixed(2)}</em></div>`)
            .join("")}</div>
          <div class="muted">confidence ${rating.confidence?.toFixed(2) ?? "–"}</div>
        </div>`
      : "";
    const dotdHtml = dotd
      ? `<div class="db-block">
          <h4>Driver of the day <small>choice</small></h4>
          <div class="big">${escapeHtml(dotd.choice)}</div>
          <div class="levels">${Object.entries(dotd.probabilities)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([name, p]) => `<div><span>${escapeHtml(name)}</span><div class="meter"><div class="fill" style="width:${pct(p)}"></div></div><em>${p.toFixed(2)}</em></div>`)
            .join("")}</div>
        </div>`
      : "";
    const cleanHtml = clean
      ? `<div class="db-block">
          <h4>Clean racer? <small>predicate</small></h4>
          <div class="big ${clean.probability >= 0.5 ? "yes" : "no"}">${clean.probability >= 0.5 ? "✔ Yes" : "✘ No"} <small>p = ${clean.probability.toFixed(2)}</small></div>
          <div class="meter wide"><div class="fill" style="width:${pct(clean.probability)}"></div></div>
        </div>`
      : "";
    $("debrief").innerHTML = `<div class="db-grid">${ratingHtml}${dotdHtml}${cleanHtml}</div>
      <div class="muted small">Debrief by the OpenAI Decisions API · ${result.roundTripMs ?? "?"} ms · ${result.inputTokens ?? "?"} input tokens</div>`;
  }
}
