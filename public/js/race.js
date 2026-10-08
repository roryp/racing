// Race simulation: physics, rival driving (executing the current AI decision),
// contacts, laps, positions and final classification.

import {
  ACCEL,
  BRAKING,
  CAR_HALF,
  CAR_LENGTH,
  CENTRIFUGAL,
  DECEL,
  DIFFICULTY,
  DRAFT_BOOST,
  DRAFT_RANGE_M,
  DRAFT_RECHARGE,
  MAX_SPEED,
  M_PER_UNIT,
  NITRO_BOOST,
  NITRO_COST,
  NITRO_DURATION,
  NITRO_RECHARGE,
  OFF_ROAD_DECEL,
  OFF_ROAD_LIMIT,
  PLAYER,
  RIVALS,
  ROAD_WIDTH,
  toKmh,
} from "./config.js";
import { SPRITE_TYPES } from "./track.js";

const HISTORY = 40; // offsets kept per car (~0.66 s at 60 Hz)
const LOOKBACK = 36; // 0.6 s
const GRID_ORDER = ["orion", "lyra", "vega", "nova", "rigel", "player"];
const COOLDOWN_SPEED = 0.62;
const AVG_SPEED = MAX_SPEED * 0.85;

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

function makeCar(def, isPlayer) {
  return {
    id: def.id,
    name: def.name,
    number: def.number,
    color: def.color,
    accent: def.accent,
    personality: def.personality ?? null,
    skill: def.skill ?? 1,
    isPlayer,
    progress: 0,
    prevProgress: 0,
    offset: 0,
    speed: 0,
    topSpeed: MAX_SPEED,
    steer: 0,
    braking: false,
    drafting: false,
    nitro: 0.5,
    nitroTime: 0,
    nitroUses: 0,
    lapsDone: -1,
    lapStart: 0,
    lapTimes: [],
    bestLap: null,
    finished: false,
    finishTime: null,
    estimated: false,
    penalty: 0,
    position: 0,
    startPosition: 0,
    overtakes: 0,
    lastOvertakeAt: -10,
    contacts: 0,
    offTrackTime: 0,
    wallHits: 0,
    wallCooldown: 0,
    maxSpeed: 0,
    launchDelay: 0,
    history: new Float32Array(HISTORY),
    historyIndex: 0,
    brain: null,
  };
}

export class Race {
  constructor({ track, laps = 3, difficulty = "normal" }) {
    this.track = track;
    this.laps = laps;
    this.difficulty = difficulty;
    this.phase = "grid"; // grid -> countdown -> racing -> finished
    this.time = 0;
    this.countdown = 0;
    this.events = [];
    this.lastContact = new Map();
    this.finishedAt = null;

    const rivalTop = DIFFICULTY[difficulty]?.rivalTop ?? DIFFICULTY.normal.rivalTop;
    this.player = makeCar(PLAYER, true);
    this.rivals = RIVALS.map((def) => {
      const car = makeCar(def, false);
      car.topSpeed = MAX_SPEED * rivalTop * def.skill;
      car.brain = {
        maneuver: "racing_line",
        pace: 1.5,
        nitroP: 0,
        maneuverDist: null,
        confidence: null,
        paceDist: null,
        paceLabels: null,
        source: "none",
        latencyMs: null,
        decidedAt: 0,
        decisions: 0,
        pending: false,
        nextAt: 0,
        nitroFired: false,
        error: null,
      };
      return car;
    });
    this.cars = [this.player, ...this.rivals];

    GRID_ORDER.forEach((id, i) => {
      const car = this.cars.find((c) => c.id === id);
      const row = Math.floor(i / 2);
      const col = i % 2;
      car.progress = -(420 + row * 3.4 * CAR_LENGTH + col * 1.3 * CAR_LENGTH);
      car.offset = col === 0 ? -0.42 : 0.42;
      car.startPosition = i + 1;
      car.position = i + 1;
      car.launchDelay = car.isPlayer ? 0 : 0.08 + Math.random() * 0.3;
      car.history.fill(car.offset);
    });
    this.order = [...this.cars].sort((a, b) => a.position - b.position);
  }

