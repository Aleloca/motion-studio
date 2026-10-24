// Motion Studio's own launch film (16:9, about a minute): the eleven steps of the home page, one beat each, with the
// interface redrawn as vector motion, a voice-over line per beat, the music bed and the sound effects. The film inside the
// boards is the launch video itself: it starts in the KOVA direction (night, cyan), grows in chat, is moved and recoloured
// by hand, takes the Motion Studio brand, gets a generated image, then becomes every format and language.
// Times in this file are authoring seconds; timeline.mjs stretches each beat to its voice-over line (the engine's warp).
import { readFileSync } from 'node:fs';
import { EASE, tw } from '../hero-gen/lib.mjs';
import { stage } from './engine.mjs';
import { musicStretches, readMedia, timeline } from './timeline.mjs';
import * as S from './assets.mjs';

const { C } = S;
const MEDIA = readMedia();
const TL = timeline(MEDIA);
/** The film's length in authoring seconds (the composition lasts `TL.D`). */
export const D = TL.DA;
/** Beat starts (authoring seconds). */
export const T = TL.A;
const SCENE_NAMES = {
  brief: 'Brief', variants: 'Three variants', chat: 'Chat request', edit: 'Manual edit', brand: 'Brand from a site', generate: 'Generate',
  formats: 'Every format', langs: 'Languages', subs: 'Subtitles', identity: 'Identity set', export: 'Export', end: 'End card',
};
const SCENE_IDS = { langs: 'languages', subs: 'subtitles', end: 'endcard' };
const SCENES = Object.keys(T).map((b) => ({ id: SCENE_IDS[b] ?? b, name: SCENE_NAMES[b], start: TL.T[b], duration: TL.len[b] }));

const CAPTIONS = [
  [T.brief + 0.2, '01', 'BRIEF', 'Type a brief.', C.agent],
  [T.variants, '02', 'VARIANTS', 'Three directions. Pick one.', C.orange],
  [T.chat, '03', 'CHAT', 'Ask for a change.', C.agent],
  [T.edit, '04', 'EDITOR', 'Or edit it by hand.', C.text],
  [T.brand, '05', 'BRAND', 'Bring your brand.', C.orange],
  [T.generate, '06', 'GENERATE', 'Generate it. Your keys.', C.store],
  [T.formats, '07', 'FORMATS', 'Every format, recomposed.', C.formats],
  [T.langs, '08', 'LANGUAGES', 'Every language, same layout.', C.lang],
  [T.subs, '09', 'SUBTITLES', 'Subtitles, in sync.', C.lang],
  [T.identity, '10', 'IDENTITY', 'Logo in. Identity out.', C.store],
  [T.export, '11', 'EXPORT', 'Every file, for every channel.', C.formats],
];

export const LINES = {
  en: ['Brief in.', 'Motion out.'],
  it: ['Entra il brief.', 'Esce il motion.'],
  de: ['Briefing rein.', 'Motion raus.'],
  ja: ['ブリーフを入れて、', 'モーションを出す。'],
};

/** The film's layout per format, in the format's own pixels. */
const FILM = {
  '16x9': { w: 1920, h: 1080, tag: { x: 150, y: 150, size: 34 }, logo: { x: 1430, y: 128, w: 340 }, head: { x: 150, y: 400, size: 180, avail: 1620 }, ring: { cx: 1440, cy: 560, d: 820 }, sub: { y: 912, size: 62 } },
  '9x16': { w: 1080, h: 1920, tag: { x: 100, y: 190, size: 34 }, logo: { x: 640, y: 172, w: 340 }, head: { x: 100, y: 1040, size: 150, avail: 880 }, ring: { cx: 540, cy: 660, d: 860 }, sub: { y: 1560, size: 64 } },
  '1x1': { w: 1080, h: 1080, tag: { x: 90, y: 100, size: 30 }, logo: { x: 690, y: 86, w: 300 }, head: { x: 90, y: 540, size: 128, avail: 900 }, ring: { cx: 780, cy: 340, d: 560 }, sub: { y: 900, size: 58 } },
};
const LH = 1.08; // headline line spacing (× size)
/** The generated backdrop (audio-gen) and how strongly it shows behind the title. */
const IMAGE = MEDIA.image?.file ?? 'generated-backdrop.jpg';
const BACKDROP_OPACITY = 0.6;
const LOGO_RATIO = 322 / 1720;
/** The size at which both headline lines of `lang` fit `avail` (never above `base`). */
const fitSize = (lang, base, avail) => Math.min(base, ...LINES[lang].map((s, i) => (avail * base) / tw(s, base, 'display', i ? 300 : 800)));

