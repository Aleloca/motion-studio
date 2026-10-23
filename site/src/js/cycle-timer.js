// The hero cycle's clock: one pending step, paused while the hero is off screen or the tab hidden (the players pause
// then too), so on return the next brief still comes when the creative reaches its end card.
export class CycleTimer {
  /** @param {{ now(): number, setTimeout(fn: () => void, ms: number): unknown, clearTimeout(id: unknown): void }} clock ms */
  constructor(clock) {
    this.clock = clock;
    this.fn = null;
    this.left = 0;
    this.since = 0;
    this.id = null;
    this.paused = false;
  }

  /** Runs `fn` in `seconds` of running time (replacing a pending step). */
  after(seconds, fn) {
    this.disarm();
    this.fn = fn;
    this.left = seconds * 1000;
    if (!this.paused) this.arm();
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    if (this.id !== null) { this.left = Math.max(0, this.left - (this.clock.now() - this.since)); this.disarm(); }
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    if (this.fn) this.arm();
  }

  arm() {
    this.since = this.clock.now();
    this.id = this.clock.setTimeout(() => { const fn = this.fn; this.id = null; this.fn = null; fn?.(); }, this.left);
  }

  disarm() {
    if (this.id !== null) this.clock.clearTimeout(this.id);
    this.id = null;
  }
}