  // ---- lifecycle -------------------------------------------------------------

  startCountdown() {
    this.phase = "countdown";
    this.countdown = 3;
    this.events.push({ type: "countdown", value: 3 });
  }

  drainEvents() {
    const out = this.events;
    this.events = [];
    return out;
  }

  // ---- geometry helpers --------------------------------------------------------

  /** Signed distance (world units) from car a to car b along the track, wrapped to (-L/2, L/2]. */
  deltaZ(a, b) {
    const L = this.track.length;
    let dz = (((b.progress - a.progress) % L) + L) % L;
    if (dz > L / 2) dz -= L;
    return dz;
  }

  surroundings(car) {
    let ahead = null;
    let behind = null;
    let alongside = null;
    for (const other of this.cars) {
      if (other === car) continue;
      const dz = this.deltaZ(car, other);
      const dx = other.offset - car.offset;
      const entry = { car: other, dz, dx, dzM: dz * M_PER_UNIT };
      if (Math.abs(dz) < CAR_LENGTH * 1.1) {
        if (!alongside || Math.abs(dx) < Math.abs(alongside.dx)) alongside = entry;
      } else if (dz > 0) {
        if (!ahead || dz < ahead.dz) ahead = entry;
      } else if (!behind || dz > behind.dz) {
        behind = entry;
      }
    }
    return { ahead, behind, alongside };
  }

  /** Nearest car ahead that overlaps laterally (would be rear-ended). */
  blocker(car, range = CAR_LENGTH * 3.5) {
    let best = null;
    for (const other of this.cars) {
      if (other === car) continue;
      const dz = this.deltaZ(car, other);
      if (dz <= 0 || dz > range) continue;
      if (Math.abs(other.offset - car.offset) > CAR_HALF * 2.1) continue;
      if (!best || dz < best.dz) best = { car: other, dz };
    }
    return best;
  }

  lapOf(car) {
    return clamp(car.lapsDone + 1, 1, this.laps);
  }

  offsetAgo(car, steps) {
    return car.history[(car.historyIndex - steps + HISTORY * 4) % HISTORY];
  }

  gapSeconds(front, back) {
    return Math.max(0, (front.progress - back.progress) / AVG_SPEED);
  }

  // ---- update -----------------------------------------------------------------

  update(dt, controls) {
    if (this.phase === "countdown") {
      const before = Math.ceil(this.countdown);
      this.countdown -= dt;
      const after = Math.ceil(this.countdown);
      if (this.countdown <= 0) {
        this.phase = "racing";
        this.events.push({ type: "go" });
      } else if (after !== before) {
        this.events.push({ type: "countdown", value: after });
      }
      return;
    }
    if (this.phase !== "racing" && this.phase !== "finished") return;
    this.time += dt;

    for (const car of this.cars) car.prevProgress = car.progress;
    for (const car of this.cars) this.updateDrafting(car, dt);
    if (this.player.finished) this.driveAi(this.player, dt);
    else this.drivePlayer(this.player, dt, controls);
    for (const car of this.rivals) {
      if (this.time >= car.launchDelay) this.driveAi(car, dt);
    }
    for (const car of this.cars) {
      car.historyIndex = (car.historyIndex + 1) % HISTORY;
      car.history[car.historyIndex] = car.offset;
      car.maxSpeed = Math.max(car.maxSpeed, car.speed);
    }
    this.handleContacts();
    for (const car of this.cars) this.updateLaps(car);
    this.updatePositions();
    this.checkRaceEnd();
  }

