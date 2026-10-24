// KOVA Air: a premium earbuds launch. Dark, cyan light, kinetic type, a spec counter, an end card.
import { makeComp, A, EASE, writeComposition, tw } from './lib.mjs';
import * as S from './kova-assets.mjs';

const C = { bg: '#06070B', text: '#EEF2F7', cyan: '#7CF5FF', muted: '#8A93A6', line: '#232A36' };
const D = 12;
const SC = [
  { id: 'noise', name: 'The world is loud', start: 0, duration: 2.4 },
  { id: 'reveal', name: 'Product reveal', start: 2.4, duration: 3 },
  { id: 'specs', name: 'Specs', start: 5.4, duration: 3.4 },
  { id: 'endcard', name: 'End card', start: 8.8, duration: 3.2 },
];

// Per-format layout.
const LAYOUT = {
  '9x16': {
    w: 1080, h: 1920, format: 'instagram-reel-9x16',
    label: { x: 90, y: 250 },
    noise: { x: 40, y: 940, w: 1000, h: 260 },
    loud: { x: 90, y: 470, size: 150, lines: true },
    glow: { x: -260, y: 250, w: 1600, h: 1600 },
    buds: { x: 40, y: 480, w: 1000, h: 800 },
    budsSpecs: { x: 0, y: -300, scale: 0.8 },
    head: { y: 1290, size: 136, stacked: true },
    specs: { x: 90, y: 890, gap: 200, num: 132, w: 900 },
    case: { x: 190, y: 330, w: 700, h: 537 },
    word: { y: 960, size: 200, align: 'center' },
    tag: { y: 1215, size: 46 },
    cta: { y: 1340, w: 520, h: 100 },
  },
  '1x1': {
    w: 1080, h: 1080, format: 'instagram-post-1x1',
    label: { x: 80, y: 80 },
    noise: { x: 40, y: 620, w: 1000, h: 220 },
    loud: { x: 80, y: 250, size: 130, lines: true },
    glow: { x: -460, y: -560, w: 2000, h: 2000 },
    buds: { x: 140, y: 70, w: 800, h: 640 },
    budsSpecs: { x: -250, y: 20, scale: 0.72 },
    head: { y: 790, size: 104, stacked: false },
    specs: { x: 540, y: 200, gap: 230, num: 112, w: 480 },
    case: { x: 290, y: 90, w: 500, h: 383 },
    word: { y: 520, size: 150, align: 'center' },
    tag: { y: 720, size: 38 },
    cta: { y: 820, w: 460, h: 88 },
  },
  '16x9': {
    w: 1920, h: 1080, format: 'youtube-16x9',
    label: { x: 110, y: 90 },
    noise: { x: 160, y: 590, w: 1600, h: 300 },
    loud: { x: 110, y: 250, size: 150, lines: false },
    glow: { x: -40, y: -500, w: 2000, h: 2000 },
    buds: { x: 560, y: 90, w: 800, h: 640 },
    budsSpecs: { x: -440, y: 40, scale: 0.9 },
    head: { y: 770, size: 128, stacked: false },
    specs: { x: 1020, y: 190, gap: 250, num: 130, w: 800 },
    case: { x: 170, y: 270, w: 700, h: 537 },
    word: { y: 300, size: 210, align: 'left', x: 960 },
    tag: { y: 580, size: 48, x: 960 },
    cta: { y: 700, w: 520, h: 100, x: 960 },
  },
};

