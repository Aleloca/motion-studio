import { describe, expect, it } from 'vitest';
import { brandKitSchema, brandSoundSchema, EMPTY_BRAND_KIT } from '../src/index.ts';

describe('brand sound', () => {
  it('an old kit without sound still parses', () => {
    const { sound: _s, ...old } = EMPTY_BRAND_KIT as Record<string, unknown>;
    const k = brandKitSchema.parse(old);
    expect(k.sound).toBeUndefined();
  });
  it('round-trips a sound style', () => {
    const sound = { genre: 'lo-fi', energy: 'low', instruments: ['piano'], avoid: ['drums'], voice: { provider: 'elevenlabs', id: 'v1', name: 'Anna' } };
    expect(brandKitSchema.parse({ ...EMPTY_BRAND_KIT, sound }).sound).toEqual(sound);
    expect(brandSoundSchema.parse({ ...sound, energy: null, voice: null }).voice).toBeNull();
  });
  it('refuses wrong energy and provider', () => {
    const ok = { genre: '', energy: null, instruments: [], avoid: [], voice: null };
    expect(brandSoundSchema.safeParse({ ...ok, energy: 'loud' }).success).toBe(false);
    expect(brandSoundSchema.safeParse({ ...ok, voice: { provider: 'pexels', id: 'x' } }).success).toBe(false);
  });
});
