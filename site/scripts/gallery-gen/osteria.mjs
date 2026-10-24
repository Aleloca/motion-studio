// Osteria Fumo: a Roman trattoria's menu of the night, 4:5. Warm editorial: cream paper, a drawn frame, Fraunces, hand-drawn
// ingredients that drop onto the table with a bounce, then the menu written line by line, then a tomato-red iris to the
// booking card.
import { makeComp, A, EASE, tw } from '../hero-gen/lib.mjs';
import { letters, words, line } from './kit.mjs';

const C = { cream: '#F3E9D8', ink: '#2B1D14', tomato: '#D4452B', olive: '#5E6B2C', basil: '#3F7A3A', ochre: '#E3A33A', soft: '#7A6555', paper: '#FBF5EA' };
const W = 1080; const H = 1350; const D = 10;
const SC = [
  { id: 'table', name: 'The table', start: 0, duration: 3.4 },
  { id: 'menu', name: 'The menu', start: 3.4, duration: 4.2 },
  { id: 'book', name: 'Book a table', start: 7.6, duration: 2.4 },
];
const DISHES = [
  { name: 'Amatriciana', what: 'Guanciale, tomato, pecorino', price: '15', icon: 'tomato' },
  { name: 'Aglio e olio', what: 'Spaghetti, garlic, chili', price: '12', icon: 'garlic' },
  { name: 'Carciofi alla giudia', what: 'Fried artichoke, lemon', price: '11', icon: 'lemon' },
  { name: 'Saltimbocca', what: 'Veal, sage, prosciutto', price: '22', icon: 'basil' },
];

/** A drop onto the table: from above, a hard landing, one small bounce. */
const drop = (from, dur = 0.75) => A.kf('y', [[0, from], [0.55, 0, EASE.in], [0.72, -36, 'cubic-bezier(.2,.7,.4,1)'], [0.88, 0, EASE.in], [1, 0]], 0, dur);

