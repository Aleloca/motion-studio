// TIDEFALL: a seaside music festival. 120 BPM: every cut, pop and pulse lands on a beat (0.5 s) or an eighth.
import { makeComp, A, EASE, writeComposition, tw } from './lib.mjs';
import * as S from './tidefall-assets.mjs';

const C = S.P;
const D = 12;
const BEAT = 0.5;
const SC = [
  { id: 'drop', name: 'Beat drop', start: 0, duration: 2 },
  { id: 'title', name: 'Title', start: 2, duration: 3 },
  { id: 'lineup', name: 'Line-up', start: 5, duration: 3.5 },
  { id: 'dates', name: 'Dates and tickets', start: 8.5, duration: 3.5 },
];
const NAMES = [
  ['MARLO VEX', 'FRI'], ['SALT CHOIR', 'FRI'], ['JUNO ARCADE', 'SAT'], ['KAI & THE RAE', 'SAT'], ['LOW ORBIT', 'SUN'], ['NINA SOLÉ', 'SUN'],
];

const LAYOUT = {
  '9x16': {
    w: 1080, h: 1920, format: 'instagram-reel-9x16', m: 80,
    drop: [{ x: -120, y: 380, s: 760, c: 'pink' }, { x: 520, y: 760, s: 520, c: 'acid', sq: true }, { x: 60, y: 1080, s: 900, c: 'arch' }],
    title: { mode: 'stack', size: 330, y: 560 }, kicker: { y: 400 }, sun: { cx: 540, cy: 860, s: 1100 }, waves: { y: 1300, h: 210 },
    lineup: { cols: 1, x: 80, y: 420, step: 142, size: 104, head: 290 },
    dates: { x: 80, y: 360, big: 290, month: 120, align: 'left' }, arches: { x: -60, y: 1000, s: 1200 }, sticker: { x: 700, y: 250, s: 300 }, cta: { x: 80, y: 1250, w: 640, h: 112 },
  },
  '4x5': {
    w: 1080, h: 1350, format: 'instagram-post-4x5', m: 80,
    drop: [{ x: -100, y: 80, s: 640, c: 'pink' }, { x: 560, y: 420, s: 440, c: 'acid', sq: true }, { x: 90, y: 720, s: 900, c: 'arch' }],
    title: { mode: 'stack', size: 300, y: 300 }, kicker: { y: 160 }, sun: { cx: 540, cy: 560, s: 1000 }, waves: { y: 1010, h: 190 },
    lineup: { cols: 1, x: 80, y: 190, step: 136, size: 98, head: 90 },
    dates: { x: 80, y: 150, big: 260, month: 110, align: 'left' }, arches: { x: 300, y: 760, s: 1000 }, sticker: { x: 740, y: 70, s: 270 }, cta: { x: 80, y: 1100, w: 600, h: 104 },
  },
  '16x9': {
    w: 1920, h: 1080, format: 'youtube-16x9', m: 140,
    drop: [{ x: 160, y: 120, s: 700, c: 'pink' }, { x: 1180, y: 160, s: 480, c: 'acid', sq: true }, { x: 560, y: 470, s: 900, c: 'arch' }],
    title: { mode: 'line', size: 330, y: 300 }, kicker: { y: 200 }, sun: { cx: 960, cy: 520, s: 1100 }, waves: { y: 800, h: 200 },
    lineup: { cols: 2, x: 140, x2: 1010, y: 270, step: 190, size: 122, head: 140 },
    dates: { x: 140, y: 170, big: 300, month: 130, align: 'left' }, arches: { x: 1010, y: 300, s: 900 }, sticker: { x: 1440, y: 90, s: 300 }, cta: { x: 140, y: 820, w: 640, h: 112 },
  },
};

const beats = (n, from = 0) => Array.from({ length: n }, (_, i) => from + i * BEAT);
/** A pulse on every beat for `len` seconds: scale 1 → peak → 1 (keyframes, sharp attack, soft decay). */
function pulse(len, peak = 1.05, start = 0) {
  const n = Math.floor(len / BEAT);
  const frames = [[0, 1]];
  for (let i = 0; i < n; i++) {
    const t0 = (i * BEAT) / len; const t1 = ((i + 0.12) * BEAT) / len; const t2 = ((i + 0.9) * BEAT) / len;
    if (i > 0) frames.push([t0, 1]);
    frames.push([t1, peak, EASE.lin], [t2, 1, EASE.quint]);
  }
  if (frames.at(-1)[0] < 1) frames.push([1, 1]);
  return A.kf('scale', frames.filter((f, i, a) => i === 0 || f[0] > a[i - 1][0]), start, len);
}

