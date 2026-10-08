// AI Race Control: reviews player/rival contacts with the Decisions API
// (choice: who is responsible, score: severity), attaching the onboard frame.

const COOLDOWN_MS = 4000;
const MIN_RESPONSIBILITY = 0.6;
const MIN_SEVERITY = 0.8;

export class RaceControl {
  constructor({ race, api, enabled, captureFrame, onVerdict }) {
    this.race = race;
    this.api = api;
    this.enabled = enabled;
    this.captureFrame = captureFrame;
    this.onVerdict = onVerdict;
    this.lastReview = new Map();
    this.pending = 0;
    this.stopped = false;
  }

  stop() {
    this.stopped = true;
  }

  review(incident) {
    if (!this.enabled || this.stopped) return;
    const now = performance.now();
    if (now - (this.lastReview.get(incident.rivalId) ?? -Infinity) < COOLDOWN_MS) return;
    this.lastReview.set(incident.rivalId, now);

    // The rival is only on camera when it is ahead of or beside the player.
    const frame = incident.front === "player" ? null : this.captureFrame();
    const rival = this.race.rivals.find((c) => c.id === incident.rivalId);
    const { rivalId, ...payload } = incident;

    this.pending++;
    this.onVerdict?.({ status: "reviewing", incident, rival });
    this.api
      .steward({ ...payload, frame })
      .then((verdict) => {
        if (this.stopped) return;
        const responsible = verdict.responsible;
        const severity = verdict.severity?.score ?? 0;
        const confidence = responsible ? (responsible.probabilities[responsible.choice] ?? 0) : 0;
        let penalty = 0;
        let target = null;
        if (responsible && responsible.choice !== "racing_incident" && confidence >= MIN_RESPONSIBILITY && severity >= MIN_SEVERITY) {
          penalty = severity >= 1.5 ? 5 : 2;
          target = responsible.choice === "player" ? this.race.player : rival;
          this.race.applyPenalty(target, penalty);
        }
        this.onVerdict?.({ status: "verdict", incident, rival, verdict, penalty, target, withFrame: Boolean(frame) });
      })
      .catch((err) => {
        if (!this.stopped) this.onVerdict?.({ status: "error", incident, rival, error: err.message });
      })
      .finally(() => {
        this.pending--;
      });
  }
}
