import { describe, expect, it } from 'vitest';
import { BRAND_PHASES, SERVICE_CHOICES, SERVICE_KINDS, briefSchema, effectiveServices, type KeyCheckResult } from '../src/index.ts';

const old = { goal: 'g', message: 'm', formats: ['reel'], durationSec: null, assets: [], notes: '' };
describe('brief services', () => {
  it('old briefs parse and mean all auto', () => {
    const b = briefSchema.parse(old);
    expect(b.services).toBeUndefined();
    expect(effectiveServices(b)).toEqual({ images: 'auto', voice: 'auto', music: 'auto', sfx: 'auto' });
  });
  it('round-trips partial services and fills the rest with auto', () => {
    const b = briefSchema.parse({ ...old, services: { voice: 'elevenlabs', images: 'none' } });
    expect(b.services).toEqual({ voice: 'elevenlabs', images: 'none' });
    expect(effectiveServices(b)).toEqual({ images: 'none', voice: 'elevenlabs', music: 'auto', sfx: 'auto' });
  });
  it('refuses a choice that is not valid for the kind', () => {
    expect(briefSchema.safeParse({ ...old, services: { music: 'openai' } }).success).toBe(false);
    expect(briefSchema.safeParse({ ...old, services: { images: 'elevenlabs' } }).success).toBe(false);
    expect(briefSchema.safeParse({ ...old, services: { tts: 'auto' } }).success).toBe(true);
  });
  it('exposes the kinds, choices and phases', () => {
    expect(SERVICE_KINDS).toEqual(['images', 'voice', 'music', 'sfx']);
    expect(SERVICE_CHOICES.sfx).toEqual(['auto', 'elevenlabs', 'none']);
    expect(BRAND_PHASES[0]).toBe('queued');
    expect(BRAND_PHASES.at(-1)).toBe('done');
  });
  it('types a key check result', () => {
    const r: KeyCheckResult = { provider: 'elevenlabs', checkedAt: '2026-10-13T10:00:00.000Z', capabilities: [{ capability: 'key', status: 'ok' }] };
    expect(r.capabilities).toHaveLength(1);
  });
});
