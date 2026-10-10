import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  COMPOSITION_LIMITS, COMPOSITION_MAX_BYTES, DEFAULT_FORMATS, compositionProblemText, parseCompositionText, validateComposition,
  type Composition, type CompositionProblem, type FormatPreset,
} from '../src/index.ts';
import { en } from '../src/i18n/en.ts';
import { it as itCatalog } from '../src/i18n/it.ts';

const spike = JSON.parse(readFileSync(new URL('./fixtures/spike-composition.json', import.meta.url), 'utf8')) as Composition;
const preset = (id: string): FormatPreset => DEFAULT_FORMATS.find((f) => f.id === id)!;
const REEL = preset('instagram-reel-9x16');
const SHORTS = preset('youtube-shorts-9x16');
const STORY_IMAGE: FormatPreset = { ...preset('playstore-phone-9x16') };
const FILES = ['composition.json', 'assets/bg.mp4', 'assets/photo.jpg', 'assets/spikefont.ttf', 'assets/logo.svg', 'assets/music.wav', 'assets/voice.wav', 'assets/sfx.wav', 'layers/outro.html'];
const files = (over: Record<string, number | null> = {}) => {
  const m = new Map<string, { size: number }>(FILES.map((f) => [f, { size: 1000 }]));
  for (const [k, v] of Object.entries(over)) { if (v === null) m.delete(k); else m.set(k, { size: v }); }
  return m;
};
const ctx = (over: Partial<Parameters<typeof validateComposition>[1]> = {}) => ({ format: REEL, files: files(), ...over });
const keysOf = (r: { problems: CompositionProblem[] }) => r.problems.map((p) => p.key);
const mutate = (fn: (c: Composition) => void): Composition => { const c = structuredClone(spike); fn(c); return c; };
type AnyClip = Record<string, unknown> & { props?: Record<string, unknown>; animations?: Array<Record<string, unknown>> };
const clip = (c: Composition, t: number, i: number) => c.tracks[t]!.clips[i] as unknown as AnyClip;

