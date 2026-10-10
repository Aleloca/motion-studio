import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COMPOSITION_LIMITS, compositionJsonSchema, compositionSchema, type Composition } from '../src/index.ts';

const spike = JSON.parse(readFileSync(new URL('./fixtures/spike-composition.json', import.meta.url), 'utf8')) as Composition;

describe('compositionSchema', () => {
  it('accepts the spike example (with the @1 tag)', () => {
    const r = compositionSchema.safeParse(spike);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });
  it('rejects the spike draft tag @0', () => {
    expect(compositionSchema.safeParse({ ...spike, $schema: 'motion-studio/composition@0' }).success).toBe(false);
  });
  it('accepts every animation form and every preset of the spec', () => {
    const presets = ['fadeIn', 'fadeOut', 'slideUp', 'slideDown', 'slideLeft', 'slideRight', 'popIn', 'scaleIn', 'wipe'];
    const animations = [
      ...presets.map((preset) => ({ preset, duration: 0.5 })),
      { prop: 'color', from: '#ffffff', to: '#000000', start: 0.1, duration: 0.5, ease: 'ease-in-out' },
      { prop: 'blur', keyframes: [{ t: 0, v: 8 }, { t: 1, v: 0, ease: 'steps(4, end)' }], duration: 1 },
    ];
    const c = structuredClone(spike);
    (c.tracks[2]!.clips[0] as { animations?: unknown[] }).animations = animations;
    const r = compositionSchema.safeParse(c);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });
  it('accepts html params of every declared type', () => {
    const c = structuredClone(spike);
    Object.assign(c.tracks[1]!.clips[2]!, { params: {
      headline: { type: 'text', value: 'Grazie!', label: 'Headline' },
      accent: { type: 'color', value: '#fbbf24' },
      speed: { type: 'number', value: 1.5 },
      logo: { type: 'image', value: 'assets/logo.svg' },
    } });
    const r = compositionSchema.safeParse(c);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });
  it('accepts a still (zero-duration) composition', () => {
    const still = { $schema: 'motion-studio/composition@1', width: 1080, height: 1080, fps: 30, duration: 0, background: '#000', fonts: [], scenes: [],
      tracks: [{ id: 'v', kind: 'visual', clips: [{ id: 'bg', type: 'shape', start: 0, duration: 0, props: { x: 0, y: 0, width: 1080, height: 1080, fill: '#ff0000' } }] }] };
    const r = compositionSchema.safeParse(still);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });
  it.each([
    ['an unknown root field', (c: Record<string, unknown>) => { c.extra = 1; }],
    ['an unknown clip type', (c: Composition) => { (c.tracks[0]!.clips[0] as { type: string }).type = 'gif'; }],
    ['a src outside assets/ and layers/', (c: Composition) => { (c.tracks[0]!.clips[0] as { src: string }).src = '../secret.mp4'; }],
    ['an fps not in the list', (c: Composition) => { (c as { fps: number }).fps = 29.97; }],
    ['a colour that is not hex', (c: Composition) => { c.background = 'red'; }],
    ['an easing with forbidden characters', (c: Composition) => { (c.tracks[2]!.clips[1] as { animations: Array<{ ease?: string }> }).animations[0]!.ease = 'url(x);'; }],
  ])('rejects %s', (_n, mutate) => {
    const c = structuredClone(spike);
    mutate(c as never);
    expect(compositionSchema.safeParse(c).success).toBe(false);
  });
});

describe('composition.schema.json', () => {
  it('is checked in and equals the schema generated from zod (run `pnpm --filter @motion-studio/shared gen:composition-schema`)', () => {
    const file = JSON.parse(readFileSync(new URL('../src/composition/composition.schema.json', import.meta.url), 'utf8'));
    expect(file).toEqual(compositionJsonSchema());
  });
  it('is a 2020-12 schema with the composition id and the limits', () => {
    const s = compositionJsonSchema() as Record<string, unknown>;
    expect(s.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(s.$id).toBe('motion-studio/composition@1');
    expect(JSON.stringify(s)).toContain(`"maxItems":${COMPOSITION_LIMITS.tracks}`);
  });
});
