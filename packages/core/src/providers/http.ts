import { redact } from '../secrets/vault.ts';
import type { LookupFn, Transport } from './safe-fetch.ts';
import { t } from '../i18n.ts';

export class ProviderError extends Error {
  constructor(public readonly status: number, message: string, public readonly upstreamStatus?: number) { super(message); this.name = 'ProviderError'; }
}
export interface HttpDeps {
  fetch: typeof fetch; timeoutMs?: number;
  /** Downloads of outside URLs (see safe-fetch.ts); default: node transport with pinned DNS and real lookup. */
  transport?: Transport; lookup?: LookupFn;
}
interface Opts { provider: string; secrets: string[] }

const ERROR_BODY_MAX = 64 * 1024;
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
  if (res.status === 401 || res.status === 403) { await res.body?.cancel().catch(() => {}); throw new ProviderError(401, t().providers.invalidKey({ provider: o.provider }), res.status); }
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