export function launch() {
  const E = stage({ width: 1920, height: 1080, duration: TL.D, background: C.stage, scenes: SCENES, warp: TL.W });
  const tr = {};
  for (const id of ['ground', 'back', 'stage', 'ui', 'fx', 'chrome', 'cursor']) tr[id] = E.c.track(id);
  /** Sound effects to place (authoring time, effect id, volume), written as audio clips at the end. */
  const cues = [];
  const sfx = (t, id, volume = 0.5) => { cues.push([t, id, volume]); };

  // ── Small builders ──────────────────────────────────────────────────────────────────────────────────────────────
  const txt = (track, name, start, dur, g, p) => E.text(track, name, start, dur, g, { font: 'body', weight: 500, ...p });
  const mono = (track, name, start, dur, g, p) => E.text(track, name, start, dur, g, { font: 'mono', weight: 500, ...p });
  /** A rounded card with a 2 px border (two shapes). */
  const card = (track, name, start, dur, g, { x, y, w, h, radius, fill = C.surface, border = C.line }) => [
    E.shape(track, `${name}-edge`, start, dur, g, { x: x - 2, y: y - 2, w: w + 4, h: h + 4, fill: border, radius: radius + 2 }),
    E.shape(track, name, start, dur, g, { x, y, w, h, fill, radius }),
  ];
  const each = (nodes, fn) => { for (const n of nodes) fn(n); return nodes; };

  /** Typing: one text clip per prefix (`chunk` characters per step); returns the clips and the caret x after each step. */
  function typing(track, name, g, t0, step, text, p, end, chunk = 2) {
    const nodes = []; const xs = [];
    const steps = Math.ceil(text.length / chunk);
    for (let i = 1; i <= steps; i++) {
      const s = t0 + (i - 1) * step;
      const pre = text.slice(0, i * chunk);
      nodes.push(E.text(track, name, s, i === steps ? end - s : step, g, { w: 1400, ...p, text: pre }));
      xs.push(p.x + tw(pre, p.size, p.font, p.weight));
    }
    return { nodes, xs, done: t0 + (steps - 1) * step };
  }

  /** The pointer, its tip at `pos`. */
  function pointer(start, end, pos) {
    const [x0, y0] = pos;
    const n = E.svg(tr.cursor, 'cursor', start, end - start, null, 'cursor.svg', { x: x0 - 4, y: y0 - 3, w: 40, h: 48 });
    n.fadeIn(start, 0.25);
    n.fadeOut(0.25);
    return {
      move(t, d, [x, y], ease = EASE.inOut) { n.to(t, d, { dx: x - x0, dy: y - y0 }, ease); },
      click(t, [x, y]) {
        sfx(t, 'click', 0.6);
        n.to(t, 0.07, { s: 0.84 }, EASE.sine); n.to(t + 0.07, 0.16, { s: 1 }, EASE.quint);
        E.svg(tr.cursor, 'click', t + 0.03, 0.5, null, 'ripple.svg', { x: x - 32, y: y - 32, w: 64, h: 64 }).init({ s: 0.3, o: 0.85 }).to(t + 0.03, 0.5, { s: 1.5, o: 0 }, EASE.quint);
      },
    };
  }

  /** A press: the element dips and comes back. */
  const press = (nodes, t) => each(nodes, (n) => { n.to(t, 0.07, { s: 0.93 }, EASE.sine); n.to(t + 0.07, 0.2, { s: 1 }, EASE.backSoft); });

  /** A board label: format badge, name, version chip (the version changes at the given times). */
  function boardLabel(name, x, y, start, end, ratio, label, versions) {
    const nodes = [
      E.svg(tr.chrome, `${name}-badge`, start, end - start, null, `ratio-${ratio.join('x')}.svg`, { x, y: y - 3, w: 30, h: 30 }),
      txt(tr.chrome, `${name}-name`, start, end - start, null, { weight: 600, size: 22, color: C.text, text: label, x: x + 42, y, w: tw(label, 22, 'body', 600) + 8 }),
    ];
    const vx = x + 42 + tw(label, 22, 'body', 600) + 18;
    versions.forEach(([t, v], i) => {
      const tEnd = versions[i + 1]?.[0] ?? end;
      const n = mono(tr.chrome, `${name}-version`, t, tEnd - t, null, { size: 19, color: C.orange, text: `★ ${v}`, x: vx, y: y + 3, w: 90 });
      if (i > 0) n.init({ s: 1.5 }).to(t, 0.45, { s: 1 }, EASE.backSoft);
      nodes.push(n);
    });
    for (const n of nodes) if (n.start <= start + 1e-9) n.fadeIn(start, 0.4);
    return { nodes, end: (t) => each(nodes.filter((n) => n.start < t && n.end > t), (n) => n.fadeOut(0.3, EASE.in, t)) };
  }

  /** Light rings pulsing from (cx, cy) between t0 and t1, none alive in a gap; plan: [from, period, colour, peak]. */
  function rings(track, g, name, t0, t1, cx, cy, d, plan, gaps = []) {
    let t = t0;
    while (t + 1.8 <= t1) {
      const step = [...plan].reverse().find(([at]) => t >= at - 1e-9) ?? plan[0];
      const [, period, color, peak] = step;
      const gap = gaps.find(([a, b]) => t < b && t + 1.8 > a);
      if (gap) { t = gap[1] + 0.05; continue; }
      E.svg(track, name, t, 1.8, g, `ring-${color}.svg`, { x: cx - d / 2, y: cy - d / 2, w: d, h: d })
        .init({ s: 0.18, o: 0 }).to(t, 1.8, { s: 1 }, EASE.quint).to(t, 0.22, { o: peak }, EASE.sine).to(t + 0.22, 1.58, { o: 0 }, EASE.sine);
      t += period;
    }
  }

  /**
   * The film in one format on a group: background (night, then the brand wiping in at `brandAt`), light rings, tag, logo
   * (from `brandAt`), and the headline in `lang` at `head` (x, y, size). Returns the nodes the beats animate further.
   */
  function film(fmt, g, t0, t1, o) {
    const L = FILM[fmt];
    const brandAt = o.brandAt ?? Infinity;
    const night = brandAt > t0;
    const bgName = (look) => `film-${fmt}-${look}.svg`;
    const trk = tr[o.track ?? 'stage'];
    const bg = E.svg(trk, `${fmt}-film`, t0, t1 - t0, g, bgName(night ? 'night' : 'brand'), { x: 0, y: 0, w: L.w, h: L.h, fit: 'fill' });
    let brandBg = null;
    if (night && brandAt < t1) brandBg = E.svg(trk, `${fmt}-brand`, brandAt, t1 - brandAt, g, bgName('brand'), { x: 0, y: 0, w: L.w, h: L.h, fit: 'fill' }).anim({ preset: 'wipe', start: brandAt, duration: 0.9, ease: EASE.inOut });
    // The backdrop made in the Generate beat, from `o.backdrop` on: over the film's ground, under its rings and title.
    if (o.backdrop !== undefined && o.backdrop < t1) {
      const at = Math.max(o.backdrop, t0);
      const b = E.image(trk, `${fmt}-backdrop`, at, t1 - at, g, IMAGE, { x: 0, y: 0, w: L.w, h: L.h, fit: 'cover' });
      if (o.backdrop > t0) b.init({ o: 0, s: 1.08 }).to(at, 0.5, { o: BACKDROP_OPACITY }, EASE.sine).to(at, 1.4, { s: 1 }, EASE.expo);
      else b.init({ o: BACKDROP_OPACITY });
    }
    const R = L.ring;
    rings(trk, g, `${fmt}-ring`, o.ringsFrom ?? t0 + 0.4, o.ringsTo ?? t1, R.cx, R.cy, R.d, o.ringPlan ?? [[0, 1.3, night ? 'cyan' : 'orange', 0.75]], o.ringGaps);
    const tag = mono(trk, `${fmt}-tag`, t0, t1 - t0, g, { size: L.tag.size, color: night ? C.steel : C.orange, text: 'MOTION STUDIO  ·  0.1.0', x: L.tag.x, y: L.tag.y, w: 900 });
    if (night && brandAt < t1) tag.anim({ prop: 'color', from: C.steel, to: C.orange, start: brandAt + 0.3, duration: 0.5, ease: EASE.sine });
    let logo = null;
    const la = Math.max(brandAt + 0.4, t0);
    if (la < t1) {
      logo = E.svg(trk, `${fmt}-logo`, la, t1 - la, g, 'logo.svg', { x: L.logo.x, y: L.logo.y, w: L.logo.w, h: L.logo.w * LOGO_RATIO });
      if (brandAt > t0) logo.init({ o: 0, dx: 40 }).to(la, 0.7, { o: 1, dx: 0 }, EASE.expo);
    }
    return { L, bg, brandBg, tag, logo };
  }

  /** The two headline lines of `lang` at (x, y) with size `size`; colour of the second line `accent`. */
  function headline(fmt, g, t0, t1, lang, x, y, size, accent, name = fmt, track = tr.stage) {
    const [a, b] = LINES[lang];
    const wa = tw(a, size, 'display', 800); const wb = tw(b, size, 'display', 300);
    const A = E.text(track, `${name}-head`, t0, t1 - t0, g, { size, weight: 800, color: C.text, text: a, x, y, w: wa + 8 });
    const B = E.text(track, `${name}-head`, t0, t1 - t0, g, { size, weight: 300, color: accent, text: b, x, y: y + size * LH, w: wb + 8 });
    return { A, B, wa, wb, size, x, y };
  }

  // ── Ground: the app's canvas, the progress line with the ten beats ────────────────────────────────────────────────
  E.svg(tr.ground, 'canvas', 0, D, null, 'canvas.svg', { x: 0, y: 0, w: 1920, h: 1080, fit: 'cover', kenBurns: { from: { scale: 1 }, to: { scale: 1.06 } } }).fadeIn(0, 1, EASE.sine);
  {
    const x0 = 120; const len = 1680; const y = 1022; const tEnd = T.end + 0.5;
    const base = E.shape(tr.chrome, 'progress', 0.4, tEnd - 0.4, null, { x: x0, y, w: len, h: 2, fill: C.line, radius: 1 });
    const fill = E.shape(tr.chrome, 'progress-fill', 0.4, tEnd - 0.4, null, { x: x0, y, w: len, h: 2, fill: C.orange, radius: 1 })
      .anim({ preset: 'wipe', start: 0.4, duration: T.end - 0.4, ease: 'linear' });
    const head = E.shape(tr.chrome, 'playhead', 0.4, tEnd - 0.4, null, { x: x0 - 1, y: y - 7, w: 3, h: 16, fill: C.orange, radius: 1.5 }).to(0.4, T.end - 0.4, { dx: len }, 'linear');
    const all = [base, fill, head];
    const names = ['Brief', 'Variants', 'Chat', 'Editor', 'Brand', 'Generate', 'Formats', 'Languages', 'Subtitles', 'Identity', 'Export'];
    CAPTIONS.forEach(([t, , , , color], i) => {
      const bt = Object.values(T)[i];
      const x = x0 + (len * bt) / T.end;
      const dot = E.shape(tr.chrome, 'beat', 0.4, tEnd - 0.4, null, { x: x - 5, y: y - 4, w: 10, h: 10, fill: '#3A3A3A', radius: 5 })
        .anim({ prop: 'color', from: '#3A3A3A', to: color, start: Math.max(bt, 0.45), duration: 0.3, ease: EASE.sine });
      const label = mono(tr.chrome, 'beat-name', 0.4, tEnd - 0.4, null, { size: 14, color: '#5A5A5A', text: names[i], x: x - 4, y: y + 14, w: 120 })
        .anim({ prop: 'color', from: '#5A5A5A', to: C.muted, start: Math.max(bt, 0.45), duration: 0.3, ease: EASE.sine });
      all.push(dot, label);
    });
    each(all, (n) => { n.fadeIn(0.4, 0.6, EASE.sine); n.fadeOut(0.5, EASE.in); });
  }

  // ── Captions: the beat's number and name, and one line ────────────────────────────────────────────────────────────
  CAPTIONS.forEach(([t, num, label, line, color], i) => {
    const next = i + 1 < CAPTIONS.length ? CAPTIONS[i + 1][0] : T.end;
    const end = next - 0.05;
    const l = mono(tr.chrome, 'step', t, end - t, null, { size: 22, color, text: `${num}  ${label}`, x: 120, y: 88, w: 400 });
    l.init({ o: 0, dx: -16 }).to(t, 0.5, { o: 1, dx: 0 }, EASE.expo);
    const w = tw(line, 62, 'display', 800);
    const cap = E.text(tr.chrome, 'caption', t + 0.08, end - t - 0.08, null, { size: 62, weight: 800, color: C.text, text: line, x: 120, y: 120, w: w + 8 });
    cap.init({ blur: 10, dy: 20 }).to(t + 0.08, 0.7, { blur: 0, dy: 0 }, EASE.expo).anim({ preset: 'wipe', start: t + 0.08, duration: 0.7, ease: EASE.expo });
    for (const n of [l, cap]) n.to(end - 0.32, 0.32, { o: 0, blur: 8, dy: -14 }, EASE.in);
  });

  // ── 01 Brief: the composer, the brief typed, sent ─────────────────────────────────────────────────────────────────
  {
    const Gc = E.group({ pivot: [960, 540] });
    const end = T.variants - 0.05;
    Gc.set({ o: 0, s: 0.94 }).to(0.35, 0.55, { s: 1 }, EASE.expo).to(0.35, 0.4, { o: 1 }, EASE.sine);
    Gc.to(3.0, 0.75, { s: 0.72, ty: 250 }, EASE.inOut).to(3.15, 0.55, { o: 0 }, EASE.in);
    card(tr.ui, 'composer', 0.35, end - 0.35, Gc, { x: 460, y: 400, w: 1000, h: 290, radius: 28 });
    mono(tr.ui, 'composer-label', 0.35, end - 0.35, Gc, { size: 18, color: C.agent, text: 'BRIEF', x: 500, y: 434, w: 80 });
    mono(tr.ui, 'composer-label', 0.35, end - 0.35, Gc, { size: 18, color: C.dash, text: '·  NEW CREATIVE', x: 568, y: 434, w: 300 });
    const p = { font: 'body', weight: 500, size: 42, color: C.text };
    const l1 = typing(tr.ui, 'brief', Gc, 0.9, 0.042, 'A launch video for Motion Studio.', { ...p, x: 500, y: 492, w: 920 }, end);
    const l2 = typing(tr.ui, 'brief', Gc, l1.done + 0.2, 0.042, 'Three variants.', { ...p, x: 500, y: 548, w: 920 }, end);
    // The caret follows the text, then blinks.
    const caret = E.shape(tr.ui, 'caret', 0.35, 2.95 - 0.35, Gc, { x: 500, y: 497, w: 3, h: 46, fill: C.orange, radius: 1.5 });
    caret.fadeIn(0.75, 0.15);
    l1.xs.forEach((x, i) => caret.to(0.9 + i * 0.042, 1 / 60, { dx: x - 500 + 4 }, 'linear'));
    caret.to(l1.done + 0.2 - 1 / 60, 1 / 60, { dx: 0, dy: 56 }, 'linear');
    l2.xs.forEach((x, i) => caret.to(l1.done + 0.2 + i * 0.042 + 0.001, 1 / 60, { dx: x - 500 + 4 }, 'linear'));
    for (let t = l2.done + 0.3; t < 2.8; t += 0.5) caret.to(t, 1 / 60, { o: 0 }, 'linear').to(t + 0.25, 1 / 60, { o: 1 }, 'linear');
    // Bottom row: attach, services, send (lights up with the first letter, pressed at 2.75 with ⌘↵).
    txt(tr.ui, 'composer-plus', 0.35, end - 0.35, Gc, { size: 30, color: C.muted, text: '+', x: 500, y: 622, w: 30 });
    txt(tr.ui, 'composer-services', 0.35, end - 0.35, Gc, { size: 21, color: C.muted, text: 'Services', x: 540, y: 630, w: 120 });
    const send = E.shape(tr.ui, 'send', 0.35, end - 0.35, Gc, { x: 1330, y: 620, w: 100, h: 44, fill: '#3A2A22', radius: 22 }).anim({ prop: 'color', from: '#3A2A22', to: C.orange, start: 0.95, duration: 0.3, ease: EASE.sine });
    const key = mono(tr.ui, 'send-key', 0.35, end - 0.35, Gc, { size: 20, color: C.stage, text: '⌘↵', align: 'center', x: 1330, y: 629, w: 100 });
    press([send, key], 2.72);
    sfx(0.9, 'typing', 0.35);
    sfx(2.72, 'click', 0.6);
  }

  // ── 02 Variants: three directions burst out, one is chosen and becomes the film ────────────────────────────────────
  const BOARD = { w: 500, h: 281.25, y: 459.375, xs: [150, 710, 1270] };
  const vk = BOARD.w / 1920;
  const HERO = { x: 120, y: 300, w: 1120, h: 630 };
  const SWAP = 8.8; // the chosen board reaches the hero size: the full-size film takes over
  const burst = 3.25;
  const GV = BOARD.xs.map((x, i) => {
    const g = E.group({ x, y: BOARD.y, k: vk, w: 1920, h: 1080 });
    const [cx, cy] = g.pivot;
    g.set({ tx: 960 - cx, ty: 545 - cy, s: 0.18, o: 0 }).to(burst + i * 0.09, 1.0, { tx: 0, ty: 0, s: 1 }, EASE.backSoft).to(burst + i * 0.09, 0.3, { o: 1 }, EASE.sine);
    return g;
  });
  sfx(burst, 'pop', 0.45);
  sfx(7.8, 'whoosh', 0.4);
  // A: the film's first look (KOVA's night and cyan rings).
  {
    const g = GV[0];
    film('16x9', g, burst, SWAP, { ringsFrom: burst + 1.1, ringsTo: 7.7 });
    const H = FILM['16x9'].head;
    headline('16x9', g, burst, SWAP, 'en', H.x, H.y, H.size, C.cyan, 'var-a');
  }
  // B: the TIDEFALL poster.
  const vEnd = 8.3;
  {
    const g = GV[1]; const P = S.TP;
    E.svg(tr.stage, 'var-b-bg', burst, vEnd - burst, g, 'poster.svg', { x: 0, y: 0, w: 1920, h: 1080, fit: 'fill' });
    E.svg(tr.stage, 'var-b-dots', burst, vEnd - burst, g, 'halftone.svg', { x: 70, y: 60, w: 420, h: 420 });
    E.svg(tr.stage, 'var-b-sun', burst, vEnd - burst, g, 'sun.svg', { x: 560, y: 120, w: 800, h: 800 }).anim({ prop: 'rotation', from: 0, to: 30, start: burst, duration: vEnd - burst, ease: 'linear' });
    E.svg(tr.stage, 'var-b-waves', burst, vEnd - burst, g, 'waves.svg', { x: 40, y: 790, w: 1840, h: 200, fit: 'cover', kenBurns: { from: { x: 0 }, to: { x: -360 } } });
    E.text(tr.stage, 'var-b-head', burst, vEnd - burst, g, { size: 230, weight: 800, color: P.cream, text: 'BRIEF IN.', align: 'center', x: 0, y: 220, w: 1920 });
    E.text(tr.stage, 'var-b-head', burst, vEnd - burst, g, { size: 230, weight: 800, color: P.pink, text: 'MOTION OUT.', align: 'center', x: 0, y: 460, w: 1920 });
  }
  // C: the Fernwise editorial.
  {
    const g = GV[2]; const F = S.FP;
    E.svg(tr.stage, 'var-c-bg', burst, vEnd - burst, g, 'paper.svg', { x: 0, y: 0, w: 1920, h: 1080, fit: 'fill' });
    E.shape(tr.stage, 'var-c-card', burst, vEnd - burst, g, { x: 1010, y: 230, w: 780, h: 600, fill: F.card, radius: 40 });
    E.svg(tr.stage, 'var-c-chart', burst, vEnd - burst, g, 'chart.svg', { x: 1060, y: 360, w: 680, h: 400, fit: 'fill' }).anim({ preset: 'wipe', start: burst + 0.7, duration: 1.4, ease: EASE.inOut });
    mono(tr.stage, 'var-c-tag', burst, vEnd - burst, g, { size: 34, color: F.muted, text: 'MOTION STUDIO  ·  0.1.0', x: 130, y: 300, w: 800 });
    E.text(tr.stage, 'var-c-head', burst, vEnd - burst, g, { size: 150, weight: 800, color: F.ink, text: 'Brief in.', x: 130, y: 420, w: tw('Brief in.', 150) + 8 });
    E.text(tr.stage, 'var-c-head', burst, vEnd - burst, g, { size: 150, weight: 300, color: F.green, text: 'Motion out.', x: 130, y: 590, w: tw('Motion out.', 150, 'display', 300) + 8 });
  }
  // Labels, the pointer, the choice.
  const pick = 6.6;
  {
    const names = ['A  ·  KINETIC', 'B  ·  POSTER', 'C  ·  EDITORIAL'];
    names.forEach((n, i) => {
      const l = mono(tr.chrome, 'variant-label', 4.2 + i * 0.08, 7.5 - 4.2 - i * 0.08, null, { size: 19, color: C.muted, text: n, x: BOARD.xs[i], y: BOARD.y - 40, w: 300 });
      l.init({ o: 0, dy: 10 }).to(4.2 + i * 0.08, 0.5, { o: 1, dy: 0 }, EASE.expo).fadeOut(0.3, EASE.in);
      if (i === 0) l.anim({ prop: 'color', from: C.muted, to: C.orange, start: pick + 0.05, duration: 0.25, ease: EASE.sine });
    });
    const cur = pointer(5.5, 7.4, [1560, 960]);
    cur.move(5.6, 0.9, [430, 640]);
    cur.click(pick, [430, 640]);
    const sel = E.svg(tr.stage, 'chosen', pick + 0.05, SWAP - pick - 0.05, GV[0], 'outline-variant.svg', { x: -46, y: -46, w: 2012, h: 1172, fit: 'fill' });
    sel.init({ o: 0, s: 1.04 }).to(pick + 0.05, 0.35, { o: 1, s: 1 }, EASE.expo).to(7.8, 0.4, { o: 0 }, EASE.in);
    for (const g of GV.slice(1)) g.to(pick + 0.1, 0.6, { o: 0.28 }, EASE.quint).to(7.55, 0.45, { o: 0 }, EASE.in);
    GV[1].to(pick + 0.1, 0.9, { tx: 40 }, EASE.quint);
    GV[2].to(pick + 0.1, 0.9, { tx: 80 }, EASE.quint);
    // A grows into the hero board.
    const [cx, cy] = GV[0].pivot;
    GV[0].to(7.8, 1.0, { tx: HERO.x + HERO.w / 2 - cx, ty: HERO.y + HERO.h / 2 - cy, s: HERO.w / BOARD.w }, EASE.inOut);
  }

  // ── The hero board: chat, editor, brand ─────────────────────────────────────────────────────────────────────────────
  const GH = E.group({ x: HERO.x, y: HERO.y, k: HERO.w / 1920, w: 1920, h: 1080 });
  const BAKE = T.formats + 0.1; // the hero's headline, grown and moved by hand, is rewritten at its new size
  const ENERGY = 12.3; const BRAND = 23.2;
  const heroEnd = T.identity + 0.6;
  /** The backdrop lands on the film in the Generate beat (the thumbnail's flight ends here). */
  const BACKDROP_AT = T.generate + 3.95;
  const hero = film('16x9', GH, SWAP, heroEnd, {
    brandAt: BRAND, backdrop: BACKDROP_AT, ringsFrom: SWAP + 0.3, ringsTo: T.identity - 0.25, ringGaps: [[T.formats + 0.25, T.formats + 1.3]],
    ringPlan: [[0, 1.3, 'cyan', 0.75], [ENERGY, 0.55, 'cyan', 0.95], [BRAND, 1.1, 'orange', 0.8]],
  });
  const H16 = FILM['16x9'].head;
  const head = headline('16x9', GH, SWAP, BAKE, 'en', H16.x, H16.y, H16.size, C.cyan, 'hero');
  const GROW = 1.25; const LIFT = -150;
  const lineNodes = [[head.A, head.wa, H16.y], [head.B, head.wb, H16.y + H16.size * LH]];
  const boxH = H16.size * 1.32;
  // 03: the title grows from its top-left corner.
  for (const [n, w, y] of lineNodes) n.to(ENERGY, 0.8, { s: GROW, dx: ((w + 8) / 2) * (GROW - 1), dy: (y + boxH / 2 - H16.y) * (GROW - 1) }, EASE.backSoft);
  const heroLabel = boardLabel('hero', HERO.x, HERO.y - 44, SWAP + 0.1, T.formats + 0.2, [16, 9], 'Video 16:9', [[SWAP + 0.1, 'v1'], [ENERGY + 0.6, 'v2'], [18.8, 'v3']]);
  heroLabel.end(T.formats - 0.1);

  // Chat panel.
  {
    const Gp = E.group({ pivot: [1550, 615] });
    const t0 = 9.0; const end = 14.25;
    Gp.set({ tx: 60, o: 0 }).to(t0, 0.55, { tx: 0 }, EASE.expo).to(t0, 0.4, { o: 1 }, EASE.sine).to(end - 0.4, 0.4, { o: 0, tx: 40 }, EASE.in);
    card(tr.ui, 'chat', t0, end - t0, Gp, { x: 1300, y: 300, w: 500, h: 630, radius: 24 });
    txt(tr.ui, 'tab', t0, end - t0, Gp, { weight: 600, size: 21, color: C.text, text: 'Chat', x: 1332, y: 326, w: 80 });
    E.shape(tr.ui, 'tab-line', t0, end - t0, Gp, { x: 1332, y: 362, w: 46, h: 3, fill: C.text, radius: 1.5 });
    txt(tr.ui, 'tab', t0, end - t0, Gp, { size: 21, color: C.dash, text: 'Comments', x: 1410, y: 326, w: 120 });
    txt(tr.ui, 'tab', t0, end - t0, Gp, { size: 21, color: C.dash, text: 'Brief', x: 1546, y: 326, w: 80 });
    E.shape(tr.ui, 'rule', t0, end - t0, Gp, { x: 1300, y: 370, w: 500, h: 2, fill: C.line });
    // Composer: typed, sent.
    card(tr.ui, 'chat-composer', t0, end - t0, Gp, { x: 1324, y: 800, w: 452, h: 106, radius: 16, fill: C.raised });
    const msg = 'Make the title bigger. More energy.';
    txt(tr.ui, 'placeholder', t0, 9.85 - t0, Gp, { size: 19, color: C.dash, text: 'Describe what to change', x: 1344, y: 818, w: 400 });
    typing(tr.ui, 'chat-typed', Gp, 9.85, 0.034, msg, { font: 'body', weight: 500, size: 20, color: C.text, x: 1344, y: 818, w: 420 }, 10.9);
    const sendBtn = E.shape(tr.ui, 'chat-send', t0, end - t0, Gp, { x: 1700, y: 858, w: 60, h: 34, fill: C.orange, radius: 17 });
    const sendKey = mono(tr.ui, 'chat-send-key', t0, end - t0, Gp, { size: 15, color: C.stage, text: '⌘↵', align: 'center', x: 1700, y: 865, w: 60 });
    press([sendBtn, sendKey], 10.82);
    sfx(9.85, 'typing', 0.35);
    sfx(10.82, 'click', 0.6);
    // The request, as a bubble.
    const bw = tw(msg, 20, 'body', 500) + 36;
    const bubble = [
      E.shape(tr.ui, 'bubble', 10.9, end - 10.9, Gp, { x: 1776 - bw, y: 396, w: bw, h: 50, fill: '#2A2A2A', radius: 18 }),
      txt(tr.ui, 'bubble-text', 10.9, end - 10.9, Gp, { size: 20, color: C.text, text: msg, x: 1776 - bw + 18, y: 408, w: bw }),
    ];
    each(bubble, (n) => n.init({ o: 0, dy: 26 }).to(10.9, 0.5, { o: 1, dy: 0 }, EASE.expo));
    // The agent: working, then done.
    const agent = [
      E.svg(tr.ui, 'avatar', 11.2, end - 11.2, Gp, 'avatar.svg', { x: 1324, y: 476, w: 30, h: 30 }),
      txt(tr.ui, 'agent', 11.2, end - 11.2, Gp, { weight: 600, size: 19, color: C.text, text: 'Agent', x: 1366, y: 479, w: 80 }),
    ];
    each(agent, (n) => n.init({ o: 0, dy: 16 }).to(11.2, 0.45, { o: 1, dy: 0 }, EASE.expo));
    for (let i = 0; i < 3; i++) {
      const d = E.shape(tr.ui, 'typing-dot', 11.35, 12.3 - 11.35, Gp, { x: 1330 + i * 18, y: 530, w: 10, h: 10, fill: C.muted, radius: 5 });
      d.init({ o: 0.3 });
      for (let t = 11.35 + i * 0.12; t + 0.3 < 12.2; t += 0.45) d.to(t, 0.15, { o: 1 }, EASE.sine).to(t + 0.15, 0.15, { o: 0.3 }, EASE.sine);
    }
    const reply = txt(tr.ui, 'reply', 12.3, end - 12.3, Gp, { size: 20, color: C.text, text: 'Bigger title, faster rings.\nVersion 2 is ready.', x: 1324, y: 522, w: 440 });
    reply.init({ o: 0, dy: 12 }).to(12.3, 0.5, { o: 1, dy: 0 }, EASE.expo);
    const chip = [
      E.shape(tr.ui, 'ready', 12.9, end - 12.9, Gp, { x: 1324, y: 600, w: 112, h: 32, fill: C.okBg, radius: 16 }),
      txt(tr.ui, 'ready-text', 12.9, end - 12.9, Gp, { weight: 600, size: 16, color: C.ok, text: 'v2 · Ready', align: 'center', x: 1324, y: 606, w: 112 }),
    ];
    each(chip, (n) => n.init({ o: 0, s: 0.8 }).to(12.9, 0.4, { o: 1, s: 1 }, EASE.backSoft));
    sfx(12.9, 'chime', 0.4);
  }

  // 04: the inspector; the title is selected, dragged up, recoloured; Save as v3.
  {
    const Gi = E.group({ pivot: [1550, 615] });
    const t0 = 14.15; const end = 19.45;
    Gi.set({ tx: 60, o: 0 }).to(t0, 0.55, { tx: 0 }, EASE.expo).to(t0, 0.4, { o: 1 }, EASE.sine).to(end - 0.4, 0.4, { o: 0, tx: 40 }, EASE.in);
    card(tr.ui, 'inspector', t0, end - t0, Gi, { x: 1300, y: 300, w: 500, h: 630, radius: 24 });
    txt(tr.ui, 'tab', t0, end - t0, Gi, { size: 21, color: C.dash, text: 'Chat', x: 1332, y: 326, w: 80 });
    txt(tr.ui, 'tab', t0, end - t0, Gi, { weight: 600, size: 21, color: C.text, text: 'Inspector', x: 1410, y: 326, w: 120 });
    E.shape(tr.ui, 'tab-line', t0, end - t0, Gi, { x: 1410, y: 362, w: 92, h: 3, fill: C.text, radius: 1.5 });
    E.shape(tr.ui, 'rule', t0, end - t0, Gi, { x: 1300, y: 370, w: 500, h: 2, fill: C.line });
    mono(tr.ui, 'field', t0, end - t0, Gi, { size: 16, color: C.dash, text: 'TEXT CLIP', x: 1332, y: 398, w: 200 });
    txt(tr.ui, 'field-value', t0, end - t0, Gi, { weight: 600, size: 24, color: C.text, text: 'Motion out.', x: 1332, y: 424, w: 300 });
    mono(tr.ui, 'field', t0, end - t0, Gi, { size: 16, color: C.dash, text: 'POSITION', x: 1332, y: 492, w: 200 });
    card(tr.ui, 'pos-x', t0, end - t0, Gi, { x: 1332, y: 522, w: 200, h: 48, radius: 12, fill: C.raised });
    card(tr.ui, 'pos-y', t0, end - t0, Gi, { x: 1552, y: 522, w: 200, h: 48, radius: 12, fill: C.raised });
    mono(tr.ui, 'pos', t0, end - t0, Gi, { size: 18, color: C.dash, text: 'X', x: 1350, y: 535, w: 30 });
    mono(tr.ui, 'pos', t0, end - t0, Gi, { size: 20, color: C.text, text: '150', x: 1384, y: 534, w: 100 });
    mono(tr.ui, 'pos', t0, end - t0, Gi, { size: 18, color: C.dash, text: 'Y', x: 1570, y: 535, w: 30 });
    const ys = [400, 388, 352, 306, 270, 256, 250];
    ys.forEach((v, i) => {
      const s = i === 0 ? t0 : 16.0 + i * 0.11;
      const e = i === ys.length - 1 ? end : 16.0 + (i + 1) * 0.11;
      mono(tr.ui, 'pos', s, e - s, Gi, { size: 20, color: i ? C.orange : C.text, text: String(v), x: 1604, y: 534, w: 100 });
    });
    mono(tr.ui, 'field', t0, end - t0, Gi, { size: 16, color: C.dash, text: 'COLOUR', x: 1332, y: 600, w: 200 });
    const sw = [C.cyan, C.agent, C.store, C.text, C.formats];
    sw.forEach((col, i) => E.shape(tr.ui, 'swatch', t0, end - t0, Gi, { x: 1332 + i * 76, y: 630, w: 56, h: 56, fill: col, radius: 14 }));
    const ring = E.svg(tr.ui, 'swatch-ring', t0, end - t0, Gi, 'outline-swatch.svg', { x: 1324, y: 622, w: 72, h: 72 });
    const save = [
      E.shape(tr.ui, 'save', t0, end - t0, Gi, { x: 1332, y: 846, w: 200, h: 56, fill: C.orange, radius: 28 }),
      txt(tr.ui, 'save-text', t0, end - t0, Gi, { weight: 600, size: 21, color: C.stage, text: 'Save as v3', align: 'center', x: 1332, y: 860, w: 200 }),
    ];
    mono(tr.ui, 'no-tokens', t0, end - t0, Gi, { size: 16, color: C.dash, text: 'No agent. No tokens.', x: 1552, y: 866, w: 240 });

    // The pointer: select the title, drag it up, pick yellow, save.
    const k = GH.k;
    const tx = (lx) => HERO.x + lx * k; const ty = (ly) => HERO.y + ly * k;
    const grab = [tx(H16.x + 300 * GROW), ty(H16.y + (H16.size * LH + 120) * GROW)]; // on "Motion out.", after the growth
    const cur = pointer(14.6, 19.15, [1560, 760]);
    cur.move(14.7, 0.85, grab);
    cur.click(15.65, grab);
    // Selection around the title block (after the growth), dragged with it.
    const bw = (Math.max(head.wa, head.wb) + 8) * GROW;
    const bx = H16.x - 18; const by = H16.y + 22; const bh = (H16.size * LH + H16.size * 1.12) * GROW;
    const selection = [E.svg(tr.stage, 'selection', 15.7, 18.8 - 15.7, GH, 'outline-select.svg', { x: bx, y: by, w: bw + 36, h: bh, fit: 'fill' })];
    for (const [hx, hy] of [[bx, by], [bx + bw + 36, by], [bx, by + bh], [bx + bw + 36, by + bh]]) {
      selection.push(E.shape(tr.stage, 'handle', 15.7, 18.8 - 15.7, GH, { x: hx - 10, y: hy - 10, w: 20, h: 20, fill: C.orange, radius: 4 }));
    }
    each(selection, (n) => n.init({ o: 0 }).to(15.7, 0.2, { o: 1 }, EASE.sine).to(18.6, 0.2, { o: 0 }, EASE.in));
    cur.move(16.0, 0.8, [grab[0], grab[1] + LIFT * k], EASE.inOut);
    for (const [n, , y] of lineNodes) n.to(16.0, 0.8, { dy: (y + boxH / 2 - H16.y) * (GROW - 1) + LIFT }, EASE.inOut);
    each(selection, (n) => n.to(16.0, 0.8, { dy: LIFT }, EASE.inOut));
    // Yellow.
    const sw1 = [1332 + 76 + 28, 658];
    cur.move(17.0, 0.6, sw1);
    cur.click(17.65, sw1);
    ring.to(17.7, 0.35, { dx: 76 }, EASE.expo);
    head.B.anim({ prop: 'color', from: C.cyan, to: C.agent, start: 17.72, duration: 0.4, ease: EASE.sine });
    // Save.
    const sv = [1432, 874];
    cur.move(18.05, 0.55, sv);
    cur.click(18.7, sv);
    press(save, 18.7);
  }

  // 05: brand from a website — palette, fonts and logo read, then applied to the film.
  {
    const Gb = E.group({ pivot: [1550, 615] });
    const t0 = 19.35; const end = T.generate + 0.05;
    Gb.set({ tx: 60, o: 0 }).to(t0, 0.55, { tx: 0 }, EASE.expo).to(t0, 0.4, { o: 1 }, EASE.sine).to(end - 0.45, 0.45, { o: 0, tx: 40 }, EASE.in);
    card(tr.ui, 'brand', t0, end - t0, Gb, { x: 1300, y: 300, w: 500, h: 630, radius: 24 });
    txt(tr.ui, 'brand-title', t0, end - t0, Gb, { weight: 600, size: 24, color: C.text, text: 'Brand kit', x: 1332, y: 326, w: 200 });
    mono(tr.ui, 'brand-from', t0, end - t0, Gb, { size: 15, color: C.dash, text: 'FROM A WEBSITE', x: 1620, y: 334, w: 160 });
    card(tr.ui, 'url', t0, end - t0, Gb, { x: 1324, y: 380, w: 452, h: 56, radius: 14, fill: C.raised });
    const url = 'aleloca.github.io/motion-studio';
    typing(tr.ui, 'url-typed', Gb, 19.95, 0.03, url, { font: 'mono', weight: 500, size: 19, color: C.text, x: 1344, y: 396, w: 430 }, end);
    sfx(19.95, 'typing', 0.3);
    sfx(21.2, 'pop', 0.4);
    // Reading the site.
    const bar = E.shape(tr.ui, 'reading', 20.45, 21.5 - 20.45, Gb, { x: 1326, y: 432, w: 448, h: 3, fill: C.orange, radius: 1.5 }).anim({ preset: 'wipe', start: 20.45, duration: 0.9, ease: EASE.inOut });
    bar.fadeOut(0.15);
    // Palette.
    mono(tr.ui, 'brand-field', 21.1, end - 21.1, Gb, { size: 15, color: C.dash, text: 'PALETTE', x: 1332, y: 466, w: 200 }).fadeIn(21.1, 0.3);
    const pal = [C.orange, C.orangeDeep, '#0C0C0C', C.text, C.muted];
    pal.forEach((col, i) => {
      const t = 21.2 + i * 0.07;
      const x = 1332 + i * 88;
      const sq = [
        E.shape(tr.ui, 'palette-edge', t, end - t, Gb, { x: x - 2, y: 492, w: 74, h: 74, fill: '#333333', radius: 17 }),
        E.shape(tr.ui, 'palette', t, end - t, Gb, { x, y: 494, w: 70, h: 70, fill: col, radius: 15 }),
        mono(tr.ui, 'palette-hex', t, end - t, Gb, { size: 13, color: C.dash, text: col.toUpperCase(), x, y: 572, w: 88 }),
      ];
      each(sq, (n) => n.init({ o: 0, s: 0.6 }).to(t, 0.45, { o: 1, s: 1 }, EASE.backSoft));
    });
    // Fonts.
    mono(tr.ui, 'brand-field', 21.6, end - 21.6, Gb, { size: 15, color: C.dash, text: 'FONTS', x: 1332, y: 616, w: 200 }).fadeIn(21.6, 0.3);
    [['display', 800, 'Bricolage Grotesque'], ['body', 500, 'Instrument Sans'], ['mono', 500, 'JetBrains Mono']].forEach(([font, weight, name], i) => {
      const t = 21.7 + i * 0.1; const y = 642 + i * 46;
      const row = [
        E.text(tr.ui, 'font-aa', t, end - t, Gb, { font, weight, size: 30, color: C.text, text: 'Aa', x: 1332, y: y - 4, w: 60 }),
        txt(tr.ui, 'font-name', t, end - t, Gb, { size: 18, color: C.muted, text: name, x: 1396, y: y + 4, w: 300 }),
      ];
      each(row, (n) => n.init({ o: 0, dx: -14 }).to(t, 0.45, { o: 1, dx: 0 }, EASE.expo));
    });
    // Logo.
    mono(tr.ui, 'brand-field', 22.05, end - 22.05, Gb, { size: 15, color: C.dash, text: 'LOGO', x: 1332, y: 788, w: 200 }).fadeIn(22.05, 0.3);
    const logo = E.svg(tr.ui, 'brand-logo', 22.15, end - 22.15, Gb, 'logo.svg', { x: 1332, y: 818, w: 330, h: 330 * LOGO_RATIO });
    logo.init({ o: 0, dx: -20 }).to(22.15, 0.5, { o: 1, dx: 0 }, EASE.expo);
    // Applied: the orange swatch and the logo fly onto the film.
    const fly = (name, src, from, to, t, shape) => {
      const n = shape
        ? E.shape(tr.fx, name, t, 0.75, null, { x: from.x, y: from.y, w: from.w, h: from.h, fill: src, radius: 15 })
        : E.svg(tr.fx, name, t, 0.75, null, src, { x: from.x, y: from.y, w: from.w, h: from.h });
      n.to(t, 0.6, { dx: to[0] - (from.x + from.w / 2), dy: to[1] - (from.y + from.h / 2) }, EASE.inOut).to(t + 0.6, 0.15, { o: 0 }, EASE.sine);
      return n;
    };
    fly('fly-orange', C.orange, { x: 1332, y: 494, w: 70, h: 70 }, [HERO.x + 560, HERO.y + 360], 22.55, true);
    fly('fly-deep', C.orangeDeep, { x: 1420, y: 494, w: 70, h: 70 }, [HERO.x + 840, HERO.y + 300], 22.62, true);
    fly('fly-logo', 'logo.svg', { x: 1332, y: 818, w: 330, h: 330 * LOGO_RATIO }, [HERO.x + (1430 + 170) * GH.k, HERO.y + (128 + 32) * GH.k], 22.7, false);
    head.B.anim({ prop: 'color', from: C.agent, to: C.orange, start: BRAND + 0.15, duration: 0.5, ease: EASE.sine });
  }

  // ── 06 Generate: an image asked for, the paid call confirmed, the picture lands on the film; then a voice and music ──
  {
    const G0 = T.generate;
    const Gg = E.group({ pivot: [1550, 615] });
    const t0 = G0 - 0.05; const end = T.formats + 0.05;
    const life = end - t0;
    Gg.set({ tx: 60, o: 0 }).to(t0, 0.55, { tx: 0 }, EASE.expo).to(t0, 0.4, { o: 1 }, EASE.sine).to(end - 0.45, 0.45, { o: 0, tx: 40 }, EASE.in);
    card(tr.ui, 'generate', t0, life, Gg, { x: 1300, y: 300, w: 500, h: 630, radius: 24 });
    txt(tr.ui, 'generate-title', t0, life, Gg, { weight: 600, size: 24, color: C.text, text: 'Generate an asset', x: 1332, y: 326, w: 300 });
    mono(tr.ui, 'generate-where', t0, life, Gg, { size: 15, color: C.dash, text: 'ASSETS', x: 1712, y: 334, w: 80 });
    // The kinds, as tabs: Image, then Voice-over, then Music.
    const KINDS = ['Image', 'Voice-over', 'Sound effect', 'Music'];
    const kw = KINDS.map((k) => tw(k, 17, 'body', 500) + 26);
    const kx = []; { let x = 1330; for (const w of kw) { kx.push(x); x += w + 4; } }
    card(tr.ui, 'kinds', t0, life, Gg, { x: 1324, y: 376, w: 452, h: 48, radius: 24, fill: C.raised });
    const VOICE_AT = G0 + 4.1; const MUSIC_AT = G0 + 5.5;
    /** The picture is made: it leaves the panel for the film. */
    const land = G0 + 3.2;
    const pill = E.shape(tr.ui, 'kind-active', t0, life, Gg, { x: kx[0], y: 382, w: kw[0], h: 36, fill: '#333333', radius: 18 });
    pill.to(VOICE_AT, 0.45, { dx: kx[1] - kx[0] }, EASE.expo).to(MUSIC_AT, 0.45, { dx: kx[3] - kx[0] }, EASE.expo);
    const on = [[t0, 0], [VOICE_AT, 1], [MUSIC_AT, 3]];
    KINDS.forEach((k, j) => {
      const label = txt(tr.ui, 'kind', t0, life, Gg, { size: 17, color: j === 0 ? C.text : C.dash, text: k, align: 'center', x: kx[j], y: 390, w: kw[j] });
      on.forEach(([t, i], n) => {
        if (n === 0) return;
        const was = on[n - 1][1] === j; const is = i === j;
        if (was !== is) label.anim({ prop: 'color', from: is ? C.dash : C.text, to: is ? C.text : C.dash, start: t, duration: 0.3, ease: EASE.sine });
      });
    });
    const field = (name, from, to, label, lines, provider) => {
      const nodes = [
        mono(tr.ui, `${name}-label`, from, to - from, Gg, { size: 15, color: C.dash, text: label, x: 1332, y: 446, w: 300 }),
        ...lines.map((l, i) => txt(tr.ui, `${name}-text`, from, to - from, Gg, { size: 19, color: C.text, text: l, x: 1344, y: 488 + i * 30, w: 420 })),
        mono(tr.ui, `${name}-provider`, from, to - from, Gg, { size: 15, color: C.muted, text: provider, x: 1332, y: 600, w: 440 }),
      ];
      // The last one leaves with the panel.
      return each(nodes, (n) => { n.init({ o: 0, dy: 10 }).to(from, 0.35, { o: 1, dy: 0 }, EASE.expo); if (to < end) n.fadeOut(0.2, EASE.in); });
    };
    card(tr.ui, 'gen-field', t0, life, Gg, { x: 1324, y: 470, w: 452, h: 112, radius: 14, fill: C.raised });
    // Image: the description typed, Generate pressed.
    mono(tr.ui, 'image-label', t0, VOICE_AT - t0, Gg, { size: 15, color: C.dash, text: 'DESCRIPTION', x: 1332, y: 446, w: 300 }).fadeOut(0.2, EASE.in);
    const p = { font: 'body', weight: 500, size: 19, color: C.text };
    const l1 = typing(tr.ui, 'prompt', Gg, G0 + 0.55, 0.022, 'Dark studio backdrop, warm orange', { ...p, x: 1344, y: 488, w: 420 }, land);
    typing(tr.ui, 'prompt', Gg, l1.done + 0.06, 0.022, 'light through haze, floating frames.', { ...p, x: 1344, y: 518, w: 420 }, land);
    sfx(G0 + 0.55, 'typing', 0.3);
    const provider = mono(tr.ui, 'image-provider', t0, G0 + 3.45 - t0, Gg, { size: 15, color: C.muted, text: `OPENAI  ·  GPT-IMAGE-2  ·  ${MEDIA.image?.asked ?? '1920×1088'}`, x: 1332, y: 600, w: 440 });
    provider.fadeOut(0.2, EASE.in);
    const genBtn = [
      E.shape(tr.ui, 'gen-button', t0, life, Gg, { x: 1324, y: 836, w: 150, h: 52, fill: C.orange, radius: 26 }),
      txt(tr.ui, 'gen-button-text', t0, life, Gg, { weight: 600, size: 20, color: C.stage, text: 'Generate', align: 'center', x: 1324, y: 849, w: 150 }),
    ];
    mono(tr.ui, 'gen-note', t0, life, Gg, { size: 14, color: C.dash, text: 'PAID CALL  ·  YOUR OWN KEY', x: 1494, y: 856, w: 290 });
    const cur = pointer(G0 + 0.9, G0 + 6.0, [1640, 960]);
    cur.move(G0 + 1.0, 0.45, [1400, 862]);
    cur.click(G0 + 1.5, [1400, 862]);
    press(genBtn, G0 + 1.5);
    // The paid call is confirmed first, on the app's approval card (the provider, the model, the size; no price on it).
    const Ga = E.group({ pivot: [1550, 690] });
    const a0 = G0 + 1.62; const a1 = G0 + 2.85;
    Ga.set({ o: 0, s: 0.92, ty: 16 }).to(a0, 0.4, { s: 1, ty: 0 }, EASE.backSoft).to(a0, 0.2, { o: 1 }, EASE.sine).to(a1 - 0.25, 0.25, { o: 0, s: 0.97 }, EASE.in);
    card(tr.fx, 'approval', a0, a1 - a0, Ga, { x: 1316, y: 560, w: 468, h: 250, radius: 20, fill: '#222222', border: '#5A3420' });
    mono(tr.fx, 'approval-kind', a0, a1 - a0, Ga, { size: 14, color: C.orange, text: 'EXTERNAL SERVICE', x: 1340, y: 582, w: 300 });
    txt(tr.fx, 'approval-title', a0, a1 - a0, Ga, { weight: 600, size: 20, color: C.text, text: 'Generate an image with gpt-image-2', x: 1340, y: 610, w: 430 });
    txt(tr.fx, 'approval-detail', a0, a1 - a0, Ga, { size: 16, color: C.muted, text: `${MEDIA.image?.asked ?? '1920×1088'}: Dark studio backdrop, warm orange…`, x: 1340, y: 646, w: 430 });
    txt(tr.fx, 'approval-keys', a0, a1 - a0, Ga, { size: 16, color: C.text, text: 'A paid call, on your own OpenAI key.', x: 1340, y: 676, w: 430 });
    const okBtn = [
      E.shape(tr.fx, 'approval-ok', a0, a1 - a0, Ga, { x: 1340, y: 728, w: 124, h: 46, fill: C.orange, radius: 23 }),
      txt(tr.fx, 'approval-ok-text', a0, a1 - a0, Ga, { weight: 600, size: 18, color: C.stage, text: 'Generate', align: 'center', x: 1340, y: 740, w: 124 }),
    ];
    for (const [x, w, l] of [[1476, 136, 'Always here'], [1624, 86, 'Deny']]) {
      card(tr.fx, 'approval-btn', a0, a1 - a0, Ga, { x, y: 728, w, h: 46, radius: 23, fill: '#222222', border: '#3A3A3A' });
      txt(tr.fx, 'approval-btn-text', a0, a1 - a0, Ga, { size: 18, color: C.text, text: l, align: 'center', x, y: 740, w });
    }
    sfx(a0, 'pop', 0.4);
    cur.move(G0 + 1.8, 0.4, [1402, 752]);
    cur.click(G0 + 2.3, [1402, 752]);
    press(okBtn, G0 + 2.3);
    // Generating, then the picture flies from the panel onto the film, beside the title.
    E.shape(tr.ui, 'generating', G0 + 2.6, 0.65, Gg, { x: 1326, y: 578, w: 448, h: 3, fill: C.orange, radius: 1.5 })
      .anim({ preset: 'wipe', start: G0 + 2.6, duration: 0.5, ease: EASE.inOut }).fadeOut(0.12);
    // The picture leaves the panel as a thumbnail and grows onto the film, where the backdrop takes over (BACKDROP_AT).
    const th = { x: 1344, y: 486, w: 192, h: 108 };
    const thumb = E.image(tr.fx, 'generated-thumb', land, BACKDROP_AT + 0.35 - land, null, IMAGE, { x: th.x, y: th.y, w: th.w, h: th.h, fit: 'cover' });
    thumb.init({ o: 0 }).to(land, 0.15, { o: 1 }, EASE.sine)
      .to(land, 0.75, { dx: HERO.x + HERO.w / 2 - (th.x + th.w / 2), dy: HERO.y + HERO.h / 2 - (th.y + th.h / 2), s: HERO.w / th.w }, EASE.inOut)
      .to(BACKDROP_AT, 0.35, { o: 0 }, EASE.sine);
    sfx(land, 'whoosh', 0.3);
    sfx(BACKDROP_AT, 'pop', 0.45);
    const added = [
      E.shape(tr.ui, 'added', G0 + 3.5, VOICE_AT - G0 - 3.5, Gg, { x: 1324, y: 594, w: 174, h: 32, fill: C.okBg, radius: 16 }),
      txt(tr.ui, 'added-text', G0 + 3.5, VOICE_AT - G0 - 3.5, Gg, { weight: 600, size: 16, color: C.ok, text: 'Added to Assets', align: 'center', x: 1324, y: 600, w: 174 }),
    ];
    each(added, (n) => n.init({ o: 0, s: 0.8 }).to(G0 + 3.5, 0.35, { o: 1, s: 1 }, EASE.backSoft).fadeOut(0.2, EASE.in));
    // Voice-over, then music: what each makes, its waveform.
    cur.move(G0 + 3.55, 0.4, [kx[1] + kw[1] / 2, 400]);
    cur.click(VOICE_AT, [kx[1] + kw[1] / 2, 400]);
    cur.move(G0 + 5.05, 0.35, [kx[3] + kw[3] / 2, 400]);
    cur.click(MUSIC_AT, [kx[3] + kw[3] / 2, 400]);
    const voice = MEDIA.voice ? `${MEDIA.voice.provider === 'openai' ? 'OPENAI' : 'ELEVENLABS'}  ·  ${MEDIA.voice.model.toUpperCase()}  ·  ${MEDIA.voice.name.toUpperCase()}` : 'ELEVENLABS  ·  ELEVEN_MULTILINGUAL_V2';
    field('voice', VOICE_AT, MUSIC_AT, 'TEXT TO SPEAK', ['Need an image, a voice, music', 'or a sound effect?'], voice);
    field('music', MUSIC_AT, end, 'DESCRIPTION', ['Confident launch underscore,', '110 BPM, warm synth bass.'], 'ELEVENLABS  ·  MUSIC_V1  ·  INSTRUMENTAL');
    for (const [name, from, to] of [['voice', VOICE_AT + 0.25, MUSIC_AT], ['music', MUSIC_AT + 0.25, end]]) {
      card(tr.ui, `${name}-wave-card`, from, to - from, Gg, { x: 1324, y: 652, w: 452, h: 150, radius: 14, fill: C.raised })
        .forEach((n) => { n.init({ o: 0 }).to(from, 0.3, { o: 1 }, EASE.sine); if (to < end) n.fadeOut(0.2, EASE.in); });
      const wv = E.svg(tr.ui, `${name}-wave`, from, to - from, Gg, `wave-${name}.svg`, { x: 1344, y: 682, w: 412, h: 90, fit: 'fill' })
        .anim({ preset: 'wipe', start: from, duration: 0.7, ease: EASE.expo });
      const play = E.svg(tr.ui, `${name}-play`, from + 0.3, to - from - 0.3, Gg, 'avatar.svg', { x: 1720, y: 612, w: 34, h: 34 });
      play.init({ o: 0, s: 0.6 }).to(from + 0.3, 0.35, { o: 1, s: 1 }, EASE.backSoft);
      if (to < end) { wv.fadeOut(0.2, EASE.in); play.fadeOut(0.2, EASE.in); }
    }
  }

  // ── 07 Formats: the film recomposed for 9:16 and 1:1, beside the 16:9 ──────────────────────────────────────────────
  const ROW = { s916: { x: 107.5, y: 320, w: 315 }, s11: { x: 482.5, y: 410, w: 470 }, s169: { x: 1012.5, y: 430, w: 800 } };
  const MOVE = T.formats + 0.25;
  sfx(MOVE, 'whoosh', 0.4);
  sfx(MOVE + 0.8, 'pop', 0.35);
  {
    const [cx, cy] = GH.pivot;
    const s = ROW.s169.w / HERO.w;
    GH.to(MOVE, 1.05, { tx: ROW.s169.x + ROW.s169.w / 2 - cx, ty: ROW.s169.y + (ROW.s169.w * 9) / 16 / 2 - cy, s }, EASE.inOut);
  }
  const boards = {};
  {
    const mk = (key, slot, w, h, t) => {
      const k = slot.w / w;
      const g = E.group({ x: slot.x, y: slot.y, k, w, h });
      const [cx, cy] = g.pivot;
      const tc = [ROW.s169.x + ROW.s169.w / 2, ROW.s169.y + (ROW.s169.w * 9) / 16 / 2];
      g.set({ tx: tc[0] - cx, ty: tc[1] - cy, s: 0.55, o: 0 }).to(t, 1.15, { tx: 0, ty: 0, s: 1 }, EASE.expo).to(t, 0.35, { o: 1 }, EASE.sine);
      return g;
    };
    boards['1x1'] = mk('1x1', ROW.s11, 1080, 1080, MOVE + 0.75);
    boards['9x16'] = mk('9x16', ROW.s916, 1080, 1920, MOVE + 0.9);
    boards['16x9'] = GH;
  }
  const rowEnd = T.identity + 0.6;
  const filmOf = {};
  for (const fmt of ['9x16', '1x1']) {
    const g = boards[fmt];
    const t0 = fmt === '1x1' ? MOVE + 0.75 : MOVE + 0.9;
    filmOf[fmt] = film(fmt, g, t0, rowEnd, { brandAt: -1, backdrop: t0, track: 'back', ringsFrom: t0 + 1.2, ringsTo: T.identity - 0.25, ringPlan: [[0, 1.2, 'orange', 0.8]] });
  }
  // The headlines per format and language: the 16:9 at the size and place set by hand, the others in their own layouts.
  const HEADS = {
    '16x9': { x: H16.x, y: H16.y + LIFT, size: H16.size * GROW, avail: FILM['16x9'].head.avail },
    '9x16': FILM['9x16'].head,
    '1x1': FILM['1x1'].head,
  };
  const FLIPS = [['en', 0], ['it', T.langs + 0.7], ['de', T.langs + 2.0], ['ja', T.langs + 3.3], ['en', T.subs + 0.15]];
  const heads = { '16x9': [], '9x16': [], '1x1': [] };
  for (const [fmt, g] of Object.entries(boards)) {
    const Hd = HEADS[fmt];
    const bi = { '9x16': 0, '1x1': 1, '16x9': 2 }[fmt];
    FLIPS.forEach(([lang, tf], i) => {
      const t = i === 0 ? (fmt === '16x9' ? BAKE : (fmt === '1x1' ? MOVE + 0.75 : MOVE + 0.9)) : tf + bi * 0.07;
      const size = fitSize(lang, Hd.size, Hd.avail);
      const next = FLIPS[i + 1] ? FLIPS[i + 1][1] + bi * 0.07 : null;
      const end = next !== null ? next + 0.3 : rowEnd;
      const h = headline(fmt, g, i === 0 ? t : t + 0.1, end, lang, Hd.x, Hd.y, size, C.orange, `${fmt}-${lang}`, i === 0 && fmt !== '16x9' ? tr.back : tr.stage);
      // In: the first time, the 9:16 and 1:1 lines wipe in once their board lands; after a flip, they rise from a blur.
      if (i === 0 && fmt !== '16x9') {
        [h.A, h.B].forEach((n, j) => n.init({ o: 0, dx: -30 }).to(t + 1.15 + j * 0.1, 0.7, { o: 1, dx: 0 }, EASE.expo));
      } else if (i > 0) {
        [h.A, h.B].forEach((n, j) => n.init({ o: 0, dy: 26, blur: 10 }).to(t + 0.1 + j * 0.05, 0.5, { o: 1, dy: 0, blur: 0 }, EASE.expo));
      }
      if (next !== null) [h.A, h.B].forEach((n, j) => n.to(next + j * 0.05, 0.22, { o: 0, dy: -22, blur: 8 }, EASE.in));
      heads[fmt].push(h);
    });
  }
  // Labels over the three boards.
  [
    ['916', ROW.s916, [9, 16], 'Story/Reel 9:16', MOVE + 1.5],
    ['11', ROW.s11, [1, 1], 'Post 1:1', MOVE + 1.4],
    ['169', ROW.s169, [16, 9], 'Video 16:9', MOVE + 1.2],
  ].forEach(([name, slot, ratio, label, t]) => {
    const l = boardLabel(`row-${name}`, slot.x, slot.y - 42, t, T.identity + 0.3, ratio, label, [[t, 'v3']]);
    l.end(T.identity - 0.1);
    return l;
  });

  // ── 08 Languages: the tabs, the flips ──────────────────────────────────────────────────────────────────────────────
  {
    const names = ['English', 'Italian', 'German', 'Japanese'];
    const ws = names.map((n) => tw(n, 20, 'body', 500) + 40);
    const total = ws.reduce((a, b) => a + b, 0) + 12;
    const x0 = 1800 - total; const y = 108;
    const t0 = T.langs + 0.1; const end = T.identity + 0.1;
    const strip = [...card(tr.chrome, 'lang-tabs', t0, end - t0, null, { x: x0, y, w: total, h: 56, radius: 28 })];
    const pill = E.shape(tr.chrome, 'lang-active', t0, end - t0, null, { x: x0 + 6, y: y + 6, w: ws[0], h: 44, fill: '#2E2E2E', radius: 22 });
    strip.push(pill);
    const order = [0, 1, 2, 3, 0];
    const xs = []; let acc = x0 + 6; for (const w of ws) { xs.push(acc); acc += w; }
    FLIPS.forEach(([, tf], i) => { if (i > 0) { pill.to(tf, 0.45, { dx: xs[order[i]] - xs[0] }, EASE.expo); sfx(tf, 'whoosh', 0.22); } });
    names.forEach((n, j) => {
      const label = txt(tr.chrome, 'lang-tab', t0, end - t0, null, { size: 20, color: j === 0 ? C.text : C.dash, text: n, align: 'center', x: xs[j], y: y + 15, w: ws[j] });
      FLIPS.forEach(([, tf], i) => {
        if (i === 0) return;
        const was = order[i - 1] === j; const is = order[i] === j;
        if (was !== is) label.anim({ prop: 'color', from: is ? C.dash : C.text, to: is ? C.text : C.dash, start: tf, duration: 0.3, ease: EASE.sine });
      });
      strip.push(label);
    });
    each(strip, (n) => n.init({ o: 0, dy: -12 }).to(t0, 0.5, { o: 1, dy: 0 }, EASE.expo).fadeOut(0.3, EASE.in));
  }

  // ── 09 Subtitles: a voice, its waveform, lines in sync in every format ─────────────────────────────────────────────
  {
    const t0 = T.subs + 0.2; const end = T.identity + 0.1;
    const wave = { x: 107.5, y: 908, w: 1705, h: 62 };
    const wv = E.svg(tr.chrome, 'waveform', t0, end - t0, null, 'waveform.svg', { x: wave.x, y: wave.y, w: wave.w, h: wave.h, fit: 'fill' });
    wv.anim({ preset: 'wipe', start: t0, duration: 0.6, ease: EASE.expo }).fadeOut(0.3, EASE.in);
    // The real line: its voice-over starts at `speakR` (film time) and each word is lit from its start to the next one's
    // (times from media.json); the nodes take authoring times (TL.U).
    const v = TL.vo.find((x) => x.beat === 'subs');
    const U = TL.U;
    const speakR = v ? v.start : TL.W(T.subs + 0.8); const lenR = v ? v.duration : 3.6;
    const fallback = 'Subtitles stay in sync with the voice.'.split(' ').map((w, i) => ({ text: w, start: 0.2 + i * 0.4, end: 0.55 + i * 0.4 }));
    const words = (v ? v.words : fallback).map((w) => ({ text: w.text, s: speakR + w.start, e: speakR + w.end }));
    const speak = U(speakR);
    const ph = E.shape(tr.chrome, 'voice-head', speak - 0.1, end - speak + 0.1, null, { x: wave.x - 1, y: wave.y - 8, w: 3, h: wave.h + 16, fill: C.orange, radius: 1.5 });
    ph.fadeIn(speak - 0.1, 0.2).to(speak, U(speakR + lenR) - speak, { dx: wave.w }, 'linear').fadeOut(0.3, EASE.in);
    // Two cues (the 9:16 is too narrow for the line in one).
    const half = Math.ceil(words.length / 2);
    const cues = [words.slice(0, half), words.slice(half)];
    for (const [fmt, g] of Object.entries(boards)) {
      const L = FILM[fmt];
      const size = L.sub.size;
      cues.forEach((cw, ci) => {
        const line = cw.map((w) => w.text).join(' ');
        const lw = tw(line, size, 'body', 600);
        const pad = size * 0.5;
        const x = (L.w - lw) / 2;
        const cs = U(cw[0].s - 0.08); const ce = ci === 0 ? U(cues[1][0].s - 0.1) : rowEnd;
        const box = E.shape(tr.stage, `${fmt}-sub-box`, cs, ce - cs, g, { x: x - pad, y: L.sub.y - size * 0.32, w: lw + pad * 2, h: size * 1.32 + size * 0.5, fill: '#000000B3', radius: size * 0.3 });
        const text = E.text(tr.stage, `${fmt}-sub`, cs, ce - cs, g, { font: 'body', weight: 600, size, color: C.text, text: line, x, y: L.sub.y - size * 0.07, w: lw + 8 });
        for (const n of [box, text]) { n.init({ o: 0, dy: 14 }).to(cs, 0.25, { o: 1, dy: 0 }, EASE.expo); if (ci === 0) n.fadeOut(0.12, EASE.in); }
        // The spoken word, in orange, from its start to the next word's (the last one a little past its end).
        let pre = '';
        cw.forEach((w, wi) => {
          const until = Math.min(cw[wi + 1]?.s ?? w.e + 0.3, TL.W(ce));
          const wx = x + tw(pre, size, 'body', 600);
          E.text(tr.stage, `${fmt}-word`, U(w.s), U(until) - U(w.s), g, { font: 'body', weight: 600, size, color: C.orange, text: w.text, x: wx, y: L.sub.y - size * 0.07, w: tw(w.text, size, 'body', 600) + 8 });
          pre += `${w.text} `;
        });
      });
    }
  }
  // The row leaves.
  {
    const out = T.identity - 0.15;
    const order = [boards['9x16'], boards['1x1'], GH];
    order.forEach((g, i) => {
      const t = out + i * 0.07;
      g.to(t, 0.55, { o: 0 }, EASE.in);
      g.to(t, 0.55, { ty: (g === GH ? g.v.ty.at(E.W(t)) : 0) + 50 }, EASE.in);
    });
  }

  // ── 10 Identity: the mark becomes an app icon, a favicon in a tab, a social preview ───────────────────────────────
  {
    const t0 = T.identity + 0.4; const end = T.export + 0.1;
    const mark = E.svg(tr.stage, 'mark', t0, 1.4, null, 'mark.svg', { x: 780, y: 400, w: 360, h: 320 });
    mark.init({ o: 0, s: 0.6 }).to(t0, 0.7, { s: 1 }, EASE.backSoft).to(t0, 0.3, { o: 1 }, EASE.sine).to(t0 + 1.0, 0.4, { s: 0.7, o: 0 }, EASE.in);
    const split = t0 + 1.05;
    sfx(t0, 'pop', 0.4);
    sfx(split, 'whoosh', 0.35);
    const out = (nodes, t, from) => each(nodes, (n) => n.init({ o: 0, s: 0.4, dx: from }).to(t, 0.8, { s: 1, dx: 0 }, EASE.expo).to(t, 0.3, { o: 1 }, EASE.sine).to(end - 0.45, 0.4, { o: 0, dy: -30 }, EASE.in));
    // App icon (centre).
    out([
      E.shape(tr.stage, 'app-icon-edge', split, end - split, null, { x: 798, y: 378, w: 324, h: 324, fill: '#333333', radius: 73 }),
      E.svg(tr.stage, 'app-icon', split, end - split, null, 'app-icon.svg', { x: 800, y: 380, w: 320, h: 320 }),
    ], split, 0);
    // Favicon in a browser tab (left), drawn at 440 × 200 and shown 1.27 ×.
    const Gt = E.group({ x: 120 - 160 * 1.27, y: 395 - 440 * 1.27, k: 1.27 });
    const tab = [
      E.svg(tr.stage, 'tab', split + 0.12, end - split - 0.12, Gt, 'tab.svg', { x: 160, y: 440, w: 440, h: 200 }),
      E.svg(tr.stage, 'favicon', split + 0.12, end - split - 0.12, Gt, 'app-icon.svg', { x: 194, y: 498, w: 26, h: 26 }),
      txt(tr.stage, 'tab-title', split + 0.12, end - split - 0.12, Gt, { weight: 500, size: 17, color: C.text, text: 'Motion Studio', x: 230, y: 500, w: 200 }),
      mono(tr.stage, 'tab-url', split + 0.12, end - split - 0.12, Gt, { size: 16, color: C.muted, text: 'aleloca.github.io/motion-studio', x: 220, y: 566, w: 340 }),
    ];
    out(tab, split + 0.12, 330);
    // Social preview (right), drawn at 480 × 252 and shown 1.25 ×.
    const Go = E.group({ x: 1200 - 1290 * 1.25, y: 390 - 414 * 1.25, k: 1.25 });
    const og = [
      ...card(tr.stage, 'og', split + 0.2, end - split - 0.2, Go, { x: 1290, y: 414, w: 480, h: 252, radius: 18, fill: '#0C0C0C' }),
      E.svg(tr.stage, 'og-mark', split + 0.2, end - split - 0.2, Go, 'mark.svg', { x: 1322, y: 446, w: 72, h: 64 }),
      E.text(tr.stage, 'og-head', split + 0.2, end - split - 0.2, Go, { size: 46, weight: 800, color: C.text, text: 'Brief in.', x: 1322, y: 530, w: 400 }),
      E.text(tr.stage, 'og-head', split + 0.2, end - split - 0.2, Go, { size: 46, weight: 300, color: C.orange, text: 'Motion out.', x: 1322, y: 580, w: 400 }),
    ];
    out(og, split + 0.2, -330);
    [['favicon', 400], ['app icon', 960], ['social preview', 1500]].forEach(([l, x], i) => {
      const t = split + 0.5 + i * 0.08;
      mono(tr.stage, 'identity-label', t, end - t, null, { size: 20, color: C.muted, text: l, align: 'center', x: x - 200, y: 744, w: 400 })
        .init({ o: 0, dy: 10 }).to(t, 0.5, { o: 1, dy: 0 }, EASE.expo).to(end - 0.45, 0.4, { o: 0 }, EASE.in);
    });
  }

  // ── 11 Export: one click, the files fly into a folder per channel ──────────────────────────────────────────────────
  {
    const t0 = T.export + 0.2; const end = T.end - 0.1;
    const btn = [
      E.shape(tr.ui, 'export', t0, end - t0, null, { x: 860, y: 300, w: 200, h: 64, fill: C.text, radius: 32 }),
      E.svg(tr.ui, 'export-icon', t0, end - t0, null, 'download.svg', { x: 892, y: 320, w: 24, h: 24 }),
      txt(tr.ui, 'export-text', t0, end - t0, null, { weight: 600, size: 24, color: C.stage, text: 'Export', x: 926, y: 315, w: 120 }),
    ];
    each(btn, (n) => n.init({ o: 0, s: 0.8 }).to(t0, 0.5, { o: 1, s: 1 }, EASE.backSoft).to(end - 0.4, 0.35, { o: 0 }, EASE.in));
    const cur = pointer(t0 + 0.2, t0 + 1.7, [1320, 820]);
    cur.move(t0 + 0.3, 0.6, [990, 336]);
    const click = t0 + 1.0;
    cur.click(click, [990, 336]);
    press(btn, click);
    // Folders.
    const FOLD = [['YouTube', C.orange, 560], ['Instagram', C.store, 960], ['Web', C.formats, 1360]];
    const folders = FOLD.map(([name, color, cx], i) => {
      const t = t0 + 0.4 + i * 0.08;
      const f = E.svg(tr.stage, 'folder', t, end - t, null, `folder-${i}.svg`, { x: cx - 150, y: 640, w: 300, h: 220 });
      f.init({ o: 0, dy: 30 }).to(t, 0.6, { o: 1, dy: 0 }, EASE.expo).to(end - 0.4, 0.35, { o: 0 }, EASE.in);
      const label = txt(tr.stage, 'folder-name', t, end - t, null, { weight: 600, size: 24, color: C.text, text: name, align: 'center', x: cx - 150, y: 878, w: 300 });
      label.init({ o: 0 }).to(t + 0.1, 0.4, { o: 1 }, EASE.sine).to(end - 0.4, 0.35, { o: 0 }, EASE.in);
      return { f, cx, color, count: 0, times: [] };
    });
    const FILES = [
      ['launch-16x9.mp4', 0], ['launch-9x16.mp4', 1], ['favicon.ico', 2], ['launch-16x9.srt', 0],
      ['launch-1x1.mp4', 1], ['app-icon.png', 2], ['og-image.png', 2],
    ];
    const rowsY = [420, 492];
    const widths = FILES.map(([n]) => 66 + tw(n, 19, 'mono', 500) + 22);
    const rows = [FILES.slice(0, 4), FILES.slice(4)];
    let idx = 0;
    rows.forEach((row, ri) => {
      const ws = row.map((_, j) => widths[idx + j]);
      const total = ws.reduce((a, b) => a + b, 0) + (row.length - 1) * 16;
      let x = (1920 - total) / 2;
      row.forEach(([name, fi], j) => {
        const i = idx + j;
        const w = ws[j]; const y = rowsY[ri];
        const appear = click + 0.15 + i * 0.05;
        const g = E.group({ pivot: [x + w / 2, y + 26] });
        g.set({ o: 0, ty: -40 }).to(appear, 0.5, { ty: 0 }, EASE.expo).to(appear, 0.25, { o: 1 }, EASE.sine);
        const flyAt = click + 0.9 + i * 0.16;
        const F = folders[fi];
        g.to(flyAt, 0.6, { tx: F.cx - (x + w / 2) }, EASE.inOut).to(flyAt, 0.6, { ty: 690 - (y + 26) }, 'cubic-bezier(.5,-0.55,.6,1)');
        g.to(flyAt + 0.6, 0.18, { s: 0.3 }, EASE.in).to(flyAt + 0.55, 0.23, { o: 0 }, EASE.in);
        const life = flyAt + 0.8 - appear;
        card(tr.fx, 'file', appear, life, g, { x, y, w, h: 52, radius: 14 });
        E.svg(tr.fx, 'file-glyph', appear, life, g, `file-${fi}.svg`, { x: x + 18, y: y + 9, w: 28, h: 34 });
        mono(tr.fx, 'file-name', appear, life, g, { size: 19, color: C.text, text: name, x: x + 60, y: y + 14, w: w - 60 });
        F.times.push(flyAt + 0.7);
        x += w + 16;
      });
      idx += row.length;
    });
    sfx(click + 0.9, 'files', 0.45);
    sfx(Math.max(...folders.flatMap((F) => F.times)), 'chime', 0.4);
    // Each arrival: the folder bumps, its count goes up.
    folders.forEach((F) => {
      F.times.forEach((t) => F.f.to(t, 0.06, { s: 1.06 }, EASE.sine).to(t + 0.06, 0.09, { s: 1 }, EASE.sine));
      const counts = [[t0 + 0.5, '0 files'], ...F.times.map((t, i) => [t, `${i + 1} file${i ? 's' : ''}`])];
      counts.forEach(([t, label], i) => {
        const e = counts[i + 1]?.[0] ?? end;
        const n = mono(tr.stage, 'folder-count', t, e - t, null, { size: 17, color: i ? F.color : C.dash, text: label, align: 'center', x: F.cx - 150, y: 916, w: 300 });
        if (i === 0) n.fadeIn(t, 0.4); else n.init({ s: 1.3 }).to(t, Math.min(0.3, e - t), { s: 1 }, EASE.backSoft);
        if (!counts[i + 1]) n.fadeOut(0.35, EASE.in, end - 0.4);
      });
    });
  }

  // ── End card ───────────────────────────────────────────────────────────────────────────────────────────────────────
  {
    const t0 = T.end;
    E.image(tr.ground, 'end-backdrop', t0, D - t0, null, IMAGE, { x: 0, y: 0, w: 1920, h: 1080, fit: 'cover' }).init({ o: 0, s: 1.06 }).to(t0, 1.6, { o: 0.32 }, EASE.sine).to(t0, D - t0, { s: 1 }, 'linear');
    E.svg(tr.ground, 'ember', t0, D - t0, null, 'ember.svg', { x: 260, y: -160, w: 1400, h: 1400 }).init({ o: 0, s: 0.85 }).to(t0, 2.2, { o: 1, s: 1 }, EASE.sine);
    const lw = 620;
    sfx(t0 + 0.2, 'chime', 0.35);
    const logo = E.svg(tr.stage, 'end-logo', t0 + 0.2, D - t0 - 0.2, null, 'logo.svg', { x: (1920 - lw) / 2, y: 300, w: lw, h: lw * LOGO_RATIO });
    logo.init({ o: 0, s: 0.92, blur: 14 }).to(t0 + 0.2, 1.0, { o: 1, s: 1, blur: 0 }, EASE.expo);
    const size = 120;
    const a = 'Brief in.'; const b = 'Motion out.';
    const wa = tw(a, size, 'display', 800); const wb = tw(b, size, 'display', 300); const gap = size * 0.28;
    const x0 = (1920 - wa - gap - wb) / 2;
    E.text(tr.stage, 'end-a', t0 + 0.75, D - t0 - 0.75, null, { size, weight: 800, color: C.text, text: a, x: x0, y: 500, w: wa + 8 })
      .init({ blur: 12, dy: 30 }).to(t0 + 0.75, 0.9, { blur: 0, dy: 0 }, EASE.expo).anim({ preset: 'wipe', start: t0 + 0.75, duration: 0.8, ease: EASE.expo });
    E.text(tr.stage, 'end-b', t0 + 1.0, D - t0 - 1.0, null, { size, weight: 300, color: C.orange, text: b, x: x0 + wa + gap, y: 500, w: wb + 8 })
      .init({ blur: 12, dx: -30 }).to(t0 + 1.0, 0.9, { blur: 0, dx: 0 }, EASE.expo).anim({ preset: 'wipe', start: t0 + 1.0, duration: 0.8, ease: EASE.expo });
    const gh = 'github.com/Aleloca/motion-studio';
    const gw = tw(gh, 32, 'mono', 500);
    mono(tr.stage, 'end-url', t0 + 1.7, D - t0 - 1.7, null, { size: 32, color: C.text, text: gh, align: 'center', x: 0, y: 704, w: 1920 })
      .init({ o: 0, dy: 16 }).to(t0 + 1.7, 0.7, { o: 1, dy: 0 }, EASE.expo);
    E.shape(tr.stage, 'end-rule', t0 + 2.1, D - t0 - 2.1, null, { x: (1920 - gw) / 2, y: 756, w: gw, h: 3, fill: C.orange, radius: 1.5 }).anim({ preset: 'wipe', start: t0 + 2.1, duration: 0.8, ease: EASE.inOut });
    txt(tr.stage, 'end-line', t0 + 2.4, D - t0 - 2.4, null, { size: 24, color: C.muted, text: 'Free and open source  ·  macOS, Windows, Linux', align: 'center', x: 0, y: 800, w: 1920 })
      .fadeIn(t0 + 2.4, 0.7, EASE.sine);
  }

  // ── Sound: the voice-over, the music bed ducked under it, the effects ─────────────────────────────────────────────
  sound(E, cues);
  return E.build();
}