  updateDrafting(car, dt) {
    const target = this.blocker(car, DRAFT_RANGE_M / M_PER_UNIT);
    car.drafting = Boolean(target && target.dz > CAR_LENGTH * 1.2 && car.speed > MAX_SPEED * 0.5 && Math.abs(target.car.offset - car.offset) < 0.22);
    car.nitro = Math.min(1, car.nitro + (NITRO_RECHARGE + (car.drafting ? DRAFT_RECHARGE : 0)) * dt);
    if (car.nitroTime > 0) car.nitroTime = Math.max(0, car.nitroTime - dt);
  }

  fireNitro(car) {
    if (car.nitroTime > 0 || car.nitro < NITRO_COST || this.phase !== "racing") return false;
    car.nitro -= NITRO_COST;
    car.nitroTime = NITRO_DURATION;
    car.nitroUses++;
    this.events.push({ type: "nitro", car });
    return true;
  }

  limitSpeed(car, top, dt) {
    let limit = top;
    if (car.nitroTime > 0) limit *= NITRO_BOOST;
    if (car.drafting) limit *= DRAFT_BOOST;
    if (car.speed > limit) car.speed = Math.max(limit, car.speed - MAX_SPEED * 0.6 * dt);
    car.speed = Math.max(0, car.speed);
  }

  drivePlayer(car, dt, controls) {
    const track = this.track;
    const seg = track.findSegment(car.progress);
    const speedPct = car.speed / MAX_SPEED;
    const dx = dt * 2 * speedPct;

    car.steer = 0;
    if (controls.left) {
      car.offset -= dx;
      car.steer = -1;
    } else if (controls.right) {
      car.offset += dx;
      car.steer = 1;
    }
    car.offset -= dx * speedPct * seg.curve * CENTRIFUGAL;

    if (controls.nitro) this.fireNitro(car);
    car.braking = Boolean(controls.down);
    if (controls.up) car.speed += ACCEL * (car.nitroTime > 0 ? 1.8 : 1) * dt;
    else if (controls.down) car.speed += BRAKING * dt;
    else car.speed += DECEL * dt;

    const offRoad = Math.abs(car.offset) > 1;
    if (offRoad) {
      car.offTrackTime += dt;
      if (car.speed > OFF_ROAD_LIMIT) car.speed += OFF_ROAD_DECEL * dt;
      this.checkRoadsideHit(car, seg, dt);
    }
    car.wallCooldown = Math.max(0, car.wallCooldown - dt);
    car.offset = clamp(car.offset, -2.6, 2.6);
    this.limitSpeed(car, MAX_SPEED, dt);
    car.progress += car.speed * dt;
  }

  checkRoadsideHit(car, seg, dt) {
    if (car.wallCooldown > 0) return;
    for (const sprite of seg.sprites) {
      const type = SPRITE_TYPES[sprite.kind];
      if (!type.solid) continue;
      const w = (type.width / ROAD_WIDTH) * type.solid;
      const center = sprite.offset + (sprite.offset < 0 ? -1 : 1) * (type.width / ROAD_WIDTH) * 0.5;
      if (Math.abs(car.offset - center) < w / 2 + CAR_HALF) {
        car.speed = Math.min(car.speed, MAX_SPEED * 0.12);
        car.wallCooldown = 0.8;
        car.wallHits++;
        this.events.push({ type: "wall", car });
        return;
      }
    }
  }

