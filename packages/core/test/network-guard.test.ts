import https from 'node:https';
import { afterEach, describe, expect, it } from 'vitest';
import { BLOCKED_PROVIDER_HOSTS, isBlockedProviderHost, ProviderNetworkBlocked } from '../../../test-support/block-provider-network.ts';
import { checkKey } from '../src/providers/key-check.ts';
import { nodeTransport } from '../src/providers/safe-fetch.ts';

// The guard refuses before any socket opens: nothing here reaches the network.
afterEach(() => { delete process.env.MS_ALLOW_PROVIDER_NETWORK; });

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
  it('a key check with the default real fetch is refused, never sent', async () => {
    const r = await checkKey({ fetch: globalThis.fetch }, 'openai', 'sk-guard-0123456789');
    expect(r.capabilities.find((c) => c.capability === 'key')!.status).toBe('error');
  });
  it('lets other hosts through and can be opted out of explicitly', () => {
    expect(isBlockedProviderHost('127.0.0.1')).toBe(false);
    expect(isBlockedProviderHost('example.com')).toBe(false);
    process.env.MS_ALLOW_PROVIDER_NETWORK = '1';
    expect(isBlockedProviderHost('api.openai.com')).toBe(false);
  });
});
