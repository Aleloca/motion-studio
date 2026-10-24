// Night Sky 101: an evening astronomy course, 1:1. Chalk on a blackboard: stars pop, the Big Dipper is joined line by line
// and points to Polaris, an eraser wipes the board, the planets turn on their orbits around a chalk sun, then the course's
// dates and an enrol button drawn in chalk; the eraser clears the board for the loop.
import { makeComp, A, EASE } from '../hero-gen/lib.mjs';
import { seeded, f1, line } from './kit.mjs';

const C = { board: '#1F2B26', chalk: '#ECEAE1', yellow: '#F3D36B', pink: '#EFA3A0', blue: '#9CC9E8', dust: '#3A4741' };
const W = 1080; const H = 1080; const D = 9;
const SC = [
  { id: 'stars', name: 'The Big Dipper', start: 0, duration: 3.3 },
  { id: 'orbits', name: 'Orbits', start: 3.3, duration: 3.1 },
  { id: 'enrol', name: 'Enrol', start: 6.4, duration: 2.6 },
];
// The Big Dipper (handle to bowl), on the board; Polaris beyond the bowl's pointer stars.
const STARS = { alkaid: [150, 640], mizar: [290, 560], alioth: [410, 548], megrez: [540, 566], phecda: [580, 700], merak: [770, 700], dubhe: [800, 540] };
const POLARIS = [880, 250];
const JOIN = [['alkaid', 'mizar'], ['mizar', 'alioth'], ['alioth', 'megrez'], ['megrez', 'dubhe'], ['dubhe', 'merak'], ['merak', 'phecda'], ['phecda', 'megrez']];

/** The eraser crosses the board in `dur` s from `start`; it covers it all at `start + dur / 2`. */
function eraser(c, track, start, dur) {
  c.svg(track, 'eraser', start, dur, 'eraser.svg', { x: 0, y: 0, w: 2000, h: H, fit: 'fill' }, [A.tw('x', -2000, W, 0, dur, 'linear')]);
}

