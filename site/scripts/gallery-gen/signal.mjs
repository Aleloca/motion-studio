// Late Signal: a night-time podcast's new episode, 1:1. Seventies warm: cream, mustard, orange and brown, chunky type,
// a record that slides out of its sleeve and spins under a tonearm that swings onto it, and an equalizer rising from the
// floor (each bar slides up from behind the brown band, which masks it), then the weekly date.
import { makeComp, A, EASE } from '../hero-gen/lib.mjs';
import { seeded, f1, letters, words } from './kit.mjs';

const C = { cream: '#F2E3C6', mustard: '#E7A92F', orange: '#D9592A', rust: '#9C3B1B', brown: '#3A2416', vinyl: '#17110D' };
const W = 1080; const H = 1080; const D = 9;
const SC = [
  { id: 'sleeve', name: 'Out of the sleeve', start: 0, duration: 3 },
  { id: 'play', name: 'On air', start: 3, duration: 3.4 },
  { id: 'weekly', name: 'Every Friday', start: 6.4, duration: 2.6 },
];
const FLOOR = 800;

export function signal() {
  const c = makeComp({ width: W, height: H, duration: D, background: C.cream, scenes: SC });
  const back = c.track('stripes');
  const disc = c.track('record');
  const bars = c.track('bars');
  const floor = c.track('floor');
  const type = c.track('type', 'text');

  // Seventies stripes sweep in behind everything.
  c.svg(back, 'stripes', 0.05, D - 0.05, 'stripes.svg', { x: 0, y: 0, w: W, h: H }, [A.wipe(0, 0.8, EASE.inOut), A.fadeOutAt(D - 0.45, 0.4)]);

  // Scene 1: the sleeve slides in, the record slides out of it and starts to spin.
  const SL = { x: 110, y: 290, s: 470 };
  const R = { cx: 540, cy: 482, s: 556 };
  c.svg(disc, 'record', 0.75, D - 0.75, 'record.svg', { x: R.cx - R.s / 2, y: R.cy - R.s / 2, w: R.s, h: R.s }, [
    A.kf('x', [[0, -330], [0.12, -330], [0.3, 0, EASE.expo], [1, 0]], 0, 2.3),
    A.tw('rotation', 0, 1440, 0.6, D - 0.75 - 0.6, 'linear'), A.fadeIn(0, 0.15), A.tw('scale', 1, 0, D - 0.75 - 0.5, 0.45, EASE.in),
  ]);
  c.svg(disc, 'shine', 1.4, D - 1.4, 'shine.svg', { x: R.cx - R.s / 2, y: R.cy - R.s / 2, w: R.s, h: R.s }, [A.fadeIn(0, 0.5), A.tw('scale', 1, 0, D - 1.4 - 0.5, 0.45, EASE.in)]);
  // The sleeve stays over the record, which peeks out of it, until it slides away.
  c.svg(disc, 'sleeve', 0.2, 3.1, 'sleeve.svg', { x: SL.x, y: SL.y, w: SL.s, h: SL.s, rotation: -4 }, [A.tw('x', -700, 0, 0, 0.7, EASE.expo), A.tw('rotation', -14, 0, 0, 0.8, EASE.backSoft), A.tw('x', 0, -900, 2.5, 0.6, EASE.in)]);
  // The tonearm swings in on its pivot (the drawing's centre) once the sleeve has gone.
  c.svg(disc, 'arm', 2.6, D - 2.6, 'arm.svg', { x: 840 - 200, y: 200 - 200, w: 400, h: 400 }, [A.tw('rotation', -48, 0, 0, 0.9, EASE.backSoft), A.fadeIn(0, 0.2), A.tw('rotation', 0, -48, D - 2.6 - 0.7, 0.5, EASE.in), A.fadeOut(0.3)]);

  // The title, letter by letter with a bounce, top left.
  c.text(type, 'kicker', 0.3, 2.9, { font: 'mono', weight: 600, size: 26, color: C.rust, text: 'PODCAST  ·  EPISODE 42', x: 64, y: 40, w: 600 }, [A.wipe(0, 0.5), A.fadeOut(0.25)]);
  letters(c, type, 'title', 'Late Signal', { font: 'display', weight: 800, size: 100, color: C.brown, x: 60, y: 66, tracking: -2, end: 3.0 }, 0.4, 0.05,
    (i, s) => [A.tw('y', -120, 0, 0, 0.55, EASE.back), A.fadeIn(0, 0.15), A.tw('y', 0, -40, 2.7 - s, 0.25, EASE.in), A.fadeOut(0.25)]);

  // Scene 2: the brown floor rises, the equalizer comes out of it, the episode's title over it.
  c.shape(floor, 'floor', 2.85, D - 2.85, { x: 0, y: FLOOR, w: W, h: H - FLOOR, fill: C.brown }, [A.tw('y', H - FLOOR, 0, 0, 0.5, EASE.expo), A.tw('y', 0, H - FLOOR, D - 2.85 - 0.5, 0.45, EASE.in)]);
  const N = 22; const bw = 30; const gap = (W - 80 - N * bw) / (N - 1);
  const rand = seeded(17);
  for (let i = 0; i < N; i++) {
    const s = 3.1 + i * 0.015; const dur = 5.6 - s;
    const frames = [[0, 0]];
    const steps = 40;
    for (let k = 1; k <= steps; k++) {
      const t = k / steps; const time = t * dur;
      const beat = Math.pow(1 - ((time % 0.5) / 0.5), 2);
      const env = Math.sin(Math.PI * (0.15 + 0.85 * (i / (N - 1)))) * 0.6 + 0.4;
      const hgt = k === steps ? 0 : (40 + 220 * env * (0.35 + 0.65 * beat) * (0.6 + 0.4 * rand()));
      frames.push([t, -Math.round(hgt), EASE.sine]);
    }
    c.shape(bars, 'bar', s, dur, { x: 40 + i * (bw + gap), y: FLOOR, w: bw, h: 300, fill: i % 3 === 1 ? C.orange : C.mustard, radius: bw / 2 }, [A.kf('y', frames, 0, dur)]);
  }
  c.text(type, 'ep', 3.35, 3.0, { font: 'mono', weight: 600, size: 26, color: C.mustard, text: 'EP. 42  ·  48 MIN', x: 64, y: FLOOR + 50, w: 600 }, [A.wipe(0, 0.4), A.fadeOut(0.25)]);
  words(c, type, 'ep-t', 'The sound of night buses', { font: 'display', weight: 800, size: 66, color: C.cream, x: 62, y: FLOOR + 92, end: 6.35 }, 3.5, 0.08,
    () => [A.tw('y', 50, 0, 0, 0.5, EASE.back), A.fadeIn(0, 0.2), A.fadeOut(0.25)]);
  c.text(type, 'hosts', 3.9, 2.45, { font: 'body', weight: 500, size: 32, color: C.cream, text: 'with Mara Ilić and Teo Banks', x: 64, y: FLOOR + 186, w: 700, opacity: 0.8 }, [A.fadeIn(0, 0.4), A.fadeOut(0.25)]);

  // Scene 3: the weekly date, chunky, over the floor.
  words(c, type, 'new', 'New every Friday', { font: 'display', weight: 800, size: 92, color: C.cream, x: W / 2, y: FLOOR + 40, align: 'center', end: 8.55 }, 6.45, 0.1,
    () => [A.tw('y', 80, 0, 0, 0.5, EASE.back), A.fadeIn(0, 0.15), A.fadeOut(0.3)]);
  c.text(type, 'where', 6.85, 1.7, { font: 'mono', weight: 600, size: 26, color: C.mustard, text: 'WHEREVER YOU GET PODCASTS', align: 'center', x: 0, y: FLOOR + 170, w: W }, [A.wipe(0, 0.5), A.fadeOut(0.3)]);

  return {
    id: 'gallery-signal-1x1',
    comp: c.build(),
    meta: { format: 'instagram-post-1x1', posterTime: 4.6, label: 'Late Signal, a night-time podcast\'s new episode: seventies stripes, a record that slides out of its sleeve and spins under a swinging tonearm, an equalizer rising from the floor on the beat, then the weekly date, in a 1:1 Instagram post.' },
    assets: { 'stripes.svg': stripes(), 'record.svg': record(), 'shine.svg': shine(), 'sleeve.svg': sleeve(), 'arm.svg': arm() },
  };
}

