// FORM/27: a design conference opens its tickets, 16:9. Swiss grid in paper, black and signal red: the grid draws itself,
// the year is built from square cells, a countdown runs from ten with a progress rule, then a red field carries the name,
// the dates and the speakers, set on the grid's columns.
import { makeComp, A, EASE, tw } from '../hero-gen/lib.mjs';
import { line } from './kit.mjs';

const C = { paper: '#F4F3EE', ink: '#111111', red: '#FF3B1F', grey: '#D3D1C8', mid: '#77746B' };
const W = 1920; const H = 1080; const D = 10;
const SC = [
  { id: 'grid', name: 'Grid and year', start: 0, duration: 2.6 },
  { id: 'count', name: 'Countdown', start: 2.6, duration: 3.1 },
  { id: 'info', name: 'Name, dates, speakers', start: 5.7, duration: 4.3 },
];
const M = 60; const COLS = 12; const ROWS = 6;
const CW = (W - 2 * M) / COLS; const RH = (H - 2 * M) / ROWS;
const colX = (i) => M + i * CW; const rowY = (j) => M + j * RH;
const DIGITS = { 2: ['111', '001', '111', '100', '111'], 7: ['111', '001', '010', '010', '010'] };
const SPEAKERS = [['Ines Duarte', 'Type design'], ['Kofi Mensah', 'Motion systems'], ['Yuki Sato', 'Interfaces'], ['Lena Vogt', 'Wayfinding'], ['Marco Ruiz', 'Generative art'], ['Ada Okafor', 'Design ops']];

