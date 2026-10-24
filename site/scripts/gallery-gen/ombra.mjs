// Casa Ombra: a modern house for sale, 16:9. Blueprint style: the house's south elevation draws itself line by line on a
// drafting grid with its dimensions, its windows light up for dusk, then the listing counts its rooms, surface and price.
import { makeComp, A, EASE } from '../hero-gen/lib.mjs';
import { line } from './kit.mjs';

const C = { blue: '#14366B', grid: '#21498A', ink: '#EAF2FF', dim: '#8FB0E0', warm: '#FFC857', deep: '#0E2A55' };
const W = 1920; const H = 1080; const D = 10;
const SC = [
  { id: 'draw', name: 'The elevation draws itself', start: 0, duration: 3.6 },
  { id: 'dusk', name: 'Dusk and the listing', start: 3.6, duration: 3.4 },
  { id: 'price', name: 'Price and viewing', start: 7, duration: 3 },
];
const GROUND = 840;
/** The elevation, in drawing order: [from, to, weight]. */
const LINES = [
  [[90, GROUND], [1250, GROUND], 5],
  // lower volume
  [[260, GROUND], [260, 600], 4], [[260, 600], [900, 600], 4], [[900, 600], [900, GROUND], 4],
  // upper volume, cantilevered over the terrace
  [[420, 600], [420, 400], 4], [[400, 400], [1150, 400], 6], [[1130, 400], [1130, 600], 4], [[900, 600], [1130, 600], 4], [[1040, 600], [1040, GROUND], 3],
  [[400, 384], [1150, 384], 2],
  // ground-floor glazing and door
  [[300, 640], [620, 640], 3], [[300, 640], [300, GROUND], 3], [[620, 640], [620, GROUND], 3], [[380, 640], [380, GROUND], 2], [[460, 640], [460, GROUND], 2], [[540, 640], [540, GROUND], 2],
  [[700, 680], [790, 680], 3], [[700, 680], [700, GROUND], 3], [[790, 680], [790, GROUND], 3],
  // ribbon window upstairs
  [[480, 450], [1080, 450], 3], [[480, 450], [480, 560], 3], [[1080, 450], [1080, 560], 3], [[480, 560], [1080, 560], 3],
  [[600, 450], [600, 560], 2], [[720, 450], [720, 560], 2], [[840, 450], [840, 560], 2], [[960, 450], [960, 560], 2],
  // terrace rail and pool
  [[900, 760], [1040, 760], 2], [[1080, GROUND + 4], [1080, GROUND + 40], 3], [[1080, GROUND + 40], [1250, GROUND + 40], 3],
];
const GLASS = [[300, 640, 320, 200], [700, 680, 90, 160], [480, 450, 600, 110]];

