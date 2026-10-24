// Greenroots: a tree-planting charity's spring appeal, 9:16. Illustrated and warm: a seed drops into a hill, a sprout and
// then a forest grow out of it (each trunk rises from behind the hill, which masks it, and its crown pops open), the count
// of trees planted climbs to 10,000 with a handwritten note, then the ask, and the forest sinks back for the loop.
import { makeComp, A, EASE } from '../hero-gen/lib.mjs';
import { seeded, f1, words } from './kit.mjs';

const C = { sand: '#F7E8D0', sun: '#F29E4C', leaf: '#3F8F4E', leaf2: '#7BB661', deep: '#1F5136', soil: '#7A4A2A', soil2: '#5C3720', cream: '#FFF8EC', ink: '#2B2A20', blush: '#F4C9A0' };
const W = 1080; const H = 1920; const D = 10;
const SC = [
  { id: 'seed', name: 'One seed', start: 0, duration: 3 },
  { id: 'forest', name: 'A forest', start: 3, duration: 3.6 },
  { id: 'ask', name: 'The ask', start: 6.6, duration: 3.4 },
];
const HY = 1300; // the hill's top edge in the frame (its middle is 160 px higher)
const hillY = (x) => { const t = x / W; return HY + (1 - t) ** 2 * 140 + 2 * t * (1 - t) * -20 + t * t * 140; };
const TREES = [[120, 0.8, 0], [250, 1.05, 1], [390, 0.9, 2], [540, 1.25, 0], [690, 0.95, 1], [830, 1.1, 2], [960, 0.85, 0]];

