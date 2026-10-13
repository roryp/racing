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

const released = () => ({ left: false, right: false, up: false, down: false, nitro: false });

/**
 * Adds `touch-ui` to <html> on touch-first devices, or as soon as someone touches the page,
 * so the on-screen controls and touch hints show instead of keyboard hints.
 */
export function watchTouchUi(onChange) {
  const root = document.documentElement;
  const enable = () => {
    if (root.classList.contains("touch-ui")) return;
    root.classList.add("touch-ui");
    onChange?.();
  };
  if (matchMedia("(pointer: coarse)").matches) enable();
  window.addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType === "touch") enable();
    },
    { capture: true, passive: true },
  );
}

export class Input {
  constructor(target = window) {
    this.keys = released();
    this.touch = released();
    this.pointers = new Map(); // pointerId -> { button, pad } for fingers on the touch pads
    this.touchRoot = null;
    this.pressed = new Set();

    target.addEventListener("keydown", (e) => {
      if (e.target instanceof Element && e.target.closest("button, select, input, textarea")) return;
      const held = HELD[e.code];
      const action = ACTIONS[e.code];
      if (held) this.keys[held] = true;
      if (action && !e.repeat) this.pressed.add(action);
      if (held || action === "nitro") e.preventDefault();
    });
    target.addEventListener("keyup", (e) => {
      const held = HELD[e.code];
      if (held) this.keys[held] = false;
    });
    window.addEventListener("blur", () => this.reset());
  }

  /**
   * Controls currently held on the keyboard or the touch pads. `nitro` is only ever held on the
   * touch pads (the keyboard fires it once per press through `consume`).
   */
  get held() {
    const { keys, touch } = this;
    return {
      left: keys.left || touch.left,
      right: keys.right || touch.right,
      up: keys.up || touch.up,
      down: keys.down || touch.down,
      nitro: touch.nitro,
    };
  }

  /**
   * On-screen controls. `[data-hold]` buttons act like held keys and follow the finger
   * to other buttons on the same `.pad` (slide from ◀ to ▶ to steer); `[data-boost]`
   * buttons also request nitro while a finger is on them, so the throttle thumb can slide
   * from GAS up to NITRO (whose hold is the throttle too) without letting off.
   * `[data-tap]` buttons fire their action once per touch. Every finger is tracked separately.
   */
  bindTouch(root) {
    this.touchRoot = root;
    const buttonAt = (x, y, pad) => {
      const button = document.elementFromPoint(x, y)?.closest("[data-hold]");
      return button && button.closest(".pad") === pad ? button : null;
    };
    const release = (e) => {
      if (this.pointers.delete(e.pointerId)) this.syncTouch();
    };

    root.addEventListener("pointerdown", (e) => {
      const button = e.target.closest("[data-hold], [data-tap]");
      if (!button) return;
      e.preventDefault();
      // Keep receiving this finger's events even after it slides off the button.
      try {
        button.setPointerCapture(e.pointerId);
      } catch {
        // The pointer is already gone; the press still counts.
      }
      if (button.dataset.tap) {
        this.pressed.add(button.dataset.tap);
        button.classList.add("on");
        setTimeout(() => button.classList.remove("on"), 140);
        return;
      }
      this.pointers.set(e.pointerId, { button, pad: button.closest(".pad") });
      this.syncTouch();
    });
    root.addEventListener("pointermove", (e) => {
      const finger = this.pointers.get(e.pointerId);
      if (!finger) return;
      const button = buttonAt(e.clientX, e.clientY, finger.pad);
      if (button !== finger.button) {
        finger.button = button;
        this.syncTouch();
      }
    });
    root.addEventListener("pointerup", release);
    root.addEventListener("pointercancel", release);
    root.addEventListener("lostpointercapture", release);
    root.addEventListener("contextmenu", (e) => e.preventDefault());
    // Don't let a tap on a pad become a click on whatever just appeared under the finger
    // (the pause menu after ❚❚, or the results screen when the race ends).
    root.addEventListener("touchend", (e) => e.preventDefault(), { passive: false });
  }

  syncTouch() {
    this.touch = released();
    const down = new Set();
    for (const { button } of this.pointers.values()) {
      if (!button) continue;
      down.add(button);
      this.touch[button.dataset.hold] = true;
      if ("boost" in button.dataset) this.touch.nitro = true;
    }
    for (const button of this.touchRoot?.querySelectorAll("[data-hold]") ?? []) {
      button.classList.toggle("on", down.has(button));
    }
  }

  /** Returns true once per key press for edge-triggered actions. */
  consume(action) {
    return this.pressed.delete(action);
  }

  reset() {
    this.keys = released();
    this.pointers.clear();
    this.syncTouch();
    this.pressed.clear();
  }
}