/**
 * The audio tracks, in film time: one voice clip per line, the music bed in stretches of one level (musicStretches)
 * alternating between two tracks, and the effects at their cues.
 */
function sound(E, cues) {
  const voice = E.c.track('voice', 'audio');
  for (const v of TL.vo) E.c.audio(voice, 'voice', v.start, v.duration, `audio/${v.file}`, { role: 'voice', script: v.text });
  if (MEDIA.music) {
    const tracks = [E.c.track('music-a', 'audio'), E.c.track('music-b', 'audio')];
    musicStretches(TL.vo, Math.min(TL.D, MEDIA.music.duration)).forEach((m, i) => {
      E.c.audio(tracks[i % 2], 'music', m.from, m.to - m.from, `audio/${MEDIA.music.file}`, { trimStart: m.from, volume: m.level, role: 'music', fadeIn: m.fadeIn, fadeOut: m.fadeOut });
    });
  }
  if (MEDIA.sfx) {
    const fx = E.c.track('sfx', 'audio');
    for (const [t, id, volume] of cues.sort((a, b) => a[0] - b[0])) {
      const m = MEDIA.sfx[id];
      if (!m) continue;
      const start = TL.W(t);
      E.c.audio(fx, `sfx-${id}`, start, Math.min(m.duration, TL.D - start), `audio/${m.file}`, { volume, role: 'sfx' });
    }
  }
}

