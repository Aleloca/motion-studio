// Maison Noir, Drop 03: a fashion label's new coat, 4:5. High-contrast editorial in black, bone and one red: three black
// panels wipe down and up like shutters, the name is cut in thin Fraunces, the panels part on a coat drawn as a technical
// flat that draws itself from the collar down, with callouts, then the drop date on black and a bone wipe for the loop.
import { makeComp, A, EASE, tw } from '../hero-gen/lib.mjs';
import { letters, line } from './kit.mjs';

const C = { bone: '#F1EEE7', black: '#0B0B0B', red: '#C8102E', grey: '#8A8680' };
const W = 1080; const H = 1350; const D = 9;
const SC = [
  { id: 'shutters', name: 'Shutters and name', start: 0, duration: 3.3 },
  { id: 'look', name: 'The look', start: 3.3, duration: 3.1 },
  { id: 'drop', name: 'The drop', start: 6.4, duration: 2.6 },
];
const CUT = 'cubic-bezier(.77,0,.18,1)';

/**
 * A rectangle wiped along the vertical: a shape turned a quarter (its own x runs down the frame when `down`, up otherwise),
 * so the runtime's left-to-right wipe opens it top to bottom (or bottom to top).
 */
function vpanel(c, track, name, x, y, w, h, fill, start, dur, wipe, down, anims = []) {
  return c.shape(track, name, start, dur, { x: x + w / 2 - h / 2, y: y + h / 2 - w / 2, w: h, h: w, fill, rotation: down ? 90 : -90 },
    [{ preset: 'wipe', start: 0, duration: wipe, ease: CUT }, ...anims]);
}

