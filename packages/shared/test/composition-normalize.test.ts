import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FORMATS, normalizeComposition, validateComposition, type Composition } from '../src/index.ts';

const spike = JSON.parse(readFileSync(new URL('./fixtures/spike-composition.json', import.meta.url), 'utf8')) as Composition;
type Loose = Record<string, any>;

describe('normalizeComposition', () => {
  it('leaves a complete composition as is (same object)', () => {
    expect(normalizeComposition(spike)).toBe(spike);
  });
  it('a text clip without fontFamily gets fonts[0], without touching the input', () => {
    const input = structuredClone(spike) as Loose;
    delete input.tracks[2].clips[0].props.fontFamily;
    const before = structuredClone(input);
    const out = normalizeComposition(input) as Loose;
    expect(out.tracks[2].clips[0].props.fontFamily).toBe('SpikeFont');
    expect(input).toEqual(before);
    expect(out.tracks[0]).toBe(input.tracks[0]);
  });
  it('no fonts: fontFamily stays missing (the validator reports it)', () => {
    const input = structuredClone(spike) as Loose;
    input.fonts = [];
    delete input.tracks[2].clips[0].props.fontFamily;
    expect((normalizeComposition(input) as Loose).tracks[2].clips[0].props.fontFamily).toBeUndefined();
  });
  it('a video without scenes gets one scene from 0 to the duration, with a free id', () => {
    const input = structuredClone(spike) as Loose;
    input.scenes = [];
    expect((normalizeComposition(input) as Loose).scenes).toEqual([{ id: 'scene-1', start: 0, duration: 6 }]);
    input.tracks[0].id = 'scene-1';
    input.tracks[1].clips[0].id = 'scene-2';
    expect((normalizeComposition(input) as Loose).scenes[0].id).toBe('scene-3');
  });
  it('a still keeps no scenes', () => {
    const input = { ...structuredClone(spike), duration: 0, scenes: [] };
    expect((normalizeComposition(input) as Loose).scenes).toEqual([]);
  });
  it('is idempotent and its output validates', () => {
    const input = structuredClone(spike) as Loose;
    input.scenes = [];
    for (const t of input.tracks) for (const k of t.clips) { delete k.scene; if (k.type === 'text') delete k.props.fontFamily; }
    const once = normalizeComposition(input);
    expect(normalizeComposition(once)).toBe(once);
    const files = new Map(['assets/bg.mp4', 'assets/photo.jpg', 'assets/spikefont.ttf', 'assets/logo.svg', 'assets/music.wav', 'assets/voice.wav', 'assets/sfx.wav', 'layers/outro.html'].map((f) => [f, { size: 1 }]));
    expect(validateComposition(once, { format: DEFAULT_FORMATS.find((f) => f.id === 'instagram-reel-9x16')!, files }).problems).toEqual([]);
  });
  it.each([null, 42, 'x', [], { tracks: 'no' }, { fonts: [1], tracks: [null, { clips: [null, { type: 'text' }] }] }])('never throws on %j', (v) => {
    expect(() => normalizeComposition(v)).not.toThrow();
  });
});
