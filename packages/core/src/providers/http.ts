import { redact } from '../secrets/vault.ts';

export class ProviderError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'ProviderError'; }
}
export interface HttpDeps { fetch: typeof fetch; timeoutMs?: number }
interface Opts { provider: string; secrets: string[] }

async function send(deps: HttpDeps, url: string, init: RequestInit, o: Opts): Promise<Response> {
  let res: Response;
  try { res = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(deps.timeoutMs ?? 120_000) }); }
  catch (e) { throw new ProviderError(502, redact(`${o.provider} non raggiungibile: ${(e as Error).message}`, o.secrets)); }
  if (res.ok) return res;
  if (res.status === 401 || res.status === 403) throw new ProviderError(401, `Chiave ${o.provider} non valida o senza permessi`);
  if (res.status === 429) throw new ProviderError(429, `Limite di richieste raggiunto per ${o.provider}: riprova più tardi`);
  const text = await res.text().catch(() => '');
  let detail = text;
  try { const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string; detail?: unknown }; detail = (typeof j.error === 'object' ? j.error?.message : j.error) ?? j.message ?? text; } catch { /* plain text */ }
  throw new ProviderError(502, redact(`${o.provider} ha risposto ${res.status}: ${String(detail).slice(0, 300)}`, o.secrets));
}

export async function requestJson<T>(deps: HttpDeps, url: string, init: RequestInit, o: Opts): Promise<T> {
  const res = await send(deps, url, init, o);
  try { return (await res.json()) as T; } catch { throw new ProviderError(502, `Risposta non valida da ${o.provider}`); }
}

export async function requestBytes(deps: HttpDeps, url: string, init: RequestInit, o: Opts & { maxBytes: number }): Promise<{ bytes: Buffer; contentType: string }> {
  const res = await send(deps, url, init, o);
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = res.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > o.maxBytes) { await reader.cancel().catch(() => {}); throw new ProviderError(413, `File troppo grande da ${o.provider}`); }
      chunks.push(Buffer.from(value));
    }
  }
  return { bytes: Buffer.concat(chunks), contentType: res.headers.get('content-type') ?? '' };
}
