import { describe, expect, it } from 'vitest';
import { channelName, CUSTOM_CHANNEL, customFormatInputSchema, customPreset, customPresetId, DEFAULT_FORMATS, formatLabel, formatName, formatPresetSchema, isCustomPreset, videoTargetBitrateKbps } from '../src/index.ts';

describe('custom formats (report 59)', () => {
  it('derives an id from the name that matches the preset id rule, with a suffix on a clash', () => {
    expect(customPresetId('Banner Città 2:1', new Set())).toBe('custom-banner-citta-2-1');
    expect(customPresetId('Banner Città 2:1', new Set(['custom-banner-citta-2-1']))).toBe('custom-banner-citta-2-1-2');
    expect(customPresetId('Banner Città 2:1', new Set(['custom-banner-citta-2-1', 'custom-banner-citta-2-1-2']))).toBe('custom-banner-citta-2-1-3');
    // Nothing usable in the name: a generic id.
    expect(customPresetId('🎬 ✨', new Set())).toBe('custom-format');
    const long = customPresetId('x'.repeat(200), new Set());
    expect(long.length).toBeLessThanOrEqual(63);
    expect(formatPresetSchema.shape.id.safeParse(long).success).toBe(true);
    const taken = new Set([long]);
    const next = customPresetId('x'.repeat(200), taken);
    expect(next).not.toBe(long);
    expect(formatPresetSchema.shape.id.safeParse(next).success).toBe(true);
  });

  it('builds a valid preset: channel custom, the shipped extensions of its kind, a bitrate for video, no duration for an image', () => {
    const v = customPreset({ name: ' Totem ', kind: 'video', width: 1080, height: 1920, maxDurationSec: 30 }, 'custom-totem');
    expect(v).toEqual({ id: 'custom-totem', channel: CUSTOM_CHANNEL, name: 'Totem', kind: 'video', width: 1080, height: 1920, maxDurationSec: 30,
      extensions: DEFAULT_FORMATS.find((p) => p.kind === 'video')!.extensions, targetBitrateKbps: videoTargetBitrateKbps(1080, 1920) });
    expect(formatPresetSchema.safeParse(v).success).toBe(true);
    const i = customPreset({ name: 'Volantino', kind: 'image', width: 1240, height: 1754, maxDurationSec: 30 }, 'custom-volantino');
    expect(i.maxDurationSec).toBeUndefined();
    expect(i.targetBitrateKbps).toBeUndefined();
    expect(i.extensions).toEqual(DEFAULT_FORMATS.find((p) => p.kind === 'image')!.extensions);
    expect(isCustomPreset(i)).toBe(true);
    expect(isCustomPreset(DEFAULT_FORMATS[0]!)).toBe(false);
  });

  it('validates the input: name, integer sizes 16–8192, an integer duration', () => {
    const ok = { name: 'A', kind: 'image', width: 16, height: 8192 };
    expect(customFormatInputSchema.safeParse(ok).success).toBe(true);
    expect(customFormatInputSchema.safeParse({ ...ok, name: '   ' }).success).toBe(false);
    expect(customFormatInputSchema.safeParse({ ...ok, name: 'x'.repeat(61) }).success).toBe(false);
    expect(customFormatInputSchema.safeParse({ ...ok, width: 15 }).success).toBe(false);
    expect(customFormatInputSchema.safeParse({ ...ok, height: 8193 }).success).toBe(false);
    expect(customFormatInputSchema.safeParse({ ...ok, width: 100.5 }).success).toBe(false);
    expect(customFormatInputSchema.safeParse({ ...ok, kind: 'video', maxDurationSec: 0 }).success).toBe(false);
    expect(customFormatInputSchema.safeParse({ ...ok, kind: 'video', maxDurationSec: 2.5 }).success).toBe(false);
    expect(customFormatInputSchema.safeParse({ ...ok, kind: 'video', maxDurationSec: 3601 }).success).toBe(false);
    expect(customFormatInputSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });

  it('is shown under the "Personalizzati" channel, with its name as stored', () => {
    const p = customPreset({ name: 'Post 1:1', kind: 'image', width: 1080, height: 1080 }, 'custom-post-1-1');
    expect(channelName(p.channel, 'it')).toBe('Personalizzati');
    expect(channelName(p.channel, 'en')).toBe('Custom');
    expect(formatName(p, 'en')).toBe('Post 1:1');
    expect(formatLabel(p, 'it')).toBe('Personalizzati · Post 1:1');
  });

  it('a hidden preset (deleted while in use) stays a valid preset', () => {
    const p = { ...customPreset({ name: 'A', kind: 'image', width: 100, height: 100 }, 'custom-a'), hidden: true as const };
    expect(formatPresetSchema.safeParse(p).success).toBe(true);
  });
});
