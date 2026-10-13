import { createHmac, randomBytes } from 'node:crypto';
import { KEY_CAPABILITIES, KEY_PERMISSIONS, type KeyCapability, type KeyCheckResult, type KeyCheckStatus, type ProviderId } from '@motion-studio/shared';
import { redact } from '../secrets/vault.ts';
import { t } from '../i18n.ts';
import { classifyRefusal, ProviderError, requestProbe, type HttpDeps } from './http.ts';
import { OPENAI_IMAGE_MODEL } from './openai-images.ts';
import { OPENAI_TTS_MODEL } from './tts.ts';

/** Deadline of each probe (they run in parallel, so a whole check takes at most this long). */
export const KEY_CHECK_TIMEOUT_MS = 15_000;
const PERMISSION_MAX = 64;
const DETAIL_MAX = 200;

export { KEY_CAPABILITIES, KEY_PERMISSIONS };

// Per process: a fingerprint means nothing outside this run of the core.
const FINGERPRINT_SALT = randomBytes(32);
/** A one-way, salted fingerprint of a key: what the cache compares, so it never holds or compares the key itself. */
export const keyFingerprint = (key: string): string => createHmac('sha256', FINGERPRINT_SALT).update(key).digest('base64url');

/** Which key a real call used (its fingerprint) and what the cache knew then: enough to drop what it learns about an old key. */
export interface KeyLease { readonly provider: ProviderId; readonly fingerprint: string; readonly generation: number }

type Entry = KeyCheckResult['capabilities'][number];
const CONTROL = /[\u0000-\u001f\u007f]/g;
/**
 * Bounded and single-line: what a result may carry in `permission` and `detail`. `checkKey` also redacts the key; the cache
 * (which never sees a key) only bounds and cleans, its strings coming from constants and the catalogs.
 */
const clean = (v: string | undefined, max: number, secrets: string[]): string | undefined => {
  if (v === undefined) return undefined;
  const out = redact(String(v), secrets).replace(CONTROL, ' ').trim().slice(0, max);
  return out || undefined;
};
const entry = (capability: KeyCapability, status: KeyCheckStatus, permission?: string, detail?: string, secrets: string[] = []): Entry => {
  const p = clean(permission, PERMISSION_MAX, secrets);
  const d = clean(detail, DETAIL_MAX, secrets);
  return { capability, status, ...(p !== undefined ? { permission: p } : {}), ...(d !== undefined ? { detail: d } : {}) };
};

type Outcome = { kind: 'ok' } | { kind: 'denied'; why: 'permission' | 'invalid' } | { kind: 'notFound' } | { kind: 'error'; detail: string };

interface Probe {
  capability: KeyCapability;
  url: string;
  /** The probe that tells whether the provider knows the key at all. */
  base?: boolean;
  /** What a permission refusal means for this capability (default: missing, with its permission). */
  denied?: 'unverified';
  /** For a 404 (a model the account cannot see): the capability is missing, with this name. */
  notFound?: string;
}
interface Plan { label: string; headers: Record<string, string>; probes: Probe[]; /** The provider has permissions on its keys. */ scoped: boolean }

const plan = (provider: ProviderId, apiKey: string): Plan => {
  switch (provider) {
    case 'openai': return {
      label: 'OpenAI', headers: { authorization: `Bearer ${apiKey}` }, scoped: true,
      probes: [
        { capability: 'key', url: 'https://api.openai.com/v1/models', base: true },
        { capability: 'images', url: `https://api.openai.com/v1/models/${OPENAI_IMAGE_MODEL}`, denied: 'unverified', notFound: OPENAI_IMAGE_MODEL },
        { capability: 'tts', url: `https://api.openai.com/v1/models/${OPENAI_TTS_MODEL}`, denied: 'unverified', notFound: OPENAI_TTS_MODEL },
      ],
    };
    case 'elevenlabs': return {
      label: 'ElevenLabs', headers: { 'xi-api-key': apiKey }, scoped: true,
      probes: [
        { capability: 'account', url: 'https://api.elevenlabs.io/v1/user', base: true },
        { capability: 'voices', url: 'https://api.elevenlabs.io/v2/voices?page_size=1' },
      ],
    };
    case 'pexels': return {
      label: 'Pexels', headers: { authorization: apiKey }, scoped: false,
      probes: [{ capability: 'search', url: 'https://api.pexels.com/v1/search?query=test&per_page=1', base: true }],
    };
    case 'unsplash': return {
      label: 'Unsplash', headers: { authorization: `Client-ID ${apiKey}`, 'accept-version': 'v1' }, scoped: false,
      probes: [{ capability: 'search', url: 'https://api.unsplash.com/search/photos?query=test&per_page=1', base: true }],
    };
  }
};

