import { describe, expect, it } from 'vitest';
import { applyEdit, type Composition, type EditOp } from '../src/index.ts';
import { FILES, clipOf, copy, expectValid, mutate, spike, withParams } from './composition-edit-helpers.ts';

function ok(c: Composition, op: EditOp, ctx?: Parameters<typeof applyEdit>[2]): Composition {
  const before = copy(c);
  const r = applyEdit(c, op, ctx);
  expect(c).toEqual(before);
  if (!r.ok) throw new Error(`refused: ${r.problem.key} ${JSON.stringify(r.problem.params)}`);
  expectValid(r.composition);
  return r.composition;
}
function refused(c: Composition, op: EditOp, key: string, ctx?: Parameters<typeof applyEdit>[2]) {
  const before = copy(c);
  const r = applyEdit(c, op, ctx);
  expect(c).toEqual(before);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.problem.key).toBe(key);
  return r;
}

describe('clipProps', () => {
  it('edits text, style and box of a text clip', () => {
    const out = ok(spike, { kind: 'clipProps', clipId: 'title', props: { text: 'Hi', fontSize: 80, color: '#ff00ff', align: 'left', x: 10, opacity: 0.5 } });
    const expected = copy(spike);
    Object.assign((clipOf(expected, 'title') as { props: object }).props, { text: 'Hi', fontSize: 80, color: '#ff00ff', align: 'left', x: 10, opacity: 0.5 });
    expect(out).toEqual(expected);
  });
  it('edits fill and radius of a shape', () => {
    const out = ok(spike, { kind: 'clipProps', clipId: 'card', props: { fill: '#112233', radius: 12 } });
    expect((clipOf(out, 'card') as { props: object }).props).toMatchObject({ fill: '#112233', radius: 12 });
  });
  it('removes a key set to undefined', () => {
    const out = ok(spike, { kind: 'clipProps', clipId: 'title', props: { fontWeight: undefined, rotation: undefined } });
    expect(clipOf(out, 'title')).toEqual(clipOf(spike, 'title'));
  });
  it.each([
    ['unknown key', 'title', { kenBurns: 1 }],
    ['key of another type', 'title', { fill: '#fff' }],
    ['text key on a shape', 'card', { text: 'x' }],
    ['anything on audio', 'music', { x: 1 }],
    ['__proto__', 'title', JSON.parse('{"__proto__": {"x": 1}}')],
  ])('refuses %s', (_n, clipId, props) => {
    refused(spike, { kind: 'clipProps', clipId, props: props as never }, 'editor.badProp');
  });
  it('refuses values outside the schema and undeclared fonts', () => {
    refused(spike, { kind: 'clipProps', clipId: 'title', props: { opacity: 2 } }, 'editor.invalid');
    refused(spike, { kind: 'clipProps', clipId: 'title', props: { color: 'red' } }, 'editor.invalid');
    refused(spike, { kind: 'clipProps', clipId: 'title', props: { fontSize: Number.NaN } }, 'editor.invalid');
    refused(spike, { kind: 'clipProps', clipId: 'title', props: { text: 'x'.repeat(2001) } }, 'editor.invalid');
    refused(spike, { kind: 'clipProps', clipId: 'title', props: { fontFamily: 'Nope' } }, 'composition.unknownFont');
    refused(spike, { kind: 'clipProps', clipId: 'nope', props: { x: 1 } }, 'editor.unknownClip');
  });
});

