import { describe, expect, it } from 'vitest';
import { assetEntrySchema } from '../src/index.ts';

const old = { file: 'a/x.png', kind: 'image', origin: 'upload', sourceUrl: null, description: '', tags: [], width: 1, height: 1, addedAt: '2026-10-07T10:00:00.000Z' };
describe('asset metadata', () => {
  it('old entries parse without the new fields', () => {
    const a = assetEntrySchema.parse(old);
    expect(a.provider).toBeUndefined();
    expect(a.loop).toBeUndefined();
  });
  it('round-trips the new fields and the google-fonts origin', () => {
    const e = { ...old, file: 'a/x.mp3', kind: 'audio', origin: 'google-fonts', provider: 'elevenlabs', model: 'm1', durationSec: 12.5, bytes: 100, loop: true };
    expect(assetEntrySchema.parse(e)).toMatchObject(e);
    expect(assetEntrySchema.parse({ ...e, durationSec: null }).durationSec).toBeNull();
  });
  it('refuses an unknown origin and a negative size', () => {
    expect(assetEntrySchema.safeParse({ ...old, origin: 'nope' }).success).toBe(false);
    expect(assetEntrySchema.safeParse({ ...old, bytes: -1 }).success).toBe(false);
  });
});