export function ombra() {
  const c = makeComp({ width: W, height: H, duration: D, background: C.blue, scenes: SC });
  const paper = c.track('grid');
  const glow = c.track('glow');
  const draw = c.track('lines');
  const type = c.track('type', 'text');
  const top = c.track('front');

  c.svg(paper, 'grid', 0, D, 'grid.svg', { x: 0, y: 0, w: W, h: H, fit: 'fill' }, [A.fadeIn(0, 0.6), A.fadeOut(0.5)]);
  const fade = (s) => [A.fadeOutAt(9.35 - s, 0.5)];

  // Scene 1: the elevation, line by line (each drawn from its first point), then the tree, the sun and the dimensions.
  LINES.forEach(([a, b, t], i) => {
    const s = 0.2 + i * 0.075;
    line(c, draw, 'line', a, b, t, C.ink, s, D, 0.32, 'cubic-bezier(.5,0,.3,1)', fade(s));
  });
  c.svg(draw, 'tree', 2.25, D - 2.25, 'tree.svg', { x: 110, y: 560, w: 180, h: 280 }, [A.wipe(0, 0.6, EASE.inOut), ...fade(2.25)]);
  c.svg(draw, 'hatch', 2.45, D - 2.45, 'water.svg', { x: 1082, y: GROUND + 6, w: 166, h: 32 }, [A.wipe(0, 0.4), ...fade(2.45)]);
  // Dimensions: width under the ground line, height on the right.
  line(c, draw, 'dim', [260, 920], [1130, 920], 2, C.dim, 2.6, D, 0.5, EASE.inOut, fade(2.6));
  [[260, 900, 260, 940], [1130, 900, 1130, 940], [1200, 400, 1240, 400], [1200, GROUND, 1240, GROUND]].forEach(([x1, y1, x2, y2], i) => line(c, draw, 'tick', [x1, y1], [x2, y2], 2, C.dim, 2.6 + i * 0.05, D, 0.2, EASE.inOut, fade(2.6)));
  line(c, draw, 'dim', [1220, GROUND], [1220, 400], 2, C.dim, 2.75, D, 0.45, EASE.inOut, fade(2.75));
  c.text(type, 'dim-w', 3.0, 7, { font: 'mono', weight: 500, size: 26, color: C.dim, text: '18.40 m', align: 'center', x: 595, y: 930, w: 200 }, [A.fadeIn(0, 0.3), ...fade(3.0)]);
  c.text(type, 'dim-h', 3.1, 6.9, { font: 'mono', weight: 500, size: 26, color: C.dim, text: '7.20 m', x: 1240, y: 600, w: 160, rotation: -90 }, [A.fadeIn(0, 0.3), ...fade(3.1)]);
  c.text(type, 'sheet', 0.4, 9.6, { font: 'mono', weight: 500, size: 24, color: C.dim, text: 'CASA OMBRA  ·  SOUTH ELEVATION  ·  1:100', x: 100, y: 60, w: 1000 }, [A.wipe(0, 0.6), ...fade(0.4)]);
  c.svg(draw, 'north', 0.6, 9.4, 'north.svg', { x: 1180, y: 46, w: 64, h: 64 }, [A.tw('rotation', -120, 0, 0, 1.2, EASE.backSoft), A.fadeIn(0, 0.3), ...fade(0.6)]);

  // Scene 2: dusk. The glass fills with warm light, pane by pane; the drawing sinks a little under it.
  c.shape(paper, 'dusk', 3.5, 6.5, { x: 0, y: 0, w: W, h: H, fill: C.deep }, [A.fadeIn(0, 1.2), A.fadeOutAt(5.85, 0.5)]);
  GLASS.forEach(([x, y, w, h], i) => {
    const s = 3.8 + i * 0.35;
    c.shape(glow, 'halo', s, D - s, { x: x - 40, y: y - 40, w: w + 80, h: h + 80, fill: C.warm, radius: 30, opacity: 0.4 }, [A.fadeIn(0, 0.6), A.tw('blur', 10, 34, 0, 0.8), ...fade(s)]);
    c.shape(glow, 'glass', s, D - s, { x, y, w, h, fill: C.warm, opacity: 0.88 }, [A.fadeIn(0, 0.35), A.kf('opacity', [[0, 1], [0.1, 0.55], [0.2, 1], [1, 1]], 0, 0.6), ...fade(s)]);
  });

  // The listing on the right.
  const X = 1380;
  c.text(type, 'kick', 3.7, 6.3, { font: 'mono', weight: 600, size: 26, color: C.warm, text: 'FOR SALE  ·  CAPO TESTA', x: X, y: 110, w: 480 }, [A.wipe(0, 0.5), ...fade(3.7)]);
  c.text(type, 'name', 3.8, 6.2, { font: 'body', weight: 600, size: 104, color: C.ink, text: 'Casa\nOmbra', x: X - 6, y: 150, w: 520 }, [A.wipe(0, 0.7, EASE.quint), ...fade(3.8)]);
  const SPECS = [['Bedrooms', [1, 2, 3, 4], ''], ['Bathrooms', [1, 2, 3], ''], ['Living', [60, 120, 180, 240, 280], ' m²'], ['Plot', [300, 600, 900, 1200], ' m²']];
  SPECS.forEach(([label, vals, unit], i) => {
    const col = i % 2; const row = Math.floor(i / 2);
    const x = X + col * 250; const y = 440 + row * 150; const s = 4.6 + i * 0.18;
    line(c, type, 'spec-r', [x, y], [x + 220, y], 2, C.dim, s, D, 0.35, EASE.inOut, fade(s));
    c.text(type, 'spec-l', s + 0.1, D - s - 0.1, { font: 'mono', weight: 500, size: 22, color: C.dim, text: label.toUpperCase(), x, y: y + 14, w: 230 }, [A.fadeIn(0, 0.3), ...fade(s + 0.1)]);
    c.counter(type, 'spec-v', s + 0.15, D, vals.map((v) => `${v.toLocaleString('en-US')}${unit}`), 0.11, { font: 'body', weight: 600, size: 58, color: C.ink, x, y: y + 46, w: 240 }, fade(s + 0.15 + (vals.length - 1) * 0.11));
  });

  // Scene 3: the price and the viewing.
  c.text(type, 'price-l', 7.1, 2.9, { font: 'mono', weight: 500, size: 22, color: C.dim, text: 'ASKING PRICE', x: X, y: 750, w: 400 }, [A.fadeIn(0, 0.3), ...fade(7.1)]);
  c.counter(type, 'price', 7.15, D, ['€ 380,000', '€ 760,000', '€ 1,050,000', '€ 1,250,000'], 0.1, { font: 'body', weight: 600, size: 66, color: C.warm, x: X, y: 780, w: 520 }, [A.tw('scale', 1.12, 1, 0, 0.3, EASE.back), ...fade(7.45)]);
  const bw = 360; const bh = 76;
  c.shape(top, 'btn', 7.7, 2.3, { x: X, y: 900, w: bw, h: bh, fill: C.ink, radius: bh / 2 }, [A.pop(0, 0.4), ...fade(7.7)]);
  c.text(top, 'btn-t', 7.8, 2.2, { font: 'body', weight: 700, size: 30, color: C.blue, text: 'Book a viewing  →', align: 'center', x: X, y: 900 + bh * 0.22, w: bw }, [A.fadeIn(0, 0.3), ...fade(7.8)]);
  c.text(top, 'when', 8.0, 2.0, { font: 'mono', weight: 500, size: 22, color: C.dim, text: 'Viewings from 3 May', x: X, y: 1000, w: 400 }, [A.fadeIn(0, 0.3), ...fade(8.0)]);

  return {
    id: 'gallery-ombra-16x9',
    comp: c.build(),
    meta: { format: 'youtube-16x9', posterTime: 6.2, label: 'Casa Ombra, a modern house for sale: its south elevation draws itself line by line on a blueprint grid with its dimensions, the windows light up for dusk, then the listing counts its rooms, surface and price, in a 16:9 YouTube video.' },
    assets: { 'grid.svg': grid(), 'tree.svg': tree(), 'water.svg': water(), 'north.svg': north() },
  };
}