  /** Executes the car's current high-level decision (from the Decisions API or fallback). */
  driveAi(car, dt) {
    const track = this.track;
    const brain = car.finished || !car.brain ? { maneuver: "racing_line", pace: 0 } : car.brain;
    const near = this.surroundings(car);
    const ahead = near.ahead && near.ahead.dzM < 90 ? near.ahead.car : null;
    const behind = near.behind && near.behind.dzM > -70 ? near.behind.car : null;

    let targetOffset = car.offset;
    switch (brain.maneuver) {
      case "overtake_left":
      case "overtake_right": {
        if (ahead) {
          let side = brain.maneuver === "overtake_left" ? -1 : 1;
          if (Math.abs(ahead.offset + side * 0.55) > 0.86) side = -side;
          targetOffset = ahead.offset + side * 0.55;
        }
        break;
      }
      case "slipstream":
        if (ahead) targetOffset = ahead.offset;
        break;
      case "defend":
        if (behind) targetOffset = behind.offset;
        break;
      case "back_off": {
        const other = near.alongside?.car ?? ahead;
        if (other) targetOffset = car.offset - (Math.sign(other.offset - car.offset) || 1) * 0.35;
        break;
      }
      default:
        targetOffset = clamp(track.avgCurveAhead(car.progress, 40) * 0.12, -0.55, 0.55);
    }
    targetOffset = clamp(targetOffset, -0.86, 0.86);

    // Never steer into a car that is alongside: stop short of its flank.
    const clearance = CAR_HALF * 2 + 0.04;
    for (const other of this.cars) {
      if (other === car || Math.abs(this.deltaZ(car, other)) > CAR_LENGTH * 1.3) continue;
      if (other.offset > car.offset && targetOffset > car.offset) {
        targetOffset = Math.min(targetOffset, Math.max(car.offset, other.offset - clearance));
      } else if (other.offset < car.offset && targetOffset < car.offset) {
        targetOffset = Math.max(targetOffset, Math.min(car.offset, other.offset + clearance));
      }
    }

    const lateral = (0.25 + (car.speed / MAX_SPEED) * 1.0) * dt;
    const move = clamp(targetOffset - car.offset, -lateral, lateral);
    car.offset += move;
    car.steer = move > lateral * 0.4 ? 1 : move < -lateral * 0.4 ? -1 : 0;

    const top = car.isPlayer ? MAX_SPEED * COOLDOWN_SPEED : car.finished ? car.topSpeed * COOLDOWN_SPEED : car.topSpeed;
    const pace = 0.92 + 0.03 * clamp(brain.pace ?? 1.5, 0, 3);
    const corner = 1 - 0.03 * Math.max(0, track.maxCurveAhead(car.progress, 30) - 2);
    let target = top * pace * corner;
    if (brain.maneuver === "back_off") target *= 0.94;
    if (brain.maneuver === "overtake_left" || brain.maneuver === "overtake_right") target *= 1.02;
    if (car.nitroTime > 0) target *= NITRO_BOOST;
    if (car.drafting) target *= DRAFT_BOOST;

    const block = this.blocker(car);
    if (block) {
      const gap = block.dz - CAR_LENGTH;
      if (gap < CAR_LENGTH * 2) target = Math.min(target, block.car.speed * (gap < CAR_LENGTH * 0.6 ? 0.94 : 1));
    }

    car.braking = target < car.speed - MAX_SPEED * 0.04;
    if (car.speed < target) car.speed = Math.min(target, car.speed + ACCEL * (car.nitroTime > 0 ? 1.8 : 1) * dt);
    else car.speed = Math.max(target, car.speed - MAX_SPEED * 0.55 * dt);
    car.progress += car.speed * dt;
  }

  handleContacts() {
    const width = CAR_HALF * 2 * 0.92;
    for (let i = 0; i < this.cars.length; i++) {
      for (let j = i + 1; j < this.cars.length; j++) {
        const a = this.cars[i];
        const b = this.cars[j];
        const dz = this.deltaZ(a, b);
        const dx = b.offset - a.offset;
        if (Math.abs(dz) >= CAR_LENGTH || Math.abs(dx) >= width) continue;

        const speedA = a.speed;
        const speedB = b.speed;
        const front = dz > 0 ? b : a;
        const rear = dz > 0 ? a : b;
        const closing = rear.speed - front.speed;
        // If they did not overlap lengthwise on the previous step, one ran into the other.
        const prevDz = Math.abs(this.deltaZ({ progress: a.prevProgress }, { progress: b.prevProgress }));
        const kind = prevDz >= CAR_LENGTH * 0.98 ? "rear" : "side";
        if (kind === "rear") {
          if (closing > 0) {
            front.speed += closing * 0.3;
            rear.speed = Math.max(0, front.speed - closing * 0.6);
          }
          rear.progress -= CAR_LENGTH - Math.abs(dz);
          rear.offset -= (Math.sign(dx) || 1) * (dz > 0 ? 0.02 : -0.02);
        } else {
          const push = (width - Math.abs(dx)) / 2 + 0.02;
          const dir = Math.sign(dx) || (Math.random() < 0.5 ? -1 : 1);
          a.offset -= dir * push;
          b.offset += dir * push;
          a.speed *= 0.985;
          b.speed *= 0.985;
        }
        this.registerContact(a, b, kind, front, speedA, speedB);
      }
    }
  }