/** The SVG files of the composition's assets/ folder (the logo and the mark come from the site and the identity set). */
export function launchAssets() {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const A = {
    'logo.svg': read('../../src/assets/logo-horizontal-light.svg'), 'mark.svg': read('../../compositions/identity/assets/mark.svg'),
    'app-icon.svg': read('../../compositions/identity/assets/favicon.svg'),
    'canvas.svg': S.canvas, 'ember.svg': S.ember, 'cursor.svg': S.cursor, 'ripple.svg': S.ripple, 'avatar.svg': S.avatar,
    'ring-cyan.svg': S.ringCyan, 'ring-orange.svg': S.ringOrange,
    'poster.svg': S.posterBg(1920, 1080), 'sun.svg': S.sun, 'waves.svg': S.waves, 'halftone.svg': S.halftone,
    'paper.svg': S.paperBg(1920, 1080), 'chart.svg': S.chart,
    'outline-variant.svg': S.outline(2012, 1172, 96, C.orange, 3),
    'outline-select.svg': S.outline(1000, 600, 6, C.orange, 2.5),
    'outline-swatch.svg': S.outline(72, 72, 18, C.text, 3),
    'download.svg': S.download, 'tab.svg': S.browserTab(),
    'ratio-16x9.svg': S.ratioIcon(16, 9, C.orange), 'ratio-9x16.svg': S.ratioIcon(9, 16, C.orange), 'ratio-1x1.svg': S.ratioIcon(1, 1, C.orange),
    'folder-0.svg': S.folder(C.orange), 'folder-1.svg': S.folder(C.store), 'folder-2.svg': S.folder(C.formats),
    'file-0.svg': S.fileGlyph(C.orange), 'file-1.svg': S.fileGlyph(C.store), 'file-2.svg': S.fileGlyph(C.formats),
  };
  // Waveforms: the subtitles beat's line, and the Generate beat's voice and music (the real recordings when there are).
  const peaksOf = (beat) => TL.vo.find((v) => v.beat === beat)?.peaks;
  A['waveform.svg'] = peaksOf('subs') ? S.peaksWave(1705, 62, peaksOf('subs')) : S.waveform(1705, 62);
  A['wave-voice.svg'] = peaksOf('generate') ? S.peaksWave(412, 90, peaksOf('generate'), C.muted, 7) : S.waveform(412, 90, C.muted);
  A['wave-music.svg'] = MEDIA.music ? S.peaksWave(412, 90, MEDIA.music.peaks, C.muted, 7) : S.waveform(412, 90, C.muted);
  for (const [fmt, L] of Object.entries(FILM)) {
    A[`film-${fmt}-night.svg`] = S.filmBg(L.w, L.h, L.ring.cx, L.ring.cy, 'night');
    A[`film-${fmt}-brand.svg`] = S.filmBg(L.w, L.h, L.ring.cx, L.ring.cy, 'brand');
  }
  return A;
}
