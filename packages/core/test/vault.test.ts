import { describe, expect, it } from 'vitest';
import { MemoryVault, redact } from '../src/secrets/vault.ts';

describe('MemoryVault', () => {
  it('prefers env, stores, deletes and reports status without values', async () => {
    const v = new MemoryVault({ OPENAI_API_KEY: 'sk-env' });
    await v.set('pexels', '  pk-123  ');
    expect(await v.get('openai')).toBe('sk-env');
    expect(await v.get('pexels')).toBe('pk-123');
    expect(await v.status()).toEqual([
      { provider: 'openai', configured: true, source: 'env' },
      { provider: 'elevenlabs', configured: false, source: null },
      { provider: 'pexels', configured: true, source: 'keychain' },
      { provider: 'unsplash', configured: false, source: null },
    ]);
    await v.delete('pexels');
    expect(await v.get('pexels')).toBeNull();
  });
  it('rejects invalid values', async () => {
    const v = new MemoryVault({});
    for (const bad of ['', '   ', 'a\nb', 'x'.repeat(501)]) expect((await v.set('openai', bad).catch((e) => e)).status, JSON.stringify(bad)).toBe(400);
  });
});

describe('redact', () => {
  it('hides secrets in text', () => {
    expect(redact('Bearer sk-abc failed for sk-abc', ['sk-abc'])).toBe('Bearer ••• failed for •••');
    expect(redact('nothing', [])).toBe('nothing');
  });
});
