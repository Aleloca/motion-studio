// Alta Via Co.: guided treks in the Dolomites, 9:16. A dusk landscape in layers drawn in SVG: the camera rises and every
// range moves at its own speed (parallax), the name stands huge between the ranges, a dotted trail draws itself from hut to
// hut, then night falls on the booking card and the camera sinks back to the opening frame for the loop.
import { makeComp, A, EASE, tw } from '../hero-gen/lib.mjs';
import { seeded, f1, words } from './kit.mjs';

const C = { top: '#2B2459', rose: '#C0628A', peach: '#F6A27A', glow: '#FCD9A8', sun: '#FFE7BD', cream: '#FFF3E4', night: '#171235', far: '#B38DB6', mid: '#7A5A9C', near: '#4A3A79', front: '#211A44' };
const W = 1080; const H = 1920; const D = 10;
const SC = [
  { id: 'rise', name: 'The camera rises', start: 0, duration: 3.6 },
  { id: 'trail', name: 'The trail', start: 3.6, duration: 3.4 },
  { id: 'night', name: 'Night and booking', start: 7, duration: 3 },
];

/** The ranges, back to front: where their top sits, how far they start below it, how far they drift sideways. */
const RANGES = [
  { id: 'far', y: 1010, h: 910, from: 160, drift: 14, delay: 0.1 },
  { id: 'mid', y: 1050, h: 870, from: 420, drift: 30, delay: 0.25 },
  { id: 'near', y: 1430, h: 490, from: 620, drift: 52, delay: 0.38 },
  { id: 'front', y: 1500, h: 420, from: 900, drift: 90, delay: 0.5 },
];
const OVER = 120; // each range is wider than the frame by this much on each side, for the drift