  registerContact(a, b, kind, front, speedA, speedB) {
    const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
    const last = this.lastContact.get(key) ?? -Infinity;
    this.lastContact.set(key, this.time);
    if (this.time - last < 1.5) return;

    a.contacts++;
    b.contacts++;
    if (!a.isPlayer && !b.isPlayer) return;

    const player = a.isPlayer ? a : b;
    const rival = a.isPlayer ? b : a;
    const playerSpeed = a.isPlayer ? speedA : speedB;
    const rivalSpeed = a.isPlayer ? speedB : speedA;
    const pThen = this.offsetAgo(player, LOOKBACK);
    const rThen = this.offsetAgo(rival, LOOKBACK);
    const dir = Math.sign(rival.offset - player.offset) || Math.sign(rThen - pThen) || 1;
    const intensity = clamp(Math.abs(playerSpeed - rivalSpeed) / (MAX_SPEED * 0.25) + 0.25, 0.25, 1);

    this.events.push({
      type: "contact",
      rival,
      intensity,
      incident: {
        rival: { name: rival.name, number: rival.number },
        rivalId: rival.id,
        lap: this.lapOf(player),
        laps: this.laps,
        kind,
        front: kind === "side" ? "level" : front === player ? "player" : "rival",
        playerSpeedKmh: Math.round(toKmh(playerSpeed)),
        rivalSpeedKmh: Math.round(toKmh(rivalSpeed)),
        playerLateral: Number(((player.offset - pThen) * dir).toFixed(3)),
        rivalLateral: Number(((rival.offset - rThen) * -dir).toFixed(3)),
        rivalManeuver: rival.brain?.maneuver ?? null,
        playerBraking: player.braking,
        playerNitro: player.nitroTime > 0,
        playerOffTrack: Math.abs(player.offset) > 1,
      },
    });
  }

  updateLaps(car) {
    const L = this.track.length;
    const completed = Math.floor(car.progress / L);
    if (completed <= car.lapsDone) return;
    if (completed >= 1 && !car.finished) {
      const crossTime = this.time - (car.progress - completed * L) / Math.max(car.speed, 1);
      const lapTime = crossTime - car.lapStart;
      car.lapTimes.push(lapTime);
      car.bestLap = car.bestLap === null ? lapTime : Math.min(car.bestLap, lapTime);
      car.lapStart = crossTime;
      if (completed >= this.laps) {
        car.finished = true;
        car.finishTime = crossTime;
        this.events.push({ type: "finish", car });
      } else if (car.isPlayer) {
        this.events.push({ type: "lap", lap: completed, lapTime, best: car.bestLap === lapTime, final: completed === this.laps - 1 });
      }
    }
    car.lapsDone = completed;
  }

