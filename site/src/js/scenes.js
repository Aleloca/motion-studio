// The home's demos: each step's section holds a small canvas (boards with real compositions, the app's panels) and its
// chat, drawn in their finished state. With motion each demo replays its step by itself, in a loop at its own pace: one
// GSAP timeline per demo, played while the demo is on screen (from its start after it has been off screen entirely) and
// paused otherwise, never tied to the scroll. A render pass reads the timeline's time for everything that is a state
// rather than a tween (a typed request, a version label, a pressed button, the inspector's numbers, the export's rows).
import { typed, labelAt, viewChange, clamp, PLAY_RATIO } from './scene-logic.js';

/** Seconds a demo holds its finished state before it starts again. */
const HOLD = 3.4;
/** Seconds of the fade between the end of a loop and its next start. */
const OUT = 0.45;
/** The agent's turn: "Working…" for this long before its answer. */
const WORK = 0.9;

export function startScenes({ gsap }) {
  const scenes = [...document.querySelectorAll('[data-scene]')].map((root) => scene(root, gsap));
  // The pictures of a demo load ahead of it (a version waiting for its wipe sits under a clip-path that hides it all: a
  // lazy image there would load only as the wipe reveals it).
  const ahead = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) {
      for (const img of e.target.querySelectorAll('img[loading="lazy"]')) img.loading = 'eager';
      ahead.unobserve(e.target);
    }
  }, { rootMargin: '150% 0px' });
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) {
      // A demo taller than the screen counts as on screen once it fills half of it.
      const ratio = e.isIntersecting ? Math.max(e.intersectionRatio, e.intersectionRect.height / innerHeight / 0.5 * PLAY_RATIO) : 0;
      scenes.find((s) => s.demo === e.target)?.view(ratio);
    }
  }, { threshold: [0, 0.1, PLAY_RATIO, 0.6, 1] });
  for (const s of scenes) { ahead.observe(s.demo); seen.observe(s.demo); }
  return scenes;
}

/* ---------------------------------------------------------------- one demo */

function scene(root, gsap) {
  const name = root.dataset.scene;
  const demo = root.classList.contains('demo') ? root : root.querySelector('.demo');
  const stage = demo.querySelector('.scene');
  const layout = () => getComputedStyle(stage).getPropertyValue('--layout').trim();
  let built = null;
  let state = { playing: false, left: true };
  let held = false;

  const build = () => {
    built?.ctx.revert();
    let k = null;
    const ctx = gsap.context(() => {
      k = kit(gsap, demo, stage);
      const end = BUILD[name](k);
      k.tl.to({}, { duration: HOLD }, end);
      k.tl.to([stage, k.chat], { opacity: 0, duration: OUT, ease: 'power1.in' });
      k.tl.fromTo([stage, k.chat], { opacity: 0 }, { opacity: 1, duration: 0.35, ease: 'power1.out', immediateRender: false }, 0);
      k.tl.eventCallback('onUpdate', () => k.render(k.tl.time()));
      k.tl.eventCallback('onComplete', () => k.tl.restart());
      k.actEnd = end;
    }, demo);
    built = { ctx, k, layout: layout() };
    k.render(0);
  };
  build();
  // The demo lays itself out again for a phone's narrow canvas: the moves are measured again.
  new ResizeObserver(() => {
    if (layout() === built.layout) return;
    const t = built.k.tl.time();
    build();
    built.k.tl.time(t);
    if (state.playing && !held) built.k.tl.play();
  }).observe(stage);

  const api = {
    name, demo,
    get timeline() { return built.k.tl; },
    get playing() { return !built.k.tl.paused(); },
    get time() { return built.k.tl.time(); },
    get actEnd() { return built.k.actEnd; },
    /** The share of the demo on screen changed. */
    view(ratio) {
      state = viewChange(state, ratio);
      const tl = built.k.tl;
      if (held) return;
      if (state.playing) { if (state.restart) tl.restart(); else tl.play(); } else tl.pause();
    },
    /** Holds the finished state while the demo's sound plays (a loop starting again would wipe its board away). */
    hold(on) {
      held = on;
      const tl = built.k.tl;
      if (on) tl.pause(Math.max(tl.time(), built.k.actEnd));
      else if (state.playing) tl.play();
    },
  };
  return api;
}