function grid() {
  const minor = []; const major = [];
  for (let x = 0; x <= W; x += 40) (x % 200 ? minor : major).push(`M${x} 0V${H}`);
  for (let y = 0; y <= H; y += 40) (y % 200 ? minor : major).push(`M0 ${y}H${W}`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path d="${minor.join('')}" stroke="${C.grid}" stroke-width="1"/><path d="${major.join('')}" stroke="${C.grid}" stroke-width="2.5"/></svg>`;
}

function tree() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 280"><g fill="none" stroke="${C.ink}" stroke-width="3" stroke-linecap="round"><circle cx="90" cy="100" r="78"/><circle cx="62" cy="118" r="40" stroke-width="1.6" stroke-dasharray="4 7"/><circle cx="112" cy="80" r="34" stroke-width="1.6" stroke-dasharray="4 7"/><path d="M90 178V280M90 220l-24-26M90 206l20-22"/></g></svg>`;
}

function water() {
  const waves = Array.from({ length: 3 }, (_, i) => `<path d="M${6 + i * 6} ${8 + i * 9}q10 -6 20 0t20 0t20 0t20 0t20 0t20 0t20 0"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 166 32"><g fill="none" stroke="${C.dim}" stroke-width="2" stroke-linecap="round">${waves}</g></svg>`;
}

function north() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="29" fill="none" stroke="${C.dim}" stroke-width="2"/><path d="M32 8l9 26H23z" fill="${C.warm}"/><path d="M32 56l-9-22h18z" fill="none" stroke="${C.dim}" stroke-width="2"/></svg>`;
}
