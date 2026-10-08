// Shared constants for the pseudo-3D racer.

export const STEP = 1 / 60;
export const WIDTH = 1280;
export const HEIGHT = 720;

// Road geometry (world units)
export const SEGMENT_LENGTH = 200;
export const RUMBLE_LENGTH = 3;
export const ROAD_WIDTH = 2000; // half-width: the road spans offset -1..+1
export const LANES = 3;
export const LANE_WIDTH = 2 / LANES; // in offset units

// Camera
export const FIELD_OF_VIEW = 100;
export const CAMERA_HEIGHT = 1000;
export const CAMERA_DEPTH = 1 / Math.tan(((FIELD_OF_VIEW / 2) * Math.PI) / 180);
export const PLAYER_Z = CAMERA_HEIGHT * CAMERA_DEPTH;
export const DRAW_DISTANCE = 300;
export const FOG_DENSITY = 4;

// Driving model
export const MAX_SPEED = SEGMENT_LENGTH / STEP; // 12,000 units/s
export const KMH_AT_MAX = 300;
export const M_PER_UNIT = KMH_AT_MAX / 3.6 / MAX_SPEED;
export const toKmh = (speed) => (speed / MAX_SPEED) * KMH_AT_MAX;
export const ACCEL = MAX_SPEED / 5;
export const BRAKING = -MAX_SPEED;
export const DECEL = -MAX_SPEED / 5;
export const OFF_ROAD_DECEL = -MAX_SPEED / 2;
export const OFF_ROAD_LIMIT = MAX_SPEED / 4;
export const CENTRIFUGAL = 0.3;

// Cars
export const CAR_WIDTH = 560; // world units
export const CAR_LENGTH = 340; // world units along the track
export const CAR_HALF = CAR_WIDTH / ROAD_WIDTH / 2; // half-width in offset units

// Nitro & slipstream
export const NITRO_BOOST = 1.22;
export const NITRO_DURATION = 2.2;
export const NITRO_COST = 0.34;
export const NITRO_RECHARGE = 0.025; // tank per second
export const DRAFT_RECHARGE = 0.12; // extra tank per second while drafting
export const DRAFT_BOOST = 1.06;
export const DRAFT_RANGE_M = 28;

export const DIFFICULTY = {
  easy: { rivalTop: 0.88, label: "Easy" },
  normal: { rivalTop: 0.94, label: "Normal" },
  hard: { rivalTop: 1.0, label: "Hard" },
};

export const PLAYER = { id: "player", name: "You", number: 1, color: "#eef2fb", accent: "#2f6bff" };

export const RIVALS = [
  { id: "vega", name: "Vega", number: 7, personality: "aggressive", color: "#ff4b3a", accent: "#2b2b2b", skill: 1.0 },
  { id: "nova", name: "Nova", number: 11, personality: "tactical", color: "#25c9f5", accent: "#0d2a52", skill: 1.0 },
  { id: "orion", name: "Orion", number: 3, personality: "defensive", color: "#45d46a", accent: "#123d1f", skill: 0.99 },
  { id: "lyra", name: "Lyra", number: 22, personality: "smooth", color: "#a865ff", accent: "#f2e8ff", skill: 1.01 },
  { id: "rigel", name: "Rigel", number: 9, personality: "wildcard", color: "#ffcf33", accent: "#3a2a00", skill: 0.985 },
];

export const MANEUVERS = {
  racing_line: { label: "Racing line", tag: "LINE", color: "#8aa1c1" },
  overtake_left: { label: "Overtake left", tag: "◀ OVERTAKE", color: "#ff8a3d" },
  overtake_right: { label: "Overtake right", tag: "OVERTAKE ▶", color: "#ffb03d" },
  slipstream: { label: "Slipstream", tag: "≋ DRAFT", color: "#3dd6ff" },
  defend: { label: "Defend", tag: "■ DEFEND", color: "#ff4f7b" },
  back_off: { label: "Back off", tag: "▼ BACK OFF", color: "#9be564" },
};

// Probability a rival needs from the `nitro` predicate before it fires a boost.
export const NITRO_THRESHOLD = { aggressive: 0.5, wildcard: 0.5, tactical: 0.65, smooth: 0.65, defensive: 0.6 };

export const COLORS = {
  fog: "#c56d78",
  light: { road: "#5b5967", grass: "#2f6f45", rumble: "#efe9ea", lane: "#dcd7dc" },
  dark: { road: "#56545f", grass: "#2a663f", rumble: "#c9363d", lane: null },
};
