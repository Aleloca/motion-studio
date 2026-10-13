import https from 'node:https';
import { afterEach, describe, expect, it } from 'vitest';
import { allowProviderNetwork, BLOCKED_PROVIDER_HOSTS, INHERITED_OPT_IN, isBlockedProviderHost, ProviderNetworkBlocked, scrubInheritedOptIn } from '../../../test-support/block-provider-network.ts';
import { CATALOG_URL } from '../src/providers/google-fonts-catalog.ts';
import { checkKey } from '../src/providers/key-check.ts';
import { nodeTransport } from '../src/providers/safe-fetch.ts';

// The guard refuses before any socket opens: nothing here reaches the network.
afterEach(() => { delete process.env[INHERITED_OPT_IN]; });

describe('test network guard', () => {
  it('refuses a real fetch to every provider and Google Fonts host', async () => {
    for (const host of BLOCKED_PROVIDER_HOSTS) {
      await expect(fetch(`https://${host}/x`)).rejects.toBeInstanceOf(ProviderNetworkBlocked);
      await expect(fetch(new URL(`https://${host.toUpperCase()}./x`))).rejects.toBeInstanceOf(ProviderNetworkBlocked);
      await expect(fetch(new Request(`https://${host}/x`))).rejects.toBeInstanceOf(ProviderNetworkBlocked);
    }
  });
  it('refuses node http(s) requests too, also through the named import of the safe-fetch transport', async () => {
    expect(() => https.request('https://api.elevenlabs.io/v1/user')).toThrow(ProviderNetworkBlocked);
    expect(() => https.get({ hostname: 'api.pexels.com', path: '/' })).toThrow(ProviderNetworkBlocked);
    // The lookup pins a loopback address: even if the guard failed, nothing would leave the machine.
    const lookup = (async () => [{ address: '127.0.0.1', family: 4 }]) as never;
    await expect(nodeTransport(new URL('https://fonts.gstatic.com/s/a.ttf'), {}, lookup)).rejects.toBeInstanceOf(ProviderNetworkBlocked);
  });
  it('covers the Google Fonts catalog host the product reads (fonts.google.com), not only the css2 and file hosts', async () => {
    for (const u of [CATALOG_URL, 'https://fonts.googleapis.com/css2?family=Inter', 'https://fonts.gstatic.com/s/inter/a.ttf']) {
      expect(isBlockedProviderHost(new URL(u).hostname)).toBe(true);
    }
    await expect(fetch(CATALOG_URL)).rejects.toBeInstanceOf(ProviderNetworkBlocked);
  });
  it('a key check with the default real fetch is refused, never sent', async () => {
    const r = await checkKey({ fetch: globalThis.fetch }, 'openai', 'sk-guard-0123456789');
    expect(r.capabilities.find((c) => c.capability === 'key')!.status).toBe('error');
  });
  it('lets other hosts through', () => {
    expect(isBlockedProviderHost('127.0.0.1')).toBe(false);
    expect(isBlockedProviderHost('example.com')).toBe(false);
  });
  it('an inherited environment opt-in never disables it: removed at load and ignored anyway', async () => {
    // Removed when the guard loads (a fake environment shows what load does to the real one).
    const env: NodeJS.ProcessEnv = { [INHERITED_OPT_IN]: '1', OTHER: 'x' };
    scrubInheritedOptIn(env);
    expect(env).toEqual({ OTHER: 'x' });
    expect(process.env[INHERITED_OPT_IN]).toBeUndefined();
    // Set after load, as a shell export would be: still blocked, and refused before any socket.
    process.env[INHERITED_OPT_IN] = '1';
    expect(isBlockedProviderHost('api.openai.com')).toBe(true);
    await expect(fetch('https://api.openai.com/v1/models')).rejects.toBeInstanceOf(ProviderNetworkBlocked);
  });
  it('allowProviderNetwork opens it for the test and its restore closes it (decision only, no request)', () => {
    const restore = allowProviderNetwork();
    expect(isBlockedProviderHost('api.elevenlabs.io')).toBe(false);
    restore();
    expect(isBlockedProviderHost('api.elevenlabs.io')).toBe(true);
  });
  it('an opt-in left open by one test…', () => {
    allowProviderNetwork(); // no restore, on purpose
    expect(isBlockedProviderHost('api.pexels.com')).toBe(false);
  });
  it('…does not leak into the next one (global afterEach)', async () => {
    expect(isBlockedProviderHost('api.pexels.com')).toBe(true);
    await expect(fetch('https://api.pexels.com/v1/search')).rejects.toBeInstanceOf(ProviderNetworkBlocked);
  });
});