  updatePositions() {
    const order = [...this.cars].sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.progress - a.progress;
    });
    order.forEach((car, i) => {
      const pos = i + 1;
      if (this.phase === "racing" && pos < car.position && !car.finished && this.time - car.lastOvertakeAt > 1.5) {
        car.overtakes += car.position - pos;
        car.lastOvertakeAt = this.time;
      }
      car.position = pos;
    });
    this.order = order;
  }

  checkRaceEnd() {
    if (this.phase !== "racing") return;
    const everyone = this.cars.every((c) => c.finished);
    const playerDoneLongAgo = this.player.finished && this.time - this.player.finishTime > 25;
    if (!everyone && !playerDoneLongAgo) return;
    for (const car of this.cars) {
      if (car.finished) continue;
      const remaining = this.laps * this.track.length - car.progress;
      car.finishTime = this.time + remaining / AVG_SPEED;
      car.estimated = true;
      car.finished = true;
    }
    this.phase = "finished";
    this.finishedAt = this.time;
    this.events.push({ type: "classified" });
  }

  applyPenalty(car, seconds) {
    car.penalty += seconds;
    this.events.push({ type: "penalty", car, seconds });
  }

  /** Final standings including time penalties. */
  classify() {
    return [...this.cars]
      .map((car) => ({ car, total: (car.finishTime ?? Infinity) + car.penalty }))
      .sort((a, b) => a.total - b.total)
      .map((entry, i) => ({ ...entry, position: i + 1 }));
  }

  // ---- Decisions API payloads -------------------------------------------------

  rivalPayload(car) {
    const near = this.surroundings(car);
    const describe = (entry, maxM) =>
      entry && Math.abs(entry.dzM) <= maxM
        ? {
            name: entry.car.name,
            isPlayer: entry.car.isPlayer,
            gapM: Math.round(Math.abs(entry.dzM)),
            offset: Number(entry.car.offset.toFixed(2)),
            relSpeedKmh: Math.round(toKmh(entry.car.speed - car.speed)),
          }
        : null;
    const leader = this.order[0];
    const index = this.order.indexOf(car);
    const next = this.order[index + 1];
    const lookahead = car.progress + car.speed * 0.4; // compensate for decision latency
    return {
      driver: { name: car.name, number: car.number, personality: car.personality },
      race: {
        lap: this.lapOf(car),
        laps: this.laps,
        position: car.position,
        cars: this.cars.length,
        gapToLeaderS: car === leader ? 0 : Number(this.gapSeconds(leader, car).toFixed(1)),
        gapToNextS: next ? Number(this.gapSeconds(car, next).toFixed(1)) : 0,
      },
      self: {
        speedKmh: Math.round(toKmh(car.speed)),
        topSpeedKmh: Math.round(toKmh(car.topSpeed)),
        offset: Number(car.offset.toFixed(2)),
        nitro: Number(car.nitro.toFixed(2)),
        nitroActive: car.nitroTime > 0,
        lastManeuver: car.brain.decisions > 0 ? car.brain.maneuver : null,
        lastManeuverAgoS: Number((this.time - car.brain.decidedAt).toFixed(1)),
      },
      track: this.track.describeAhead(lookahead),
      elevation: this.track.elevationAhead(lookahead),
      ahead: describe(near.ahead, 150),
      behind: describe(near.behind, 100),
      alongside: near.alongside ? describe(near.alongside, 10) : null,
    };
  }

  summary() {
    const standings = this.classify();
    return {
      laps: this.laps,
      difficulty: this.difficulty,
      drivers: standings.map(({ car, total, position }) => ({
        name: car.name,
        isPlayer: car.isPlayer,
        personality: car.personality,
        start: car.startPosition,
        finish: position,
        timeS: Number.isFinite(total) ? Number(total.toFixed(2)) : null,
        penaltyS: car.penalty,
        bestLapS: car.bestLap ? Number(car.bestLap.toFixed(2)) : null,
        overtakes: car.overtakes,
        contacts: car.contacts,
      })),
      player: {
        offTrackS: Number(this.player.offTrackTime.toFixed(1)),
        wallHits: this.player.wallHits,
        nitroUses: this.player.nitroUses,
        topSpeedKmh: Math.round(toKmh(this.player.maxSpeed)),
      },
    };
  }
}
