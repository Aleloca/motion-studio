// Plays one Motion Studio composition in a figure, through the product's own runtime page in preview mode
// (runtime/<id>.html?mode=preview&parentOrigin=…) and its preview protocol: setScale, mute, play, pause, seek.
// The figure keeps its poster image underneath: it shows until the runtime is ready, and for good if it fails.
import { decide } from './player-logic.js';

export const READY_TIMEOUT_MS = 8000;

export class CompositionPlayer {
  /**
   * @param {{ dataset: { composition: string, posterTime?: string }, classList: { add(c: string): void, remove(c: string): void } }} figure
   * @param {{ origin: string, mount(src: string, player: CompositionPlayer): { contentWindow: { postMessage(m: unknown, o: string): void }, remove(): void },
   *   setTimeout(fn: () => void, ms: number): unknown, clearTimeout(id: unknown): void, log?: (m: unknown) => void }} deps
   */
  constructor(figure, deps) {
    this.figure = figure;
    this.deps = deps;
    this.id = figure.dataset.composition;
    this.posterTime = Number(figure.dataset.posterTime ?? 0) || 0;
    this.frame = null;
    this.ready = false;
    this.failed = false;
    this.playing = false;
    this.still = false;
    this.timer = null;
    this.state = { visible: false, near: false, reducedMotion: false };
  }

  get src() {
    return `runtime/${this.id}.html?mode=preview&parentOrigin=${encodeURIComponent(this.deps.origin)}`;
  }

  /** @param {{ visible?: boolean, near?: boolean, reducedMotion?: boolean }} state */
  update(state) {
    this.state = { ...this.state, ...state };
    const action = decide({ ...this.state, ready: this.ready, failed: this.failed });
    if (action === 'mount' && !this.frame) this.mount();
    else if (action === 'play') this.play();
    else if (action === 'pause') this.pause();
    else if (action === 'still') this.showStill();
  }

  mount() {
    this.frame = this.deps.mount(this.src, this);
    this.timer = this.deps.setTimeout(() => this.fail(), READY_TIMEOUT_MS);
  }

  send(m) {
    this.deps.log?.(m);
    this.frame?.contentWindow?.postMessage(m, this.deps.origin);
  }

  play() {
    if (this.playing) return;
    this.playing = true;
    this.still = false;
    this.send({ type: 'play', loop: true });
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.send({ type: 'pause' });
  }

  seek(t) { this.send({ type: 'seek', t }); }

  showStill() {
    if (this.still) return;
    this.pause();
    this.still = true;
    this.seek(this.posterTime);
  }

  fail() {
    if (this.failed) return;
    this.failed = true;
    this.deps.clearTimeout(this.timer);
    this.frame?.remove();
    this.frame = null;
    this.figure.classList.remove('is-ready');
    this.figure.classList.add('is-failed');
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
      this.figure.classList.add('is-ready');
      this.update({});
    } else if (data.type === 'error' && !this.ready) {
      // Before ready only fatal errors are posted (no data, bad base, a composition that cannot mount).
      this.fail();
    }
  }

  destroy() {
    this.deps.clearTimeout(this.timer);
    this.frame?.remove();
    this.frame = null;
  }
}

/**
 * One player per `figure[data-composition]` of the document: mounted when within one viewport of the screen, playing while
 * at least a quarter of it is visible, a still frame under prefers-reduced-motion.
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
    for (const e of entries) players.get(e.target)?.update({ visible: e.isIntersecting, reducedMotion: motion.matches });
  }, { threshold: 0.25 });
  for (const figure of players.keys()) { near.observe(figure); visible.observe(figure); }
  motion.addEventListener('change', () => { for (const p of players.values()) p.update({ reducedMotion: motion.matches }); });
  return [...players.values()];
}
