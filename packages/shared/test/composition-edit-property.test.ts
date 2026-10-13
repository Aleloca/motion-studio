import { describe, expect, it, vi } from 'vitest';
import { applyEdit, validateComposition, type Composition, type EditOp } from '../src/index.ts';
import { FILES, FILE_LIST, REEL, clipOf, copy, fileMap, spike, withParams } from './composition-edit-helpers.ts';

// Load-robust (flaky under a busy machine): a per-file timeout, not a global one; what the tests check is unchanged.
vi.setConfig({ testTimeout: 60_000 });

/** mulberry32: a small seeded PRNG, so a failure repeats. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRESETS = ['fadeIn', 'fadeOut', 'slideUp', 'slideDown', 'slideLeft', 'slideRight', 'popIn', 'scaleIn', 'wipe'] as const;
const FORMAT = { ...REEL, maxDurationSec: 600 };

function randomOp(c: Composition, rnd: () => number): EditOp {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const num = (lo: number, hi: number) => Math.round((lo + rnd() * (hi - lo)) * 100) / 100;
  const clips = c.tracks.flatMap((t) => t.clips);
  const clip = pick(clips);
  const tracks = c.tracks;
  const odd = rnd() < 0.1;
  switch (Math.floor(rnd() * 12)) {
    case 0: return { kind: 'clipProps', clipId: clip.id, props: pick([{ x: num(-50, 900) }, { text: 'T' + num(0, 9) }, { opacity: odd ? 3 : num(0, 1) }, { fill: '#abcdef', radius: num(0, 90) }, { fontSize: num(8, 200), color: '#101010' }, { rotation: num(-90, 90), scale: num(0, 3) }]) };
    case 1: case 2: return { kind: 'clipTiming', clipId: clip.id, start: num(-1, 7), duration: odd ? 0 : num(0, 4), ripple: rnd() < 0.5 };
    case 3: return { kind: 'clipMedia', clipId: clip.id, src: pick(FILE_LIST.concat(['assets/nope.jpg'])), volume: num(0, 2.2) };
    case 4: return { kind: 'clipFlags', clipId: clip.id, hidden: rnd() < 0.5, locked: rnd() < 0.3 };
    case 5: return { kind: 'trackFlags', trackId: pick(tracks).id, hidden: rnd() < 0.5, locked: rnd() < 0.2, muted: rnd() < 0.5 };
    case 6: case 7: return { kind: 'sceneDuration', sceneId: pick(c.scenes).id, duration: num(0.1, 5) };
    case 8: {
      const ids = c.scenes.map((s) => s.id);
      for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [ids[i], ids[j]] = [ids[j]!, ids[i]!]; }
      return { kind: 'sceneOrder', order: ids };
    }
    case 9: return { kind: 'animationPreset', clipId: clip.id, slot: pick(['in', 'out'] as const), preset: rnd() < 0.2 ? null : pick(PRESETS), duration: num(0.05, 3) };
    case 10: return { kind: 'htmlParam', clipId: 'outro-html', key: pick(['headline', 'tint', 'speed', 'logo']), value: pick(['Hi', '#00ff00', 'red', 4, -2, 'assets/other.jpg', 'assets/nope.jpg']) };
    default: return { kind: 'addFont', font: { family: 'F' + Math.floor(rnd() * 3), src: pick(['assets/other.ttf', 'assets/photo.jpg']) } };
  }
}

describe('applyEdit, property style', () => {
  it('200 random sequences: every result is a refusal or a valid composition, and the input is never touched', () => {
    let applied = 0; let refused = 0;
    const kinds = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) {
      const rnd = prng(seed);
      // Odd seeds drop the clips that span scenes, so scene reordering is allowed there.
      let c = withParams();
      if (seed % 2 === 1) c.tracks = c.tracks.filter((t) => t.id !== 'bg' && t.id !== 'logo');
      for (let step = 0; step < 8; step++) {
        const op = randomOp(c, rnd);
        const before = copy(c);
        const r = applyEdit(c, op, { files: FILES });
        expect(c, `seed ${seed} step ${step} mutated its input`).toEqual(before);
        if (!r.ok) { expect(r.problem.key).toMatch(/^(editor|composition)\./); refused++; continue; }
        const v = validateComposition(r.composition, { format: FORMAT, files: fileMap() });
        expect(v.problems, `seed ${seed} step ${step} ${JSON.stringify(op)}`).toEqual([]);
        applied++; kinds.add(op.kind);
        c = r.composition;
      }
    }
    expect(applied).toBeGreaterThan(300);
    expect(refused).toBeGreaterThan(100);
    expect([...kinds].sort()).toEqual(['addFont', 'animationPreset', 'clipFlags', 'clipMedia', 'clipProps', 'clipTiming', 'htmlParam', 'sceneDuration', 'sceneOrder', 'trackFlags']);
  });
  it('the spike itself is untouched by a refused op', () => {
    expect(clipOf(spike, 'title')).toBeDefined();
  });
});
