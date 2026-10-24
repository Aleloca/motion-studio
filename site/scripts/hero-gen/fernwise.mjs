// Fernwise: a savings app's year in money. Light and calm: a spending bar chart, a savings curve drawn with a dot riding
// it, a counted balance, then the app.
import { makeComp, A, EASE, writeComposition, tw } from './lib.mjs';
import * as S from './fernwise-assets.mjs';

const C = S.F;
const D = 12;
const SC = [
  { id: 'hook', name: 'Hook', start: 0, duration: 2.6 },
  { id: 'spending', name: 'Spending', start: 2.6, duration: 3.1 },
  { id: 'savings', name: 'Savings curve', start: 5.7, duration: 3.4 },
  { id: 'app', name: 'The app', start: 9.1, duration: 2.9 },
];
const BARS = [
  { label: 'Rent', v: 38, col: C.ink }, { label: 'Groceries', v: 18, col: C.ink }, { label: 'Travel', v: 14, col: C.ink },
  { label: 'Going out', v: 9, col: C.ink }, { label: 'Saved', v: 21, col: C.green },
];
const MONTHS = 'JFMAMJJASOND';

const LAYOUT = {
  '9x16': {
    w: 1080, h: 1920, format: 'instagram-reel-9x16', m: 80,
    hook: { x: 80, y: 500, size: 158 }, kicker: { y: 400 }, coins: [[700, 1120, 220], [180, 1210, 150], [560, 1360, 120]],
    spendTitle: { x: 80, y: 290, size: 92 }, card: { x: 60, y: 520, w: 960, h: 900 }, bars: { pad: 64, labelW: 0, stacked: true },
    saveLabel: { x: 80, y: 280 }, counter: { x: 80, y: 330, size: 170 }, chip: { x: 80, y: 560 }, chartCard: { x: 60, y: 690, w: 960, h: 720 },
    phone: { x: 330, y: 240, w: 420, h: 861 }, word: { y: 1150, size: 120, align: 'center' }, tag: { y: 1310 }, cta: { y: 1390, w: 560, h: 100 },
  },
  '1x1': {
    w: 1080, h: 1080, format: 'instagram-post-1x1', m: 80,
    hook: { x: 80, y: 250, size: 140 }, kicker: { y: 160 }, coins: [[760, 640, 200], [600, 830, 130], [880, 870, 110]],
    spendTitle: { x: 80, y: 80, size: 72 }, card: { x: 80, y: 230, w: 920, h: 770 }, bars: { pad: 54, labelW: 200, stacked: false },
    saveLabel: { x: 80, y: 80 }, counter: { x: 80, y: 120, size: 120 }, chip: { x: 700, y: 150 }, chartCard: { x: 80, y: 330, w: 920, h: 670 },
    phone: { x: 90, y: 170, w: 350, h: 718 }, word: { x: 500, y: 370, size: 92, align: 'left' }, tag: { x: 500, y: 500 }, cta: { x: 500, y: 590, w: 440, h: 92 },
  },
  '16x9': {
    w: 1920, h: 1080, format: 'youtube-16x9', m: 140,
    hook: { x: 140, y: 300, size: 160 }, kicker: { y: 210 }, coins: [[1420, 300, 260], [1240, 620, 170], [1620, 700, 140]],
    spendTitle: { x: 140, y: 380, size: 104 }, card: { x: 860, y: 130, w: 920, h: 820 }, bars: { pad: 60, labelW: 200, stacked: false },
    saveLabel: { x: 140, y: 330 }, counter: { x: 140, y: 380, size: 168 }, chip: { x: 140, y: 620 }, chartCard: { x: 860, y: 130, w: 920, h: 820 },
    phone: { x: 1180, y: 110, w: 420, h: 861 }, word: { x: 140, y: 330, size: 150, align: 'left' }, tag: { x: 140, y: 530 }, cta: { x: 140, y: 650, w: 520, h: 104 },
  },
};

