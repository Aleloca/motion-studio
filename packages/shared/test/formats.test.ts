import { describe, expect, it } from 'vitest';
import { DEFAULT_FORMATS, formatsFileSchema } from '../src/index.ts';

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
