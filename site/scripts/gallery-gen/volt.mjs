// VOLT Run Club: a city running club's weekly run, 1:1. Kinetic sports type on a diagonal: speed lines whip across, words
// slam in from the right with a motion blur and leave to the left, a volt flash carries three marquee rows, then the lockup.
import { makeComp, A, EASE, tw } from '../hero-gen/lib.mjs';
import { seeded, letters } from './kit.mjs';

const C = { black: '#0A0A0A', volt: '#D7FF1F', white: '#F4F4F0', grey: '#3A3A3A' };
const W = 1080; const H = 1080; const D = 8;
const TILT = -10;
const SC = [
  { id: 'slam', name: 'Words slam in', start: 0, duration: 3 },
  { id: 'ticker', name: 'Volt marquee', start: 3, duration: 2.6 },
  { id: 'lockup', name: 'Lockup', start: 5.6, duration: 2.4 },
];
const SLAM = { in: 'cubic-bezier(.2,1.25,.4,1)', out: 'cubic-bezier(.6,0,.9,.3)' };

export function volt() {
  const c = makeComp({ width: W, height: H, duration: D, background: C.black, scenes: SC });
  const lines = c.track('speed');
  const type = c.track('type', 'text');
  const flash = c.track('flash');
  const top = c.track('front');

  // Speed lines across the whole film: thin bars on the diagonal, whipping right to left.
  const rand = seeded(9);
  for (let i = 0; i < 34; i++) {
    const s = rand() * (D - 0.9); const dur = 0.45 + rand() * 0.45;
    const len = 180 + rand() * 620; const th = 4 + Math.round(rand() * 10);
    const y = 60 + rand() * (H - 120);
    const col = rand() < 0.25 ? C.volt : C.white;
    c.shape(lines, 'speed', s, dur, { x: W / 2 - len / 2, y, w: len, h: th, fill: col, radius: th / 2, rotation: TILT, opacity: 0.35 + rand() * 0.5 }, [A.tw('x', W + len, -W - len, 0, dur, EASE.lin)]);
  }

  // Scene 1: three words slam in, hold, and leave.
  const WORDS = [['RUN', C.white, 470, 0.12, 1.1], ['FASTER', C.volt, 300, 1.0, 2.05], ['TOGETHER', C.white, 230, 1.95, 3.0]];
  WORDS.forEach(([word, color, size, s, e]) => {
    const ww = tw(word, size, 'condensed', 400) + 40;
    c.text(type, 'slam', s, e - s, { font: 'condensed', weight: 400, size, color, text: word, align: 'center', x: (W - ww) / 2, y: (H - size * 1.5) / 2, w: ww, rotation: TILT }, [
      A.tw('x', 1100, 0, 0, 0.32, SLAM.in), A.tw('blur', 26, 0, 0, 0.26), A.tw('scale', 1.25, 1, 0, 0.4, EASE.expo),
      A.tw('x', 0, -1300, e - s - 0.24, 0.24, SLAM.out), A.tw('blur', 0, 22, e - s - 0.2, 0.2),
    ]);
  });
  c.text(type, 'k', 0.3, 2.6, { font: 'mono', weight: 700, size: 26, color: C.volt, text: 'VOLT RUN CLUB  /  WEEK 41', x: 60, y: 60, w: 600 }, [A.wipe(0, 0.4), A.fadeOut(0.2)]);

  // Scene 2: a volt flash, three marquee rows on the tilt, and the distances counted in a black disc.
  c.shape(flash, 'flash', 2.95, 2.75, { x: -400, y: -400, w: W + 800, h: H + 800, fill: C.volt, rotation: TILT }, [A.wipe(0, 0.22, EASE.inOut)]);
  const unit = 'RUN CLUB  ·  6:30 AM  ·  RIVERSIDE  ·  ';
  const uw = tw(unit, 170, 'condensed', 400);
  [-1, 0, 1].forEach((row, i) => {
    const text = unit.repeat(4);
    const bw = uw * 4;
    const dir = i % 2 ? 1 : -1;
    c.text(flash, 'row', 3.05, 2.6, { font: 'condensed', weight: 400, size: 170, color: i === 1 ? C.black : '#0A0A0A', text, x: W / 2 - bw / 2, y: H / 2 - 120 + row * 250, w: bw + 40, rotation: TILT, opacity: i === 1 ? 1 : 0.22 }, [
      A.tw('x', dir < 0 ? 0 : -uw, dir < 0 ? -uw : 0, 0, 2.6, EASE.lin),
    ]);
  });
  const R = 380;
  c.shape(flash, 'disc', 3.35, 2.25, { x: (W - R) / 2, y: (H - R) / 2, w: R, h: R, fill: C.black, radius: R / 2 }, [A.scaleIn(0, 0.35, EASE.back), A.tw('scale', 1, 0, 1.95, 0.3, EASE.in)]);
  ['5K', '10K', '21K'].forEach((d, i) => {
    const s = 3.5 + i * 0.6;
    c.text(flash, 'dist', s, i === 2 ? 5.3 - s : 0.6, { font: 'condensed', weight: 400, size: 170, color: C.volt, text: d, align: 'center', x: (W - R) / 2, y: H / 2 - 170 * 0.72, w: R, rotation: TILT }, [A.tw('y', 60, 0, 0, 0.25, EASE.back), A.tw('scale', 1.4, 1, 0, 0.3, EASE.expo), A.fadeIn(0, 0.08)]);
  });

  // Scene 3: back to black with a diagonal slab, the lockup, then everything whips off to the left for the loop.
  c.shape(top, 'slab', 5.5, 2.5, { x: -500, y: -500, w: W + 1000, h: H + 1000, fill: C.black, rotation: TILT }, [A.tw('x', W + 1100, 0, 0, 0.35, EASE.expo)]);
  const out = (s) => [A.tw('x', 0, -1400, 7.55 - s, 0.3, SLAM.out), A.tw('blur', 0, 20, 7.6 - s, 0.25)];
  letters(c, top, 'volt', 'VOLT', { font: 'condensed', weight: 400, size: 360, color: C.white, x: W / 2, y: 150, align: 'center', tracking: 6, rotation: TILT, end: 8 }, 5.75, 0.07,
    (i, s) => [A.tw('y', -500, 0, 0, 0.42, SLAM.in), A.tw('blur', 18, 0, 0, 0.3), ...out(s)]);
  const sub = 'RUN CLUB';
  letters(c, top, 'club', sub, { font: 'condensed', weight: 400, size: 128, color: C.volt, x: W / 2, y: 640, align: 'center', tracking: 26, rotation: TILT, end: 8 }, 6.1, 0.035,
    (i, s) => [A.tw('x', 300, 0, 0, 0.35, EASE.expo), A.fadeIn(0, 0.1), ...out(s)]);
  c.text(top, 'when', 6.5, 1.5, { font: 'body', weight: 600, size: 38, color: C.white, text: 'Thursdays, 6:30 am · Riverside Bridge', align: 'center', x: 0, y: 860, w: W }, [A.fadeIn(0, 0.3), A.tw('y', 20, 0, 0, 0.4, EASE.expo), ...out(6.5)]);
  const bw = 260; const bh = 72;
  c.shape(top, 'join', 6.7, 1.3, { x: (W - bw) / 2, y: 945, w: bw, h: bh, fill: C.volt, radius: bh / 2 }, [A.pop(0, 0.35), ...out(6.7)]);
  c.text(top, 'join-t', 6.78, 1.22, { font: 'body', weight: 700, size: 30, color: C.black, text: 'Join free  →', align: 'center', x: (W - bw) / 2, y: 945 + bh * 0.22, w: bw }, [A.fadeIn(0, 0.2), ...out(6.78)]);

  return {
    id: 'gallery-volt-1x1',
    comp: c.build(),
    meta: { format: 'instagram-post-1x1', posterTime: 4.1, label: 'VOLT Run Club, a weekly city run: speed lines whip across a diagonal, RUN, FASTER and TOGETHER slam in with a motion blur, a volt flash carries marquee rows and the distances, then the lockup, in a 1:1 Instagram post.' },
    assets: {},
  };
}
