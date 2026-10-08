import { redact } from '../secrets/vault.ts';

export class ProviderError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'ProviderError'; }
}
export interface HttpDeps { fetch: typeof fetch; timeoutMs?: number }
interface Opts { provider: string; secrets: string[] }

const ERROR_BODY_MAX = 64 * 1024;
const JSON_MAX = 64 * 1024 * 1024;

const reason = (e: unknown): string => (e as Error | undefined)?.message ?? String(e);
const unreachable = (o: Opts, e: unknown) => new ProviderError(502, redact(`${o.provider} non raggiungibile: ${reason(e)}`, o.secrets));

interface Sent { res: Response; signal: AbortSignal }

async function send(deps: HttpDeps, url: string, init: RequestInit, o: Opts): Promise<Sent> {
  const timeout = AbortSignal.timeout(deps.timeoutMs ?? 120_000);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  let res: Response;
  try { res = await deps.fetch(url, { ...init, signal }); }
  catch (e) { throw unreachable(o, e); }
  if (res.ok) return { res, signal };
  if (res.status === 401 || res.status === 403) { await res.body?.cancel().catch(() => {}); throw new ProviderError(401, `Chiave ${o.provider} non valida o senza permessi`); }
  if (res.status === 429) { await res.body?.cancel().catch(() => {}); throw new ProviderError(429, `Limite di richieste raggiunto per ${o.provider}: riprova più tardi`); }
  let text = '';
  try { text = (await readBounded(res, ERROR_BODY_MAX, false)).toString('utf8'); } catch { /* unreadable error body */ }
  let detail = text;
  try {
    const j = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    const cand = typeof j.error === 'object' && j.error !== null ? j.error.message : j.error;
    if (typeof cand === 'string') detail = cand;
    else if (typeof j.message === 'string') detail = j.message;
  } catch { /* plain text */ }
  throw new ProviderError(502, redact(`${o.provider} ha risposto ${res.status}: ${redact(String(detail), o.secrets).slice(0, 300)}`, o.secrets));
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
  try { return await readBounded(res, max, true, () => new ProviderError(413, `File troppo grande da ${o.provider}`)); }
  catch (e) {
    if (e instanceof ProviderError) throw e;
    throw unreachable(o, e);
  }
}

export async function requestJson<T>(deps: HttpDeps, url: string, init: RequestInit, o: Opts & { maxBytes?: number }): Promise<T> {
  const { res } = await send(deps, url, init, o);
  const buf = await readBody(res, o, o.maxBytes ?? JSON_MAX);
  try { return JSON.parse(buf.toString('utf8')) as T; } catch { throw new ProviderError(502, `Risposta non valida da ${o.provider}`); }
}

export async function requestBytes(deps: HttpDeps, url: string, init: RequestInit, o: Opts & { maxBytes: number }): Promise<{ bytes: Buffer; contentType: string }> {
  const { res } = await send(deps, url, init, o);
  if (!res.body) throw new ProviderError(502, `Risposta non valida da ${o.provider}`);
  const bytes = await readBody(res, o, o.maxBytes);
  if (bytes.length === 0) throw new ProviderError(502, `Risposta non valida da ${o.provider}`);
  return { bytes, contentType: res.headers.get('content-type') ?? '' };
}