export function greenroots() {
  const c = makeComp({ width: W, height: H, duration: D, background: C.sand, scenes: SC });
  const sky = c.track('sky');
  const trees = c.track('trees');
  const hill = c.track('hill');
  const type = c.track('type', 'text');

  // The sun and the hill hold the whole film: the loop starts and ends on them.
  c.svg(sky, 'sun', 0, D, 'sun.svg', { x: 720, y: 110, w: 290, h: 290 }, [A.tw('rotation', 0, 60, 0, D, EASE.lin), A.kf('scale', [[0, 0.92], [0.5, 1.04, EASE.sine], [1, 0.92, EASE.sine]], 0, D)]);
  c.svg(sky, 'clouds', 0, D, 'clouds.svg', { x: -200, y: 560, w: 1500, h: 260 }, [A.tw('x', 0, 180, 0, D, EASE.lin)]);
  c.svg(hill, 'hill', 0, D, 'hill.svg', { x: 0, y: HY - 40, w: W, h: H - HY + 40, fit: 'fill' }, []);

  // Scene 1: one seed drops, the soil puffs, a sprout comes up with two leaves.
  const SX = 540; const SY = hillY(SX) - 10;
  c.svg(type, 'seed', 0.3, 1.0, 'seed.svg', { x: SX - 26, y: SY - 40, w: 52, h: 64 }, [A.kf('y', [[0, -SY], [0.5, 0, EASE.in], [0.62, -24, 'cubic-bezier(.2,.7,.4,1)'], [0.74, 0, EASE.in], [1, 30]], 0, 1.0), A.tw('rotation', -200, 0, 0, 0.6, EASE.quint)]);
  c.svg(hill, 'puff', 0.82, 0.6, 'puff.svg', { x: SX - 90, y: SY - 50, w: 180, h: 80 }, [A.tw('scale', 0.3, 1.2, 0, 0.5, EASE.expo), A.fadeOut(0.35)]);
  c.shape(trees, 'stem', 1.25, 1.95, { x: SX - 9, y: SY - 250, w: 18, h: 310, fill: C.leaf, radius: 9 }, [A.tw('y', 310, 0, 0, 0.7, EASE.expo), A.tw('y', 0, 340, 1.6, 0.35, EASE.in)]);
  c.svg(trees, 'leaf-l', 1.7, 1.5, 'leaf.svg', { x: SX - 160, y: SY - 330, w: 154, h: 112, rotation: -18 }, [A.tw('scale', 0, 1, 0, 0.45, EASE.back), A.tw('rotation', 20, 0, 0, 0.6, EASE.backSoft), A.tw('scale', 1, 0, 1.15, 0.3, EASE.in)]);
  c.svg(trees, 'leaf-r', 1.82, 1.38, 'leaf.svg', { x: SX + 4, y: SY - 288, w: 154, h: 112, rotation: 198 }, [A.tw('scale', 0, 1, 0, 0.45, EASE.back), A.tw('rotation', -20, 0, 0, 0.6, EASE.backSoft), A.tw('scale', 1, 0, 1.03, 0.3, EASE.in)]);
  words(c, type, 'one', 'It starts with one.', { font: 'hand', weight: 700, size: 104, color: C.ink, x: W / 2, y: 720, align: 'center', end: 2.95 }, 0.6, 0.12,
    () => [A.wipe(0, 0.35, EASE.quint), A.tw('y', 20, 0, 0, 0.5, EASE.expo), A.fadeOut(0.3)]);

  // Scene 2: the forest. Each trunk rises from behind the hill, its crown pops open, back to front.
  const rand = seeded(31);
  TREES.forEach(([x, k, tone], i) => {
    const s = 2.95 + Math.abs(i - 3) * 0.14 + rand() * 0.08;
    const base = hillY(x) + 30; const th = 230 * k; const tw2 = 24 * k;
    const sink = [A.tw('y', 0, th + 40, 9.35 - s, 0.5, EASE.in)];
    c.shape(trees, 'trunk', s, D - s, { x: x - tw2 / 2, y: base - th, w: tw2, h: th + 20, fill: C.soil2, radius: tw2 / 2 }, [A.tw('y', th + 40, 0, 0, 0.6, EASE.expo), ...sink]);
    const cs = 210 * k;
    c.svg(trees, 'crown', s + 0.3, D - s - 0.3, `crown-${tone}.svg`, { x: x - cs / 2, y: base - th - cs * 0.62, w: cs, h: cs }, [
      A.tw('scale', 0, 1, 0, 0.55, EASE.back), A.tw('rotation', i % 2 ? 14 : -14, 0, 0, 0.7, EASE.backSoft),
      A.kf('rotation', [[0, 0], [0.5, i % 2 ? 2.5 : -2.5, EASE.sine], [1, 0, EASE.sine]], 0.7, 2.4), A.tw('scale', 1, 0, 9.0 - s - 0.3, 0.35, EASE.in), A.fadeOut(0.2),
    ]);
  });
  c.svg(hill, 'grass', 3.2, D - 3.2, 'grass.svg', { x: 0, y: HY + 60, w: W, h: 120, fit: 'fill' }, [A.wipe(0, 0.8, EASE.inOut), A.fadeOutAt(D - 3.2 - 0.6, 0.5)]);
  // The count, with a handwritten note and an underline drawn under it.
  const vals = [0, 400, 1200, 2600, 4300, 6100, 7800, 9100, 10000];
  c.counter(type, 'count', 3.4, 6.5, vals.map((v) => v.toLocaleString('en-US')), 0.16, { font: 'display', weight: 800, size: 200, color: C.deep, align: 'center', x: 0, y: 420, w: W }, [A.tw('scale', 1.1, 1, 0, 0.3, EASE.back), A.fadeOut(0.3)]);
  c.text(type, 'count-l', 3.6, 2.9, { font: 'hand', weight: 700, size: 76, color: C.ink, text: 'trees planted this spring', align: 'center', x: 0, y: 680, w: W, rotation: -3 }, [A.wipe(0, 0.6, EASE.quint), A.fadeOut(0.3)]);
  c.svg(type, 'under', 4.3, 2.2, 'underline.svg', { x: 220, y: 778, w: 640, h: 44, fit: 'fill', rotation: -3 }, [A.wipe(0, 0.5, EASE.inOut), A.fadeOut(0.3)]);

  // Scene 3: the ask, a button and the name; then the forest sinks back.
  c.text(type, 'k', 6.7, 2.9, { font: 'mono', weight: 600, size: 28, color: C.leaf, text: 'GREENROOTS  ·  SPRING APPEAL', align: 'center', x: 0, y: 440, w: W }, [A.wipe(0, 0.5), A.fadeOut(0.3)]);
  words(c, type, 'ask', 'Plant one for €2', { font: 'display', weight: 800, size: 124, color: C.deep, x: W / 2, y: 492, align: 'center', end: 9.6 }, 6.8, 0.1,
    () => [A.tw('y', 70, 0, 0, 0.55, EASE.back), A.fadeIn(0, 0.15), A.fadeOut(0.3)]);
  const bw = 400; const bh = 112;
  c.shape(type, 'btn', 7.3, 2.3, { x: (W - bw) / 2, y: 700, w: bw, h: bh, fill: C.leaf, radius: bh / 2 }, [A.pop(0, 0.45), A.fadeOut(0.3)]);
  c.text(type, 'btn-t', 7.4, 2.2, { font: 'body', weight: 700, size: 42, color: C.cream, text: 'Donate  →', align: 'center', x: (W - bw) / 2, y: 700 + bh * 0.23, w: bw }, [A.fadeIn(0, 0.3), A.fadeOut(0.3)]);
  c.text(type, 'note', 7.75, 1.85, { font: 'hand', weight: 700, size: 70, color: C.sun, text: 'every tree counts', align: 'center', x: 240, y: 836, w: 600, rotation: 4 }, [A.wipe(0, 0.5, EASE.quint), A.fadeOut(0.3)]);

  return {
    id: 'gallery-greenroots-9x16',
    comp: c.build(),
    meta: { format: 'instagram-reel-9x16', posterTime: 5.8, label: 'Greenroots, a tree-planting charity\'s spring appeal: a seed drops into a hill and sprouts, a forest grows out of it tree by tree while the count climbs to 10,000 with a handwritten note, then the ask, in a 9:16 Instagram Reel.' },
    assets: {
      'sun.svg': sunSvg(), 'clouds.svg': clouds(), 'hill.svg': hillSvg(), 'seed.svg': seed(), 'puff.svg': puff(), 'leaf.svg': leaf(), 'grass.svg': grass(),
      'crown-0.svg': crown(C.leaf, C.deep, 3), 'crown-1.svg': crown(C.leaf2, C.leaf, 7), 'crown-2.svg': crown('#5FA458', C.deep, 11),
      'underline.svg': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 44" preserveAspectRatio="none"><path d="M8 30C150 10 330 6 632 22M60 38C240 26 420 26 600 34" fill="none" stroke="${C.sun}" stroke-width="8" stroke-linecap="round"/></svg>`,
    },
  };
}