export function kova(key) {
  const L = LAYOUT[key];
  const { w, h } = L;
  const c = makeComp({ width: w, height: h, duration: D, background: C.bg, scenes: SC });
  const bg = c.track('backdrop');
  const art = c.track('product');
  const type = c.track('type', 'text');
  const fx = c.track('light');

  // Backdrop: a slow dot grid, the glow (from the reveal on, breathing).
  const side = Math.max(w, h) * 1.1;
  c.svg(bg, 'grid', 0, D, 'grid.svg', { x: (w - side) / 2, y: (h - side) / 2, w: side, h: side, opacity: 0.35, fit: 'cover', kenBurns: { from: { scale: 1 }, to: { scale: 1.12 } } }, [A.fadeIn(0, 1.2)]);
  c.svg(bg, 'glow', 2.3, D - 2.3, 'glow.svg', { x: L.glow.x, y: L.glow.y, w: L.glow.w, h: L.glow.h }, [
    A.fadeIn(0, 1.2, EASE.sine), A.tw('scale', 0.4, 1, 0, 1.6, EASE.expo),
    A.kf('scale', [[0, 1], [0.25, 1.08, EASE.sine], [0.5, 0.96, EASE.sine], [0.75, 1.06, EASE.sine], [1, 1, EASE.sine]], 1.6, D - 2.3 - 1.6),
  ]);

  // Scene 1: the world is loud.
  c.text(type, 'lab', 0.2, 2.1, { font: 'mono', weight: 500, size: key === '16x9' ? 26 : 28, color: C.muted, text: 'KOVA LABS  /  001', x: L.label.x, y: L.label.y, w: 700 }, [A.fadeIn(0, 0.5), A.tw('x', -24, 0, 0, 0.8), A.fadeOut(0.3)]);
  const N = L.noise;
  c.svg(art, 'noise', 0.15, 2.0, 'noise.svg', { x: N.x, y: N.y, w: N.w, h: N.h, fit: 'fill' }, [
    A.wipe(0, 0.9, EASE.quint),
    A.kf('scale', [[0, 1], [0.12, 1.05, 'steps(1, end)'], [0.24, 0.97, 'steps(1, end)'], [0.36, 1.04, 'steps(1, end)'], [0.48, 0.98, 'steps(1, end)'], [0.6, 1.03, 'steps(1, end)'], [0.72, 0.99, 'steps(1, end)'], [1, 1]], 0, 1.4),
    A.tw('opacity', 1, 0, 1.7, 0.3, EASE.lin),
  ]);
  // The eraser: a background-coloured band wipes over the noise, a cyan line draws with it.
  c.shape(art, 'erase', 1.35, 1.05, { x: N.x - 10, y: N.y - 10, w: N.w + 20, h: N.h + 20, fill: C.bg }, [A.wipe(0, 0.7, EASE.inOut)]);
  c.shape(fx, 'flat', 1.35, 1.05, { x: N.x, y: N.y + N.h / 2 - 2, w: N.w, h: 4, fill: C.cyan, radius: 2 }, [A.wipe(0, 0.7, EASE.inOut), A.kf('opacity', [[0, 1], [0.7, 1], [1, 0]], 0, 1.05)]);
  const lo = L.loud;
  if (lo.lines) {
    c.text(type, 'loud', 0.35, 2.05, { size: lo.size, color: C.text, text: 'The world', x: lo.x, y: lo.y, w: w - lo.x * 2 }, [A.fadeIn(0, 0.4), A.tw('y', 50, 0, 0, 0.8), A.tw('blur', 18, 0, 0, 0.6), A.tw('blur', 0, 20, 1.65, 0.4, EASE.in), A.fadeOut(0.4)]);
    c.text(type, 'loud', 0.55, 1.85, { size: lo.size, color: C.text, text: 'is loud.', x: lo.x, y: lo.y + lo.size * 1.05, w: w - lo.x * 2 }, [A.fadeIn(0, 0.4), A.tw('y', 50, 0, 0, 0.8), A.tw('blur', 18, 0, 0, 0.6), A.tw('color', C.text, C.muted, 0.85, 0.5, EASE.sine), A.tw('blur', 0, 20, 1.45, 0.4, EASE.in), A.fadeOut(0.4)]);
  } else {
    c.text(type, 'loud', 0.35, 2.05, { size: lo.size, color: C.text, text: 'The world is loud.', x: lo.x, y: lo.y, w: w - lo.x * 2 }, [A.fadeIn(0, 0.4), A.tw('y', 50, 0, 0, 0.8), A.tw('blur', 18, 0, 0, 0.6), A.tw('color', C.text, C.muted, 1.2, 0.5, EASE.sine), A.tw('blur', 0, 20, 1.65, 0.4, EASE.in), A.fadeOut(0.4)]);
  }

  // Scene 2: rings from the flat line, the buds rise.
  const B = L.buds;
  const ringSize = Math.min(w, h) * 0.9;
  for (const [i, s] of [2.3, 2.75, 3.2, 9.0, 9.45].entries()) {
    const cx = s > 8 ? L.case.x + L.case.w / 2 : B.x + B.w / 2; const cy = s > 8 ? L.case.y + L.case.h / 2 : B.y + B.h / 2;
    c.svg(fx, 'ring', s, 1.8, 'ring.svg', { x: cx - ringSize / 2, y: cy - ringSize / 2, w: ringSize, h: ringSize }, [
      A.tw('scale', 0.15, i % 2 ? 1.5 : 1.25, 0, 1.8, EASE.quint), A.kf('opacity', [[0, 0], [0.1, 0.9], [1, 0, EASE.sine]], 0, 1.8),
    ]);
  }
  const bs = L.budsSpecs;
  c.svg(art, 'buds', 2.5, 6.15, 'buds.svg', { x: B.x, y: B.y, w: B.w, h: B.h }, [
    A.fadeIn(0, 0.5), A.tw('y', 160, 0, 0, 1.3), A.tw('blur', 28, 0, 0, 0.9), A.tw('rotation', -10, 0, 0, 1.5), A.tw('scale', 0.82, 1, 0, 1.4),
    A.kf('y', [[0, 0], [0.5, -14, EASE.sine], [1, 0, EASE.sine]], 1.3, 1.6),
    A.tw('x', 0, bs.x, 2.9, 0.9, EASE.inOut), A.tw('y', 0, bs.y, 2.9, 0.9, EASE.inOut), A.tw('scale', 1, bs.scale, 2.9, 0.9, EASE.inOut),
    A.tw('rotation', 0, 4, 3.8, 2.2, EASE.sine),
    A.tw('blur', 0, 16, 5.75, 0.4, EASE.in), A.fadeOut(0.4),
  ]);

  // Headline: "Silence," heavy, "engineered." light.
  const H = L.head;
  const out = (len) => [A.tw('blur', 0, 16, len - 0.4, 0.4, EASE.in), A.fadeOut(0.4)];
  if (H.stacked) {
    c.text(type, 'silence', 3.3, 2.1, { size: H.size, color: C.text, text: 'Silence,', align: 'center', x: 0, y: H.y, w }, [A.fadeIn(0, 0.3), A.tw('scale', 1.25, 1, 0, 0.9), A.tw('blur', 22, 0, 0, 0.6), ...out(2.1)]);
    c.text(type, 'engineered', 3.65, 1.75, { size: H.size, weight: 300, color: C.cyan, text: 'engineered.', align: 'center', x: 0, y: H.y + H.size * 1.1, w }, [A.wipe(0, 0.9), A.tw('x', -40, 0, 0, 1), ...out(1.75)]);
  } else {
    const a = tw('Silence,', H.size); const b = tw('engineered.', H.size, 'display', 300); const gap = H.size * 0.26;
    const x0 = (w - a - gap - b) / 2;
    c.text(type, 'silence', 3.3, 2.1, { size: H.size, color: C.text, text: 'Silence,', x: x0, y: H.y, w: a + 4 }, [A.fadeIn(0, 0.3), A.tw('scale', 1.25, 1, 0, 0.9), A.tw('blur', 22, 0, 0, 0.6), ...out(2.1)]);
    c.text(type, 'engineered', 3.65, 1.75, { size: H.size, weight: 300, color: C.cyan, text: 'engineered.', x: x0 + a + gap, y: H.y, w: b + 4 }, [A.wipe(0, 0.9), A.tw('x', -40, 0, 0, 1), ...out(1.75)]);
  }

  // Scene 3: three specs, counted up.
  const P = L.specs;
  const rows = [
    { vals: [0, 6, 13, 21, 28, 34, 39, 43, 46, 47, 48], unit: 'dB', label: 'ADAPTIVE NOISE CANCELLING' },
    { vals: [0, 4, 9, 15, 21, 26, 30, 33, 35, 36], unit: 'h', label: 'BATTERY WITH THE CASE' },
    { vals: ['0.0', '1.1', '2.2', '3.1', '3.8', '4.3', '4.6', '4.8', '4.9'], unit: 'g', label: 'PER EARBUD' },
  ];
  rows.forEach((row, i) => {
    const s = 5.75 + i * 0.42;
    const end = 8.8;
    const y = P.y + i * P.gap;
    const fin = String(row.vals.at(-1));
    const numW = tw(fin, P.num);
    c.shape(fx, 'rule', s, end - s, { x: P.x, y, w: P.w, h: 2, fill: C.line }, [A.wipe(0, 0.8), A.fadeOut(0.35)]);
    c.shape(fx, 'tick', s + 0.15, end - s - 0.15, { x: P.x, y: y - 1, w: 48, h: 4, fill: C.cyan, radius: 2 }, [A.wipe(0, 0.5), A.fadeOut(0.35)]);
    c.counter(type, 'num', s + 0.1, end, row.vals, 0.055, { size: P.num, color: C.text, x: P.x - P.num * 0.04, y: y + P.num * 0.1, w: P.num * 3 }, [A.tw('color', C.text, C.cyan, 0, 0.6, EASE.sine), A.tw('blur', 0, 12, end - s - 0.1 - (row.vals.length - 1) * 0.055 - 0.35, 0.35, EASE.in), A.fadeOut(0.35)]);
    c.text(type, 'unit', s + 0.55, end - s - 0.55, { size: P.num * 0.5, weight: 300, color: C.muted, text: row.unit, x: P.x + numW + P.num * 0.12, y: y + P.num * 0.1 + P.num * 0.52, w: P.num * 2 }, [A.fadeIn(0, 0.4), A.tw('x', -16, 0, 0, 0.6), A.fadeOut(0.35)]);
    c.text(type, 'spec', s + 0.3, end - s - 0.3, { font: 'mono', weight: 500, size: Math.round(P.num * 0.22), color: C.muted, text: row.label, x: P.x, y: y + P.num * 1.42, w: P.w }, [A.wipe(0, 0.7), A.fadeOut(0.35)]);
  });

  // Scene 4: the end card.
  const K = L.case;
  c.svg(art, 'case', 8.9, D - 8.9, 'case.svg', { x: K.x, y: K.y, w: K.w, h: K.h }, [A.fadeIn(0, 0.5), A.tw('y', 120, 0, 0, 1.2), A.tw('blur', 24, 0, 0, 0.8), A.tw('scale', 0.86, 1, 0, 1.3), A.kf('y', [[0, 0], [0.5, -10, EASE.sine], [1, 0, EASE.sine]], 1.2, 1.9)]);
  const Wd = L.word;
  const wx = Wd.x ?? 0; const ww = Wd.x ? w - Wd.x : w;
  const kw = tw('KOVA', Wd.size); const aw = tw('Air', Wd.size, 'display', 300); const kg = Wd.size * 0.22;
  const kx = Wd.align === 'center' ? (w - kw - kg - aw) / 2 : wx;
  c.text(type, 'kova', 9.25, D - 9.25, { size: Wd.size, color: C.text, text: 'KOVA', x: kx, y: Wd.y, w: kw + 4 }, [A.wipe(0, 0.8), A.tw('blur', 14, 0, 0, 0.6)]);
  c.text(type, 'air', 9.55, D - 9.55, { size: Wd.size, weight: 300, color: C.cyan, text: 'Air', x: kx + kw + kg, y: Wd.y, w: aw + 4 }, [A.wipe(0, 0.7), A.tw('x', -30, 0, 0, 0.8)]);
  const T = L.tag;
  c.text(type, 'tag', 9.8, D - 9.8, { font: 'body', weight: 400, size: T.size, color: C.muted, text: 'Hear only what matters.', align: T.x ? 'left' : 'center', x: T.x ?? 0, y: T.y, w: T.x ? w - T.x : w }, [A.fadeIn(0, 0.5), A.tw('y', 24, 0, 0, 0.8)]);
  const Q = L.cta;
  const qx = Q.x ?? (w - Q.w) / 2;
  c.shape(type, 'cta', 10.1, D - 10.1, { x: qx, y: Q.y, w: Q.w, h: Q.h, fill: C.cyan, radius: Q.h / 2 }, [A.pop(0, 0.6), A.kf('scale', [[0, 1], [0.5, 1.04, EASE.sine], [1, 1, EASE.sine]], 0.8, 1)]);
  c.text(type, 'cta-label', 10.25, D - 10.25, { font: 'body', weight: 600, size: Q.h * 0.36, color: C.bg, text: 'Pre-order  ·  €199', align: 'center', x: qx, y: Q.y + Q.h * 0.28, w: Q.w }, [A.fadeIn(0, 0.4)]);
  c.text(type, 'ship', 10.5, D - 10.5, { font: 'mono', weight: 500, size: Math.round(Q.h * 0.24), color: C.muted, text: 'SHIPS 14.11', align: Q.x ? 'left' : 'center', x: Q.x ? qx + Q.w + 36 : 0, y: Q.x ? Q.y + Q.h * 0.36 : Q.y + Q.h + 34, w: Q.x ? 400 : w }, [A.fadeIn(0, 0.5)]);

  return { comp: c.build(), format: L.format };
}

const LABELS = {
  '9x16': 'KOVA Air, an earbuds launch: noise erased into a line, the earbuds rising in cyan light, counted specs and a pre-order end card, in a 9:16 Instagram Reel.',
  '1x1': 'The KOVA Air earbuds launch recomposed for a 1:1 Instagram post.',
  '16x9': 'The KOVA Air earbuds launch recomposed for a 16:9 YouTube video.',
};

export function writeKova(out, keys = ['9x16', '1x1', '16x9']) {
  for (const key of keys) {
    const { comp, format } = kova(key);
    writeComposition(out, `kova-${key}`, comp, { format, posterTime: 4.4, label: LABELS[key] }, {
      'buds.svg': S.buds, 'case.svg': S.kase, 'glow.svg': S.glow, 'ring.svg': S.ring, 'noise.svg': S.noise(), 'grid.svg': S.grid,
    });
  }
}