/** The pieces every demo is built from, on its timeline. */
function kit(gsap, demo, stage) {
  const tl = gsap.timeline({ paused: true, defaults: { ease: 'expo.out', duration: 0.55 } });
  const chat = demo.querySelector('.chat');
  const states = [];
  const q = (s) => demo.querySelector(s);
  const qa = (s) => [...demo.querySelectorAll(s)];
  const board = (id) => q(`[data-board="${id}"]`);
  const k = {
    tl, chat, stage, q, qa, board,
    render(t) { for (const fn of states) fn(t); },
    /** A state of the demo as a function of its time. */
    state(fn) { states.push(fn); },
    /** `el` comes in at `at` (from below, by default). */
    enter(el, at, from = { y: 14 }) {
      tl.fromTo(el, { autoAlpha: 0, ...from }, { autoAlpha: 1, x: 0, y: 0, xPercent: 0, yPercent: 0, scale: 1 }, at);
      return at;
    },
    /** The visitor's request types itself into its bubble (the bubble keeps its size: nothing below it moves). */
    type(bubble, at, dur = 1.4) {
      const full = bubble.textContent;
      const done = h('span'); const rest = h('span', 'msg__rest');
      bubble.replaceChildren(done, rest);
      k.enter(bubble, at, { y: 8 });
      k.state((t) => { const s = typed(full, (t - at - 0.15) / dur); done.textContent = s; rest.textContent = full.slice(s.length); });
      return at + 0.15 + dur;
    },
    /** The agent's turn: "Working…" in the answer's place, then the answer. Returns when the answer is in. */
    answer(bubble, at, work = WORK) {
      k.enter(bubble, at, { y: 6 });
      k.state((t) => bubble.classList.toggle('is-working', t >= at && t < at + work));
      tl.fromTo(bubble, { y: 6 }, { y: 0, duration: 0.5, immediateRender: false }, at + work);
      return at + work;
    },
    /** A board's version label: the version before, "Rendering…", the new one (marked new for a moment). */
    version(label, renderAt, doneAt) {
      const before = label.dataset.ver; const after = label.textContent;
      const marks = [[0, before], [renderAt, 'Rendering…'], [doneAt, after]];
      k.state((t) => {
        const s = labelAt(marks, t);
        label.textContent = s;
        label.classList.toggle('is-rendering', s === 'Rendering…');
        label.classList.toggle('is-new', t >= doneAt && t < doneAt + 1.2);
      });
    },
    /** The new version wipes in over the old one's poster. */
    wipe(fig, at, duration = 0.75) {
      tl.fromTo(fig, { clipPath: 'inset(0% 100% 0% 0%)' }, { clipPath: 'inset(0% 0% 0% 0%)', duration, ease: 'power3.inOut' }, at);
    },
    /** Boards that are made from another one come out of it. */
    outOf(ids, from, at, step = 0.12) {
      const c = center(from, stage);
      ids.forEach((id, i) => {
        const el = board(id); const b = center(el, stage);
        k.enter(el, at + i * step, { xPercent: ((c.x - b.x) / el.offsetWidth) * 100, yPercent: ((c.y - b.y) / el.offsetHeight) * 100, scale: 0.4, y: 0 });
      });
      return at + (ids.length - 1) * step + 0.55;
    },
    /**
     * The pointer: `moves` are [at, duration, target, press]: it glides to the target (an element's centre, or a point in
     * the scene), then `press`: 'click' presses it for a moment, 'down' holds the button (a drag), 'up' lets it go. It fades
     * in before its first move and out after its last.
     */
    cursor(moves) {
      const el = h('span', 'cursor');
      el.setAttribute('aria-hidden', 'true');
      el.innerHTML = '<svg class="i" aria-hidden="true"><use href="#i-cursor"/></svg>';
      stage.append(el);
      const [first] = moves; const last = moves.at(-1);
      const at = (target) => (target instanceof Element ? center(target, stage) : target);
      const start = at(first[2]);
      gsap.set(el, { left: `${pct(start.x + 60, stage.offsetWidth)}%`, top: `${pct(start.y + 50, stage.offsetHeight)}%` });
      tl.fromTo(el, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.25 }, first[0] - 0.2);
      for (const [start, dur, target, press] of moves) {
        const c = at(target);
        tl.to(el, { left: `${pct(c.x, stage.offsetWidth)}%`, top: `${pct(c.y, stage.offsetHeight)}%`, duration: dur, ease: 'power2.inOut' }, start);
        if (press === 'click') tl.to(el, { scale: 0.82, duration: 0.1, ease: 'power2.out', yoyo: true, repeat: 1 }, start + dur);
        else if (press) tl.to(el, { scale: press === 'down' ? 0.82 : 1, duration: 0.1, ease: 'power2.out' }, start + dur);
      }
      tl.to(el, { autoAlpha: 0, duration: 0.3, ease: 'power1.in' }, last[0] + last[1] + 0.5);
      return el;
    },
  };
  return k;
}

