// The two demos with sound, Generate and Subtitles, each with its own Play with sound control: nothing on the page speaks
// unless the viewer asks. Generate plays the voice-over it made, then a taste of its music bed (its tiles show the
// playhead); Subtitles lets its board speak its line, in sync with the subtitles it draws. One sound at a time: a demo's
// sound stops the other's and pauses the final cut; the film's Play stops the demo's. A demo's sound stops when it leaves
// the screen, and while it plays the demo holds its finished state.
import { clamp, cuesOn } from './scene-logic.js';

/** The subtitles board's loop starts again here, just before its voice; the line is over by `SUBS_END`. */
const SUBS_FROM = 2.4;
const SUBS_END = 5.6;
/** Seconds of the music bed after the voice-over, faded in and out. */
const MUSIC_FOR = 8;

/**
 * @param {{ players: import('./player.js').CompositionPlayer[], scenes: { name: string, hold(on: boolean): void }[], film?: import('./player.js').CompositionPlayer }} deps
 */
export function startSounds({ players, scenes, film }) {
  let current = null;
  const controls = [];
  const stopAll = (except) => { for (const c of controls) if (c !== except) c.stop(); };
  const scene = (name) => scenes.find((s) => s.name === name);

  for (const btn of document.querySelectorAll('[data-sound-play]')) {
    const name = btn.dataset.soundPlay;
    const section = btn.closest('[data-scene]');
    const make = name === 'generate' ? generate : subtitles;
    const c = make(btn, section, players);
    const paint = (on) => {
      btn.classList.toggle('is-on', on);
      btn.querySelector('.sound-play__label').textContent = on ? 'Stop the sound' : 'Play with sound';
    };
    const control = {
      name,
      get on() { return c.on; },
      start() {
        stopAll(control);
        if (film?.playing) film.update({ intent: 'pause' });
        current = control;
        scene(name)?.hold(true);
        paint(true);
        c.start(() => control.stop());
      },
      stop() {
        if (!c.on) return;
        c.stop();
        if (current === control) current = null;
        scene(name)?.hold(false);
        paint(false);
      },
      get audio() { return c.audio; },
    };
    controls.push(control);
    btn.hidden = false;
    btn.addEventListener('click', () => (c.on ? control.stop() : control.start()));
    // Off screen, it stops.
    new IntersectionObserver(([e]) => { if (!e.isIntersecting) control.stop(); }).observe(section);
  }
  // The film's Play (with its sound) stops a demo's.
  film?.onChange((p) => { if (p.playing && !p.muted) stopAll(); });
  return {
    controls,
    get playing() { return current?.name ?? null; },
    get audio() { const a = current?.audio; return a ? { src: a.src, paused: a.paused } : null; },
  };
}

/** Generate: the voice-over it made, then a taste of its music bed, each on its tile. */
function generate(btn, section) {
  const tiles = { voice: section.querySelector('[data-board="genvoice"]'), music: section.querySelector('[data-board="genmusic"]') };
  let audio = null;
  let raf = 0;
  // A sound that stops lets go of its media (a paused element keeps its decoded audio until it is collected).
  const release = () => {
    cancelAnimationFrame(raf);
    if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
    audio = null;
    for (const t of Object.values(tiles)) { t.classList.remove('is-playing'); t.style.removeProperty('--p'); }
  };
  const play = (src, tile, seconds, then) => {
    const a = new Audio(src);
    audio = a;
    tile.classList.add('is-playing');
    const tick = () => {
      if (audio !== a) return;
      const t = a.currentTime; const d = seconds || a.duration || 1;
      tile.style.setProperty('--p', String(clamp(t / d, 0, 1)));
      if (seconds) {
        a.volume = clamp(Math.min(t / 0.6, (seconds - t) / 1.2), 0, 1) * 0.8;
        if (t >= seconds) { tile.classList.remove('is-playing'); then(); return; }
      }
      raf = requestAnimationFrame(tick);
    };
    if (seconds) a.volume = 0;
    a.addEventListener('playing', () => { raf = requestAnimationFrame(tick); }, { once: true });
    a.addEventListener('ended', () => { if (audio === a) { tile.classList.remove('is-playing'); then(); } });
    a.play().catch(() => then());
  };
  return {
    get on() { return audio !== null; },
    get audio() { return audio; },
    start(done) {
      play(btn.dataset.voice, tiles.voice, 0, () => {
        release();
        play(btn.dataset.music, tiles.music, MUSIC_FOR, () => { release(); done(); });
      });
    },
    stop: release,
  };
}

/** Subtitles: the board's own voice, in sync with its subtitles, from just before its line. */
function subtitles(btn, section, players) {
  const p = players.find((x) => section.contains(x.figure) && x.id === 'story-subs');
  const lines = [...section.querySelectorAll('.lines__list li')];
  const cues = lines.map((li) => ({ start: Number(li.dataset.start), end: Number(li.dataset.end) }));
  let on = false; let from = false; let done = null;
  // The subtitles panel follows the board's time.
  p?.onChange((x) => {
    cuesOn(cues, x.time).forEach((lit, i) => lines[i].classList.toggle('is-on', lit && x.playing));
    if (!on) return;
    if (x.ready && !from) { from = true; x.seekTo(SUBS_FROM); }
    else if (from && x.time >= SUBS_END) done?.();
  });
  return {
    get on() { return on; },
    audio: null,
    start(stop) {
      if (!p) { stop(); return; }
      on = true; from = false; done = stop;
      // The viewer's Play: it takes a live runtime even past the page's budget, and plays even under reduced motion.
      p.setMuted(false);
      p.update({ intent: 'play' });
      if (p.ready) { from = true; p.seekTo(SUBS_FROM); }
    },
    stop() {
      if (!on) return;
      on = false; done = null;
      p.setMuted(true);
      p.update({ intent: null });
    },
  };
}