export function form() {
  const c = makeComp({ width: W, height: H, duration: D, background: C.paper, scenes: SC });
  const grid = c.track('rules');
  const cells = c.track('cells');
  const type = c.track('type', 'text');
  const top = c.track('front');

  // The grid: column lines down, row lines across, kept to the end, then they retract for the loop.
  for (let i = 0; i <= COLS; i++) line(c, grid, 'col', [colX(i), M], [colX(i), H - M], 2, C.grey, 0.05 + i * 0.035, D, 0.5, EASE.inOut, [A.fadeOutAt(9.5 - 0.05 - i * 0.035, 0.4)]);
  for (let j = 0; j <= ROWS; j++) line(c, grid, 'row', [M, rowY(j)], [W - M, rowY(j)], 2, C.grey, 0.2 + j * 0.05, D, 0.6, EASE.inOut, [A.fadeOutAt(9.5 - 0.2 - j * 0.05, 0.4)]);

  // Scene 1: the year, built from square cells (a five-row pixel figure), popping on a diagonal.
  const PX = 126; const GAP = 10; const X0 = colX(1); const Y0 = rowY(0) + 80;
  let n = 0;
  ['2', '7'].forEach((d, k) => {
    DIGITS[d].forEach((row, j) => [...row].forEach((on, i) => {
      if (on !== '1') return;
      const col = k * 4 + i;
      const s = 0.7 + (col + j) * 0.045;
      const out = 2.5 + (col + j) * 0.03;
      c.shape(cells, 'px', s, out + 0.25 - s, { x: X0 + col * (PX + GAP), y: Y0 + j * (PX + GAP), w: PX, h: PX, fill: k ? C.ink : C.red }, [A.scaleIn(0, 0.35, EASE.back), A.tw('scale', 1, 0, out - s, 0.25, EASE.in)]);
      n++;
    }));
  });
  c.text(type, 'k1', 0.5, 2.3, { font: 'mono', weight: 600, size: 26, color: C.ink, text: 'FORM/27  ·  DESIGN CONFERENCE', x: colX(9), y: rowY(0) + 20, w: 520 }, [A.wipe(0, 0.5), A.fadeOut(0.25)]);
  c.text(type, 'k2', 0.9, 1.9, { font: 'body', weight: 700, size: 44, color: C.ink, text: 'Three days on\nform, type and\nmotion.', x: colX(9), y: rowY(1) + 20, w: 520 }, [A.wipe(0, 0.6, EASE.quint), A.fadeOut(0.25)]);

  // Scene 2: tickets open in ten, nine, …, one; a red rule fills the width as it counts.
  c.text(type, 'k3', 2.7, 2.95, { font: 'mono', weight: 600, size: 30, color: C.ink, text: 'TICKETS OPEN IN', x: colX(1), y: rowY(1) + 10, w: 600 }, [A.wipe(0, 0.4), A.fadeOut(0.2)]);
  for (let v = 10; v >= 1; v--) {
    const s = 2.8 + (10 - v) * 0.27; const last = v === 1;
    const size = 560;
    c.text(type, 'count', s, last ? 0.45 : 0.27, { font: 'body', weight: 700, size, color: v <= 3 ? C.red : C.ink, text: String(v), x: colX(1) - 20, y: rowY(1) + 40, w: tw(String(v), size, 'body', 700) + 40 }, [
      A.tw('y', 140, 0, 0, 0.22, EASE.expo), A.fadeIn(0, 0.05), ...(last ? [A.tw('scale', 1, 1.08, 0.12, 0.2, EASE.back), A.fadeOut(0.12)] : []),
    ]);
  }
  line(c, cells, 'progress', [colX(0), rowY(6) - 24], [colX(12), rowY(6) - 24], 14, C.red, 2.8, 5.65, 2.75, 'linear');
  c.text(type, 'secs', 2.9, 2.75, { font: 'mono', weight: 500, size: 26, color: C.mid, text: '27—29 MAY 2027  ·  LISBON', x: colX(8), y: rowY(5) + 40, w: 600 }, [A.fadeIn(0, 0.3), A.fadeOut(0.2)]);

  // Scene 3: a red field over the left half, the name, the dates, and the speakers on the right columns.
  c.shape(top, 'field', 5.6, 4.4, { x: 0, y: 0, w: colX(6), h: H, fill: C.red }, [A.wipe(0, 0.45, 'cubic-bezier(.77,0,.18,1)'), A.tw('x', 0, -colX(6), 3.7, 0.5, 'cubic-bezier(.77,0,.18,1)')]);
  const out = (s, d = 0) => [A.fadeOutAt(9.3 - s + d, 0.3)];
  const NS = Math.floor(((colX(6) - M - 90) * 1000) / tw('FORM/27', 1000, 'body', 700));
  c.text(top, 'name', 5.9, 4.1, { font: 'body', weight: 700, size: NS, color: C.paper, text: 'FORM/27', x: M + 30, y: rowY(1) - 10, w: colX(6) - M - 30 }, [A.wipe(0, 0.6, 'cubic-bezier(.77,0,.18,1)'), A.tw('x', -60, 0, 0, 0.8, EASE.expo), ...out(5.9)]);
  c.text(top, 'sub', 6.2, 3.8, { font: 'body', weight: 700, size: 56, color: C.paper, text: 'Design conference', x: M + 36, y: rowY(3) - 10, w: 800 }, [A.fadeIn(0, 0.3), A.tw('y', 30, 0, 0, 0.5, EASE.expo), ...out(6.2)]);
  c.text(top, 'when', 6.35, 3.65, { font: 'mono', weight: 600, size: 32, color: C.paper, text: '27—29 MAY 2027\nLX FACTORY, LISBON', x: M + 36, y: rowY(4) - 10, w: 800 }, [A.wipe(0, 0.5), ...out(6.35)]);
  const bw = 470; const bh = 84;
  c.shape(top, 'btn', 6.7, 3.3, { x: M + 36, y: rowY(5) + 10, w: bw, h: bh, fill: C.ink, radius: bh / 2 }, [A.pop(0, 0.4), ...out(6.7)]);
  c.text(top, 'btn-t', 6.8, 3.2, { font: 'body', weight: 700, size: 32, color: C.paper, text: 'Tickets on sale now  →', align: 'center', x: M + 36, y: rowY(5) + 10 + bh * 0.24, w: bw }, [A.fadeIn(0, 0.3), ...out(6.8)]);
  c.text(type, 'sp-k', 6.0, 3.65, { font: 'mono', weight: 600, size: 26, color: C.red, text: 'SPEAKERS', x: colX(7) + 16, y: rowY(0) + 26, w: 400 }, [A.wipe(0, 0.4), ...out(6.0)]);
  SPEAKERS.forEach(([name, what], i) => {
    const col = i % 2; const row = Math.floor(i / 2);
    const x = colX(7 + col * 3) + 16; const y = rowY(1 + row * 1.5) + 10; const s = 6.25 + i * 0.12;
    c.shape(type, 'sp-sq', s, 3.75 - (s - 6.25), { x, y: y + 6, w: 22, h: 22, fill: i % 3 === 0 ? C.red : C.ink }, [A.scaleIn(0, 0.3, EASE.back), ...out(s)]);
    c.text(type, 'sp-n', s + 0.05, 3.7 - (s - 6.25), { font: 'body', weight: 700, size: 46, color: C.ink, text: name, x: x + 40, y: y - 8, w: 420 }, [A.wipe(0, 0.45, EASE.quint), A.tw('x', -30, 0, 0, 0.5, EASE.expo), ...out(s + 0.05)]);
    c.text(type, 'sp-w', s + 0.15, 3.6 - (s - 6.25), { font: 'mono', weight: 500, size: 24, color: C.mid, text: what.toUpperCase(), x: x + 40, y: y + 56, w: 420 }, [A.fadeIn(0, 0.3), ...out(s + 0.15)]);
  });

  return {
    id: 'gallery-form-16x9',
    comp: c.build(),
    meta: { format: 'youtube-16x9', posterTime: 7.6, label: 'FORM/27, a design conference opening its tickets: a Swiss grid draws itself, the year is built from square cells, a countdown runs from ten with a red progress rule, then a red field carries the name and dates beside the speakers set on the grid, in a 16:9 YouTube video.' },
    assets: {},
  };
}