/* ---------------------------------------------------------------- the steps */

const BUILD = {
  /** Step 1, the hero: the brief, three variants, C chosen. */
  brief(k) {
    const [you, agent, event] = k.qa('.chat .msg');
    const [a, b, c] = ['a', 'b', 'c'].map(k.board);
    const chooseText = k.q('.board__choose-text');
    let t = k.type(you, 0.3, 1.7);
    const work = t + 0.2;
    t = k.answer(agent, work);
    [a, b, c].forEach((el, i) => k.enter(el, work + 0.25 + i * 0.16, { y: 22, scale: 0.96 }));
    k.cursor([[t + 0.5, 0.65, k.q('[data-board="c"] .board__choose'), 'click']]);
    const chosen = t + 1.2;
    k.tl.to([a, b], { opacity: 0.5, duration: 0.5, ease: 'power2.out' }, chosen + 0.1);
    k.state((s) => {
      c.classList.toggle('is-chosen', s >= chosen);
      c.classList.toggle('is-ring', s >= chosen && s < chosen + 1.2);
      chooseText.textContent = s >= chosen ? 'Chosen' : 'Choose';
    });
    return k.enter(event, chosen + 0.35) + 0.6;
  },

  /** A sentence in the chat makes v2. */
  ask(k) {
    const [you, agent] = k.qa('.chat .msg');
    let t = k.type(you, 0.3, 1.3);
    const work = t + 0.2;
    t = k.answer(agent, work, 1.3);
    k.version(k.q('.board__ver'), work, t);
    k.wipe(k.q('[data-wipe]'), work + 0.5);
    return t + 0.6;
  },

  /** The title dragged, resized and recoloured in the editor, saved as v3. */
  edit(k) {
    const [event] = k.qa('.chat .msg');
    const box = k.q('.edit__box'); const ghost = k.q('.edit__ghost'); const overlay = k.q('.edit');
    const save = k.q('.inspector__save'); const swatch = k.q('.swatch'); const hex = k.q('.inspector__hex');
    const fields = k.qa('.inspector__fields dd[data-from]');
    const BOX2 = { left: '8.33%', top: '29.64%', width: '57.75%', height: '33.47%' };
    const BOX3 = { left: '6.25%', top: '45.19%', width: '51.56%', height: '31.67%' };
    // Where the box is grabbed (at v2's title) and dropped (at v3's).
    Object.assign(box.style, BOX3); const p3 = center(box, k.stage);
    Object.assign(box.style, BOX2); const p2 = center(box, k.stage);
    k.tl.set(box, BOX2, 0);
    k.tl.fromTo(overlay, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.3 }, 0.3);
    const grab = 0.95; const drop = grab + 1;
    k.cursor([[0.45, 0.5, p2, 'down'], [grab + 0.1, 0.9, p3, 'up'], [drop + 0.65, 0.5, save, 'click']]);
    // The cursor drags the box: its first move ends on the box at BOX2; then box and cursor travel together.
    k.tl.to(box, { ...BOX3, duration: 0.9, ease: 'power2.inOut' }, grab + 0.1);
    k.tl.fromTo(ghost, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.2 }, grab + 0.1);
    const saved = drop + 1.15;
    k.state((t) => {
      const p = clamp((t - grab - 0.1) / 0.9, 0, 1);
      const e = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
      for (const dd of fields) dd.textContent = String(Math.round(Number(dd.dataset.from) + (Number(dd.dataset.to) - Number(dd.dataset.from)) * e));
      const yellow = t >= drop + 0.25;
      swatch.style.setProperty('--swatch', yellow ? '#FACC15' : '#2DD4BF');
      hex.textContent = yellow ? '#FACC15' : '#2DD4BF';
      save.classList.toggle('is-pressed', t >= saved && t < saved + 0.25);
    });
    k.version(k.q('.board__ver'), saved + 0.1, saved + 0.75);
    k.wipe(k.q('[data-wipe]'), saved + 0.15, 0.6);
    k.tl.to(overlay, { autoAlpha: 0, duration: 0.3, ease: 'power1.in' }, saved + 0.15);
    return k.enter(event, saved + 0.6) + 0.6;
  },

  /** A website read into a brand kit; v4 wears it. */
  brand(k) {
    const [you, agent] = k.qa('.chat .msg');
    let t = k.type(you, 0.3, 1.3);
    const work = t + 0.2;
    const kitPanel = k.q('.brandkit');
    k.enter(kitPanel, work + 0.1, { y: 18 });
    k.qa('.brandkit__colors li').forEach((li, i) => k.enter(li, work + 0.3 + i * 0.1, { y: 12 }));
    k.enter(k.q('.brandkit__row'), work + 0.65, { y: 10 });
    t = k.answer(agent, work, 1.6);
    k.version(k.q('.board__ver'), work + 0.8, t);
    k.wipe(k.q('[data-wipe]'), work + 0.95);
    return t + 0.6;
  },

  /** The Generate dialog: its paid call confirmed, the backdrop lands in C (v5), the voice and the music beside it. */
  generate(k) {
    const [you, agent] = k.qa('.chat .msg');
    const panel = k.q('.genpanel'); const paid = k.q('.genpanel__paid'); const done = k.q('.genpanel__done'); const go = k.q('.paid__btn--go');
    const kinds = k.qa('.genpanel__kinds [data-kind]');
    const texts = k.qa('.genpanel [data-image-text]').map((el) => [el, el.dataset.imageText, el.textContent]);
    let t = k.type(you, 0.3, 1.5);
    k.enter(panel, t + 0.15, { y: 18 });
    const ask = t + 0.6;
    k.enter(paid, ask, { y: 14, scale: 0.96 });
    k.cursor([[ask + 0.35, 0.55, go, 'click']]);
    const yes = ask + 0.95;
    k.tl.to(paid, { autoAlpha: 0, duration: 0.2, ease: 'power1.in' }, yes + 0.12);
    const voiceAt = yes + 0.9;
    k.state((s) => {
      done.classList.toggle('is-on', s >= yes + 0.25);
      go.classList.toggle('is-pressed', s >= yes && s < yes + 0.18);
      for (const el of kinds) el.classList.toggle('is-on', (el.dataset.kind === 'voice') === (s >= voiceAt));
      for (const [el, image, voice] of texts) el.textContent = s >= voiceAt ? voice : image;
    });
    k.version(k.q('.board__ver'), yes + 0.2, yes + 0.95);
    k.wipe(k.q('[data-wipe]'), yes + 0.3);
    k.enter(k.board('genvoice'), voiceAt + 0.1, { y: 14 });
    k.enter(k.board('genmusic'), voiceAt + 0.25, { y: 14 });
    t = k.answer(agent, yes + 0.2, 1.3);
    return Math.max(t, voiceAt + 0.8) + 0.4;
  },

  /** The 16:9 multiplies into a 9:16 and a 1:1. */
  formats(k) {
    const [you, agent] = k.qa('.chat .msg');
    let t = k.type(you, 0.3, 1.2);
    const work = t + 0.2;
    k.outOf(['f11', 'f916'], k.board('c'), work + 0.35, 0.15);
    t = k.answer(agent, work, 1.2);
    return t + 0.6;
  },

  /** Three translations fan out of the English one; the German one shows its box. */
  languages(k) {
    const [you, agent] = k.qa('.chat .msg');
    let t = k.type(you, 0.3, 1.1);
    const work = t + 0.2;
    const out = k.outOf(['it', 'de', 'es'], k.board('c'), work + 0.35, 0.14);
    k.enter(k.q('.fit'), out + 0.15, { scale: 1.06 });
    t = k.answer(agent, work, 1.3);
    return Math.max(t, out + 0.5) + 0.6;
  },

  /** The subtitle set beside C; v6 draws it. */
  subtitles(k) {
    const [you, agent] = k.qa('.chat .msg');
    let t = k.type(you, 0.3, 1.1);
    const work = t + 0.2;
    k.enter(k.q('.lines'), work + 0.2, { x: 18, y: 0 });
    t = k.answer(agent, work, 1.2);
    k.version(k.q('.board__ver'), work + 0.3, t);
    k.wipe(k.q('[data-wipe]'), work + 0.45);
    // A longer hold: the board says its line and the panel follows it.
    return t + 2;
  },

  /** The logo's file sets appear. */
  identity(k) {
    const [you, agent] = k.qa('.chat .msg');
    let t = k.type(you, 0.3, 1.4);
    const work = t + 0.2;
    ['identity', 'appicon', 'favicon', 'social'].forEach((id, i) => k.enter(k.board(id), work + 0.3 + i * 0.12, { y: 18, scale: 0.94 }));
    t = k.answer(agent, work, 1.2);
    return t + 0.6;
  },

  /** Export pressed: every file fills, then done. */
  export(k) {
    const [event] = k.qa('.chat .msg');
    const btn = k.q('.toolbar__export'); const dialog = k.q('.export');
    const rows = k.qa('.export__rows li');
    k.cursor([[0.4, 0.6, btn, 'click']]);
    const press = 1.0;
    k.enter(dialog, press + 0.2, { scale: 0.96, y: 8 });
    const fill = press + 0.45;
    k.state((t) => {
      btn.classList.toggle('is-pressed', t >= press && t < press + 0.2);
      rows.forEach((row, i) => {
        const p = clamp((t - fill - i * 0.16) / 0.45, 0, 1);
        row.style.setProperty('--p', String(p));
        row.classList.toggle('is-done', p >= 1);
      });
    });
    const end = fill + (rows.length - 1) * 0.16 + 0.45;
    return k.enter(event, end + 0.15) + 0.6;
  },
};

/* ---------------------------------------------------------------- helpers */

/** An element's centre in its scene, in pixels, from the layout (not from transforms, which the timeline moves). */
function center(el, stage) {
  let x = 0; let y = 0;
  for (let e = el; e && e !== stage; e = e.offsetParent) { x += e.offsetLeft; y += e.offsetTop; }
  return { x: x + el.offsetWidth / 2, y: y + el.offsetHeight / 2 };
}

const pct = (v, of) => (of ? (v / of) * 100 : 0);

function h(tag, cls) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  return el;
}