describe('validateComposition', () => {
  it('accepts the spike example for the Reel', () => {
    const r = validateComposition(spike, ctx());
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it.each([
    ['overlapping scenes', mutate((c) => { c.scenes[1]!.start = 1.5; c.scenes[1]!.duration = 2.5; }), 'composition.sceneOverlap'],
    ['a gap between scenes', mutate((c) => { c.scenes[1]!.start = 2.5; c.scenes[1]!.duration = 1.5; }), 'composition.sceneGap'],
    ['a first scene that does not start at 0', mutate((c) => { c.scenes[0]!.start = 0.5; c.scenes[0]!.duration = 1.5; }), 'composition.sceneStart'],
    ['scenes that end before the duration', mutate((c) => { c.scenes[2]!.duration = 1; }), 'composition.scenesEnd'],
    ['scenes that end after the duration', mutate((c) => { c.scenes[2]!.duration = 3; }), 'composition.scenesEnd'],
    ['a clip past the end of the composition', mutate((c) => { clip(c, 0, 0).duration = 7; }), 'composition.clipOutside'],
    ['a clip that starts after the end', mutate((c) => { clip(c, 3, 0).start = 6.5; clip(c, 3, 0).duration = 1; }), 'composition.clipOutside'],
    ['a clip outside its scene', mutate((c) => { clip(c, 2, 0).start = 1.5; }), 'composition.clipOutsideScene'],
    ['a clip with an unknown scene', mutate((c) => { clip(c, 2, 0).scene = 'nope'; }), 'composition.unknownScene'],
    ['a zero-length clip in a video', mutate((c) => { clip(c, 2, 0).duration = 0; }), 'composition.clipZero'],
    ['a font family not declared in fonts[]', mutate((c) => { clip(c, 2, 0).props!.fontFamily = 'Helvetica'; }), 'composition.unknownFont'],
    ['a generic CSS family is not a declared font either', mutate((c) => { clip(c, 2, 0).props!.fontFamily = 'sans-serif'; }), 'composition.unknownFont'],
    ['a font that is not a font file under assets/', mutate((c) => { c.fonts[0]!.src = 'layers/spikefont.ttf'; }), 'composition.fontNotAsset'],
    ['a font file with a non-font extension', mutate((c) => { c.fonts[0]!.src = 'assets/photo.jpg'; }), 'composition.fontNotAsset'],
    ['a duplicate id', mutate((c) => { clip(c, 2, 1).id = 'title'; }), 'composition.duplicateId'],
    ['an audio clip on a visual track', mutate((c) => { c.tracks[1]!.clips.push(structuredClone(c.tracks[4]!.clips[0]!)); clip(c, 1, 3).id = 'music2'; }), 'composition.trackKind'],
    ['a visual clip on an audio track', mutate((c) => { c.tracks[4]!.clips.push(structuredClone(c.tracks[3]!.clips[0]!)); clip(c, 4, 4).id = 'logo2'; }), 'composition.trackKind'],
    ['an animation past the end of its clip', mutate((c) => { clip(c, 2, 0).animations![0]!.duration = 3; }), 'composition.animationOutside'],
    ['keyframes out of order', mutate((c) => { (clip(c, 2, 2).animations![0]!.keyframes as Array<{ t: number }>)[2]!.t = 0.2; }), 'composition.keyframesOrder'],
    ['a colour animation with numbers', mutate((c) => { Object.assign(clip(c, 2, 1).animations![0]!, { prop: 'color', from: 0, to: 1 }); }), 'composition.animationValue'],
    ['a numeric animation with colours', mutate((c) => { Object.assign(clip(c, 2, 1).animations![0]!, { from: '#fff', to: '#000' }); }), 'composition.animationValue'],
    ['an html clip whose src is not an .html file in layers/', mutate((c) => { clip(c, 1, 2).src = 'assets/outro.js'; }), 'composition.layerNotHtml'],
    ['a media clip whose src is in layers/', mutate((c) => { clip(c, 1, 1).src = 'layers/photo.jpg'; }), 'composition.mediaNotAsset'],
  ])('%s', (_name, composition, key) => {
    const r = validateComposition(composition, ctx({ files: files({ 'layers/spikefont.ttf': 10, 'assets/outro.js': 10, 'layers/photo.jpg': 10 }) }));
    expect(r.ok).toBe(false);
    expect(keysOf(r)).toContain(key);
  });

  it('a missing asset, layer or font file', () => {
    const r = validateComposition(spike, ctx({ files: files({ 'assets/photo.jpg': null, 'layers/outro.html': null, 'assets/spikefont.ttf': null }) }));
    expect(r.problems.filter((p) => p.key === 'composition.assetMissing').map((p) => p.params.path).sort())
      .toEqual(['assets/photo.jpg', 'assets/spikefont.ttf', 'layers/outro.html']);
  });
  it('an image param pointing to a missing asset', () => {
    const c = mutate((x) => { Object.assign(clip(x, 1, 2), { params: { logo: { type: 'image', value: 'assets/missing.png' } } }); });
    expect(validateComposition(c, ctx()).problems).toContainEqual({ key: 'composition.assetMissing', params: { path: 'assets/missing.png' } });
  });
  it('assets over the default limit of 500 MB per composition, and a configurable limit', () => {
    expect(COMPOSITION_MAX_BYTES).toBe(500 * 1024 * 1024);
    const big = validateComposition(spike, ctx({ files: files({ 'assets/bg.mp4': 501 * 1024 * 1024 }) }));
    expect(keysOf(big)).toContain('composition.assetsTooLarge');
    const small = validateComposition(spike, ctx({ maxBytes: 5000 }));
    expect(small.problems).toContainEqual({ key: 'composition.assetsTooLarge', params: { sizeMB: 0, maxMB: 0 } });
  });
  it('a size that does not match the format', () => {
    const r = validateComposition(spike, ctx({ format: preset('instagram-post-1x1') }));
    expect(r.problems).toContainEqual({ key: 'composition.sizeMismatch', params: { width: 1080, height: 1920, expectedWidth: 1080, expectedHeight: 1080, format: 'instagram-post-1x1' } });
  });
  it('a duration over the format maximum', () => {
    const c = mutate((x) => { x.duration = 70; x.scenes[2]!.duration = 66; });
    expect(validateComposition(c, ctx({ format: SHORTS })).problems).toContainEqual({ key: 'composition.durationOverMax', params: { duration: 70, max: 60, format: SHORTS.id } });
  });
  it('a still for a video format, and a duration for an image format', () => {
    const still = mutate((x) => { x.duration = 0; x.scenes = []; for (const t of x.tracks) t.clips = t.clips.filter((k) => k.start === 0).map((k) => { const s = { ...k, duration: 0 } as AnyClip; delete s.scene; delete s.animations; return s as unknown as typeof k; }); x.tracks = x.tracks.filter((t) => t.kind !== 'audio'); });
    expect(keysOf(validateComposition(still, ctx()))).toContain('composition.stillForVideo');
    expect(validateComposition(still, ctx({ format: STORY_IMAGE })).problems).toEqual([]);
    expect(keysOf(validateComposition(spike, ctx({ format: STORY_IMAGE })))).toContain('composition.durationForImage');
  });
  it('a still has no scenes, every clip starts at 0 and has no audio', () => {
    const still = mutate((x) => { x.duration = 0; for (const t of x.tracks) for (const k of t.clips) k.duration = 0; });
    const keys = keysOf(validateComposition(still, ctx({ format: STORY_IMAGE })));
    expect(keys).toContain('composition.stillScenes');
    expect(keys).toContain('composition.clipStill');
    expect(keys).toContain('composition.stillAudio');
  });

  it.each([
    ['an unknown field', mutate((c) => { (c as unknown as Record<string, unknown>).colour = '#fff'; }), 'composition.unknownField'],
    ['a missing field', mutate((c) => { delete (c as Partial<Composition>).fps; }), 'composition.missingField'],
    ['a wrong type', mutate((c) => { (c as unknown as Record<string, unknown>).width = '1080'; }), 'composition.wrongType'],
    ['a bad colour', mutate((c) => { c.background = 'navy'; }), 'composition.badColor'],
    ['a bad path', mutate((c) => { clip(c, 0, 0).src = 'https://example.com/bg.mp4'; }), 'composition.badPath'],
    ['a bad id', mutate((c) => { c.scenes[0]!.id = 'Intro Scene'; }), 'composition.badId'],
    ['a value out of range', mutate((c) => { clip(c, 4, 0).volume = 9; }), 'composition.tooBig'],
    ['a value not allowed', mutate((c) => { (c as unknown as Record<string, unknown>).fps = 29; }), 'composition.badValue'],
    ['an unknown clip type', mutate((c) => { clip(c, 1, 0).type = 'gif'; }), 'composition.badValue'],
    ['an animation in no known form', mutate((c) => { clip(c, 2, 0).animations![0] = { preset: 'spin', duration: 1 }; }), 'composition.badAnimation'],
    ['not an object', 'hello' as unknown as Composition, 'composition.wrongType'],
  ])('structural: %s', (_name, composition, key) => {
    const r = validateComposition(composition, ctx());
    expect(r.ok).toBe(false);
    expect(keysOf(r)).toContain(key);
  });

  it('names the path of a structural problem', () => {
    const r = validateComposition(mutate((c) => { c.tracks[1]!.clips[0]!.start = -1; }), ctx());
    expect(r.problems).toContainEqual({ key: 'composition.tooSmall', params: { path: 'tracks[1].clips[0].start', min: 0 } });
  });

  it.each([
    ['tracks', (n: number) => mutate((c) => { c.tracks = Array.from({ length: n }, (_, i) => ({ id: `t${i}`, kind: 'visual' as const, clips: [] })); }), COMPOSITION_LIMITS.tracks],
    ['scenes', (n: number) => mutate((c) => { c.scenes = Array.from({ length: n }, (_, i) => ({ id: `s${i}`, name: 's', start: i, duration: 1 })); }), COMPOSITION_LIMITS.scenes],
    ['clips in all', (n: number) => mutate((c) => { c.tracks = Array.from({ length: Math.ceil(n / 400) }, (_, t) => ({ id: `t${t}`, kind: 'visual' as const, clips: Array.from({ length: 400 }, (_, i) => ({ id: `c${t}-${i}`, type: 'shape' as const, start: 0, duration: 1, props: {} })) })); }), COMPOSITION_LIMITS.clips],
  ])('bounded: more than the limit of %s is one problem, checked before anything else', (_name, make, limit) => {
    const r = validateComposition(make(limit + 1000), ctx());
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]!.key).toBe('composition.limit');
    expect(r.problems[0]!.params.max).toBe(limit);
  });
  it('bounded: a huge array is refused without walking it', () => {
    const c = mutate((x) => { x.tracks[0]!.clips = new Array(5_000_000); });
    const t0 = performance.now();
    const r = validateComposition(c, ctx());
    expect(keysOf(r)).toEqual(['composition.limit']);
    expect(performance.now() - t0).toBeLessThan(5000);
  });
  it('bounded: the number of problems is capped', () => {
    const c = mutate((x) => { x.tracks = Array.from({ length: 60 }, (_, t) => ({ id: `t${t}`, kind: 'visual' as const, clips: Array.from({ length: 20 }, (_, i) => ({ id: `c${t}-${i}`, type: 'image' as const, src: `assets/missing-${t}-${i}.png`, start: 0, duration: 1, props: {} })) })); });
    const r = validateComposition(c, ctx());
    expect(r.problems.length).toBeLessThanOrEqual(COMPOSITION_LIMITS.problems + 1);
    expect(r.problems.at(-1)!.key).toBe('composition.moreProblems');
  });
  it('limits are documented in the problem text', () => {
    expect(compositionProblemText({ key: 'composition.limit', params: { path: 'tracks', max: 64 } }, 'en')).toContain('64');
  });
});