function sunSvg() {
  const rays = Array.from({ length: 16 }, (_, i) => {
    const a = (i / 16) * Math.PI * 2; const r0 = 120; const r1 = i % 2 ? 165 : 178;
    return `<path d="M${f1(180 + r0 * Math.cos(a))} ${f1(180 + r0 * Math.sin(a))}L${f1(180 + r1 * Math.cos(a))} ${f1(180 + r1 * Math.sin(a))}"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 360"><g stroke="${C.sun}" stroke-width="14" stroke-linecap="round">${rays}</g><circle cx="180" cy="180" r="100" fill="${C.sun}"/><path d="M130 150a60 60 0 0 1 60-50" fill="none" stroke="#F8C38A" stroke-width="12" stroke-linecap="round"/></svg>`;
}

function clouds() {
  const cloud = (x, y, s) => `<g transform="translate(${x} ${y}) scale(${s})"><path d="M0 80h260c10-40-20-70-60-60-10-40-70-50-90-10-30-20-80 0-70 40-30 0-40 30 0 30z"/></g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1500 260"><g fill="#FFF6E6">${cloud(80, 60, 1)}${cloud(760, 120, 0.8)}${cloud(1180, 30, 0.6)}</g></svg>`;
}

function hillSvg() {
  const h = H - HY + 40;
  const rand = seeded(12);
  const pebbles = Array.from({ length: 40 }, () => `<ellipse cx="${f1(rand() * W)}" cy="${f1(240 + rand() * (h - 260))}" rx="${f1(6 + rand() * 12)}" ry="${f1(4 + rand() * 7)}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${h}" preserveAspectRatio="none"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.soil}"/><stop offset="1" stop-color="${C.soil2}"/></linearGradient></defs><path d="M0 180Q540 20 1080 180V${h}H0Z" fill="url(#s)"/><path d="M0 180Q540 20 1080 180V220Q540 70 0 220Z" fill="${C.leaf2}"/><g fill="#8F5C38">${pebbles}</g></svg>`;
}

function seed() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 52 64"><path d="M26 4C42 14 48 34 40 50S12 62 8 46 10 12 26 4z" fill="${C.soil}"/><path d="M24 14C30 24 30 38 24 50" stroke="#A8724A" stroke-width="4" fill="none" stroke-linecap="round"/></svg>`;
}

function puff() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 80"><g fill="${C.soil}" opacity=".7"><circle cx="30" cy="50" r="18"/><circle cx="64" cy="36" r="22"/><circle cx="112" cy="38" r="20"/><circle cx="148" cy="54" r="16"/></g></svg>`;
}

function leaf() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 110 80"><path d="M106 70C80 74 20 64 4 24 40 6 96 18 106 70z" fill="${C.leaf2}"/><path d="M106 70C76 50 40 34 12 26" stroke="${C.leaf}" stroke-width="5" fill="none" stroke-linecap="round"/></svg>`;
}

function grass() {
  const rand = seeded(4);
  let d = '';
  for (let x = 6; x < W; x += 22 + rand() * 18) {
    const hgt = 30 + rand() * 50;
    d += `M${f1(x)} 120q${f1(4 + rand() * 6)} ${f1(-hgt / 2)} ${f1(rand() * 14 - 4)} ${f1(-hgt)}`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 120" preserveAspectRatio="none"><path d="${d}" fill="none" stroke="${C.leaf}" stroke-width="6" stroke-linecap="round"/></svg>`;
}

function crown(light, dark, seed2) {
  const rand = seeded(seed2);
  const blobs = [[115, 80, 70], [70, 120, 58], [160, 122, 56], [115, 140, 64]].map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}"/>`).join('');
  const dots = Array.from({ length: 9 }, () => `<circle cx="${f1(60 + rand() * 110)}" cy="${f1(60 + rand() * 110)}" r="${f1(5 + rand() * 6)}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 230 230"><g fill="${dark}">${blobs}</g><g fill="${light}" transform="translate(-8 -10)">${blobs}</g><g fill="${dark}" opacity=".35">${dots}</g></svg>`;
}
