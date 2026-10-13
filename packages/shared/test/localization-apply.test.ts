import { describe, expect, it } from 'vitest';
import { LocalizationMismatch, applyLocalization, localizableEntries, compositionSchema, type Composition, type Localization } from '../src/index.ts';
import { spike } from './composition-edit-helpers.ts';

const comp = (): Composition => compositionSchema.parse({
  $schema: 'motion-studio/composition@1', width: 1080, height: 1920, fps: 30, duration: 6, background: '#000000',
  fonts: [{ family: 'Inter', src: 'assets/inter.ttf' }],
  scenes: [{ id: 'intro', name: 'Intro', start: 0, duration: 6 }],
  tracks: [
    { id: 'text', kind: 'text', clips: [
      { id: 'title', name: 'Title', scene: 'intro', type: 'text', start: 0, duration: 6, props: { text: 'Book in 3 taps', x: 90, y: 700, width: 900, height: 200, fontFamily: 'Inter', fontSize: 100, color: '#ffffff', align: 'center' }, animations: [{ preset: 'fadeIn', duration: 0.5 }] },
      { id: 'sub', type: 'text', start: 1, duration: 4, props: { text: 'No fees', x: 90, y: 900 } },
    ] },
    { id: 'layers', kind: 'visual', clips: [
      { id: 'card', type: 'html', start: 0, duration: 6, src: 'layers/card.html', params: { headline: { type: 'text', value: 'Hello', label: 'Headline' }, accent: { type: 'color', value: '#ff0000' }, n: { type: 'number', value: 3 } }, props: { x: 0, y: 0, width: 500, height: 500 } },
    ] },
    { id: 'audio', kind: 'audio', clips: [
      { id: 'vo', type: 'audio', start: 0, duration: 5, src: 'assets/vo.mp3', role: 'voice', volume: 1, script: 'Book in three taps' },
      { id: 'vo-2', type: 'audio', start: 5, duration: 1, src: 'assets/vo2.mp3', role: 'voice' },
      { id: 'bgm', type: 'audio', start: 0, duration: 6, src: 'assets/bgm.mp3', role: 'music', volume: 0.5 },
    ] },
  ],
});

const overlay = (over: Partial<Localization> = {}): Localization => ({
  $schema: 'motion-studio/localization@1', locale: 'de', instanceId: 'instagram-reel-9x16',
  texts: { title: { source: 'Book in 3 taps', text: 'In 3 Taps buchen' }, sub: { source: 'No fees', text: 'Keine Gebühren' } },
  params: { 'card.headline': { source: 'Hello', text: 'Hallo' } },
  voices: { vo: { src: 'assets/vo-de.mp3', sourceScript: 'Book in three taps', script: 'In drei Taps buchen' } },
  fit: { title: 0.8 },
  fonts: [{ family: 'Noto Sans JP', files: ['assets/noto-jp.ttf'] }],
  ...over,
});

/** Puts back the only fields the overlay may write: the result must then equal the input, deep. */
function restore(out: Composition, src: Composition): Composition {
  const r = structuredClone(out);
  const orig = (id: string) => src.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;
  for (const clip of r.tracks.flatMap((t) => t.clips)) {
    const o = orig(clip.id);
    if (clip.type === 'text' && o.type === 'text') { clip.props.text = o.props.text; if (o.props.fontSize === undefined) delete clip.props.fontSize; else clip.props.fontSize = o.props.fontSize; }
    if (clip.type === 'html' && o.type === 'html') for (const [k, p] of Object.entries(clip.params ?? {})) if (p.type === 'text') p.value = (o.params![k] as typeof p).value;
    if (clip.type === 'audio' && o.type === 'audio' && o.role === 'voice') {
      clip.src = o.src;
      if (o.script === undefined) delete clip.script; else clip.script = o.script;
      if (o.volume === undefined) delete clip.volume; else clip.volume = o.volume;
    }
  }
  r.fonts = r.fonts.filter((f) => src.fonts.some((x) => x.family === f.family && x.src === f.src));
  return r;
}