export function altavia() {
  const c = makeComp({ width: W, height: H, duration: D, background: C.top, scenes: SC });
  const sky = c.track('sky');
  const land = c.track('land');
  const type = c.track('type', 'text');
  const top = c.track('overlay');

  c.svg(sky, 'sky', 0, D, 'sky.svg', { x: 0, y: 0, w: W, h: H, fit: 'fill' }, []);
  c.svg(sky, 'stars', 0, D, 'stars.svg', { x: 0, y: 0, w: W, h: 900 }, [A.kf('opacity', [[0, 0.9], [0.12, 0.25], [0.66, 0.2], [0.78, 1], [1, 0.9]], 0, D)]);
  // The sun rises with the camera, then sets at nightfall.
  c.svg(sky, 'sun', 0, D, 'sun.svg', { x: 560, y: 760, w: 420, h: 420 }, [A.kf('y', [[0, 380], [0.3, 0, EASE.expo], [0.7, 0], [0.86, 330, EASE.inOut], [1, 380]], 0, D)]);

  // The name stands between the far and the middle ranges: the peaks rise over its feet.
  const size = Math.floor((960 * 1000) / tw('DOLOMITI', 1000, 'condensed', 400));
  const nameW = tw('DOLOMITI', size, 'condensed', 400);
  const nx = (W - nameW) / 2;
  const NY = 830;
  const ranges = (from, to) => RANGES.slice(from, to).forEach((R) => {
    c.svg(land, R.id, 0, D, `${R.id}.svg`, { x: -OVER, y: R.y, w: W + OVER * 2, h: R.h, fit: 'fill' }, [
      A.kf('y', [[0, R.from], [0.05 + R.delay / D, R.from], [0.32 + R.delay / D, 0, EASE.expo], [0.9, 0], [1, R.from, EASE.inOut]], 0, D),
      A.tw('x', R.drift, -R.drift, 0, D, EASE.lin),
    ]);
  });
  ranges(0, 1);
  [...'DOLOMITI'].forEach((ch, i) => {
    const x = nx + (i ? tw('DOLOMITI'.slice(0, i), size, 'condensed', 400) : 0);
    const s = 0.5 + i * 0.07;
    c.text(land, 'name', s, D - s, { font: 'condensed', weight: 400, size, color: C.cream, text: ch, x, y: NY, w: tw(ch, size, 'condensed', 400) + 30 }, [
      A.fadeIn(0, 0.3), A.tw('y', 300, 0, 0, 1.6, EASE.expo), A.tw('y', 0, 300, 9.0 - s, 0.8, EASE.inOut), A.fadeOutAt(9.2 - s, 0.5),
      A.tw('x', 20 - (40 * s) / D, -20, 0, D - s, EASE.lin),
    ]);
  });
  ranges(1, 4);
  c.svg(land, 'mist', 1.2, D - 1.2, 'mist.svg', { x: -300, y: 1330, w: 1700, h: 260, fit: 'fill' }, [A.fadeIn(0, 1.2), A.tw('x', 0, 240, 0, D - 1.2, EASE.lin), A.fadeOut(0.6)]);
  c.svg(land, 'birds', 1.6, 3.2, 'birds.svg', { x: 80, y: 520, w: 220, h: 90 }, [A.tw('x', -260, 900, 0, 3.2, EASE.lin), A.kf('y', [[0, 40], [0.5, -30, EASE.sine], [1, 10, EASE.sine]], 0, 3.2), A.fadeIn(0, 0.3), A.fadeOut(0.4)]);

  // Nightfall darkens the land, not the type over it.
  c.shape(land, 'dusk', 6.9, 3.1, { x: 0, y: 0, w: W, h: H, fill: C.night, opacity: 0.5 }, [A.fadeIn(0, 0.8), A.fadeOutAt(2.5, 0.6)]);

  // Scene 1's line over the sky.
  c.text(type, 'kicker', 1.5, 2.0, { font: 'mono', weight: 600, size: 30, color: C.cream, text: 'ALTA VIA CO.  ·  SUMMER 2027', align: 'center', x: 0, y: 200, w: W }, [A.wipe(0, 0.6, EASE.quint), A.fadeOut(0.3)]);
  words(c, type, 'lead', 'Walk above the clouds.', { font: 'body', weight: 600, size: 58, color: C.cream, x: W / 2, y: 268, align: 'center', end: 3.55 }, 1.75, 0.09,
    () => [A.fadeIn(0, 0.3), A.tw('y', 30, 0, 0, 0.6, EASE.expo), A.tw('blur', 8, 0, 0, 0.4), A.fadeOut(0.3)]);

  // Scene 2: the trail, drawn hut to hut over the middle range, with the altitude counted as it climbs.
  c.svg(top, 'trail', 3.75, 3.15, 'trail.svg', { x: 0, y: 1060, w: W, h: 560 }, [A.wipe(0, 1.6, 'cubic-bezier(.45,0,.25,1)'), A.fadeOut(0.3)]);
  const HUTS = [[150, 1500, 'Rifugio Auronzo', '2,320'], [520, 1236, 'Forcella Lavaredo', '2,454'], [900, 1124, 'Rifugio Lagazuoi', '2,752']];
  HUTS.forEach(([x, y, label, alt], i) => {
    const s = 3.85 + i * 0.6;
    c.svg(top, 'pin', s, 7 - s, 'pin.svg', { x: x - 34, y: y - 84, w: 68, h: 88 }, [A.tw('y', -60, 0, 0, 0.5, EASE.back), A.fadeIn(0, 0.15), A.fadeOut(0.3)]);
    const lw = tw(label.toUpperCase(), 24, 'mono', 600) + 36;
    const lx = Math.min(Math.max(30, x - lw / 2), W - 30 - lw);
    c.shape(top, 'tag', s + 0.15, 6.85 - s, { x: lx, y: y - 152, w: lw, h: 54, fill: C.night, radius: 27, opacity: 0.88 }, [A.wipe(0, 0.35, EASE.quint), A.fadeOut(0.3)]);
    c.text(top, 'tag-t', s + 0.22, 6.78 - s, { font: 'mono', weight: 600, size: 24, color: i === 2 ? C.glow : C.cream, text: label.toUpperCase(), align: 'center', x: lx, y: y - 141, w: lw }, [A.fadeIn(0, 0.3), A.fadeOut(0.3)]);
  });
  c.text(type, 'k2', 3.75, 3.2, { font: 'mono', weight: 600, size: 30, color: C.cream, text: 'ALTA VIA 1  ·  6 DAYS  ·  120 KM', align: 'center', x: 0, y: 200, w: W }, [A.wipe(0, 0.6), A.fadeOut(0.3)]);
  const alts = [1200, 1480, 1760, 2010, 2240, 2454, 2610, 2752];
  const fmt = (v) => v.toLocaleString('en-US');
  const AY = 266; const AS = 150;
  c.counter(type, 'alt', 3.9, 6.95, alts.map(fmt), 0.2, { font: 'condensed', weight: 400, size: AS, color: C.cream, align: 'center', x: 0, y: AY, w: W }, [A.fadeOut(0.3)]);
  c.text(type, 'alt-u', 4.0, 2.95, { font: 'body', weight: 600, size: 36, color: C.glow, text: 'metres at the top, on day four', align: 'center', x: 0, y: AY + AS * 1.24, w: W }, [A.fadeIn(0, 0.4), A.tw('y', 16, 0, 0, 0.5, EASE.expo), A.fadeOut(0.3)]);

  // Scene 3: the booking card, under the night.
  c.text(type, 'brand', 7.3, 2.3, { font: 'condensed', weight: 400, size: 120, color: C.cream, text: 'ALTA VIA CO.', align: 'center', x: 0, y: 220, w: W }, [A.wipe(0, 0.6, EASE.quint), A.fadeOut(0.4)]);
  c.text(type, 'brand-l', 7.55, 2.05, { font: 'body', weight: 500, size: 40, color: C.cream, text: 'Guided treks, June to September', align: 'center', x: 0, y: 392, w: W }, [A.fadeIn(0, 0.4), A.tw('y', 16, 0, 0, 0.5, EASE.expo), A.fadeOut(0.4)]);
  const bw = 520; const bh = 108;
  c.shape(top, 'btn', 7.8, 1.8, { x: (W - bw) / 2, y: 500, w: bw, h: bh, fill: C.glow, radius: bh / 2 }, [A.pop(0, 0.45), A.fadeOut(0.35)]);
  c.text(top, 'btn-t', 7.9, 1.7, { font: 'body', weight: 700, size: 38, color: C.night, text: 'Book your summit  →', align: 'center', x: (W - bw) / 2, y: 500 + bh * 0.23, w: bw }, [A.fadeIn(0, 0.3), A.fadeOut(0.35)]);

  return {
    id: 'gallery-altavia-9x16',
    comp: c.build(),
    meta: { format: 'instagram-reel-9x16', posterTime: 5.6, label: 'Alta Via Co., guided treks in the Dolomites: a dusk landscape in layers rises with parallax around a huge name, a dotted trail draws itself from hut to hut while the altitude counts up, then night falls on the booking card, in a 9:16 Instagram Reel.' },
    assets: {
      'sky.svg': skySvg(), 'stars.svg': stars(), 'sun.svg': sunSvg(), 'mist.svg': mist(), 'birds.svg': birds(), 'trail.svg': trail(HUTS), 'pin.svg': pin(),
      'far.svg': range('far', 7, [[0.08, 0.55], [0.22, 0.85], [0.36, 0.6], [0.5, 0.95], [0.66, 0.7], [0.8, 0.9], [0.94, 0.6]], 0.08),
      'mid.svg': range('mid', 11, [[0.05, 0.7], [0.16, 0.95], [0.21, 0.98], [0.3, 0.62], [0.42, 0.78], [0.5, 1], [0.55, 0.97], [0.62, 0.66], [0.74, 0.86], [0.86, 0.6], [0.96, 0.82]], 0.05, true),
      'near.svg': range('near', 23, [[0.1, 0.8], [0.3, 0.55], [0.46, 0.9], [0.62, 0.6], [0.8, 0.95], [0.95, 0.7]], 0.1),
      'front.svg': front(),
    },
  };
}

function skySvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1920" preserveAspectRatio="none"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.top}"/><stop offset=".38" stop-color="#6A3F7E"/><stop offset=".56" stop-color="${C.rose}"/><stop offset=".7" stop-color="${C.peach}"/><stop offset=".82" stop-color="${C.glow}"/></linearGradient></defs><rect width="1080" height="1920" fill="url(#g)"/></svg>`;
}

function stars() {
  const r = seeded(42);
  const dots = Array.from({ length: 90 }, () => `<circle cx="${f1(r() * 1080)}" cy="${f1(r() * 860)}" r="${f1(0.8 + r() * 2.4)}" opacity="${f1(0.3 + r() * 0.7)}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 900"><g fill="#FFF6E8">${dots}</g></svg>`;
}

function sunSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 420"><defs><radialGradient id="g"><stop offset=".34" stop-color="${C.sun}"/><stop offset=".4" stop-color="${C.sun}" stop-opacity=".45"/><stop offset="1" stop-color="${C.sun}" stop-opacity="0"/></radialGradient></defs><circle cx="210" cy="210" r="210" fill="url(#g)"/></svg>`;
}

/**
 * A mountain range across `W + 2 * OVER`: peaks at [x share, height share], sharp Dolomite towers when `towers`, with a
 * small seeded jag between them; filled with a vertical gradient (lighter at the top: the air between us and it).
 */