export function nightsky() {
  const c = makeComp({ width: W, height: H, duration: D, background: C.board, scenes: SC });
  const board = c.track('board');
  const chalk = c.track('chalk');
  const type = c.track('type', 'text');
  const top = c.track('eraser');

  c.svg(board, 'smudge', 0, D, 'smudge.svg', { x: 0, y: 0, w: W, h: H }, []);
  const ERASE1 = 3.05; const E1 = 0.9; const CUT1 = ERASE1 + E1 / 2;
  const ERASEM = 6.0; const EM = 0.7; const CUTM = ERASEM + EM / 2;
  const ERASE2 = 8.3; const E2 = 0.7; const CUT2 = ERASE2 + E2 / 2;

  // Scene 1: the title in chalk, a scatter of stars, then the Dipper joined line by line and its pointer to Polaris.
  c.text(type, 'title', 0.15, CUT1 - 0.15, { font: 'hand', weight: 700, size: 120, color: C.chalk, text: 'Night Sky 101', x: 70, y: 40, w: 760 }, [A.wipe(0, 0.9, 'cubic-bezier(.45,0,.55,1)')]);
  const rand = seeded(77);
  for (let i = 0; i < 46; i++) {
    const x = 40 + rand() * (W - 80); const y = 230 + rand() * (H - 300); const s = 0.3 + rand() * 1.2; const r = 3 + rand() * 5;
    c.shape(chalk, 'star', s, CUT1 - s, { x, y, w: r, h: r, fill: C.chalk, radius: r / 2, opacity: 0.35 + rand() * 0.4 }, [A.scaleIn(0, 0.3, EASE.back), A.kf('opacity', [[0, 1], [0.5, 0.4, EASE.sine], [1, 1, EASE.sine]], 0.3, Math.min(1 + rand(), CUT1 - s - 0.3))]);
  }
  Object.values(STARS).forEach(([x, y], i) => {
    const s = 0.5 + i * 0.08;
    c.svg(chalk, 'big', s, CUT1 - s, 'star.svg', { x: x - 28, y: y - 28, w: 56, h: 56 }, [A.tw('scale', 0, 1, 0, 0.4, EASE.back), A.tw('rotation', -90, 0, 0, 0.6, EASE.quint), A.kf('scale', [[0, 1], [0.5, 1.2, EASE.sine], [1, 1, EASE.sine]], 0.5, 1.4)]);
  });
  JOIN.forEach(([a, b], i) => {
    const s = 1.1 + i * 0.16;
    line(c, chalk, 'join', STARS[a], STARS[b], 5, C.chalk, s, CUT1, 0.22, 'cubic-bezier(.5,0,.5,1)');
  });
  // Merak to Dubhe, five times on: Polaris.
  line(c, chalk, 'pointer', STARS.dubhe, [POLARIS[0] - 6, POLARIS[1] + 34], 3, C.yellow, 2.25, CUT1, 0.4, 'cubic-bezier(.5,0,.5,1)');
  c.svg(chalk, 'polaris', 2.55, CUT1 - 2.55, 'star-yellow.svg', { x: POLARIS[0] - 40, y: POLARIS[1] - 40, w: 80, h: 80 }, [A.tw('scale', 0, 1, 0, 0.4, EASE.back), A.tw('rotation', 0, 90, 0, 0.9, EASE.lin)]);
  c.text(type, 'pol-l', 2.5, CUT1 - 2.5, { font: 'hand', weight: 700, size: 52, color: C.yellow, text: 'Polaris, the North Star', align: 'right', x: 250, y: 284, w: 560 }, [A.wipe(0, 0.4)]);
  c.text(type, 'dip-l', 2.0, CUT1 - 2.0, { font: 'hand', weight: 700, size: 60, color: C.pink, text: 'the Big Dipper', x: 300, y: 770, w: 500, rotation: -4 }, [A.wipe(0, 0.45)]);
  eraser(c, top, ERASE1, E1);

  // Scene 2: a chalk sun and two orbits; Earth and Mars turn on them, with their years.
  const O = { x: 540, y: 600 };
  c.svg(chalk, 'sun', CUT1, CUTM - CUT1, 'sun.svg', { x: O.x - 80, y: O.y - 80, w: 160, h: 160 }, [A.tw('scale', 0, 1, 0, 0.5, EASE.back), A.tw('rotation', 0, 120, 0, CUTM - CUT1, EASE.lin)]);
  const ORB = [{ rx: 250, ry: 110, col: C.blue, name: 'Earth', year: '1 year', size: 34, turn: 0.55, phase: 0.6, s: 3.75 }, { rx: 420, ry: 190, col: C.pink, name: 'Mars', year: '1.9 years', size: 26, turn: 0.3, phase: 2.4, s: 3.95 }];
  ORB.forEach((o, i) => {
    c.svg(chalk, 'orbit', o.s, CUTM - o.s, `orbit-${i}.svg`, { x: O.x - o.rx - 6, y: O.y - o.ry - 6, w: o.rx * 2 + 12, h: o.ry * 2 + 12 }, [A.wipe(0, 0.6, 'cubic-bezier(.5,0,.5,1)')]);
    const dur = CUTM - o.s - 0.3; const n = 24;
    const at = (k) => o.phase + (k / n) * o.turn * Math.PI * 2 * (dur / 3);
    const xs = []; const ys = [];
    for (let k = 0; k <= n; k++) { xs.push([k / n, Math.round(Math.cos(at(k)) * o.rx)]); ys.push([k / n, Math.round(Math.sin(at(k)) * o.ry)]); }
    c.shape(chalk, 'planet', o.s + 0.3, dur, { x: O.x - o.size / 2, y: O.y - o.size / 2, w: o.size, h: o.size, fill: o.col, radius: o.size / 2 }, [A.kf('x', xs, 0, dur), A.kf('y', ys, 0, dur), A.scaleIn(0, 0.3, EASE.back)]);
    c.text(type, 'orb-l', o.s + 0.5, CUTM - o.s - 0.5, { font: 'hand', weight: 700, size: 52, color: o.col, text: `${o.name} · ${o.year}`, x: i ? 90 : 640, y: i ? 830 : 400, w: 420 }, [A.wipe(0, 0.45)]);
  });
  c.text(type, 'orb-t', 3.6, CUTM - 3.6, { font: 'hand', weight: 700, size: 92, color: C.chalk, text: 'Why do years differ?', x: 70, y: 70, w: 960 }, [A.wipe(0, 0.8, 'cubic-bezier(.45,0,.55,1)')]);

  eraser(c, top, ERASEM, EM);

  // Scene 3: the course, with a chalk button.
  c.text(type, 'c1', 6.55, CUT2 - 6.55, { font: 'mono', weight: 600, size: 28, color: C.yellow, text: 'EVENING COURSE  ·  6 SESSIONS', x: 90, y: 200, w: 800 }, [A.wipe(0, 0.5)]);
  c.text(type, 'c2', 6.65, CUT2 - 6.65, { font: 'hand', weight: 700, size: 104, color: C.chalk, text: 'Learn the sky\nin six evenings', x: 84, y: 250, w: 920 }, [A.wipe(0, 0.8, 'cubic-bezier(.45,0,.55,1)')]);
  c.text(type, 'c3', 7.25, CUT2 - 7.25, { font: 'body', weight: 500, size: 40, color: C.chalk, text: 'Tuesdays from 12 January · first class free', x: 90, y: 560, w: 920 }, [A.fadeIn(0, 0.4), A.tw('y', 16, 0, 0, 0.5, EASE.expo)]);
  const B = { x: 90, y: 680, w: 340, h: 104 };
  const corners = [[B.x, B.y], [B.x + B.w, B.y + 4], [B.x + B.w - 4, B.y + B.h], [B.x + 2, B.y + B.h - 3]];
  corners.forEach((p, i) => line(c, chalk, 'btn', p, corners[(i + 1) % 4], 5, C.yellow, 7.45 + i * 0.1, CUT2, 0.16, 'linear'));
  c.text(type, 'btn-t', 7.75, CUT2 - 7.75, { font: 'hand', weight: 700, size: 64, color: C.yellow, text: 'Enrol  →', align: 'center', x: B.x, y: B.y + 8, w: B.w }, [A.wipe(0, 0.35)]);
  c.svg(chalk, 'moon', 6.7, CUT2 - 6.7, 'moon.svg', { x: 760, y: 700, w: 230, h: 230 }, [A.tw('rotation', -40, 0, 0, 0.8, EASE.backSoft), A.fadeIn(0, 0.4)]);
  eraser(c, top, ERASE2, E2);

  return {
    id: 'gallery-nightsky-1x1',
    comp: c.build(),
    meta: { format: 'instagram-post-1x1', posterTime: 2.95, label: 'Night Sky 101, an evening astronomy course: on a chalkboard the Big Dipper is joined star by star and points to Polaris, an eraser wipes the board, Earth and Mars turn on their orbits around a chalk sun, then the course and an Enrol button drawn in chalk, in a 1:1 Instagram post.' },
    assets: {
      'smudge.svg': smudge(), 'eraser.svg': eraserSvg(), 'star.svg': star(C.chalk), 'star-yellow.svg': star(C.yellow), 'sun.svg': sun(), 'moon.svg': moon(),
      'orbit-0.svg': orbit(ORB[0]), 'orbit-1.svg': orbit(ORB[1]),
    },
  };
}

