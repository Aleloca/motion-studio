// Plays one Motion Studio composition in a figure, through the product's own runtime page in preview mode
// (runtime/<id>.html?mode=preview&parentOrigin=…) and its preview protocol: setScale, mute, play, pause, seek.
// The figure keeps its poster image underneath: it shows until the runtime is ready, and for good if it fails.
import { decide, isVisible, VISIBLE_RATIO } from './player-logic.js';

// Generous: the poster covers the frame until the runtime is ready, so a slow first load costs nothing visible. A cold
// first composition (runtime, preview.js and fonts) took over 8 s on a slow machine.
export const READY_TIMEOUT_MS = 20000;

/**
 * At most this many live runtimes on the whole page at once. Each runtime is a page with its fonts, its frames (an html
 * layer is a frame of its own: the final cut holds dozens) and its canvases; on a phone they all share the browser's one
 * content process, and past a few of them iOS kills the tab.
 */
export const LIVE_BUDGET = { phone: 2, desktop: 4 };

/**
 * The page's budget of live runtimes, shared by every player: a player that wants a runtime gets a slot, or takes the slot
 * of a lower-ranked one (on screen beats only near, the viewer's Play beats both, then `state.priority`), or waits on its
 * poster until one frees.
 * @param {() => number} limit the budget now (it follows the screen)
 */
export function liveBudget(limit) {
  const live = new Set();
  const waiting = new Set();
  const rank = (p) => (p.state.intent === 'play' ? 1000 : 0) + (p.state.visible ? 100 : 0) + (p.state.priority ?? 0);
  let settling = false;
  const budget = {
    live, waiting,
    get limit() { return limit(); },
    /** @returns {boolean} whether `p` may mount now */
    acquire(p) {
      waiting.delete(p);
      if (live.has(p)) return true;
      if (live.size >= limit()) {
        const lowest = [...live].sort((x, y) => rank(x) - rank(y))[0];
        if (!lowest || rank(lowest) >= rank(p)) { waiting.add(p); return false; }
        settling = true;
        lowest.unmount();
        waiting.add(lowest);
        settling = false;
      }
      live.add(p);
      return true;
    },
    release(p) {
      live.delete(p);
      if (settling) return;
      budget.refresh();
    },
    /** Waiting players take the free slots, if any. */
    refresh() {
      // The best-ranked waiting players take the freed slots (each asks again through its own update).
      for (const w of [...waiting].sort((x, y) => rank(y) - rank(x))) {
        if (live.size >= limit()) break;
        waiting.delete(w);
        w.update({});
      }
    },
    /** `p` no longer wants a runtime (left the screen's surroundings). */
    forget(p) { waiting.delete(p); },
  };
  return budget;
}

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
    /** The time of the first played frame the runtime reported since it was mounted. */
    this.firstPlayed = null;
    this.frame = null;
    this.ready = false;
    /** null, or why the poster is shown for good: 'error' (the runtime refused it) or 'timeout' (retried on its return). */
    this.failed = null;
    this.playing = false;
    this.still = false;
    /** The runtime shows the poster frame (just seeked there, not played since). */
    this.atPoster = false;
    this.timer = null;
    /** data-loop="false" (the final cut): plays once and stops on its last frame; `ended` until it plays again. */
    this.loop = figure.dataset.loop !== 'false';
    /**
     * data-autoplay="false" (the final cut): never starts by itself, whatever the scroll; it holds its poster frame until the
     * viewer's Play, and its first play starts from 0:00.
     */
    this.manualStart = figure.dataset.autoplay === 'false';
    this.started = false;
    this.ended = false;
    /** From the runtime: the composition's length and scenes (on ready), and the time it last reported. */
    this.duration = 0;
    this.scenes = [];
    this.time = 0;
    this.listeners = new Set();
    /** data-priority: its rank in the page's budget of live runtimes among players equally on screen (higher wins). */
    this.state = { visible: false, near: false, reducedMotion: false, still: false, intent: null, priority: Number(figure.dataset.priority ?? 0) || 0 };
    /** Silent unless the page's sound is on (setMuted): browsers allow sound only after a gesture. */
    this.muted = true;
  }

  /** Mutes or unmutes the composition's sound; kept for a runtime mounted later. */
  setMuted(muted) {
    if (this.muted === muted) return;
    this.muted = muted;
    if (this.ready) this.send({ type: 'mute', muted });
  }

  /** Calls `fn(player)` on ready, on every reported time and when playing starts or stops. Returns the unsubscribe. */
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(this); }

  get src() {
    return `runtime/${this.id}.html?mode=preview&parentOrigin=${encodeURIComponent(this.deps.origin)}`;
  }

  /** @param {{ visible?: boolean, near?: boolean, reducedMotion?: boolean, still?: boolean, intent?: 'play' | 'pause' | null }} state */
  update(state) {
    this.state = { ...this.state, ...state };
    if (this.failed === 'timeout' && !this.state.near) this.clearFailure();
    // A film that waits for the viewer's Play (the final cut) has no runtime until then: its poster is all it shows.
    const waiting = this.manualStart && !this.started && this.state.intent !== 'play';
    const near = this.state.near && !waiting;
    if (!near) this.deps.budget?.forget(this);
    const action = decide({ ...this.state, near, ready: this.ready, failed: this.failed !== null });
    if (action === 'mount' && !this.frame) this.mount();
    else if (action === 'unmount' || (action === 'unmounted' && this.frame)) this.unmount();
    else if (action === 'play') this.play();
    else if (action === 'pause') this.pause();
    else if (action === 'still') this.showStill();
  }

  mount() {
    if (this.deps.budget && !this.deps.budget.acquire(this)) return;
    this.firstPlayed = null;
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
    // Played to its end once (or never played, when it waits for the viewer): a play starts it from the beginning.
    if (this.ended || (this.manualStart && !this.started)) { this.seek(0); this.time = 0; }
    this.started = true;
    this.playing = true;
    this.ended = false;
    this.still = false;
    this.atPoster = false;
    this.send({ type: 'play', loop: this.loop });
    this.emit();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.send({ type: 'pause' });
    this.emit();
  }

  seek(t) { this.send({ type: 'seek', t }); }

  /**
   * The viewer's seek (the final cut's bar): a seek stops the runtime's playback, so a playing player plays on from there.
   * @returns {boolean} false when there is no live runtime yet.
   */
  seekTo(t) {
    if (!this.ready || !this.frame || this.failed) return false;
    this.ended = false;
    this.atPoster = false;
    this.still = false;
    this.started = true;
    this.time = t;
    this.seek(t);
    if (this.playing) this.send({ type: 'play', loop: this.loop });
    this.emit();
    return true;
  }

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
    this.destroy();
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
      if (typeof data.duration === 'number') this.duration = data.duration;
      if (Array.isArray(data.scenes)) this.scenes = data.scenes;
      this.deps.clearTimeout(this.timer);
      this.send({ type: 'setScale', scale: 'fit' });
      this.send({ type: 'mute', muted: this.muted });
      // Start from the poster's frame: the hand-over from poster to live frame is seamless (t = 0 is an empty frame,
      // every clip enters after it).
      this.seek(this.posterTime);
      this.atPoster = true;
      this.time = this.posterTime;
      this.update({});
      this.emit();
    } else if (data.type === 'time' && data.playing === false && this.ready && this.playing && !this.loop && typeof data.t === 'number' && data.t >= this.duration - 0.05) {
      // A film played once reached its end: it stays on its last frame.
      this.time = data.t;
      this.playing = false;
      this.ended = true;
      this.emit();
    } else if (data.type === 'time' && data.playing === true && this.ready) {
      // The poster goes only once the runtime is really playing frames (a second report, its time moved on): never a
      // blank or unpainted frame, which WebKit can show for the first one.
      if (this.firstPlayed === null) this.firstPlayed = data.t;
      else if (data.t !== this.firstPlayed) this.figure.classList.add('is-ready');
      const wrapped = data.t < this.lastTime && data.t < this.loopFrom;
      this.lastTime = data.t;
      this.time = data.t;
      this.emit();
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

  /** Lets go of the runtime: its page unloaded first (about:blank), then its frame removed, then its slot freed. */
  destroy() {
    this.deps.clearTimeout(this.timer);
    const frame = this.frame;
    this.frame = null;
    if (frame) {
      frame.src = 'about:blank';
      frame.remove();
      this.deps.budget?.release(this);
    }
  }
}

