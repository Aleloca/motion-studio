import { describe, expect, it } from 'vitest';
import { ProviderError, requestBytes, requestJson } from '../src/providers/http.ts';

const res = (status: number, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  new Response((typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body)) as BodyInit, { status, headers });
const deps = (r: Response | Error) => ({ fetch: (async () => { if (r instanceof Error) throw r; return r; }) as typeof fetch });

describe('requestJson', () => {
  it('returns JSON and maps errors without leaking the key', async () => {
    expect(await requestJson(deps(res(200, { a: 1 })), 'u', {}, { provider: 'OpenAI', secrets: ['sk-1234'] })).toEqual({ a: 1 });
    const unauthorized = await requestJson<never>(deps(res(401, { error: { message: 'bad key sk-1234' } })), 'u', {}, { provider: 'OpenAI', secrets: ['sk-1234'] }).catch((e: unknown) => e as ProviderError);
    expect(unauthorized).toBeInstanceOf(ProviderError);
    expect(unauthorized.message).toBe('Chiave OpenAI non valida o senza permessi');
    expect((await requestJson<never>(deps(res(429, {})), 'u', {}, { provider: 'Pexels', secrets: [] }).catch((e: unknown) => e as ProviderError)).message).toBe('Limite di richieste raggiunto per Pexels: riprova più tardi');
    const other = await requestJson<never>(deps(res(500, { error: { message: 'boom with sk-1234' } })), 'u', {}, { provider: 'OpenAI', secrets: ['sk-1234'] }).catch((e: unknown) => e as ProviderError);
    expect(other.message).toBe('OpenAI ha risposto 500: boom with •••');
    expect((await requestJson<never>(deps(res(200, 'not json', { 'content-type': 'text/plain' })), 'u', {}, { provider: 'X', secrets: [] }).catch((e: unknown) => e as ProviderError)).message).toBe('Risposta non valida da X');
    expect((await requestJson<never>(deps(new Error('ECONNREFUSED')), 'u', {}, { provider: 'X', secrets: [] }).catch((e: unknown) => e as ProviderError)).message).toBe('X non raggiungibile: ECONNREFUSED');
  });
});

describe('requestBytes', () => {
  it('enforces the size limit', async () => {
    const ok = await requestBytes(deps(res(200, new Uint8Array([1, 2, 3]), { 'content-type': 'image/png' })), 'u', {}, { provider: 'X', secrets: [], maxBytes: 10 });
    expect([...ok.bytes]).toEqual([1, 2, 3]);
    expect(ok.contentType).toBe('image/png');
    const big = await requestBytes(deps(res(200, new Uint8Array(20))), 'u', {}, { provider: 'X', secrets: [], maxBytes: 10 }).catch((e: unknown) => e as ProviderError);
    expect(big).toMatchObject({ status: 413, message: 'File troppo grande da X' });
  });
});

describe('redaction of transport details', () => {
  it('hides the key echoed in network errors carrying the URL', async () => {
    const err = await requestJson<never>(deps(new Error('connect failed https://x.test/v1?key=sk-1234 Bearer sk-1234')), 'https://x.test/v1?key=sk-1234', { headers: { authorization: 'Bearer sk-1234' } }, { provider: 'X', secrets: ['sk-1234'] }).catch((e: unknown) => e as ProviderError);
    expect(err.message).toBe('X non raggiungibile: connect failed https://x.test/v1?key=••• Bearer •••');
  });
});

describe('body failures and aborts', () => {
  const o = { provider: 'X', secrets: ['sk-1234'] };
  const erroring = () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.error(new Error('reset sk-1234')); } }), { status: 200 });
  it('maps mid-body stream errors for bytes and json', async () => {
    const b = await requestBytes(deps(erroring()), 'u', {}, { ...o, maxBytes: 100 }).catch((e: unknown) => e as ProviderError);
    expect(b).toMatchObject({ status: 502, message: 'X non raggiungibile: reset •••' });
    const j = await requestJson<never>(deps(erroring()), 'u', {}, o).catch((e: unknown) => e as ProviderError);
    expect(j).toMatchObject({ status: 502, message: 'X non raggiungibile: reset •••' });
  });
  it('rejects empty or missing bodies', async () => {
    for (const r of [new Response(null, { status: 200 }), new Response(new Uint8Array(0), { status: 200 })]) {
      expect(await requestBytes(deps(r), 'u', {}, { ...o, maxBytes: 10 }).catch((e: unknown) => e as ProviderError)).toMatchObject({ status: 502, message: 'Risposta non valida da X' });
    }
  });
  it('honours a caller abort signal', async () => {
    const ac = new AbortController();
    const d = { fetch: ((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted'))))) as unknown as typeof fetch };
    const p = requestJson<never>(d, 'u', { signal: ac.signal }, o).catch((e: unknown) => e as ProviderError);
    ac.abort();
    expect(await p).toMatchObject({ status: 502, message: 'X non raggiungibile: aborted' });
  });
  it('enforces maxBytes on json and redacts before truncating', async () => {
    expect(await requestJson<never>(deps(res(200, { a: 'x'.repeat(50) })), 'u', {}, { ...o, maxBytes: 10 }).catch((e: unknown) => e as ProviderError)).toMatchObject({ status: 413 });
    const e = await requestJson<never>(deps(res(500, { error: { message: 'a'.repeat(298) + 'sk-1234' } })), 'u', {}, o).catch((x: unknown) => x as ProviderError);
    expect(e.message).not.toContain('sk-');
  });
});