export function fernwise(key) {
  const L = LAYOUT[key];
  const { w, h, m } = L;
  const c = makeComp({ width: w, height: h, duration: D, background: C.bg, scenes: SC });
  const back = c.track('cards');
  const art = c.track('charts');
  const type = c.track('type', 'text');
  const top = c.track('accents');

  // Scene 1: the hook.
  c.text(type, 'kicker', 0.15, 2.3, { font: 'mono', weight: 600, size: 30, color: C.green, text: 'YOUR YEAR IN MONEY  ·  2026', x: L.hook.x, y: L.kicker.y, w: 900 }, [A.wipe(0, 0.6), A.fadeOut(0.3)]);
  const H = L.hook;
  const lines = key === '16x9' ? [['Where did', C.ink], ['2026 go?', C.green]] : [['Where', C.ink], ['did 2026', C.ink], ['go?', C.green]];
  lines.forEach(([t, col], i) => {
    const s = 0.3 + i * 0.16;
    c.text(type, 'hook', s, 2.5 - s, { size: H.size, color: col, text: t, x: H.x, y: H.y + i * H.size * 1.0, w: tw(t, H.size) + 20 }, [
      A.fadeIn(0, 0.25), A.tw('y', H.size * 0.6, 0, 0, 0.8, EASE.expo), A.tw('blur', 10, 0, 0, 0.4), A.tw('y', 0, -H.size * 0.4, 2.05 - s, 0.45, EASE.in), A.fadeOut(0.3),
    ]);
  });
  L.coins.forEach(([x, y, s], i) => {
    const st = 0.6 + i * 0.18;
    c.svg(top, 'coin', st, 2.4 - st, i % 2 ? 'coin-mint.svg' : 'coin-green.svg', { x, y, w: s, h: s }, [
      A.scaleIn(0, 0.5, EASE.back), A.tw('rotation', i % 2 ? 30 : -30, 0, 0, 0.7, EASE.back),
      A.kf('y', [[0, 0], [0.5, -16, EASE.sine], [1, 0, EASE.sine]], 0.5, 2.4 - st - 1.0), A.tw('y', 0, h, 2.4 - st - 0.48, 0.45, EASE.in),
    ]);
  });

  // Scene 2: where it went (horizontal bars, each wiped open, its value counted).
  const T = L.spendTitle;
  c.text(type, 'spend-k', 2.7, 2.9, { font: 'mono', weight: 600, size: 28, color: C.muted, text: 'SPENDING  ·  SHARE OF INCOME', x: T.x, y: T.y - 60, w: 900 }, [A.wipe(0, 0.5), A.fadeOut(0.3)]);
  c.text(type, 'spend-t', 2.75, 2.85, { size: T.size, color: C.ink, text: key === '16x9' ? 'Where it\nwent.' : 'Where it went.', x: T.x, y: T.y, w: w - T.x * 2 }, [A.fadeIn(0, 0.3), A.tw('y', 40, 0, 0, 0.7), A.fadeOut(0.3)]);
  const K = L.card;
  const cardIn = (s, len) => [A.fadeIn(0, 0.3), A.tw('y', 80, 0, 0, 0.8, EASE.expo), A.tw('scale', 0.96, 1, 0, 0.8, EASE.expo), A.tw('y', 0, -40, len - 0.35, 0.35, EASE.in), A.fadeOut(0.35)];
  c.shape(back, 'shadow', 2.75, 2.95, { x: K.x, y: K.y + 14, w: K.w, h: K.h, fill: '#E6DECF', radius: 40 }, cardIn(2.75, 2.95));
  c.shape(back, 'card', 2.75, 2.95, { x: K.x, y: K.y, w: K.w, h: K.h, fill: C.card, radius: 40 }, cardIn(2.75, 2.95));
  const Bz = L.bars;
  const inner = { x: K.x + Bz.pad, y: K.y + Bz.pad, w: K.w - Bz.pad * 2, h: K.h - Bz.pad * 2 };
  const rowH = inner.h / BARS.length;
  const end = 5.7;
  BARS.forEach((b, i) => {
    const s = 3.05 + i * 0.16;
    const y = inner.y + i * rowH;
    const bx = Bz.stacked ? inner.x : inner.x + Bz.labelW;
    const by = Bz.stacked ? y + rowH * 0.42 : y + rowH * 0.28;
    const bh = Bz.stacked ? rowH * 0.3 : rowH * 0.42;
    const valW = 120;
    const bw = inner.w - (bx - inner.x) - valW;
    const len = (bw * b.v) / 40;
    const lab = { font: 'body', weight: b.label === 'Saved' ? 700 : 500, size: key === '1x1' ? 34 : 38, color: b.label === 'Saved' ? C.green : C.ink };
    const out = [A.tw('y', 0, -40, end - s - 0.35, 0.35, EASE.in), A.fadeOut(0.35)];
    c.text(type, 'bar-label', s, end - s, { ...lab, text: b.label, x: inner.x, y: Bz.stacked ? y + rowH * 0.06 : by + bh / 2 - lab.size * 0.66, w: 400 }, [A.fadeIn(0, 0.3), A.tw('x', -20, 0, 0, 0.5), ...out]);
    c.shape(art, 'track', s, end - s, { x: bx, y: by, w: bw, h: bh, fill: C.track, radius: bh / 2 }, [A.fadeIn(0, 0.3), ...out]);
    c.shape(art, 'bar', s + 0.1, end - s - 0.1, { x: bx, y: by, w: len, h: bh, fill: b.label === 'Saved' ? C.green : b.col, radius: bh / 2 }, [A.wipe(0, 0.9, EASE.expo), ...out.map((a) => ({ ...a, start: a.start === undefined ? undefined : a.start - 0.1 }))]);
    const vals = [0, 0.15, 0.35, 0.55, 0.72, 0.85, 0.93, 1].map((f) => `${Math.round(b.v * f)}%`);
    c.counter(type, 'bar-val', s + 0.1, end, vals, 0.09, { font: 'body', weight: 700, size: 40, color: b.label === 'Saved' ? C.green : C.ink, x: bx + len + 20, y: by + bh / 2 - 26, w: valW }, [A.tw('y', 0, -40, end - s - 0.1 - 7 * 0.09 - 0.35, 0.35, EASE.in), A.fadeOut(0.35)]);
  });

  // Scene 3: the savings curve, drawn with a dot riding it; the balance counts up.
  const SL = L.saveLabel;
  c.text(type, 'save-k', 5.8, 3.2, { font: 'mono', weight: 600, size: 28, color: C.muted, text: 'SAVED THIS YEAR', x: SL.x, y: SL.y, w: 900 }, [A.wipe(0, 0.5), A.fadeOut(0.3)]);
  const N = L.counter;
  // The balance is the curve's own monthly value, in step with the dot that rides it (6.15 s, drawn in 2.25 s).
  const bal = S.SAVINGS.map((v) => `$${v.toLocaleString('en-US')}`);
  const bStep = 2.25 / (bal.length - 1);
  c.counter(type, 'balance', 6.15, 9.05, bal, bStep, { size: N.size, color: C.ink, x: N.x, y: N.y, w: tw('$12,480', N.size) + 40 }, [A.tw('color', C.ink, C.green, 0, 0.5, EASE.sine), A.kf('scale', [[0, 1], [0.4, 1.06, EASE.expo], [1, 1, EASE.quint]], 0, 0.5), A.tw('blur', 0, 10, 9.05 - 6.15 - (bal.length - 1) * bStep - 0.35, 0.35, EASE.in), A.fadeOut(0.35)]);
  const Q = L.chip;
  c.shape(back, 'chip', 8.0, 1.05, { x: Q.x, y: Q.y, w: 300, h: 76, fill: C.mint, radius: 38 }, [A.pop(0, 0.5), A.fadeOut(0.3)]);
  c.text(type, 'chip-l', 8.1, 0.95, { font: 'body', weight: 700, size: 34, color: C.ink, text: '▲ 18.4% vs 2025', align: 'center', x: Q.x, y: Q.y + 15, w: 300 }, [A.fadeIn(0, 0.3), A.fadeOut(0.3)]);
  const CK = L.chartCard;
  c.shape(back, 'shadow', 5.8, 3.25, { x: CK.x, y: CK.y + 14, w: CK.w, h: CK.h, fill: '#E6DECF', radius: 40 }, cardIn(5.8, 3.25));
  c.shape(back, 'card', 5.8, 3.25, { x: CK.x, y: CK.y, w: CK.w, h: CK.h, fill: C.card, radius: 40 }, cardIn(5.8, 3.25));
  const pad = 64;
  const ch = { x: CK.x + pad, y: CK.y + pad + 40, w: CK.w - pad * 2, h: CK.h - pad * 2 - 100 };
  const chOut = (len) => [A.tw('y', 0, -40, len - 0.35, 0.35, EASE.in), A.fadeOut(0.35)];
  c.text(type, 'chart-t', 5.95, 3.1, { font: 'body', weight: 600, size: 34, color: C.ink, text: 'Savings, month by month', x: ch.x, y: CK.y + pad - 14, w: ch.w }, [A.fadeIn(0, 0.4), ...chOut(3.1)]);
  c.svg(art, 'grid', 6.0, 3.05, `grid-${key}.svg`, { x: ch.x, y: ch.y, w: ch.w, h: ch.h, fit: 'fill' }, [A.fadeIn(0, 0.5), ...chOut(3.05)]);
  const draw = 2.25;
  c.svg(art, 'curve', 6.15, 2.9, `chart-${key}.svg`, { x: ch.x, y: ch.y, w: ch.w, h: ch.h, fit: 'fill' }, [A.wipe(0, draw, EASE.lin), ...chOut(2.9)]);
  const pts = S.chartPoints(ch.w, ch.h, { l: 0, r: 0, t: 16, b: 4 });
  const dot = 34;
  const p0 = pts[0];
  const kx = pts.map(([x], i) => [i / (pts.length - 1), x - p0[0]]);
  const ky = pts.map(([, y], i) => [i / (pts.length - 1), y - p0[1]]);
  c.shape(top, 'halo', 6.15, 2.9, { x: ch.x + p0[0] - dot, y: ch.y + p0[1] - dot, w: dot * 2, h: dot * 2, fill: '#17784A33', radius: dot }, [A.kf('x', kx, 0, draw), A.kf('y', ky, 0, draw), A.kf('scale', [[0, 0.6], [0.5, 1.1, EASE.sine], [1, 0.6, EASE.sine]], 0, 1), A.kf('scale', [[0, 0.6], [0.5, 1.2, EASE.sine], [1, 0.8, EASE.sine]], 1, 1.25), ...chOut(2.9)]);
  c.shape(top, 'dot', 6.15, 2.9, { x: ch.x + p0[0] - dot / 2, y: ch.y + p0[1] - dot / 2, w: dot, h: dot, fill: C.green, radius: dot / 2 }, [A.scaleIn(0, 0.3), A.kf('x', kx, 0, draw), A.kf('y', ky, 0, draw), ...chOut(2.9)]);
  c.shape(top, 'dot-core', 6.15, 2.9, { x: ch.x + p0[0] - 7, y: ch.y + p0[1] - 7, w: 14, h: 14, fill: C.card, radius: 7 }, [A.kf('x', kx, 0, draw), A.kf('y', ky, 0, draw), ...chOut(2.9)]);
  [...MONTHS].forEach((mo, i) => {
    const x = ch.x + ((i + 0.5) / 12) * ch.w - 15;
    c.text(type, 'month', 6.15 + (i / 12) * draw, 2.9 - (i / 12) * draw, { font: 'mono', weight: 500, size: 24, color: C.muted, text: mo, align: 'center', x, y: ch.y + ch.h + 18, w: 30 }, [A.fadeIn(0, 0.2), ...chOut(2.9 - (i / 12) * draw)]);
  });
  const last = pts.at(-1);
  c.shape(top, 'tip', 8.45, 0.6, { x: ch.x + last[0] - 150, y: ch.y + last[1] - 110, w: 150, h: 64, fill: C.ink, radius: 18 }, [A.pop(0, 0.4), A.fadeOut(0.25)]);
  c.text(type, 'tip-l', 8.5, 0.55, { font: 'body', weight: 700, size: 30, color: C.card, text: 'Dec', align: 'center', x: ch.x + last[0] - 150, y: ch.y + last[1] - 98, w: 150 }, [A.fadeIn(0, 0.2), A.fadeOut(0.25)]);

  // Scene 4: the app.
  const P = L.phone;
  c.shape(back, 'phone-shadow', 9.2, 2.8, { x: P.x + P.w * 0.08, y: P.y + P.h - 10, w: P.w * 0.84, h: 40, fill: '#DDD4C3', radius: 20 }, [A.fadeIn(0.3, 0.6), A.tw('scale', 0.6, 1, 0.2, 0.9)]);
  const disc = P.h * 0.9;
  c.shape(back, 'disc', 9.15, 2.85, { x: P.x + P.w / 2 - disc / 2, y: P.y + P.h / 2 - disc / 2, w: disc, h: disc, fill: C.mint, radius: disc / 2 }, [A.scaleIn(0, 0.9, EASE.expo), A.kf('scale', [[0, 1], [0.5, 1.03, EASE.sine], [1, 1, EASE.sine]], 0.9, 1.9)]);
  c.svg(art, 'phone', 9.2, 2.8, 'phone.svg', { x: P.x, y: P.y, w: P.w, h: P.h }, [A.fadeIn(0, 0.3), A.tw('y', h * 0.6, 0, 0, 1.0, EASE.expo), A.tw('rotation', 8, -3, 0, 1.1, EASE.expo), A.tw('rotation', -3, 0, 1.1, 1.7, EASE.sine)]);
  const W = L.word;
  const lw = W.size * 0.9; const ww = tw('Fernwise', W.size); const gap = W.size * 0.22;
  const x0 = W.align === 'center' ? (w - lw - gap - ww) / 2 : W.x;
  c.svg(top, 'logo', 9.55, 2.45, 'logo.svg', { x: x0, y: W.y + W.size * 0.18, w: lw, h: lw }, [A.scaleIn(0, 0.5, EASE.back), A.tw('rotation', -90, 0, 0, 0.6, EASE.back)]);
  c.text(type, 'word', 9.65, 2.35, { size: W.size, color: C.ink, text: 'Fernwise', x: x0 + lw + gap, y: W.y, w: ww + 20 }, [A.wipe(0, 0.6), A.tw('x', -30, 0, 0, 0.7)]);
  const TG = L.tag;
  const center = W.align === 'center';
  c.text(type, 'tag', 9.9, 2.1, { font: 'body', weight: 500, size: key === '1x1' ? 38 : 46, color: C.muted, text: 'Watch your money grow.', align: center ? 'center' : 'left', x: center ? 0 : TG.x, y: TG.y, w: center ? w : w - TG.x - 40 }, [A.fadeIn(0, 0.4), A.tw('y', 20, 0, 0, 0.6)]);
  const CT = L.cta;
  const cx = center ? (w - CT.w) / 2 : CT.x;
  c.shape(type, 'cta', 10.15, 1.85, { x: cx, y: CT.y, w: CT.w, h: CT.h, fill: C.green, radius: CT.h / 2 }, [A.pop(0, 0.5)]);
  c.text(type, 'cta-l', 10.3, 1.7, { font: 'body', weight: 700, size: CT.h * 0.34, color: C.card, text: 'Start free for 30 days', align: 'center', x: cx, y: CT.y + CT.h * 0.27, w: CT.w }, [A.fadeIn(0, 0.3)]);

  return { comp: c.build(), format: L.format, chart: ch };
}

const LABELS = {
  '9x16': 'Fernwise, a savings app\'s year in money: a spending bar chart, a savings curve drawn month by month with a counted balance, then the app, in a 9:16 Instagram Reel.',
  '1x1': 'The Fernwise year-in-money story recomposed for a 1:1 Instagram post.',
  '16x9': 'The Fernwise year-in-money story recomposed for a 16:9 YouTube video.',
};

export function writeFernwise(out, keys = ['9x16', '1x1', '16x9']) {
  for (const key of keys) {
    const { comp, format, chart } = fernwise(key);
    const cw = Math.round(chart.w); const chh = Math.round(chart.h);
    writeComposition(out, `fernwise-${key}`, comp, { format, posterTime: 8.6, label: LABELS[key] }, {
      [`chart-${key}.svg`]: S.chart(cw, chh), [`grid-${key}.svg`]: S.gridLines(cw, chh), 'phone.svg': S.phone, 'logo.svg': S.logo,
      'coin-green.svg': S.coin(C.green, '#0F5E39'), 'coin-mint.svg': S.coin(C.mint, '#6CC495'),
    });
  }
}