async function probe(deps: HttpDeps, p: Plan, pr: Probe, apiKey: string): Promise<Outcome> {
  try {
    const a = await requestProbe({ ...deps, timeoutMs: KEY_CHECK_TIMEOUT_MS }, pr.url, { method: 'GET', headers: p.headers }, { provider: p.label, secrets: [apiKey] });
    if (a.status >= 200 && a.status < 300) return { kind: 'ok' };
    if (a.status === 429 || a.status === 401 || a.status === 403) {
      // The same classification as real calls (`classifyRefusal`).
      const r = classifyRefusal(p.label, a.status, a.body);
      if (r === 'rateLimited') return { kind: 'error', detail: t().keyChecks.rateLimited };
      if (r === 'permission' || r === 'invalid') return { kind: 'denied', why: r };
      return { kind: 'error', detail: t().keyChecks.refused };
    }
    if (a.status === 404 && pr.notFound) return { kind: 'notFound' };
    return { kind: 'error', detail: t().keyChecks.status({ status: a.status }) };
  } catch (e) {
    const timedOut = e instanceof ProviderError && e.status === 504;
    return { kind: 'error', detail: timedOut ? t().keyChecks.timeout({ seconds: KEY_CHECK_TIMEOUT_MS / 1000 }) : t().keyChecks.network };
  }
}

/**
 * Tests a key with read-only, free requests (spec §7), all in parallel with a 15 s deadline each, and reports each capability:
 * `ok`, `missing` (with the permission to enable; no permission = the provider does not know the key), `unverified` (no free
 * way to tell) or `error` (network, deadline, 5xx, rate limit). Never throws; the key never appears in the result.
 */
export async function checkKey(deps: HttpDeps, provider: ProviderId, apiKey: string): Promise<KeyCheckResult> {
  const p = plan(provider, apiKey);
  const secrets = [apiKey];
  const perms = KEY_PERMISSIONS[provider];
  const outcomes = await Promise.all(p.probes.map((pr) => probe(deps, p, pr, apiKey).catch((): Outcome => ({ kind: 'error', detail: t().keyChecks.network }))));
  const byCap = new Map(p.probes.map((pr, i) => [pr.capability, { pr, out: outcomes[i]! }]));
  const baseOut = outcomes[p.probes.findIndex((pr) => pr.base)]!;
  // The provider knows the key when any probe answered with something other than "who are you?".
  const known = outcomes.some((o) => o.kind === 'ok' || o.kind === 'notFound' || (o.kind === 'denied' && o.why === 'permission'));
  const keyStatus: KeyCheckStatus = known ? 'ok' : baseOut.kind === 'denied' ? 'missing' : 'error';
  const firstError = outcomes.find((o): o is Extract<Outcome, { kind: 'error' }> => o.kind === 'error');
  const capabilities = KEY_CAPABILITIES[provider].map((capability): Entry => {
    if (capability === 'key') return entry('key', keyStatus, undefined, keyStatus === 'error' ? firstError?.detail : undefined, secrets);
    // An unknown key: nothing works with it, and there is no permission to enable.
    if (keyStatus === 'missing') return entry(capability, 'missing');
    const probed = byCap.get(capability);
    if (!probed) return entry(capability, 'unverified', perms[capability], undefined, secrets);
    const { pr, out } = probed;
    switch (out.kind) {
      case 'ok': return entry(capability, 'ok');
      case 'notFound': return entry(capability, 'missing', pr.notFound, undefined, secrets);
      case 'denied': return entry(capability, pr.denied ?? 'missing', perms[capability], undefined, secrets);
      case 'error': return entry(capability, 'error', undefined, out.detail, secrets);
    }
  });
  return { provider, checkedAt: new Date().toISOString(), capabilities };
}

