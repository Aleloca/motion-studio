// Plays one Motion Studio composition in a figure, through the product's own runtime page in preview mode
// (runtime/<id>.html?mode=preview&parentOrigin=…) and its preview protocol: setScale, mute, play, pause, seek.
// The figure keeps its poster image underneath: it shows until the runtime is ready, and for good if it fails.
import { decide, isVisible, VISIBLE_RATIO } from './player-logic.js';

// Generous: the poster covers the frame until the runtime is ready, so a slow first load costs nothing visible. A cold
// first composition (runtime, preview.js and fonts) took over 8 s on a slow machine.
export const READY_TIMEOUT_MS = 20000;

export class CompositionPlayer {
  /**
   * @param {{ dataset: { composition: string, posterTime?: string, replay?: string, loopFrom?: string }, classList: { add(c: string): void, remove(c: string): void } }} figure
   * @param {{ origin: string, mount(src: string, player: CompositionPlayer): { contentWindow: { postMessage(m: unknown, o: string): void }, remove(): void },
   *   setTimeout(fn: () => void, ms: number): unknown, clearTimeout(id: unknown): void, log?: (m: unknown) => void }} deps
   */
  constructor(figure, deps) {
    this.figure = figure;
    this.deps = deps;
    this.id = figure.dataset.composition;
    this.posterTime = Number(figure.dataset.posterTime ?? 0) || 0;
    /** data-replay="poster" (the showcase): each return to the screen plays again from the poster frame, not mid-film. */
    this.replayFromPoster = figure.dataset.replay === 'poster';
    /** data-loop-from (seconds): where the loop starts again, past an opening that is still empty (t = 0 always is). */
    this.loopFrom = Number(figure.dataset.loopFrom ?? 0) || 0;
    /** The last time the runtime reported while playing: a smaller one means it wrapped to the start. */
    this.lastTime = 0;
    this.frame = null;
    this.ready = false;
    /** null, or why the poster is shown for good: 'error' (the runtime refused it) or 'timeout' (retried on its return). */
    this.failed = null;
    this.playing = false;
    this.still = false;
    /** The runtime shows the poster frame (just seeked there, not played since). */
    this.atPoster = false;
    this.timer = null;
    this.state = { visible: false, near: false, reducedMotion: false };
  }

  get src() {
    return `runtime/${this.id}.html?mode=preview&parentOrigin=${encodeURIComponent(this.deps.origin)}`;
  }

  /** @param {{ visible?: boolean, near?: boolean, reducedMotion?: boolean }} state */
  update(state) {
    this.state = { ...this.state, ...state };
    if (this.failed === 'timeout' && !this.state.near) this.clearFailure();
    const action = decide({ ...this.state, ready: this.ready, failed: this.failed !== null });
    if (action === 'mount' && !this.frame) this.mount();
    else if (action === 'unmount' || (action === 'unmounted' && this.frame)) this.unmount();
    else if (action === 'play') this.play();
    else if (action === 'pause') this.pause();
    else if (action === 'still') this.showStill();
  }

  mount() {
    this.frame = this.deps.mount(this.src, this);
    this.timer = this.deps.setTimeout(() => this.fail('timeout'), READY_TIMEOUT_MS);
  }

  unmount() {
    this.destroy();
    this.ready = false;
    this.playing = false;
    this.still = false;
    this.atPoster = false;
    this.figure.classList.remove('is-ready');
  }

  send(m) {
    this.deps.log?.(m);
    this.frame?.contentWindow?.postMessage(m, this.deps.origin);
  }

  play() {
    if (this.playing) return;
    if (this.replayFromPoster && !this.atPoster) this.seek(this.posterTime);
    this.playing = true;
    this.still = false;
    this.atPoster = false;
    this.send({ type: 'play', loop: true });
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.send({ type: 'pause' });
  }

  seek(t) { this.send({ type: 'seek', t }); }

  /**
   * Back to the first frame (the hero shows each creative from its start). A seek stops the runtime's playback, so a
   * playing player is told to play again; a paused one stays there and plays from it when it next plays.
   * @returns {boolean} false when there is no live runtime to restart (still loading, or on its poster for good).
   */
  restart() {
    if (!this.ready || !this.frame || this.failed) return false;
    this.still = false;
    this.atPoster = false;
    this.seek(0);
    if (this.playing) this.send({ type: 'play', loop: true });
    return true;
  }

