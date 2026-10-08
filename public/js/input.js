const HELD = {
  ArrowLeft: "left",
  KeyA: "left",
  ArrowRight: "right",
  KeyD: "right",
  ArrowUp: "up",
  KeyW: "up",
  ArrowDown: "down",
  KeyS: "down",
};

const ACTIONS = {
  Space: "nitro",
  ShiftLeft: "nitro",
  ShiftRight: "nitro",
  Escape: "pause",
  KeyP: "pause",
  KeyM: "mute",
  KeyL: "labels",
  Enter: "confirm",
};

export class Input {
  constructor(target = window) {
    this.held = { left: false, right: false, up: false, down: false };
    this.pressed = new Set();

    target.addEventListener("keydown", (e) => {
      if (e.target instanceof Element && e.target.closest("button, select, input, textarea")) return;
      const held = HELD[e.code];
      const action = ACTIONS[e.code];
      if (held) this.held[held] = true;
      if (action && !e.repeat) this.pressed.add(action);
      if (held || action === "nitro") e.preventDefault();
    });
    target.addEventListener("keyup", (e) => {
      const held = HELD[e.code];
      if (held) this.held[held] = false;
    });
    window.addEventListener("blur", () => this.reset());
  }

  /** Returns true once per key press for edge-triggered actions. */
  consume(action) {
    return this.pressed.delete(action);
  }

  reset() {
    for (const key of Object.keys(this.held)) this.held[key] = false;
    this.pressed.clear();
  }
}