describe('parseCompositionText', () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  it('parses UTF-8 JSON, with or without a BOM', () => {
    expect(parseCompositionText(bytes('{"a":1}'))).toEqual({ ok: true, value: { a: 1 } });
    expect(parseCompositionText(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('{"a":"è"}')]))).toEqual({ ok: true, value: { a: 'è' } });
  });
  it.each([
    ['invalid UTF-8', new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]), 'composition.jsonNotUtf8'],
    ['Latin-1 text', new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xe8, 0x22, 0x7d]), 'composition.jsonNotUtf8'],
    ['UTF-16 with BOM', new Uint8Array([0xff, 0xfe, 0x7b, 0x00, 0x7d, 0x00]), 'composition.jsonNotUtf8'],
    ['a BOM-only file', new Uint8Array([0xef, 0xbb, 0xbf]), 'composition.jsonEmpty'],
    ['an empty file', new Uint8Array([]), 'composition.jsonEmpty'],
    ['whitespace only', bytes(' \n\t '), 'composition.jsonEmpty'],
    ['a syntax error', bytes('{"a":1,}'), 'composition.jsonSyntax'],
    ['a file over the size limit', new Uint8Array(COMPOSITION_LIMITS.jsonBytes + 1).fill(0x20), 'composition.jsonTooLarge'],
  ])('rejects %s', (_name, b, key) => {
    const r = parseCompositionText(b);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.map((p) => p.key)).toEqual([key]);
  });
});

describe('composition problem texts', () => {
  const keys = Object.keys(en.composition);
  it('every key has a text in both catalogs', () => {
    expect(Object.keys(itCatalog.composition).sort()).toEqual([...keys].sort());
  });
  it('an unknown key falls back to the key itself', () => {
    expect(compositionProblemText({ key: 'composition.nope', params: {} }, 'en')).toBe('composition.nope');
  });
  it('every problem produced in these tests is translated in en and it', () => {
    const produced: CompositionProblem[] = [];
    produced.push(...validateComposition(mutate((c) => { c.scenes[1]!.start = 2.5; clip(c, 2, 0).props!.fontFamily = 'X'; c.background = 'x'; }), ctx({ maxBytes: 1 })).problems);
    produced.push(...validateComposition(spike, ctx({ format: preset('instagram-post-1x1'), files: files({ 'assets/photo.jpg': null }) })).problems);
    for (const p of produced) for (const l of ['en', 'it'] as const) {
      const t = compositionProblemText(p, l);
      expect(t, `${l}:${p.key}`).not.toBe(p.key);
      expect(t).not.toContain('undefined');
    }
  });
});