export function osteria() {
  const c = makeComp({ width: W, height: H, duration: D, background: C.cream, scenes: SC });
  const back = c.track('paper');
  const food = c.track('ingredients');
  const type = c.track('type', 'text');
  const top = c.track('iris');

  // The drawn frame: four rules around the page, drawn corner to corner, kept until the iris.
  const m = 48;
  const corners = [[m, m], [W - m, m], [W - m, H - m], [m, H - m]];
  corners.forEach((p, i) => line(c, back, 'frame', p, corners[(i + 1) % 4], 3, C.ink, 0.05 + i * 0.12, 7.9, 0.5, EASE.inOut));

  // Scene 1: the name, then the ingredients drop around the plate.
  c.text(type, 'kicker', 0.3, 3.0, { font: 'mono', weight: 600, size: 26, color: C.tomato, text: 'TRASTEVERE  ·  DAL 1987', align: 'center', x: 0, y: 128, w: W }, [A.wipe(0, 0.6, EASE.quint), A.fadeOut(0.25)]);
  words(c, type, 'osteria', 'Osteria', { font: 'serif', weight: 400, size: 104, color: C.ink, x: W / 2, y: 180, align: 'center', end: 3.35 }, 0.45, 0.1,
    () => [A.fadeIn(0, 0.4), A.tw('y', 40, 0, 0, 0.7, EASE.expo), A.tw('y', 0, -60, 2.55, 0.35, EASE.in), A.fadeOut(0.3)]);
  letters(c, type, 'fumo', 'Fumo', { font: 'serif', weight: 900, size: 330, color: C.tomato, x: W / 2, y: 260, align: 'center', tracking: -6, end: 3.4 }, 0.62, 0.09,
    (i, s) => [A.fadeIn(0, 0.2), A.tw('y', 160, 0, 0, 0.8, EASE.expo), A.tw('rotation', i % 2 ? 8 : -8, 0, 0, 0.8, EASE.backSoft), A.tw('blur', 14, 0, 0, 0.45),
      A.tw('y', 0, -120, 3.0 + i * 0.03 - s, 0.3, EASE.in), A.fadeOut(0.3)]);

  // The plate turns slowly under a nest of spaghetti; after the title it slides down and right, and keeps turning.
  const P = { x: 300, y: 760, s: 480 };
  c.svg(food, 'plate', 1.05, 6.6, 'plate.svg', { x: P.x, y: P.y, w: P.s, h: P.s }, [
    A.pop(0, 0.6), A.tw('rotation', 0, 70, 0, 6.6, EASE.lin),
    A.tw('x', 0, 330, 2.2, 0.9, EASE.inOut), A.tw('y', 0, 380, 2.2, 0.9, EASE.inOut), A.tw('scale', 1, 1.25, 2.2, 0.9, EASE.inOut), A.fadeOut(0.3)]);
  c.svg(food, 'pasta', 1.3, 6.35, 'pasta.svg', { x: P.x + 90, y: P.y + 90, w: P.s - 180, h: P.s - 180 }, [
    A.scaleIn(0, 0.5, EASE.back), A.tw('rotation', 0, -40, 0, 6.35, EASE.lin),
    A.tw('x', 0, 330, 1.95, 0.9, EASE.inOut), A.tw('y', 0, 380, 1.95, 0.9, EASE.inOut), A.tw('scale', 1, 1.25, 1.95, 0.9, EASE.inOut), A.fadeOut(0.3)]);
  const FALL = [
    ['tomato', 120, 780, 180, 1.55, -40], ['basil', 790, 690, 170, 1.7, 30], ['garlic', 820, 1050, 170, 1.85, -20],
    ['chili', 100, 1060, 200, 2.0, 60], ['lemon', 640, 600, 130, 2.12, -80], ['basil', 190, 980, 110, 2.22, -120],
  ];
  FALL.forEach(([icon, x, y, s, t, rot], i) => {
    c.svg(food, icon, t, 3.3 - t, `${icon}.svg`, { x, y, w: s, h: s, rotation: rot / 4 }, [drop(-(y + s + 80)), A.tw('rotation', rot, 0, 0, 0.6, EASE.quint),
      A.tw('y', 0, -(y + s), 3.0 - t - i * 0.02, 0.3, EASE.in)]);
  });
  c.text(type, 'note', 2.45, 0.85, { font: 'hand', weight: 700, size: 58, color: C.ink, text: 'made this morning', x: 96, y: 664, w: 420, rotation: -6 }, [A.wipe(0, 0.5, EASE.quint), A.fadeOut(0.2)]);

  // Scene 2: the menu of the night, one line at a time: icon, dish, a dotted leader, the price.
  c.text(type, 'menu-k', 3.5, 4.0, { font: 'mono', weight: 600, size: 26, color: C.tomato, text: 'MENU  ·  GIOVEDÌ 14', x: 120, y: 130, w: 600 }, [A.wipe(0, 0.5), A.fadeOut(0.25)]);
  letters(c, type, 'tonight', 'Tonight', { font: 'serif', weight: 900, size: 150, color: C.ink, x: 112, y: 168, tracking: -3, end: 7.55 }, 3.55, 0.045,
    () => [A.fadeIn(0, 0.2), A.tw('y', 70, 0, 0, 0.6, EASE.expo), A.fadeOut(0.25)]);
  const rowY = 420; const step = 158; const nameX = 236; const priceR = W - 120;
  DISHES.forEach((d, i) => {
    const s = 3.95 + i * 0.32; const y = rowY + i * step;
    c.svg(food, `row-${d.icon}`, s, 7.6 - s, `${d.icon}.svg`, { x: 112, y: y - 4, w: 92, h: 92 }, [A.pop(0, 0.5), A.tw('rotation', -30, 0, 0, 0.6, EASE.backSoft), A.fadeOut(0.25)]);
    const nW = tw(d.name, 54, 'serif', 600);
    c.text(type, 'dish', s + 0.05, 7.55 - s, { font: 'serif', weight: 600, size: 54, color: C.ink, text: d.name, x: nameX, y: y - 4, w: nW + 14 }, [A.wipe(0, 0.5, EASE.quint), A.fadeOut(0.25)]);
    c.text(type, 'what', s + 0.18, 7.42 - s, { font: 'body', weight: 500, size: 27, color: C.soft, text: d.what, x: nameX, y: y + 66, w: 600 }, [A.fadeIn(0, 0.4), A.tw('y', 14, 0, 0, 0.5, EASE.expo), A.fadeOut(0.25)]);
    const pW = tw(d.price, 54, 'serif', 600);
    const lx = nameX + nW + 22; const lw = priceR - pW - 22 - lx;
    c.svg(back, 'leader', s + 0.2, 7.4 - s, 'dots.svg', { x: lx, y: y + 40, w: lw, h: 8, fit: 'cover' }, [A.wipe(0, 0.45, EASE.inOut), A.fadeOut(0.25)]);
    c.text(type, 'price', s + 0.4, 7.2 - s, { font: 'serif', weight: 600, size: 54, color: C.tomato, text: d.price, x: priceR - pW, y: y - 4, w: pW + 10 }, [A.pop(0, 0.4), A.fadeOut(0.25)]);
  });
  c.text(type, 'note2', 5.6, 1.95, { font: 'hand', weight: 700, size: 60, color: C.tomato, text: 'the guanciale is from Amatrice!', x: 150, y: rowY + 4 * step + 30, w: 820, rotation: -3 }, [A.wipe(0, 0.6, EASE.quint), A.fadeOut(0.25)]);
  c.svg(type, 'swoosh', 6.0, 1.55, 'swoosh.svg', { x: 150, y: rowY + 4 * step + 112, w: 560, h: 40, rotation: -3, fit: 'fill' }, [A.wipe(0, 0.45, EASE.inOut), A.fadeOut(0.25)]);

  // Scene 3: a tomato iris opens from the plate, then the booking card.
  const IR = 3200;
  c.shape(top, 'iris', 7.45, 2.55, { x: 780 - IR / 2, y: 1150 - IR / 2, w: IR, h: IR, fill: C.tomato, radius: IR / 2 }, [A.tw('scale', 0, 1, 0, 0.6, EASE.inOut)]);
  c.svg(top, 'steam', 7.9, 1.85, 'steam.svg', { x: W / 2 - 110, y: 250, w: 220, h: 200 }, [A.fadeIn(0, 0.4), A.tw('y', 40, -30, 0, 1.85, EASE.sine), A.fadeOut(0.5)]);
  c.svg(top, 'bowl', 7.8, 1.95, 'bowl.svg', { x: W / 2 - 150, y: 420, w: 300, h: 150 }, [A.pop(0, 0.5)]);
  words(c, top, 'book', 'Book a table', { font: 'serif', weight: 900, size: 128, color: C.paper, x: W / 2, y: 610, align: 'center', end: 9.95 }, 7.95, 0.1,
    () => [A.fadeIn(0, 0.25), A.tw('y', 80, 0, 0, 0.7, EASE.expo), A.tw('rotation', -4, 0, 0, 0.7, EASE.expo)]);
  c.text(top, 'when', 8.3, 1.65, { font: 'body', weight: 600, size: 40, color: C.paper, text: 'Thursday to Sunday, from 19:00', align: 'center', x: 0, y: 790, w: W }, [A.fadeIn(0, 0.4), A.tw('y', 20, 0, 0, 0.5, EASE.expo)]);
  const bw = 420; const bh = 104;
  c.shape(top, 'btn', 8.5, 1.45, { x: (W - bw) / 2, y: 900, w: bw, h: bh, fill: C.paper, radius: bh / 2 }, [A.pop(0, 0.45)]);
  c.text(top, 'btn-t', 8.6, 1.35, { font: 'body', weight: 700, size: 36, color: C.tomato, text: 'Reserve  →', align: 'center', x: (W - bw) / 2, y: 900 + bh * 0.24, w: bw }, [A.fadeIn(0, 0.3)]);
  c.text(top, 'addr', 8.75, 1.2, { font: 'hand', weight: 700, size: 52, color: C.paper, text: 'Vicolo del Fumo 7, Roma', align: 'center', x: 0, y: 1080, w: W, rotation: -2 }, [A.wipe(0, 0.5)]);
  // Back to the cream page for the loop.
  c.shape(top, 'out', 9.62, 0.38, { x: 0, y: 0, w: W, h: H, fill: C.cream }, [A.fadeIn(0, 0.3)]);

  return {
    id: 'gallery-osteria-4x5',
    comp: c.build(),
    meta: { format: 'instagram-post-4x5', posterTime: 5.9, label: 'Osteria Fumo, a Roman trattoria: hand-drawn ingredients drop around a turning plate, the menu of the night is written line by line, and a tomato-red iris opens on the booking card, in a 4:5 Instagram post.' },
    assets: {
      'plate.svg': plate(), 'pasta.svg': pasta(), 'tomato.svg': tomato(), 'basil.svg': basil(), 'garlic.svg': garlic(), 'chili.svg': chili(), 'lemon.svg': lemon(),
      'dots.svg': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2000 8" preserveAspectRatio="xMinYMid slice"><g fill="${C.soft}">${Array.from({ length: 125 }, (_, i) => `<circle cx="${4 + i * 16}" cy="4" r="3"/>`).join('')}</g></svg>`,
      'swoosh.svg': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 40" preserveAspectRatio="none"><path d="M6 28C120 12 260 8 554 18" fill="none" stroke="${C.tomato}" stroke-width="7" stroke-linecap="round"/></svg>`,
      'steam.svg': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 200"><g fill="none" stroke="${C.paper}" stroke-width="9" stroke-linecap="round" opacity=".85"><path d="M60 190c-30-40 30-60 0-100s30-60 10-85"/><path d="M110 190c-30-40 30-60 0-100s30-60 10-85"/><path d="M160 190c-30-40 30-60 0-100s30-60 10-85"/></g></svg>`,
      'bowl.svg': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 150"><path d="M10 20h280c0 70-60 120-140 120S10 90 10 20z" fill="${C.paper}"/><path d="M10 20h280" stroke="${C.paper}" stroke-width="16" stroke-linecap="round"/><path d="M40 48h220" stroke="${C.tomato}" stroke-width="6" stroke-dasharray="2 16" stroke-linecap="round"/></svg>`,
    },
  };
}

