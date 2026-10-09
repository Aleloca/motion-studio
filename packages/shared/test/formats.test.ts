import { describe, expect, it } from 'vitest';
import { videoTargetBitrateKbps, channelName, DEFAULT_FORMATS, formatLabel, formatName, formatsFileSchema, messages } from '../src/index.ts';

describe('DEFAULT_FORMATS', () => {
  it('has unique ids that are valid file stems', () => {
    const ids = DEFAULT_FORMATS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
  });
  it('covers every channel of spec §5', () => {
    const channels = new Set(DEFAULT_FORMATS.map((f) => f.channel));
    for (const c of ['Instagram', 'TikTok', 'YouTube', 'Facebook', 'LinkedIn', 'X', 'Pinterest', 'Web', 'App Store', 'Play Store']) {
      expect(channels.has(c)).toBe(true);
    }
  });
  it('validates as a formats file', () => {
    expect(formatsFileSchema.safeParse({ schemaVersion: 1, presets: DEFAULT_FORMATS }).success).toBe(true);
  });
  it('rejects duplicate ids', () => {
    const p = DEFAULT_FORMATS[0]!;
    expect(formatsFileSchema.safeParse({ schemaVersion: 1, presets: [p, p] }).success).toBe(false);
  });
  it('video presets accept mp4 first; image presets accept png first', () => {
    for (const f of DEFAULT_FORMATS) expect(f.extensions[0]).toBe(f.kind === 'video' ? 'mp4' : 'png');
  });
});

describe('video target bitrates', () => {
  it('matches the reference table at 30 fps', () => {
    expect(videoTargetBitrateKbps(1080, 1920)).toBe(4000);
    expect(videoTargetBitrateKbps(1080, 1350)).toBe(4000);
    expect(videoTargetBitrateKbps(1080, 1080)).toBe(3500);
    expect(videoTargetBitrateKbps(1920, 1080)).toBe(5000);
    expect(videoTargetBitrateKbps(3840, 2160)).toBe(20000);
  });
  it('60 fps adds 50%', () => {
    expect(videoTargetBitrateKbps(1080, 1920, 60)).toBe(6000);
    expect(videoTargetBitrateKbps(1920, 1080, 30)).toBe(5000);
  });
  it('scales an odd size by pixel count against the nearest reference of its orientation', () => {
    // 1600x900 landscape: nearest is 1920x1080 -> 5000 x 1.44M/2.0736M = 3472 -> 3500
    expect(videoTargetBitrateKbps(1600, 900)).toBe(3500);
    // 886x1920 portrait: nearest is 1080x1350 -> 4000 x 1701120/1458000 = 4667 -> 4700
    expect(videoTargetBitrateKbps(886, 1920)).toBe(4700);
  });
  it('every video preset has a target; maxFileMB only where a limit is documented', () => {
    for (const f of DEFAULT_FORMATS.filter((x) => x.kind === 'video')) {
      expect(f.targetBitrateKbps, f.id).toBeGreaterThan(0);
      expect(f.targetBitrateKbps, f.id).toBe(videoTargetBitrateKbps(f.width, f.height));
    }
    const withLimit = DEFAULT_FORMATS.filter((f) => f.maxFileMB !== undefined).map((f) => f.id).sort();
    expect(withLimit).toEqual(['appstore-preview', 'x-16x9', 'x-1x1', 'youtube-thumbnail']);
  });
});

describe('format and channel names', () => {
  it('has a catalog entry for every default preset and channel, in both languages', () => {
    for (const locale of ['en', 'it'] as const) {
      const m = messages(locale);
      for (const f of DEFAULT_FORMATS) {
        expect(Object.hasOwn(m.formats, f.id), `${locale} formats.${f.id}`).toBe(true);
        const key = f.channel.replace(/^./, (c) => c.toLowerCase()).replace(/\s+(\w)/g, (_, c: string) => c.toUpperCase());
        expect(Object.hasOwn(m.channels, key), `${locale} channels.${key}`).toBe(true);
        expect(channelName(f.channel, locale)).toBe((m.channels as Record<string, string>)[key]);
      }
    }
    expect(Object.keys(messages('en').formats).sort()).toEqual(DEFAULT_FORMATS.map((f) => f.id).sort());
  });
  it('shows a shipped name in the requested language, keyed by the stable id', () => {
    const image = DEFAULT_FORMATS.find((f) => f.id === 'instagram-image-1x1')!;
    expect(image.name).toBe('Image 1:1');
    expect(formatName(image, 'en')).toBe('Image 1:1');
    expect(formatName(image, 'it')).toBe('Immagine 1:1');
    // Workspaces created before the English seed keep the Italian stored name: still shown in the requested language.
    expect(formatName({ id: 'instagram-image-1x1', name: 'Immagine 1:1' }, 'en')).toBe('Image 1:1');
    expect(formatName({ id: 'instagram-image-1x1', name: 'Immagine 1:1' }, 'it')).toBe('Immagine 1:1');
    expect(formatLabel(DEFAULT_FORMATS.find((f) => f.id === 'appstore-icon')!, 'en')).toBe('App Store · Icon');
  });
  it('keeps names the user edited and custom presets as stored', () => {
    expect(formatName({ id: 'instagram-image-1x1', name: 'Hero quadrato' }, 'en')).toBe('Hero quadrato');
    expect(formatName({ id: 'custom-1x1', name: 'Custom' }, 'en')).toBe('Custom');
    expect(formatName({ id: 'constructor', name: 'X' }, 'en')).toBe('X');
    expect(channelName('Mastodon', 'en')).toBe('Mastodon');
  });
});