/**
 * What is known about each provider key's capabilities: the last check, updated by real calls (a 401/403 marks the capability
 * `missing`, a success `ok`). Core memory only: never persisted, never holds a key.
 */
export class KeyCheckCache {
  private readonly byProvider = new Map<ProviderId, { checkedAt: string; caps: Map<KeyCapability, Entry> }>();
  /** Bumped by every `clear` (a key saved or removed): a lease from before no longer records anything. */
  private readonly generations = new Map<ProviderId, number>();

  get(provider: ProviderId): KeyCheckResult | null {
    const cur = this.byProvider.get(provider);
    if (!cur) return null;
    const order = KEY_CAPABILITIES[provider];
    const caps = [...cur.caps.values()].sort((a, b) => order.indexOf(a.capability) - order.indexOf(b.capability));
    return { provider, checkedAt: cur.checkedAt, capabilities: caps.map((c) => ({ ...c })) };
  }

  /** The capabilities as a map (no entry = nothing known). */
  capabilities(provider: ProviderId): Partial<Record<KeyCapability, Entry>> {
    return Object.fromEntries((this.get(provider)?.capabilities ?? []).map((c) => [c.capability, c]));
  }

  /** What a real call learned. A success also proves the key. */
  record(provider: ProviderId, capability: KeyCapability, status: KeyCheckStatus, permission?: string): void {
    const cur = this.slot(provider);
    cur.caps.set(capability, entry(capability, status, status === 'ok' ? undefined : permission));
    if (status === 'ok' && capability !== 'key' && cur.caps.get('key')?.status !== 'ok') cur.caps.set('key', entry('key', 'ok'));
  }

  /**
   * A fresh check replaces what is known. A user's Test (the default) replaces EVERY learned state, so a learned `missing`
   * (perhaps from a transient refusal) never outlives it, even where the check can only say `unverified` (fix round 2).
   * Only a background check (`keepLearned`) keeps what real use learned (`ok` or `missing`) for the capabilities it cannot
   * verify. Returns the merged result.
   */
  merge(provider: ProviderId, fresh: KeyCheckResult, opts: { keepLearned?: boolean } = {}): KeyCheckResult {
    const before = opts.keepLearned ? this.byProvider.get(provider)?.caps : undefined;
    const caps = new Map<KeyCapability, Entry>();
    for (const c of fresh.capabilities) {
      const learned = before?.get(c.capability);
      const keep = c.status === 'unverified' && learned !== undefined && (learned.status === 'ok' || learned.status === 'missing');
      caps.set(c.capability, keep ? learned : entry(c.capability, c.status, c.permission, c.detail));
    }
    this.byProvider.set(provider, { checkedAt: new Date().toISOString(), caps });
    return this.get(provider)!;
  }

  /** Forgets a provider (its key was replaced or removed). */
  clear(provider: ProviderId): void {
    this.byProvider.delete(provider);
    this.generations.set(provider, (this.generations.get(provider) ?? 0) + 1);
  }

  /** Taken when a real call reads its key: `recordUse` then learns only while that key is still the current one. */
  lease(provider: ProviderId, apiKey: string): KeyLease {
    return { provider, fingerprint: keyFingerprint(apiKey), generation: this.generations.get(provider) ?? 0 };
  }

  /**
   * What a real call learned, recorded only when the key it used is still the vault's (same fingerprint, no `clear` since):
   * a call that waited for a confirmation, or a queued Generate job, can end after the user replaced the key, and its 401
   * says nothing about the new key (final review M2). Returns whether it was recorded.
   */
  async recordUse(vault: { get(p: ProviderId): Promise<string | null> }, lease: KeyLease, capability: KeyCapability, status: KeyCheckStatus, permission?: string): Promise<boolean> {
    const same = () => (this.generations.get(lease.provider) ?? 0) === lease.generation;
    if (!same()) return false;
    let current: string | null;
    try { current = await vault.get(lease.provider); } catch { return false; }
    if (!current || keyFingerprint(current) !== lease.fingerprint || !same()) return false;
    this.record(lease.provider, capability, status, permission);
    return true;
  }

  private slot(provider: ProviderId) {
    let cur = this.byProvider.get(provider);
    if (!cur) { cur = { checkedAt: '', caps: new Map() }; this.byProvider.set(provider, cur); }
    cur.checkedAt = new Date().toISOString();
    return cur;
  }
}