export function tidefall(key) {
  const L = LAYOUT[key];
  const { w, h, m } = L;
  const c = makeComp({ width: w, height: h, duration: D, background: C.blue, scenes: SC });
  const back = c.track('back');
  const mid = c.track('shapes');
  const type = c.track('type', 'text');
  const top = c.track('curtains');

  // Scene 1: the drop. Three shapes on the first three beats, then a curtain of colour on the fourth.
  L.drop.forEach((d, i) => {
    const s = i * BEAT;
    if (d.c === 'arch') {
      c.svg(mid, 'arch', s, 2 - s, 'arches.svg', { x: d.x, y: d.y, w: d.s, h: d.s }, [A.tw('y', 500, 0, 0, 0.45, EASE.back)]);
    } else if (d.sq) {
      c.shape(mid, 'square', s, 2 - s, { x: d.x, y: d.y, w: d.s, h: d.s, fill: C[d.c], radius: d.s * 0.12 }, [A.scaleIn(0, 0.3), A.tw('rotation', -45, 12, 0, 0.6, EASE.back), A.tw('rotation', 12, 30, 0.6, 2 - s - 0.6, EASE.lin)]);
    } else {
      c.svg(mid, 'disc', s, 2 - s, 'blob-pink.svg', { x: d.x, y: d.y, w: d.s, h: d.s }, [A.scaleIn(0, 0.3), pulse(1.5 - s, 1.06, 0.5), A.tw('rotation', 0, 40, 0, 2 - s, EASE.lin)]);
    }
  });
  c.svg(mid, 'dots', 0.25, 1.75, 'halftone.svg', { x: w - 520, y: h - 520, w: 480, h: 480 }, [A.wipe(0, 0.4)]);
  c.text(type, 'vol', 0.1, 1.9, { font: 'mono', weight: 600, size: 30, color: C.cream, text: 'TIDEFALL  VOL. 04', x: m, y: key === '9x16' ? 240 : 60, w: 800 }, [A.wipe(0, 0.4, EASE.quint)]);
  c.text(type, 'count', 0, BEAT, { size: key === '16x9' ? 260 : 230, color: C.cream, text: '1', x: m, y: h - (key === '9x16' ? 760 : 380), w: 400 }, []);
  ['2', '3', '4'].forEach((d, i) => c.text(type, 'count', (i + 1) * BEAT, BEAT, { size: key === '16x9' ? 260 : 230, color: C.cream, text: d, x: m, y: h - (key === '9x16' ? 760 : 380), w: 400 }, [A.tw('scale', 1.4, 1, 0, 0.25, EASE.expo)]));
  // The curtain: pink, acid, ink and blue wipes, an eighth apart; the blue one hands over to the title.
  [['pink', 1.5], ['acid', 1.62], ['ink', 1.74], ['blue', 1.86]].forEach(([col, s], i) => {
    c.shape(top, 'curtain', s, 2 - s, { x: 0, y: 0, w, h, fill: C[col] }, [A.wipe(0, Math.min(0.2, 2 - s), EASE.inOut)]);
  });

  // Scene 2: the title, letter by letter on eighths, over a turning sun and rolling waves.
  const SU = L.sun;
  c.svg(back, 'sun', 2, 3, 'sun.svg', { x: SU.cx - SU.s / 2, y: SU.cy - SU.s / 2, w: SU.s, h: SU.s }, [A.tw('scale', 0.2, 1, 0, 0.7, EASE.back), A.tw('rotation', 0, 50, 0, 3, EASE.lin)]);
  c.svg(back, 'sun-beat', 2.7, 2.3, 'sun.svg', { x: SU.cx - SU.s / 2, y: SU.cy - SU.s / 2, w: SU.s, h: SU.s, opacity: 0.35 }, [A.tw('scale', 1, 1.25, 0, 0.5, EASE.expo), A.fadeIn(0, 0.05), A.kf('opacity', [[0, 0.35], [0.22, 0]], 0, 2.3)]);
  const WV = L.waves;
  c.svg(back, 'waves', 2.25, 2.75, 'waves.svg', { x: 0, y: WV.y, w: WV.h * 16, h: WV.h, fit: 'fill' }, [A.wipe(0, 0.5), A.tw('x', 0, -WV.h * 8 * 0.5, 0, 2.75, EASE.lin)]);
  c.svg(back, 'dots', 2.1, 2.9, 'halftone-cream.svg', { x: m * 0.5, y: m * 0.5, w: 360, h: 360, rotation: 180 }, [A.wipe(0, 0.5)]);
  const T = L.title;
  const lines = T.mode === 'stack' ? [['TIDE', C.cream, 0], ['FALL', C.pink, 1]] : [['TIDEFALL', C.cream, 0]];
  let n = 0;
  for (const [word, col, row] of lines) {
    const track = T.size * 0.035;
    const full = tw(word, T.size) + track * (word.length - 1);
    const x0 = (w - full) / 2;
    [...word].forEach((ch, i) => {
      const x = x0 + tw(word.slice(0, i), T.size) + track * i;
      const s = 2.1 + n * BEAT / 4; n++;
      const color = T.mode === 'line' && i >= 4 ? C.pink : col;
      c.text(type, 'letter', s, 5 - s, { size: T.size, color, text: ch, x, y: T.y + row * T.size * 0.92, w: tw(ch, T.size) + 8 }, [
        A.tw('y', -T.size * 0.7, 0, 0, 0.4, EASE.back), A.fadeIn(0, 0.08), A.tw('rotation', i % 2 ? 14 : -14, 0, 0, 0.5, EASE.back),
        pulse(4.5 - s, 1.06, 0.5 - ((s - 2) % BEAT)),
      ]);
    });
  }
  const kw = tw('THREE NIGHTS BY THE SEA', 30, 'mono', 600) + 56;
  c.shape(type, 'kicker-bg', 3.2, 1.8, { x: (w - kw) / 2, y: L.kicker.y, w: kw, h: 64, fill: C.ink, radius: 32 }, [A.wipe(0, 0.4, EASE.quint)]);
  c.text(type, 'kicker', 3.3, 1.7, { font: 'mono', weight: 600, size: 30, color: C.acid, text: 'THREE NIGHTS BY THE SEA', align: 'center', x: 0, y: L.kicker.y + 12, w }, [A.wipe(0, 0.5, EASE.quint)]);

  // Scene 3: the line-up on a cream sheet, one name per beat.
  const U = L.lineup;
  c.shape(top, 'sheet', 4.9, 3.6, { x: 0, y: 0, w, h, fill: C.cream }, [A.wipe(0, 0.3, EASE.inOut)]);
  c.shape(top, 'strip', 5.0, 3.5, { x: 0, y: 0, w: key === '16x9' ? 24 : 20, h, fill: C.pink }, [A.tw('y', -h, 0, 0, 0.4, EASE.quint)]);
  c.svg(top, 'dots', 5.1, 3.4, 'halftone-pink.svg', { x: w - 380, y: h - 380, w: 360, h: 360 }, [A.wipe(0, 0.4)]);
  c.text(top, 'lu-head', 5.15, 3.35, { font: 'mono', weight: 600, size: 30, color: C.pink, text: 'LINE-UP  /  12—14 JUNE', x: U.x, y: U.head, w: 900 }, [A.wipe(0, 0.4)]);
  NAMES.forEach(([name, day], i) => {
    const s = 5.3 + i * BEAT * 0.75;
    const col2 = U.cols === 2 && i >= 3;
    const x = col2 ? U.x2 : U.x;
    const y = U.y + (col2 ? i - 3 : i) * U.step;
    const heavy = i % 3 !== 1;
    c.text(top, 'name', s, 8.5 - s, { size: U.size, weight: heavy ? 800 : 300, color: i % 3 === 2 ? C.pink : C.ink, text: name, x, y, w: tw(name, U.size, 'display', heavy ? 800 : 300) + 10 }, [A.wipe(0, 0.35, EASE.quint), A.tw('x', -60, 0, 0, 0.5, EASE.expo)]);
    c.text(top, 'day', s + 0.15, 8.35 - s, { font: 'mono', weight: 600, size: 26, color: C.ink, text: day, x: x + tw(name, U.size, 'display', heavy ? 800 : 300) + 22, y: y + U.size * 0.18, w: 100 }, [A.fadeIn(0, 0.2), A.tw('y', -20, 0, 0, 0.3, EASE.back)]);
  });
  const moreY = U.y + (U.cols === 2 ? 3 : 6) * U.step;
  c.text(top, 'more', 5.3 + 6 * BEAT * 0.75, 8.5 - (5.3 + 4.5 * BEAT), { size: U.size * 0.62, weight: 500, color: C.ink, text: '+ 40 more artists', x: U.cols === 2 ? U.x2 : U.x, y: moreY + U.size * 0.2, w: 900 }, [A.wipe(0, 0.4)]);

  // Scene 4: dates and tickets. A blue curtain, the arches and the sun rise.
  c.shape(top, 'curtain', 8.4, 3.6, { x: 0, y: 0, w, h, fill: C.blue }, [A.wipe(0, 0.25, EASE.inOut)]);
  const R = L.arches;
  c.svg(top, 'sun2', 8.7, 3.3, 'sun.svg', { x: R.x + R.s * 0.2, y: R.y - R.s * 0.12, w: R.s * 0.6, h: R.s * 0.6 }, [A.tw('y', R.s * 0.5, 0, 0, 1.0, EASE.expo), A.tw('rotation', 0, 40, 0, 3.3, EASE.lin)]);
  c.svg(top, 'arches', 8.55, 3.45, 'arches.svg', { x: R.x, y: R.y, w: R.s, h: R.s }, [A.tw('y', R.s * 0.7, 0, 0, 0.6, EASE.back)]);
  const Dt = L.dates;
  c.text(top, 'days', 8.75, 3.25, { size: Dt.big, color: C.acid, text: '12—14', x: Dt.x, y: Dt.y, w: tw('12—14', Dt.big) + 10 }, [A.tw('y', -120, 0, 0, 0.45, EASE.back), A.fadeIn(0, 0.1), pulse(2.75, 1.03, 0.5)]);
  c.text(top, 'month', 9.0, 3.0, { size: Dt.month, color: C.cream, text: 'JUNE 2027', x: Dt.x, y: Dt.y + Dt.big * 1.02, w: tw('JUNE 2027', Dt.month) + 10 }, [A.wipe(0, 0.4, EASE.quint)]);
  c.text(top, 'place', 9.25, 2.75, { font: 'mono', weight: 600, size: 34, color: C.cream, text: 'PORTO MARINA  ·  3 STAGES', x: Dt.x, y: Dt.y + Dt.big * 1.02 + Dt.month * 1.25, w: 900 }, [A.wipe(0, 0.5)]);
  const Q = L.cta;
  c.shape(top, 'cta', 9.5, 2.5, { x: Q.x, y: Q.y, w: Q.w, h: Q.h, fill: C.ink, radius: Q.h / 2 }, [A.pop(0, 0.45)]);
  c.text(top, 'cta-label', 9.62, 2.38, { font: 'body', weight: 700, size: Q.h * 0.34, color: C.cream, text: 'Tickets Friday, 10:00  →', align: 'center', x: Q.x, y: Q.y + Q.h * 0.27, w: Q.w }, [A.fadeIn(0, 0.3)]);
  const K = L.sticker;
  c.svg(top, 'sticker', 9.75, 2.25, 'sticker.svg', { x: K.x, y: K.y, w: K.s, h: K.s }, [A.scaleIn(0, 0.4), A.tw('rotation', -30, 20, 0, 2.25, EASE.lin), pulse(2.0, 1.08, 0.25)]);
  c.text(top, 'sticker-label', 9.85, 2.15, { size: K.s * 0.2, color: C.cream, text: '3 NIGHTS', align: 'center', x: K.x, y: K.y + K.s * 0.37, w: K.s, rotation: -8 }, [A.pop(0, 0.4)]);

  return { comp: c.build(), format: L.format };
}

const LABELS = {
  '9x16': 'TIDEFALL, a seaside music festival on a 120 BPM beat: shapes on the drop, a letter-by-letter title over a turning sun, the line-up on a cream sheet and the dates, in a 9:16 Instagram Reel.',
  '4x5': 'The TIDEFALL festival poster recomposed for a 4:5 Instagram post.',
  '16x9': 'The TIDEFALL festival poster recomposed for a 16:9 YouTube video.',
};

export function writeTidefall(out, keys = ['9x16', '4x5', '16x9']) {
  for (const key of keys) {
    const { comp, format } = tidefall(key);
    writeComposition(out, `tidefall-${key}`, comp, { format, posterTime: 3.8, label: LABELS[key] }, {
      'sun.svg': S.sun(), 'arches.svg': S.arches(), 'waves.svg': S.waves(), 'halftone.svg': S.halftone(C.ink), 'halftone-cream.svg': S.halftone(C.cream),
      'halftone-pink.svg': S.halftone(C.pink), 'sticker.svg': S.sticker(), 'blob-pink.svg': S.blob(C.pink),
    });
  }
}
