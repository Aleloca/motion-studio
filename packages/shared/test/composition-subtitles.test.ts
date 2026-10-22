import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FORMATS, applyLocalization, compositionJsonSchema, compositionSchema, localizableEntries, stripSubtitles, subtitlesClipOf,
  validateComposition, type Composition, type Localization,
} from '../src/index.ts';

const REEL = DEFAULT_FORMATS.find((f) => f.id === 'instagram-reel-9x16')!;
const ctx = { format: REEL, files: new Map<string, { size: number }>([['composition.json', { size: 10 }], ['assets/inter.ttf', { size: 10 }], ['layers/subs.html', { size: 10 }]]) };
const subsClip = (over: Record<string, unknown> = {}) => ({
  id: 'subs', type: 'subtitles', start: 0, duration: 10,
  props: { fontSize: 64, color: '#ffffff', position: 'bottom', margin: 120, maxWidth: 0.8 }, ...over,
});
const base = (tracks: unknown[] = [], duration = 10): Composition => ({
  $schema: 'motion-studio/composition@1', width: 1080, height: 1920, fps: 30, duration, background: '#000000',
  fonts: [{ family: 'Inter', src: 'assets/inter.ttf' }], scenes: duration > 0 ? [{ id: 'all', start: 0, duration }] : [],
  tracks: [
    { id: 'text', kind: 'text', clips: [{ id: 'title', type: 'text', start: 0, duration: duration || 0, props: { text: 'Hello', fontFamily: 'Inter' } }] },
    ...tracks,
  ],
}) as Composition;
const track = (clips: unknown[], id = 'subtitles') => ({ id, kind: 'subtitles', clips });
const keys = (c: unknown) => validateComposition(c, ctx).problems.map((p) => p.key);

describe('the subtitles track', () => {
  it('a composition with the track validates; without it, as today', () => {
    expect(validateComposition(base([track([subsClip()])]), ctx).problems).toEqual([]);
    expect(validateComposition(base(), ctx).problems).toEqual([]);
  });
  it('accepts every optional prop and a layers/ template', () => {
    const c = base([track([subsClip({ template: 'layers/subs.html', props: {
      fontFamily: 'Inter', fontSize: 64, fontWeight: 'bold', color: '#fff', lineHeight: 1.2, align: 'center', position: 'middle', margin: 0, maxWidth: 1,
      background: '#00000088', boxPadding: 12, boxRadius: 8, outlineColor: '#000', outlineWidth: 4, shadow: true, entrance: 'pop', entranceSec: 0.2, highlight: { color: '#ff0' },
    } })])]);
    expect(validateComposition(c, ctx).problems).toEqual([]);
  });
  it('two subtitles tracks: subtitlesTwice', () => {
    expect(keys(base([track([subsClip()]), track([subsClip({ id: 'subs2' })], 'subtitles-2')]))).toContain('composition.subtitlesTwice');
  });
  it('a clip that does not span the composition: subtitlesSpan', () => {
    expect(keys(base([track([subsClip({ duration: 5 })])]))).toContain('composition.subtitlesSpan');
    expect(keys(base([track([subsClip({ start: 1, duration: 9 })])]))).toContain('composition.subtitlesSpan');
  });
  it('a track with no clip or two clips: subtitlesSpan', () => {
    expect(keys(base([track([])]))).toContain('composition.subtitlesSpan');
    expect(keys(base([track([subsClip(), subsClip({ id: 'subs2' })])]))).toContain('composition.subtitlesSpan');
  });
  it('a scene on the clip: subtitlesSpan', () => {
    expect(keys(base([track([subsClip({ scene: 'all' })])]))).toContain('composition.subtitlesSpan');
  });
  it('a still with the track: subtitlesOnStill', () => {
    const still = base([track([subsClip({ duration: 0 })])], 0);
    expect(keys(still)).toContain('composition.subtitlesOnStill');
  });
  it('a subtitles clip on another kind, or another clip on the track: trackKind', () => {
    const onText = base(); onText.tracks[0]!.clips.push(subsClip({ id: 'x' }) as never);
    expect(keys(onText)).toContain('composition.trackKind');
    const other = base([track([{ id: 'shape', type: 'shape', start: 0, duration: 10, props: {} }])]);
    expect(keys(other)).toContain('composition.trackKind');
  });
  it('refuses a template outside layers/ and out-of-range props', () => {
    expect(keys(base([track([subsClip({ template: 'assets/x.html' })])]))).toContain('composition.layerNotHtml');
    for (const props of [{ maxWidth: 0.1 }, { maxWidth: 1.1 }, { lineHeight: 0.5 }, { fontSize: 0 }, { position: 'left' }, { entranceSec: 2 }, { boxPadding: 300 }]) {
      const r = compositionSchema.safeParse(base([track([subsClip({ props: { ...subsClip().props, ...props } })])]));
      expect(r.success, JSON.stringify(props)).toBe(false);
    }
  });
  it('a template that is not an .html file is a layerNotHtml problem', () => {
    expect(keys(base([track([subsClip({ template: 'layers/x.txt' })])]))).toContain('composition.layerNotHtml');
  });
  it('the template file must exist', () => {
    expect(keys(base([track([subsClip({ template: 'layers/missing.html' })])]))).toContain('composition.assetMissing');
  });
});

describe('stripSubtitles and subtitlesClipOf', () => {
  it('drops only the subtitles track', () => {
    const c = base([track([subsClip()])]);
    const s = stripSubtitles(c);
    expect(s.tracks.map((t) => t.id)).toEqual(['text']);
    expect(c.tracks).toHaveLength(2);
    expect(s).toEqual({ ...c, tracks: [c.tracks[0]] });
  });
  it('returns the same object when there is none', () => {
    const c = base();
    expect(stripSubtitles(c)).toBe(c);
  });
  it('finds the clip, or null', () => {
    expect(subtitlesClipOf(base([track([subsClip()])]))?.id).toBe('subs');
    expect(subtitlesClipOf(base())).toBeNull();
  });
});

describe('the JSON schema', () => {
  it('the checked-in file equals the generated one and names the subtitles clip', () => {
    const file = JSON.parse(readFileSync(new URL('../src/composition/composition.schema.json', import.meta.url), 'utf8'));
    expect(file).toEqual(JSON.parse(JSON.stringify(compositionJsonSchema())));
    expect(JSON.stringify(file)).toContain('subtitlesClip');
  });
});

describe('localization ignores the subtitles clip', () => {
  const overlay: Localization = {
    $schema: 'motion-studio/localization@1', locale: 'de', instanceId: 'instagram-reel-9x16',
    texts: { title: { source: 'Hello', text: 'Hallo' } }, params: {}, voices: {}, fit: {}, fonts: [],
  };
  it('lists nothing for it and leaves it untouched', () => {
    const c = base([track([subsClip()])]);
    expect(localizableEntries(c).texts.map((t) => t.clipId)).toEqual(['title']);
    const out = applyLocalization(c, overlay);
    expect(out.tracks[1]).toEqual(c.tracks[1]);
  });
});
