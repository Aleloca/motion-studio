import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach } from 'vitest';

/**
 * Global test guard (Task 8 review): no test may reach a paid provider or Google Fonts for real, not even with a fake key.
 * Under vitest, `fetch`, `http(s).request` and `http(s).get` (the node transport of safe-fetch) refuse these hosts before any
 * socket opens, so a default real-network dependency (`keyCheckHttp`, `fontsHttp`, `voicesHttp`, `generateHttp`, provider
 * tools without an injected fetch) fails loudly instead of calling out. A test that really means it opts in with
 * `allowProviderNetwork()`, which returns its own restore and is undone after every test anyway. No environment variable can
 * open it: an inherited `MS_ALLOW_PROVIDER_NETWORK` (an old opt-in) is deleted when the guard loads. Imported by
 * isolate-user-data.ts, so every package's setup has it.
 */
export const BLOCKED_PROVIDER_HOSTS = [
  'api.openai.com', 'api.elevenlabs.io', 'api.pexels.com', 'api.unsplash.com', 'fonts.googleapis.com', 'fonts.gstatic.com',
] as const;

export class ProviderNetworkBlocked extends Error {
  constructor(host: string) { super(`Test network guard: real request to ${host} refused (a test that means it calls allowProviderNetwork())`); this.name = 'ProviderNetworkBlocked'; }
}

// The opt-in lives on globalThis (one value per worker, whichever copy of this module asks).
const OPEN = Symbol.for('motion-studio.provider-network-open');
const state = globalThis as typeof globalThis & { [OPEN]?: boolean };

/** The old environment opt-in, inherited from a shell or CI: removed, so it can never switch the guard off. */
export const INHERITED_OPT_IN = 'MS_ALLOW_PROVIDER_NETWORK';
export function scrubInheritedOptIn(env: NodeJS.ProcessEnv = process.env): void { delete env[INHERITED_OPT_IN]; }

/** Lets the current test reach the blocked hosts. Returns the restore; the guard also closes again after every test. */
export function allowProviderNetwork(): () => void {
  state[OPEN] = true;
  return () => { state[OPEN] = false; };
}
export function closeProviderNetwork(): void { state[OPEN] = false; }

const norm = (h: string) => h.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
export function isBlockedProviderHost(host: string): boolean {
  if (state[OPEN] === true) return false;
  return (BLOCKED_PROVIDER_HOSTS as readonly string[]).includes(norm(host));
}

const hostOfUrl = (u: string): string | null => { try { return new URL(u).hostname; } catch { return null; } };
function fetchHost(input: unknown): string | null {
  if (typeof input === 'string') return hostOfUrl(input);
  if (input instanceof URL) return input.hostname;
  if (input && typeof input === 'object' && 'url' in input && typeof (input as { url: unknown }).url === 'string') return hostOfUrl((input as { url: string }).url);
  return null;
}
function requestHost(args: unknown[]): string | null {
  const [a, b] = args;
  if (typeof a === 'string') return hostOfUrl(a);
  if (a instanceof URL) return a.hostname;
  const o = (a && typeof a === 'object' ? a : b && typeof b === 'object' ? b : null) as { hostname?: unknown; host?: unknown } | null;
  if (!o) return null;
  if (typeof o.hostname === 'string') return o.hostname;
  if (typeof o.host === 'string') return o.host.replace(/:\d+$/, '');
  return null;
}
const record = (host: string) => {
  // One line per refusal, so a run's log shows which tests relied on the real network.
  process.stderr.write(`[provider-network-guard] blocked ${host}\n`);
  return new ProviderNetworkBlocked(host);
};

scrubInheritedOptIn();
closeProviderNetwork();
// Backstop: an opt-in never outlives its test, even when the test forgets its restore.
afterEach(() => { closeProviderNetwork(); });

const MARK = Symbol.for('motion-studio.provider-network-guard');
const g = globalThis as typeof globalThis & { [MARK]?: boolean };
if (process.env.VITEST && !g[MARK]) {
  g[MARK] = true;
  const realFetch = globalThis.fetch;
  if (typeof realFetch === 'function') {
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const host = fetchHost(input);
      if (host && isBlockedProviderHost(host)) return Promise.reject(record(host));
      return realFetch(input, init);
    }) as typeof fetch;
  }
  for (const mod of [http, https] as const) {
    const m = mod as unknown as Record<'request' | 'get', (...args: unknown[]) => unknown>;
    for (const name of ['request', 'get'] as const) {
      const real = m[name]!;
      m[name] = function guarded(this: unknown, ...args: unknown[]) {
        const host = requestHost(args);
        if (host && isBlockedProviderHost(host)) throw record(host);
        return real.apply(this, args);
      };
    }
  }
  // `import { request } from 'node:https'` bindings follow the patched functions.
  syncBuiltinESMExports();
}