describe('applyLocalization', () => {
  it('is pure and writes only the allowed fields', () => {
    const c = comp();
    const frozen = structuredClone(c);
    const out = applyLocalization(c, overlay());
    expect(c).toEqual(frozen); // the input is untouched
    expect(out).not.toBe(c);
    expect(restore(out, c)).toEqual(c); // everything else deep-equals the input
    expect(out).not.toEqual(c);
  });
  it('writes texts, params, voices, fit and fonts into the real fields', () => {
    const out = applyLocalization(comp(), overlay());
    const clip = (id: string) => out.tracks.flatMap((t) => t.clips).find((x) => x.id === id) as any;
    expect(clip('title').props.text).toBe('In 3 Taps buchen');
    expect(clip('sub').props.text).toBe('Keine Gebühren');
    expect(clip('card').params.headline.value).toBe('Hallo');
    expect(clip('card').params.accent.value).toBe('#ff0000');
    expect(clip('vo').src).toBe('assets/vo-de.mp3');
    expect(clip('vo').script).toBe('In drei Taps buchen');
    expect(clip('vo-2').src).toBe('assets/vo2.mp3'); // not in the overlay
    expect(clip('bgm').src).toBe('assets/bgm.mp3');
    expect(clip('title').props.fontSize).toBeCloseTo(80);
    expect(clip('sub').props.fontSize).toBeUndefined();
    expect(out.fonts).toEqual([{ family: 'Inter', src: 'assets/inter.ttf' }, { family: 'Noto Sans JP', src: 'assets/noto-jp.ttf' }]);
    expect(compositionSchema.safeParse(out).success).toBe(true);
  });
  it('fit multiplies the size, the default size when unset', () => {
    const out = applyLocalization(comp(), overlay({ fit: { title: 0.7, sub: 0.5 + 0.2 } }));
    const clip = (id: string) => out.tracks.flatMap((t) => t.clips).find((x) => x.id === id) as any;
    expect(clip('title').props.fontSize).toBeCloseTo(70);
    expect(clip('sub').props.fontSize).toBeCloseTo(48 * 0.7);
    expect((applyLocalization(comp(), overlay({ fit: { sub: 1 } })).tracks[0]!.clips[1] as any).props.fontSize).toBeUndefined();
  });
  it('stale ids keep the source text, voice and size', () => {
    const c = comp();
    const out = applyLocalization(c, overlay(), { stale: ['title', 'card.headline', 'vo'] });
    const clip = (id: string) => out.tracks.flatMap((t) => t.clips).find((x) => x.id === id) as any;
    expect(clip('title').props.text).toBe('Book in 3 taps');
    expect(clip('title').props.fontSize).toBe(100);
    expect(clip('sub').props.text).toBe('Keine Gebühren');
    expect(clip('card').params.headline.value).toBe('Hello');
    expect(clip('vo').src).toBe('assets/vo.mp3');
    expect(clip('vo').script).toBe('Book in three taps');
  });
  it('a stale entry may name a clip that is gone', () => {
    const o = overlay({ texts: { gone: { source: 'a', text: 'b' } } });
    expect(() => applyLocalization(comp(), o, { stale: ['gone'] })).not.toThrow();
  });
  it('voice modes', () => {
    const c = comp();
    const clip = (o: Composition, id: string) => o.tracks.flatMap((t) => t.clips).find((x) => x.id === id) as any;
    const orig = applyLocalization(c, overlay(), { voiceMode: 'original' });
    expect(clip(orig, 'vo').src).toBe('assets/vo.mp3');
    expect(clip(orig, 'vo').script).toBe('Book in three taps');
    expect(clip(orig, 'vo').volume).toBe(1);
    expect(clip(orig, 'title').props.text).toBe('In 3 Taps buchen');
    const muted = applyLocalization(c, overlay(), { voiceMode: 'muted' });
    expect(clip(muted, 'vo').volume).toBe(0);
    expect(clip(muted, 'vo-2').volume).toBe(0);
    expect(clip(muted, 'vo').src).toBe('assets/vo.mp3');
    expect(clip(muted, 'bgm').volume).toBe(0.5); // music is not a voice
    expect(clip(applyLocalization(c, overlay()), 'vo').volume).toBe(1);
  });
  it('throws for an unknown id', () => {
    for (const o of [
      overlay({ texts: { nope: { source: 'a', text: 'b' } } }), overlay({ params: { 'nope.x': { source: 'a', text: 'b' } } }),
      overlay({ params: { 'card.nope': { source: 'a', text: 'b' } } }), overlay({ voices: { nope: { src: 'assets/a.mp3', sourceScript: '', script: '' } } }),
      overlay({ fit: { nope: 0.8 } }),
    ]) {
      expect(() => applyLocalization(comp(), o)).toThrow(LocalizationMismatch);
    }
  });
  it('throws for an id of the wrong kind', () => {
    const v = { src: 'assets/a.mp3', sourceScript: '', script: '' };
    for (const o of [
      overlay({ texts: { card: { source: 'a', text: 'b' } } }), overlay({ texts: { vo: { source: 'a', text: 'b' } } }),
      overlay({ params: { 'title.headline': { source: 'a', text: 'b' } } }), overlay({ params: { 'card.accent': { source: 'a', text: 'b' } } }),
      overlay({ voices: { bgm: v } }), overlay({ voices: { title: v } }),
      overlay({ fit: { card: 0.8 } }),
    ]) {
      expect(() => applyLocalization(comp(), o)).toThrow(LocalizationMismatch);
    }
  });
  it('an empty overlay changes nothing', () => {
    const c = comp();
    expect(applyLocalization(c, overlay({ texts: {}, params: {}, voices: {}, fit: {}, fonts: [] }))).toEqual(c);
  });
  it('does not add a font twice', () => {
    const once = applyLocalization(comp(), overlay());
    expect(applyLocalization(once, overlay()).fonts).toEqual(once.fonts);
  });
  it('works on the spike fixture', () => {
    const before = structuredClone(spike);
    expect(applyLocalization(spike, overlay({ texts: {}, params: {}, voices: {}, fit: {}, fonts: [] }))).toEqual(before);
  });
});

