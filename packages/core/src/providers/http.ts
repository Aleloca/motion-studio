import { redact } from '../secrets/vault.ts';
import type { LookupFn, Transport } from './safe-fetch.ts';
import { t } from '../i18n.ts';

/**
 * How a provider's refusal reads, for key checks and for what real calls learn (one classification for both, fix round 2):
 * `permission` (a known key that lacks a permission), `invalid` (a key the provider does not know), `rateLimited`, or
 * `refused` (anything else: quota, billing, account state, unknown wording). Only `permission` ever makes a capability
 * `missing` from a real call.
 */
export type Refusal = 'permission' | 'invalid' | 'rateLimited' | 'refused';

export class ProviderError extends Error {
  constructor(public readonly status: number, message: string, public readonly upstreamStatus?: number, public readonly refusal?: Refusal) { super(message); this.name = 'ProviderError'; }
}

/** The words a provider uses for a known key that lacks a permission (ElevenLabs `missing_permissions`, OpenAI scopes). */
export const PERMISSION_WORDS = /missing_permissions|missing the permission|insufficient permissions|missing scopes/i;
/**
 * The words of a key the provider does not know (ElevenLabs `invalid_api_key` / "Invalid API key", OpenAI "Incorrect API key"
 * / `invalid_api_key`). Only these make a key invalid: any other 401 is `refused`, so a restricted key worded in a new way is
 * never shown as invalid (Review Focus 3).
 */
export const INVALID_WORDS = /invalid_api_key|invalid api key|incorrect api key/i;
const RATE_LIMIT_WORDS = /rate limit/i;
/** Refusals about money or the account, never about a permission of the key (e.g. ElevenLabs `quota_exceeded`). */
const ACCOUNT_WORDS = /quota|billing|credits?\b|payment|subscription|suspended|unusual activity|unusual_activity|account (?:is )?(?:disabled|inactive|deactivated)/i;
/** The providers whose keys have permissions (Pexels and Unsplash keys have none: any refusal means the key). */
const SCOPED = new Set(['OpenAI', 'ElevenLabs']);

/** Classifies a 401/403/429 answer from `provider` (its label) by status and body: the one rule key checks and real calls share. */
export function classifyRefusal(provider: string, status: number, body: string): Refusal {
  if (status === 429 || (status === 403 && RATE_LIMIT_WORDS.test(body))) return 'rateLimited';
  if (!SCOPED.has(provider)) return 'invalid';
  if (PERMISSION_WORDS.test(body)) return 'permission';
  if (ACCOUNT_WORDS.test(body)) return 'refused';
  if (status === 403) return 'permission';
  if (INVALID_WORDS.test(body)) return 'invalid';
  return 'refused';
}
export interface HttpDeps {
  fetch: typeof fetch; timeoutMs?: number;
  /** Downloads of outside URLs (see safe-fetch.ts); default: node transport with pinned DNS and real lookup. */
  transport?: Transport; lookup?: LookupFn;
}
interface Opts { provider: string; secrets: string[] }

const ERROR_BODY_MAX = 64 * 1024;
const REFUSAL_BODY_MAX = 8 * 1024;
const JSON_MAX = 64 * 1024 * 1024;

const reason = (e: unknown): string => (e as Error | undefined)?.message ?? String(e);
const unreachable = (o: Opts, e: unknown) => new ProviderError(502, redact(t().providers.unreachable({ provider: o.provider, detail: reason(e) }), o.secrets));

interface Sent { res: Response; signal: AbortSignal }