export function noir() {
  const c = makeComp({ width: W, height: H, duration: D, background: C.bone, scenes: SC });
  const panels = c.track('panels');
  const art = c.track('art');
  const type = c.track('type', 'text');
  const top = c.track('cover');

  // Scene 1: three shutters close (down, up, down), the name is cut into them, then they part.
  const pw = W / 3;
  [0, 1, 2].forEach((i) => {
    const s = 0.1 + i * 0.12;
    // Moves are in the turned shape's own frame: on a quarter turn down, its y runs to the left of the frame; turned up,
    // its x runs up the frame. The outer shutters part sideways, the middle one goes up.
    const part = i === 1 ? A.tw('x', 0, H, 3.15 - s, 0.55, CUT) : A.tw('y', 0, i === 0 ? pw + 2 : -pw - 2, 3.15 - s, 0.55, CUT);
    vpanel(c, panels, 'shutter', i * pw - 1, 0, pw + 2, H, C.black, s, 3.7 - s, 0.55, i !== 1, [part]);
  });
  const NS = 330;
  const nameW = tw('NOIR', NS, 'serif', 300) + 40 * 3;
  letters(c, type, 'noir', 'NOIR', { font: 'serif', weight: 300, size: NS, color: C.bone, x: W / 2, y: 420, align: 'center', tracking: 40, end: 3.3 }, 0.75, 0.16,
    (i, s) => [A.wipe(0, 0.5, CUT), A.tw('y', 30, 0, 0, 0.9, EASE.expo), A.tw('y', 0, -140, 2.9 - s + i * 0.03, 0.3, EASE.in), A.fadeOutAt(2.95 - s + i * 0.03, 0.25)]);
  c.text(type, 'maison', 0.5, 2.7, { font: 'mono', weight: 500, size: 28, color: C.bone, text: 'M A I S O N', align: 'center', x: 0, y: 360, w: W }, [A.wipe(0, 0.5, CUT), A.fadeOut(0.25)]);
  line(c, type, 'rule', [(W - nameW) / 2, 860], [(W + nameW) / 2, 860], 4, C.red, 1.5, 3.1, 0.6, CUT, [A.fadeOut(0.2)]);
  c.text(type, 'ss', 1.75, 1.35, { font: 'mono', weight: 500, size: 26, color: C.grey, text: 'AUTUMN / WINTER 27', align: 'center', x: 0, y: 900, w: W }, [A.fadeIn(0, 0.4), A.fadeOut(0.25)]);

  // Scene 2: the coat, drawn top to bottom as a technical flat, with its callouts.
  const CW = 470; const CH = CW * 1.75; const cx = (W - CW) / 2; const cy = 120;
  c.svg(art, 'coat', 3.45, 2.95, 'coat-turned.svg', { x: cx + CW / 2 - CH / 2, y: cy + CH / 2 - CW / 2, w: CH, h: CW, rotation: 90 }, [
    { preset: 'wipe', start: 0, duration: 1.5, ease: 'cubic-bezier(.45,0,.3,1)' }, A.fadeOut(0.3)]);
  c.text(type, 'look', 3.5, 2.85, { font: 'mono', weight: 500, size: 26, color: C.black, text: 'LOOK 07', x: 80, y: 1110, w: 300 }, [A.wipe(0, 0.4), A.fadeOut(0.25)]);
  c.text(type, 'look-n', 3.6, 2.75, { font: 'serif', weight: 300, size: 76, color: C.black, text: 'The long coat', x: 80, y: 1146, w: 700 }, [A.wipe(0, 0.6, CUT), A.fadeOut(0.25)]);
  const sx = CW / 400; // the flat's units to the frame
  const pt = ([x, y]) => [cx + x * sx, cy + y * sx];
  const CALL = [
    [[118, 118], 'NOTCHED LAPEL', 'left', 250, 4.3], [[338, 150], 'DROPPED SHOULDER', 'right', 330, 4.55],
    [[225, 415], 'SELF TIE BELT', 'right', 640, 4.8], [[110, 472], 'WOOL-CASHMERE', 'left', 760, 5.05],
  ];
  CALL.forEach(([p, label, side, ly, s]) => {
    const [px, py] = pt(p);
    const ex = side === 'left' ? 64 : W - 64; const lx = side === 'left' ? cx - 24 : cx + CW + 24;
    c.shape(art, 'dot', s, 6.3 - s, { x: px - 9, y: py - 9, w: 18, h: 18, fill: C.red, radius: 9 }, [A.scaleIn(0, 0.3, EASE.back), A.fadeOut(0.25)]);
    line(c, art, 'call', [px, py], [lx, ly], 2, C.red, s + 0.1, 6.3, 0.35, EASE.inOut, [A.fadeOut(0.25)]);
    const tW = tw(label, 22, 'mono', 500) + 8;
    c.text(type, 'call-t', s + 0.35, 6.3 - s - 0.35, { font: 'mono', weight: 500, size: 22, color: C.black, text: label, x: side === 'left' ? ex : ex - tW, y: ly - 32, w: tW, align: side }, [A.wipe(0, 0.4), A.fadeOut(0.25)]);
    line(c, art, 'call-u', [side === 'left' ? ex : ex - tW, ly], [lx, ly], 2, C.red, s + 0.3, 6.3, 0.3, EASE.inOut, [A.fadeOut(0.25)]);
  });
  // The price, swung on like a tag.
  c.shape(art, 'tag', 5.4, 0.95, { x: 760, y: 1080, w: 240, h: 96, fill: C.red, radius: 6, rotation: -6 }, [A.tw('rotation', -40, 0, 0, 0.6, EASE.back), A.fadeIn(0, 0.1), A.fadeOut(0.25)]);
  c.text(type, 'price', 5.5, 0.85, { font: 'serif', weight: 600, size: 54, color: C.bone, text: '€ 640', align: 'center', x: 760, y: 1092, w: 240, rotation: -6 }, [A.tw('rotation', -40, 0, 0, 0.5, EASE.back), A.fadeIn(0, 0.15), A.fadeOut(0.25)]);

  // Scene 3: black shutters close again, the drop date, then a bone wipe for the loop.
  [0, 1, 2].forEach((i) => vpanel(c, top, 'shutter2', i * pw - 1, 0, pw + 2, H, C.black, 6.2 + i * 0.08, 2.8 - i * 0.08, 0.45, i % 2 === 0));
  c.text(top, 'drop-k', 6.75, 2.0, { font: 'mono', weight: 500, size: 28, color: C.grey, text: 'MAISON NOIR', align: 'center', x: 0, y: 340, w: W }, [A.wipe(0, 0.5, CUT)]);
  letters(c, top, 'drop', 'Drop 03', { font: 'serif', weight: 300, size: 230, color: C.bone, x: W / 2, y: 420, align: 'center', tracking: 4, end: 8.75 }, 6.8, 0.06,
    () => [A.wipe(0, 0.45, CUT), A.tw('y', 40, 0, 0, 0.8, EASE.expo)]);
  c.text(top, 'date', 7.3, 1.45, { font: 'body', weight: 500, size: 44, color: C.bone, text: 'Thursday 27 November, 10:00 CET', align: 'center', x: 0, y: 760, w: W }, [A.fadeIn(0, 0.4), A.tw('y', 18, 0, 0, 0.5, EASE.expo)]);
  c.shape(top, 'live', 7.55, 1.2, { x: W / 2 - 13, y: 880, w: 26, h: 26, fill: C.red, radius: 13 }, [A.scaleIn(0, 0.3, EASE.back), A.kf('opacity', [[0, 1], [0.25, 0.25], [0.5, 1], [0.75, 0.25], [1, 1]], 0.3, 0.9)]);
  vpanel(c, top, 'bone', 0, 0, W, H, C.bone, 8.5, 0.5, 0.42, true);

  return {
    id: 'gallery-noir-4x5',
    comp: c.build(),
    meta: { format: 'instagram-post-4x5', posterTime: 5.7, label: 'Maison Noir, a fashion label\'s Drop 03: black shutters wipe down and up, the name is cut in thin serif capitals, the shutters part on a coat drawn as a technical flat with red callouts and a swinging price tag, then the drop date on black, in a 4:5 Instagram post.' },
    assets: { 'coat-turned.svg': coat() },
  };
}

/** The coat as a technical flat (400 x 700 units), turned a quarter back so the clip's quarter turn sets it upright. */
function coat() {
  const k = C.black;
  const body = 'M150 50Q200 66 250 50L330 90Q350 100 352 130L374 470L330 478L312 210L314 664Q200 680 86 664L88 210L70 478L26 470L48 130Q50 100 70 90Z';
  const lapels = 'M150 50L118 118L168 146L200 236L232 146L282 118L250 50M168 146L150 50M232 146L250 50';
  const details = [
    'M200 236V664', 'M88 398H312', 'M88 430H312', 'M30 432L72 438M370 432L328 438', 'M112 472H168M232 472H288',
    'M312 430Q330 470 318 520M300 430Q306 480 290 512', 'M200 70V40',
  ].join('');
  const buttons = [[176, 290], [224, 290], [176, 352], [224, 352]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="7"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 700 400"><g transform="translate(0 400) rotate(-90)"><path d="${body}" fill="#E4E0D7"/><g fill="none" stroke="${k}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"><path d="${body}"/><path d="${lapels}"/><path d="${details}" stroke-width="2.6"/></g><rect x="186" y="392" width="28" height="44" rx="3" fill="none" stroke="${k}" stroke-width="3"/><g fill="${k}">${buttons}</g><path d="M96 650H304" stroke="${k}" stroke-width="2" stroke-dasharray="6 6"/></g></svg>`;
}