function plate() {
  const dashes = Array.from({ length: 36 }, (_, i) => {
    const a = (i / 36) * Math.PI * 2;
    return `<circle cx="${(250 + 212 * Math.cos(a)).toFixed(1)}" cy="${(250 + 212 * Math.sin(a)).toFixed(1)}" r="${i % 3 ? 4 : 8}"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 500"><circle cx="250" cy="262" r="244" fill="#2B1D14" opacity=".12"/><circle cx="250" cy="250" r="244" fill="${C.paper}"/><circle cx="250" cy="250" r="244" fill="none" stroke="${C.ink}" stroke-width="4"/><g fill="${C.tomato}">${dashes}</g><circle cx="250" cy="250" r="180" fill="#F6EEDF" stroke="${C.ink}" stroke-opacity=".25" stroke-width="3"/></svg>`;
}

function pasta() {
  const loops = Array.from({ length: 9 }, (_, i) => {
    const r = 30 + i * 13; const a = i * 0.7;
    return `<ellipse cx="${(160 + 8 * Math.cos(a)).toFixed(1)}" cy="${(160 + 8 * Math.sin(a)).toFixed(1)}" rx="${r}" ry="${(r * 0.9).toFixed(1)}" transform="rotate(${i * 23} 160 160)"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320"><g fill="none" stroke="${C.ochre}" stroke-width="9" stroke-linecap="round">${loops}</g><g fill="none" stroke="#C9861F" stroke-width="3">${loops}</g><g fill="${C.tomato}"><circle cx="120" cy="130" r="16"/><circle cx="196" cy="150" r="13"/><circle cx="150" cy="205" r="15"/></g><path d="M200 96c22-18 50-14 60 4-24 6-44 4-60-4z" fill="${C.basil}"/></svg>`;
}

function tomato() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path d="M100 40c52 0 86 34 86 76s-36 74-86 74-86-32-86-74 34-76 86-76z" fill="${C.tomato}"/><path d="M58 78c-14 12-20 28-18 44" stroke="#F3A08E" stroke-width="10" stroke-linecap="round" fill="none"/><path d="M100 58l-14-26 18 14 12-22 2 26 26-10-20 22 26 8-30 4-8 18-6-20-26 4 20-14z" fill="${C.basil}"/><path d="M104 46c0-14 4-26 12-34" stroke="${C.basil}" stroke-width="7" stroke-linecap="round" fill="none"/></svg>`;
}

function basil() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path d="M30 170C30 90 90 30 176 24c-6 86-60 146-146 146z" fill="${C.basil}"/><path d="M30 170C70 120 110 80 170 30" stroke="#2C5A29" stroke-width="6" stroke-linecap="round" fill="none"/><path d="M80 118l-6-40M108 92l-2-36M100 102l40 6M74 128l42 8" stroke="#2C5A29" stroke-width="4" stroke-linecap="round" fill="none"/></svg>`;
}

function garlic() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path d="M100 26c10 22 24 30 46 46 30 22 36 64 10 92-16 18-36 22-56 22s-40-4-56-22c-26-28-20-70 10-92 22-16 36-24 46-46z" fill="${C.paper}" stroke="${C.ink}" stroke-width="5" stroke-linejoin="round"/><path d="M100 40c-18 40-26 90-12 144M100 40c18 40 26 90 12 144M72 80c-20 30-22 70-4 100M128 80c20 30 22 70 4 100" fill="none" stroke="${C.ink}" stroke-opacity=".45" stroke-width="4" stroke-linecap="round"/><path d="M92 26h16" stroke="${C.ink}" stroke-width="6" stroke-linecap="round"/></svg>`;
}

function chili() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path d="M150 54c20 14 18 44 0 72-24 36-74 58-120 56 30-14 62-40 80-78 10-22 20-60 40-50z" fill="${C.tomato}"/><path d="M134 76c-8 22-22 46-46 66" stroke="#F3A08E" stroke-width="7" stroke-linecap="round" fill="none"/><path d="M144 52c6-14 18-24 34-26-2 14-12 26-26 32z" fill="${C.basil}"/></svg>`;
}

function lemon() {
  const seg = Array.from({ length: 8 }, (_, i) => {
    const a0 = (i / 8) * Math.PI * 2 + 0.06; const a1 = ((i + 1) / 8) * Math.PI * 2 - 0.06;
    const p = (r, a) => `${(100 + r * Math.cos(a)).toFixed(1)} ${(100 + r * Math.sin(a)).toFixed(1)}`;
    return `<path d="M${p(10, (a0 + a1) / 2)}L${p(66, a0)}A66 66 0 0 1 ${p(66, a1)}Z"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><circle cx="100" cy="100" r="92" fill="#E8B92C"/><circle cx="100" cy="100" r="80" fill="#FBF0C2"/><g fill="#F4D25A">${seg}</g></svg>`;
}