describe('localizableEntries', () => {
  it('lists texts, text params and voice clips', () => {
    const e = localizableEntries(comp());
    expect(e.texts).toEqual([
      { clipId: 'title', name: 'Title', scene: 'intro', text: 'Book in 3 taps', box: { w: 900, h: 200 }, size: 100 },
      { clipId: 'sub', text: 'No fees', box: { w: 1080, h: 58 }, size: 48 },
    ]);
    expect(e.params).toEqual([{ key: 'card.headline', label: 'Headline', text: 'Hello' }]);
    expect(e.voices).toEqual([{ clipId: 'vo', script: 'Book in three taps', duration: 5 }, { clipId: 'vo-2', script: null, duration: 1 }]);
  });
});

describe('audio script field', () => {
  it('is allowed with role voice only, max 5000', () => {
    const c = comp();
    const audio = (extra: object) => ({ ...c, tracks: [{ id: 'a', kind: 'audio', clips: [{ id: 'x', type: 'audio', start: 0, duration: 1, src: 'assets/a.mp3', ...extra }] }] });
    expect(compositionSchema.safeParse(audio({ role: 'voice', script: 'hi' })).success).toBe(true);
    expect(compositionSchema.safeParse(audio({ role: 'music', script: 'hi' })).success).toBe(false);
    expect(compositionSchema.safeParse(audio({ script: 'hi' })).success).toBe(false);
    expect(compositionSchema.safeParse(audio({ role: 'voice', script: 'x'.repeat(5001) })).success).toBe(false);
    expect(compositionSchema.safeParse(audio({ role: 'voice' })).success).toBe(true);
  });
});