  showStill() {
    if (this.still) return;
    this.pause();
    this.still = true;
    if (!this.atPoster) { this.seek(this.posterTime); this.atPoster = true; }
  }

  /** @param {'error' | 'timeout'} why */
  fail(why) {
    if (this.failed) return;
    this.failed = why;
    this.figure.dataset.fail = why;
    this.deps.clearTimeout(this.timer);
    this.frame?.remove();
    this.frame = null;
    this.figure.classList.remove('is-ready');
    this.figure.classList.add('is-failed');
  }

  clearFailure() {
    this.failed = null;
    delete this.figure.dataset.fail;
    this.figure.classList.remove('is-failed');
  }

  /** @param {{ data: unknown, origin: string, source: unknown }} ev */
  onMessage(ev) {
    if (!this.frame || ev.source !== this.frame.contentWindow || ev.origin !== this.deps.origin) return;
    const data = ev.data;
    if (typeof data !== 'object' || data === null) return;
    if (data.type === 'ready' && !this.ready) {
      this.ready = true;
      this.deps.clearTimeout(this.timer);
      this.send({ type: 'setScale', scale: 'fit' });
      this.send({ type: 'mute', muted: true });
      // Start from the poster's frame: the hand-over from poster to live frame is seamless (t = 0 is an empty frame,
      // every clip enters after it).
      this.seek(this.posterTime);
      this.atPoster = true;
      this.update({});
    } else if (data.type === 'time' && data.playing === true && this.ready) {
      // The poster goes only once the runtime is really playing frames: never a blank or unpainted frame.
      this.figure.classList.add('is-ready');
      const wrapped = data.t < this.lastTime && data.t < this.loopFrom;
      this.lastTime = data.t;
      if (wrapped && this.playing) {
        // A seek stops the runtime's playback: play again from there.
        this.seek(this.loopFrom);
        this.send({ type: 'play', loop: true });
      }
    } else if (data.type === 'error' && !this.ready) {
      // Before ready only fatal errors are posted (no data, bad base, a composition that cannot mount).
      this.fail('error');
    }
  }

  destroy() {
    this.deps.clearTimeout(this.timer);
    this.frame?.remove();
    this.frame = null;
  }
}

/**
 * One player per `figure[data-composition]` of the document: mounted while within one viewport of the screen (and unmounted
 * beyond it), playing while at least a quarter of it is visible, a still frame under prefers-reduced-motion.
 * @param {Document} doc
 */
export function mountPlayers(doc, { log } = {}) {
  const win = doc.defaultView;
  const motion = win.matchMedia('(prefers-reduced-motion: reduce)');
  const players = new Map();
  const deps = {
    origin: win.location.origin,
    log,
    setTimeout: (fn, ms) => win.setTimeout(fn, ms),
    clearTimeout: (id) => win.clearTimeout(id),
    mount(src, player) {
      const iframe = doc.createElement('iframe');
      iframe.src = src;
      iframe.title = player.figure.querySelector('img')?.alt || 'Motion Studio composition';
      iframe.setAttribute('aria-hidden', 'true');
      iframe.tabIndex = -1;
      player.figure.querySelector('.comp-stage')?.appendChild(iframe) ?? player.figure.appendChild(iframe);
      return iframe;
    },
  };
  for (const figure of doc.querySelectorAll('figure[data-composition]')) {
    players.set(figure, new CompositionPlayer(figure, deps));
  }
  win.addEventListener('message', (ev) => { for (const p of players.values()) p.onMessage(ev); });
  const near = new win.IntersectionObserver((entries) => {
    for (const e of entries) players.get(e.target)?.update({ near: e.isIntersecting, reducedMotion: motion.matches });
  }, { rootMargin: '100% 0px' });
  const visible = new win.IntersectionObserver((entries) => {
    for (const e of entries) players.get(e.target)?.update({ visible: isVisible(e), reducedMotion: motion.matches });
  }, { threshold: [0, VISIBLE_RATIO] });
  for (const figure of players.keys()) { near.observe(figure); visible.observe(figure); }
  motion.addEventListener('change', () => { for (const p of players.values()) p.update({ reducedMotion: motion.matches }); });
  return [...players.values()];
}