function range(id, seed, peaks, jag, towers = false) {
  const RW = W + OVER * 2; const R = RANGES.find((x) => x.id === id); const RH = R.h;
  const rand = seeded(seed);
  const pts = [[0, RH * 0.5]];
  peaks.forEach(([px, ph], i) => {
    const x = px * RW; const y = RH * (1 - ph) * 0.62;
    const prev = pts[pts.length - 1];
    // A few jagged points on the way up.
    for (let k = 1; k <= 3; k++) {
      const t = k / 4;
      pts.push([prev[0] + (x - prev[0]) * t, prev[1] + (y - prev[1]) * t + (rand() - 0.5) * RH * jag]);
    }
    if (towers && i % 2 === 1) { pts.push([x - 26, y + 40], [x - 18, y], [x + 14, y + 6], [x + 22, y + 52]); } else pts.push([x, y]);
  });
  pts.push([RW, RH * 0.45], [RW, RH], [0, RH]);
  const d = `M${pts.map(([x, y]) => `${f1(x)} ${f1(y)}`).join('L')}Z`;
  const col = C[id];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${RW} ${RH}" preserveAspectRatio="none"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${lighten(col, 0.18)}"/><stop offset=".55" stop-color="${col}"/><stop offset="1" stop-color="${lighten(col, -0.18)}"/></linearGradient></defs><path d="${d}" fill="url(#g)"/></svg>`;
}

function front() {
  const RW = W + OVER * 2; const RH = 420;
  const rand = seeded(5);
  let trees = '';
  for (let x = 10; x < RW; x += 34 + rand() * 30) {
    const h = 90 + rand() * 110; const b = 214 + rand() * 40; const w = h * 0.46;
    trees += `<path d="M${f1(x)} ${f1(b - h)}L${f1(x + w / 2)} ${f1(b)}H${f1(x - w / 2)}Z"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${RW} ${RH}" preserveAspectRatio="none"><g fill="${C.front}">${trees}<path d="M0 230C200 200 420 250 640 220S1060 200 ${RW} 236V${RH}H0Z"/></g></svg>`;
}

function mist() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1700 260" preserveAspectRatio="none"><defs><radialGradient id="m" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#FFF3E4" stop-opacity=".55"/><stop offset="1" stop-color="#FFF3E4" stop-opacity="0"/></radialGradient></defs><ellipse cx="380" cy="130" rx="420" ry="90" fill="url(#m)"/><ellipse cx="1100" cy="150" rx="520" ry="80" fill="url(#m)"/><ellipse cx="760" cy="110" rx="300" ry="60" fill="url(#m)"/></svg>`;
}

function birds() {
  const b = (x, y, s) => `<path d="M${x} ${y}q${s * 0.5} ${-s * 0.4} ${s} 0q${s * 0.5} ${-s * 0.4} ${s} 0" />`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 90"><g fill="none" stroke="${C.night}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">${b(10, 40, 26)}${b(80, 20, 20)}${b(130, 60, 22)}</g></svg>`;
}

function trail(huts) {
  const p = huts.map(([x, y]) => [x, y - 1060]);
  const d = `M-20 ${p[0][1] + 60}C${p[0][0] - 60} ${p[0][1] + 40} ${p[0][0] - 30} ${p[0][1]} ${p[0][0]} ${p[0][1]}C${p[0][0] + 160} ${p[0][1]} ${p[1][0] - 200} ${p[1][1] + 120} ${p[1][0]} ${p[1][1]}C${p[1][0] + 160} ${p[1][1] - 90} ${p[2][0] - 220} ${p[2][1] + 60} ${p[2][0]} ${p[2][1]}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 560"><path d="${d}" fill="none" stroke="${C.night}" stroke-opacity=".35" stroke-width="16" stroke-linecap="round"/><path d="${d}" fill="none" stroke="${C.glow}" stroke-width="8" stroke-linecap="round" stroke-dasharray="2 20"/></svg>`;
}

function pin() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 68 88"><path d="M34 86C14 58 4 46 4 32a30 30 0 0 1 60 0c0 14-10 26-30 54z" fill="${C.glow}" stroke="${C.night}" stroke-width="4"/><path d="M20 38l14-14 14 14v12H20z" fill="${C.night}"/></svg>`;
}

/** A hex colour lighter (a > 0) or darker (a < 0). */
function lighten(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(a > 0 ? v + (255 - v) * a : v * (1 + a)));
  return `#${ch.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}