async function send(deps: HttpDeps, url: string, init: RequestInit, o: Opts): Promise<Sent> {
  const timeout = AbortSignal.timeout(deps.timeoutMs ?? 120_000);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  let res: Response;
  try { res = await deps.fetch(url, { redirect: 'error', ...init, signal }); }
  catch (e) { throw unreachable(o, e); }
  if (res.ok) return { res, signal };
  if (res.status === 401 || res.status === 403) {
    // Read (bounded) only to classify the refusal; the body itself goes nowhere.
    let body = '';
    try { body = (await readBounded(res, REFUSAL_BODY_MAX, false)).toString('utf8'); } catch { /* unreadable: classified on the status */ }
    throw new ProviderError(401, t().providers.invalidKey({ provider: o.provider }), res.status, classifyRefusal(o.provider, res.status, body));
  }
  if (res.status === 429) { await res.body?.cancel().catch(() => {}); throw new ProviderError(429, t().providers.rateLimited({ provider: o.provider }), 429); }
  let text = '';
  try { text = (await readBounded(res, ERROR_BODY_MAX, false)).toString('utf8'); } catch { /* unreadable error body */ }
  let detail = text;
  try {
    const j = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    const cand = typeof j.error === 'object' && j.error !== null ? j.error.message : j.error;
    if (typeof cand === 'string') detail = cand;
    else if (typeof j.message === 'string') detail = j.message;
  } catch { /* plain text */ }
  throw new ProviderError(502, redact(t().providers.responded({ provider: o.provider, status: res.status, detail: redact(String(detail), o.secrets).slice(0, 300) }), o.secrets), res.status);
}

/** Reads the body up to `max` bytes: over the limit it throws (strict) or truncates (not strict). */
async function readBounded(res: Response, max: number, strict: boolean, onOver?: () => Error): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      if (strict) throw onOver!();
      chunks.push(Buffer.from(value.subarray(0, value.byteLength - (size - max))));
      break;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function readBody(res: Response, o: Opts, max: number): Promise<Buffer> {
  try { return await readBounded(res, max, true, () => new ProviderError(413, t().providers.fileTooLarge({ provider: o.provider }))); }
  catch (e) {
    if (e instanceof ProviderError) throw e;
    throw unreachable(o, e);
  }
}

export interface ProbeAnswer { status: number; body: string }

/**
 * A read-only probe (key checks): the answer comes back whatever its status, with at most `maxBytes` of a non-2xx body
 * (redacted). Same rules as the other calls (`redirect: 'error'`, a deadline: `deps.timeoutMs`). A network failure throws
 * a redacted ProviderError 502; the deadline throws a ProviderError 504.
 */
export async function requestProbe(deps: HttpDeps, url: string, init: RequestInit, o: Opts & { maxBytes?: number }): Promise<ProbeAnswer> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), deps.timeoutMs ?? 120_000);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;
  try {
    let res: Response;
    try { res = await deps.fetch(url, { ...init, redirect: 'error', signal }); }
    catch (e) {
      if (deadline.signal.aborted) throw new ProviderError(504, o.provider);
      throw unreachable(o, e);
    }
    if (res.ok) { await res.body?.cancel().catch(() => {}); return { status: res.status, body: '' }; }
    let body = '';
    try { body = (await readBounded(res, o.maxBytes ?? 8 * 1024, false)).toString('utf8'); } catch { /* unreadable error body */ }
    return { status: res.status, body: redact(body, o.secrets) };
  } finally { clearTimeout(timer); }
}

export async function requestJson<T>(deps: HttpDeps, url: string, init: RequestInit, o: Opts & { maxBytes?: number }): Promise<T> {
  const { res } = await send(deps, url, init, o);
  const buf = await readBody(res, o, o.maxBytes ?? JSON_MAX);
  try { return JSON.parse(buf.toString('utf8')) as T; } catch { throw new ProviderError(502, t().providers.invalidResponse({ provider: o.provider })); }
}

export async function requestBytes(deps: HttpDeps, url: string, init: RequestInit, o: Opts & { maxBytes: number }): Promise<{ bytes: Buffer; contentType: string }> {
  const { res } = await send(deps, url, init, o);
  if (!res.body) throw new ProviderError(502, t().providers.invalidResponse({ provider: o.provider }));
  const bytes = await readBody(res, o, o.maxBytes);
  if (bytes.length === 0) throw new ProviderError(502, t().providers.invalidResponse({ provider: o.provider }));
  return { bytes, contentType: res.headers.get('content-type') ?? '' };
}
