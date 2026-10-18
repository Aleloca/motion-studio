import { describe, expect, it } from 'vitest';
import { DEFAULT_FORMATS, isDefaultProfile, outputFileInfoSchema, profileApplies, profileFor, recordedQuality, scaledSize } from '../src/index.ts';

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