/**
 * One player per `figure[data-composition]` of the document: mounted while within one viewport of the screen (and unmounted
 * beyond it), playing while at least a quarter of it is visible, a still frame under prefers-reduced-motion. The figures
 * `manual(figure)` names are left to their caller (the story's canvas drives its boards by step): never observed here.
 * @param {Document} doc
 * @param {{ log?: (m: unknown) => void, manual?: (figure: Element) => boolean }} [options]
 */
export function mountPlayers(doc, { log, manual = () => false } = {}) {
  const win = doc.defaultView;
  const motion = win.matchMedia('(prefers-reduced-motion: reduce)');
  const players = new Map();
  // A phone (a touch screen or a narrow window) holds fewer live runtimes than a computer.
  const phone = win.matchMedia('(pointer: coarse), (max-width: 959px)');
  const budget = liveBudget(() => (phone.matches ? LIVE_BUDGET.phone : LIVE_BUDGET.desktop));
  phone.addEventListener?.('change', () => budget.refresh());
  const deps = {
    origin: win.location.origin,
    budget,
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
  for (const figure of players.keys()) if (!manual(figure)) { near.observe(figure); visible.observe(figure); }
  motion.addEventListener('change', () => { for (const p of players.values()) p.update({ reducedMotion: motion.matches }); });
  const list = [...players.values()];
  list.budget = budget;
  return list;
}