describe('locks and flags', () => {
  const lockedClip = mutate((c) => { (clipOf(c, 'title') as { locked?: boolean }).locked = true; });
  const lockedTrack = mutate((c) => { c.tracks.find((t) => t.id === 'text')!.locked = true; });
  const ops: EditOp[] = [
    { kind: 'clipProps', clipId: 'title', props: { x: 1 } },
    { kind: 'clipTiming', clipId: 'title', start: 0.5, duration: 1, ripple: false },
    { kind: 'animationPreset', clipId: 'title', slot: 'in', preset: 'fadeIn', duration: 0.3 },
  ];
  it.each([['clip', lockedClip], ['track', lockedTrack]])('a locked %s refuses every op but flags', (_n, c) => {
    for (const op of ops) refused(c, op, 'editor.locked');
    refused(c, { kind: 'clipMedia', clipId: 'title', volume: 1 }, 'editor.locked');
  });
  it('clipFlags and trackFlags work on locked things and drop false flags', () => {
    const unlocked = ok(lockedClip, { kind: 'clipFlags', clipId: 'title', locked: false, hidden: true });
    expect(clipOf(unlocked, 'title')).toMatchObject({ hidden: true });
    expect(clipOf(unlocked, 'title')).not.toHaveProperty('locked');
    const t = ok(lockedTrack, { kind: 'trackFlags', trackId: 'text', locked: false, muted: true, hidden: true });
    expect(t.tracks.find((x) => x.id === 'text')).toMatchObject({ hidden: true, muted: true });
    expect(t.tracks.find((x) => x.id === 'text')).not.toHaveProperty('locked');
    refused(spike, { kind: 'trackFlags', trackId: 'zzz', hidden: true }, 'editor.unknownTrack');
    refused(spike, { kind: 'clipFlags', clipId: 'zzz', hidden: true }, 'editor.unknownClip');
  });
  it('old compositions without flags stay valid', () => { expectValid(spike); });
});

describe('clipTiming', () => {
  const t = (clipId: string, start: number, duration: number, ripple = false): EditOp => ({ kind: 'clipTiming', clipId, start, duration, ripple });
  it('moves and resizes inside the scene', () => {
    const out = ok(spike, t('title', 0.5, 1));
    expect(clipOf(out, 'title')).toMatchObject({ start: 0.5, duration: 1 });
  });
  it('clamps to the scene, to the start and to one frame', () => {
    expect(clipOf(ok(spike, t('title', -5, 1)), 'title')).toMatchObject({ start: 0, duration: 1 });
    expect(clipOf(ok(spike, t('title', 1.5, 5)), 'title')).toMatchObject({ start: 1.5, duration: 0.5 });
    const late = clipOf(ok(spike, t('title', 9, 1)), 'title');
    expect(late.start).toBeCloseTo(2 - 1 / 30, 5);
    expect(late.duration).toBeCloseTo(1 / 30, 5);
    expect(late.duration).toBeGreaterThanOrEqual(1 / 30);
    expect(clipOf(ok(spike, t('title', 0.5, 0)), 'title').duration).toBeGreaterThanOrEqual(1 / 30);
  });
  it('clamps an unscened clip to the composition', () => {
    expect(clipOf(ok(spike, t('vo', 5, 4)), 'vo')).toMatchObject({ start: 5, duration: 1 });
    expect(clipOf(ok(spike, t('vo', 0, 99)), 'vo')).toMatchObject({ start: 0, duration: 6 });
  });
  it('keeps the entry and exit presets at the edges of a resized clip, and custom animations that fit', () => {
    const c = mutate((x) => { (clipOf(x, 'card') as { animations: unknown[] }).animations.push({ preset: 'fadeOut', start: 1.6, duration: 0.4 }); });
    const out = ok(c, t('card', 0, 1));
    expect((clipOf(out, 'card') as { animations: unknown[] }).animations).toEqual([{ preset: 'fadeIn', duration: 0.3 }, { preset: 'fadeOut', start: 0.6, duration: 0.4 }]);
  });
  it('refuses to cut a custom animation off', () => {
    refused(spike, t('subtitle', 0.6, 0.2), 'composition.animationOutside');
  });
  it('ripple grows the scene and shifts later scenes, clips and the duration', () => {
    const out = ok(spike, t('title', 0.2, 2.5, true));
    expect(out.scenes.map((s) => [s.start, s.duration])).toEqual([[0, 2.7], [2.7, 2], [4.7, 2]]);
    expect(out.duration).toBe(6.7);
    expect(clipOf(out, 'title')).toMatchObject({ start: 0.2, duration: 2.5 });
    expect(clipOf(out, 'photo1')).toMatchObject({ start: 2.7 });
    expect(clipOf(out, 'caption')).toMatchObject({ start: 3.0 });
    expect(clipOf(out, 'outro-html')).toMatchObject({ start: 4.7 });
    expect(clipOf(out, 'whoosh')).toMatchObject({ start: 2.7 });
    expect(clipOf(out, 'bgv')).toMatchObject({ start: 0, duration: 6.7 });
    expect(clipOf(out, 'music')).toMatchObject({ start: 0, duration: 6.7 });
    expect(clipOf(out, 'vo')).toMatchObject({ start: 0.5, duration: 4 });
    expect(clipOf(out, 'card')).toMatchObject({ start: 0, duration: 2 });
  });
  it('ripple without growth behaves like a plain move', () => {
    expect(ok(spike, t('title', 0.5, 1, true))).toEqual(ok(spike, t('title', 0.5, 1)));
  });
  it('ripple on the last scene extends the duration', () => {
    const out = ok(spike, t('outro-html', 4, 3, true));
    expect(out.duration).toBe(7);
    expect(out.scenes[2]).toMatchObject({ start: 4, duration: 3 });
  });
  it('refuses timing on a still', () => {
    const still = mutate((c) => { c.duration = 0; c.scenes = []; c.tracks = [{ id: 'l', kind: 'visual', clips: [{ id: 'img', type: 'image', src: 'assets/photo.jpg', start: 0, duration: 0, props: {} }] }]; });
    refused(still, t('img', 0, 1), 'editor.stillTiming');
  });
  it('refuses non-finite times', () => {
    refused(spike, t('title', Number.NaN, 1), 'editor.badValue');
    refused(spike, t('title', 0, Number.POSITIVE_INFINITY), 'editor.badValue');
  });
});