function smudge() {
  const rand = seeded(3);
  const blobs = Array.from({ length: 7 }, () => `<ellipse cx="${f1(rand() * W)}" cy="${f1(rand() * H)}" rx="${f1(160 + rand() * 260)}" ry="${f1(60 + rand() * 120)}" transform="rotate(${f1(rand() * 40 - 20)})"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"><defs><filter id="b"><feGaussianBlur stdDeviation="40"/></filter></defs><g fill="${C.dust}" opacity=".55" filter="url(#b)">${blobs}</g><rect x="0" y="${H - 26}" width="${W}" height="26" fill="#2A372F"/></svg>`;
}

/** The eraser's pass: a soft leading and trailing edge, a solid middle wider than the board, a dusty trail. */
function eraserSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2000 1080" preserveAspectRatio="none"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${C.board}" stop-opacity="0"/><stop offset=".15" stop-color="${C.board}"/><stop offset=".85" stop-color="${C.board}"/><stop offset="1" stop-color="${C.board}" stop-opacity="0"/></linearGradient></defs><rect width="2000" height="1080" fill="url(#g)"/><g stroke="${C.dust}" stroke-width="18" opacity=".5" stroke-linecap="round"><path d="M320 200H1700M320 420H1700M320 640H1700M320 860H1700"/></g></svg>`;
}

function star(col) {
  const pts = Array.from({ length: 10 }, (_, i) => { const a = (i / 10) * Math.PI * 2 - Math.PI / 2; const r = i % 2 ? 9 : 26; return `${f1(28 + r * Math.cos(a))},${f1(28 + r * Math.sin(a))}`; }).join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 56"><polygon points="${pts}" fill="${col}" stroke="${col}" stroke-width="3" stroke-linejoin="round"/></svg>`;
}

function sun() {
  const rays = Array.from({ length: 12 }, (_, i) => { const a = (i / 12) * Math.PI * 2; return `<path d="M${f1(80 + 52 * Math.cos(a))} ${f1(80 + 52 * Math.sin(a))}L${f1(80 + 74 * Math.cos(a))} ${f1(80 + 74 * Math.sin(a))}"/>`; }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160"><g fill="none" stroke="${C.yellow}" stroke-width="6" stroke-linecap="round"><circle cx="80" cy="80" r="40"/>${rays}<path d="M62 74l14 14M70 62l26 26M84 62l12 12" stroke-width="4" opacity=".7"/></g></svg>`;
}

function moon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 220"><path d="M150 30A90 90 0 1 0 190 160 74 74 0 1 1 150 30z" fill="none" stroke="${C.chalk}" stroke-width="7" stroke-linejoin="round"/><g fill="${C.chalk}" opacity=".5"><circle cx="80" cy="120" r="9"/><circle cx="104" cy="160" r="6"/><circle cx="66" cy="80" r="5"/></g></svg>`;
}

function orbit({ rx, ry, col }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${rx * 2 + 12} ${ry * 2 + 12}"><ellipse cx="${rx + 6}" cy="${ry + 6}" rx="${rx}" ry="${ry}" fill="none" stroke="${col}" stroke-width="4" stroke-dasharray="14 12" opacity=".8"/></svg>`;
}
