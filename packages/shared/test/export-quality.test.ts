import { describe, expect, it } from 'vitest';
import { DEFAULT_FORMATS, EXPORT_FPS, isDefaultProfile, outputFileInfoSchema, profileApplies, profileFor, recordedQuality, scaledSize } from '../src/index.ts';

const preset = (id: string) => DEFAULT_FORMATS.find((p) => p.id === id)!;

describe('export resolution and quality (decision 974)', () => {
  it('scales to the short side, keeping the ratio, with even sides', () => {
    expect(scaledSize({ width: 1920, height: 1080 }, 720)).toEqual({ width: 1280, height: 720 });
    expect(scaledSize({ width: 1920, height: 1080 }, 480)).toEqual({ width: 854, height: 480 });
    expect(scaledSize({ width: 1920, height: 1080 }, 2160)).toEqual({ width: 3840, height: 2160 });
    expect(scaledSize({ width: 1080, height: 1920 }, 480)).toEqual({ width: 480, height: 854 });
    expect(scaledSize({ width: 1080, height: 1350 }, 720)).toEqual({ width: 720, height: 900 });
    expect(scaledSize({ width: 1080, height: 1080 }, 1440)).toEqual({ width: 1440, height: 1440 });
    // The own short side, or none: the format's own size.
    expect(scaledSize({ width: 1920, height: 1080 }, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(scaledSize({ width: 1920, height: 1080 })).toEqual({ width: 1920, height: 1080 });
  });

  it('applies to videos only: not to stills, identity formats or store pack formats', () => {
    expect(profileApplies(preset('youtube-16x9'), 'youtube-16x9')).toBe(true);
    expect(profileApplies(preset('youtube-16x9'), 'youtube-16x9@2')).toBe(true);
    expect(profileApplies(preset('youtube-thumbnail'), 'youtube-thumbnail')).toBe(false);
    expect(profileApplies(preset('appstore-preview'), 'appstore-preview')).toBe(false);
    expect(profileApplies(null, 'x')).toBe(false);
  });

  it('a profile for a format: its own short side is the default size, a still gets the default profile', () => {
    expect(profileFor(preset('youtube-16x9'), 'youtube-16x9', { quality: 'high', short: 1080 })).toEqual({ quality: 'high' });
    expect(profileFor(preset('youtube-16x9'), 'youtube-16x9', { quality: 'max', short: 720 })).toEqual({ quality: 'max', short: 720 });
    expect(profileFor(preset('youtube-thumbnail'), 'youtube-thumbnail', { quality: 'max', short: 720 })).toEqual({ quality: 'high' });
    expect(isDefaultProfile({ quality: 'high' })).toBe(true);
    expect(isDefaultProfile({ quality: 'standard' })).toBe(false);
    expect(isDefaultProfile({ quality: 'high', short: 720 })).toBe(false);
  });

  it('an output keeps its render record (quality, size, encoder); one without it counts as standard', () => {
    const base = { format: 'f', file: 'f.mp4', width: 1920, height: 1080, durationSec: 4, verified: true, preview: null };
    const parsed = outputFileInfoSchema.parse({ ...base, render: { quality: 'high', width: 1920, height: 1080, encoder: 'libx264' } });
    expect(parsed.render).toEqual({ quality: 'high', width: 1920, height: 1080, encoder: 'libx264' });
    expect(recordedQuality(parsed)).toBe('high');
    expect(recordedQuality(outputFileInfoSchema.parse(base))).toBe('standard');
  });
});

describe('export frame rate (report 39, decision 1233)', () => {
  it('offers 24, 25, 30, 50 and 60 fps, the values a composition may have', () => {
    expect([...EXPORT_FPS]).toEqual([24, 25, 30, 50, 60]);
  });

  it('a profile keeps its fps for a video, drops it where no profile applies; with an fps it is not the default', () => {
    expect(profileFor(preset('youtube-16x9'), 'youtube-16x9', { quality: 'high', fps: 60 })).toEqual({ quality: 'high', fps: 60 });
    expect(profileFor(preset('youtube-16x9'), 'youtube-16x9', { quality: 'high', short: 1440, fps: 25 })).toEqual({ quality: 'high', short: 1440, fps: 25 });
    expect(profileFor(preset('youtube-thumbnail'), 'youtube-thumbnail', { quality: 'high', fps: 60 })).toEqual({ quality: 'high' });
    expect(profileFor(preset('appstore-preview'), 'appstore-preview', { quality: 'high', fps: 60 })).toEqual({ quality: 'high' });
    expect(isDefaultProfile({ quality: 'high', fps: 30 })).toBe(false);
  });

  it('a render record keeps its fps; one without it was made at the composition fps', () => {
    const base = { format: 'f', file: 'f.mp4', width: 1920, height: 1080, durationSec: 4, verified: true, preview: null };
    const render = { quality: 'high', width: 1920, height: 1080, encoder: 'libx264' };
    expect(outputFileInfoSchema.parse({ ...base, render: { ...render, fps: 60 } }).render).toEqual({ ...render, fps: 60 });
    expect(outputFileInfoSchema.parse({ ...base, render }).render).toEqual(render);
    expect(() => outputFileInfoSchema.parse({ ...base, render: { ...render, fps: 48 } })).toThrow();
  });
});