describe('clipMedia', () => {
  it('replaces the source of an image, a video and an audio clip with a file present', () => {
    expect((clipOf(ok(spike, { kind: 'clipMedia', clipId: 'photo1', src: 'assets/other.jpg' }, { files: FILES }), 'photo1') as { src: string }).src).toBe('assets/other.jpg');
    expect((clipOf(ok(spike, { kind: 'clipMedia', clipId: 'bgv', src: 'assets/other.mp4', trimStart: 1.5, volume: 0.5 }, { files: FILES }), 'bgv') as { trimStart: number }).trimStart).toBe(1.5);
    expect(clipOf(ok(spike, { kind: 'clipMedia', clipId: 'music', volume: 1.2, fadeIn: 1, fadeOut: 2 }), 'music')).toMatchObject({ volume: 1.2, fadeIn: 1, fadeOut: 2 });
  });
  it('refuses sources outside assets/ or missing from the files, and keys of another type', () => {
    refused(spike, { kind: 'clipMedia', clipId: 'photo1', src: 'layers/outro.html' }, 'editor.badAsset');
    refused(spike, { kind: 'clipMedia', clipId: 'photo1', src: 'assets/../x.jpg' }, 'editor.badAsset');
    refused(spike, { kind: 'clipMedia', clipId: 'photo1', src: 'https://x/y.jpg' }, 'editor.badAsset');
    refused(spike, { kind: 'clipMedia', clipId: 'photo1', src: 'assets/missing.jpg' }, 'editor.badAsset', { files: FILES });
    refused(spike, { kind: 'clipMedia', clipId: 'photo1', volume: 1 }, 'editor.badProp');
    refused(spike, { kind: 'clipMedia', clipId: 'bgv', fadeIn: 1 }, 'editor.badProp');
    refused(spike, { kind: 'clipMedia', clipId: 'title', src: 'assets/photo.jpg' }, 'editor.wrongType');
    refused(spike, { kind: 'clipMedia', clipId: 'music', volume: 3 }, 'editor.invalid');
  });
});