function stripes() {
  const cols = [C.mustard, C.orange, C.rust];
  const bands = cols.map((col, i) => {
    const r = 760 - i * 70;
    return `<circle cx="1080" cy="1080" r="${r}" fill="none" stroke="${col}" stroke-width="54"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1080">${bands}</svg>`;
}

function record() {
  const grooves = Array.from({ length: 16 }, (_, i) => `<circle cx="280" cy="280" r="${f1(110 + i * 10.5)}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 560"><circle cx="280" cy="280" r="278" fill="${C.vinyl}"/><g fill="none" stroke="#2C2420" stroke-width="2">${grooves}</g><circle cx="280" cy="280" r="96" fill="${C.orange}"/><circle cx="280" cy="280" r="96" fill="none" stroke="${C.mustard}" stroke-width="10" stroke-dasharray="40 14"/><path d="M220 260h60M220 284h96M220 308h44" stroke="${C.cream}" stroke-width="9" stroke-linecap="round"/><circle cx="280" cy="280" r="10" fill="${C.cream}"/></svg>`;
}

function shine() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 560"><g fill="#FFFFFF" opacity=".09"><path d="M280 280L120 40A278 278 0 0 1 220 6Z"/><path d="M280 280L440 520A278 278 0 0 1 340 554Z"/></g></svg>`;
}

function sleeve() {
  const arcs = [C.mustard, C.orange, C.rust, C.cream].map((col, i) => `<circle cx="240" cy="330" r="${150 - i * 34}" fill="${col}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 480"><rect width="480" height="480" rx="6" fill="${C.brown}"/><clipPath id="k"><rect width="480" height="480" rx="6"/></clipPath><g clip-path="url(#k)">${arcs}<rect y="330" width="480" height="150" fill="${C.brown}"/><g fill="${C.mustard}"><rect x="40" y="370" width="400" height="12"/><rect x="40" y="398" width="400" height="12" fill="${C.orange}"/><rect x="40" y="426" width="400" height="12" fill="${C.rust}"/></g></g><rect x="40" y="40" width="120" height="16" rx="8" fill="${C.cream}" opacity=".8"/></svg>`;
}

function arm() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><circle cx="200" cy="200" r="34" fill="${C.brown}"/><circle cx="200" cy="200" r="14" fill="${C.mustard}"/><path d="M200 200L120 290L64 330" fill="none" stroke="${C.brown}" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/><rect x="34" y="316" width="48" height="30" rx="5" transform="rotate(-36 58 331)" fill="${C.brown}"/><path d="M230 170l30-30" stroke="${C.brown}" stroke-width="20" stroke-linecap="round"/></svg>`;
}