describe('htmlParam', () => {
  const c = withParams();
  const set = (key: string, value: string | number): EditOp => ({ kind: 'htmlParam', clipId: 'outro-html', key, value });
  it('sets each type', () => {
    const params = (cc: Composition) => (clipOf(cc, 'outro-html') as { params: Record<string, { value: unknown }> }).params;
    expect(params(ok(c, set('headline', 'Bye'))).headline!.value).toBe('Bye');
    expect(params(ok(c, set('tint', '#0f0'))).tint!.value).toBe('#0f0');
    expect(params(ok(c, set('speed', -3.5))).speed!.value).toBe(-3.5);
    expect(params(ok(c, set('logo', 'assets/other.jpg'), { files: FILES })).logo!.value).toBe('assets/other.jpg');
  });
  it('checks the declared type', () => {
    refused(c, set('headline', 5), 'editor.badParam');
    refused(c, set('headline', 'x'.repeat(2001)), 'editor.badParam');
    refused(c, set('tint', 'red'), 'editor.badParam');
    refused(c, set('tint', '#12345'), 'editor.badParam');
    refused(c, set('speed', 'fast'), 'editor.badParam');
    refused(c, set('speed', Number.NaN), 'editor.badParam');
    refused(c, set('speed', Number.POSITIVE_INFINITY), 'editor.badParam');
    refused(c, set('logo', 'layers/outro.html'), 'editor.badAsset');
    refused(c, set('logo', 'assets/missing.jpg'), 'editor.badAsset', { files: FILES });
    refused(c, set('logo', 'http://x/y.png'), 'editor.badAsset');
    refused(c, set('nope', 'x'), 'editor.unknownParam');
    refused(c, set('__proto__', 'x'), 'editor.unknownParam');
    refused(c, { kind: 'htmlParam', clipId: 'title', key: 'a', value: 'x' }, 'editor.wrongType');
  });
});

describe('addFont', () => {
  it('adds a font with a file present', () => {
    const out = ok(spike, { kind: 'addFont', font: { family: 'Other', src: 'assets/other.ttf' } }, { files: FILES });
    expect(out.fonts).toEqual([...spike.fonts, { family: 'Other', src: 'assets/other.ttf' }]);
  });
  it('refuses duplicates, non-fonts and missing files', () => {
    refused(spike, { kind: 'addFont', font: { family: 'spikefont', src: 'assets/other.ttf' } }, 'editor.fontExists');
    refused(spike, { kind: 'addFont', font: { family: 'Other', src: 'assets/photo.jpg' } }, 'editor.badFont');
    refused(spike, { kind: 'addFont', font: { family: 'Other', src: 'layers/x.ttf' } }, 'editor.badAsset');
    refused(spike, { kind: 'addFont', font: { family: 'Other', src: 'assets/missing.ttf' } }, 'editor.badAsset', { files: FILES });
  });
});

describe('font weights', () => {
  const declaring = (c: Composition) => { c.fonts = [{ family: 'SpikeFont', src: 'assets/spikefont.ttf', weight: 400 }]; return c; };
  it('refuses a weight the family declares it does not have, and accepts a declared one', () => {
    const base = declaring(copy(spike));
    refused(base, { kind: 'clipProps', clipId: 'title', props: { fontWeight: 700 } }, 'editor.badWeight');
    refused(base, { kind: 'clipProps', clipId: 'title', props: { fontWeight: 'bold' } }, 'editor.badWeight');
    ok(base, { kind: 'clipProps', clipId: 'title', props: { fontWeight: 400 } });
  });
  it('leaves families without declared weights free (agent compositions use one file for regular and bold)', () => {
    ok(spike, { kind: 'clipProps', clipId: 'title', props: { fontWeight: 700 } });
  });
});
