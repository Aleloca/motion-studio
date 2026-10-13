import { describe, expect, it } from 'vitest';
import { elevenlabsMusic, elevenlabsSoundEffect, elevenlabsVoices } from '../src/providers/elevenlabs-audio.ts';
import { KeyCheckCache } from '../src/providers/key-check.ts';

const KEY = 'xi-secret-key-123';
const recorder = (responses: Response[]) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return responses.shift()!; }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};
const audio = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
const deps = (fetchImpl: typeof fetch) => ({ fetch: fetchImpl, apiKey: KEY });

describe('elevenlabsSoundEffect', () => {
  it('posts the documented body and header, with the output format in the query', async () => {
    const { calls, fetchImpl } = recorder([audio()]);
    const r = await elevenlabsSoundEffect(deps(fetchImpl), { prompt: 'door slam', durationSec: 2.5, loop: true, promptInfluence: 0.6 });
    expect(r.format).toBe('mp3');
    expect([...r.bytes]).toEqual([1, 2, 3]);
    expect(calls[0]!.url).toBe('https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>)['xi-api-key']).toBe(KEY);
    expect(calls[0]!.init.redirect).toBe('error');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ text: 'door slam', duration_seconds: 2.5, prompt_influence: 0.6, loop: true, model_id: 'eleven_text_to_sound_v2' });
  });
  it('omits the optional fields so the service infers the duration', async () => {
    const { calls, fetchImpl } = recorder([audio()]);
    await elevenlabsSoundEffect(deps(fetchImpl), { prompt: 'rain' });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ text: 'rain', model_id: 'eleven_text_to_sound_v2' });
  });
  it('enforces the limits before sending anything', async () => {
    const { calls, fetchImpl } = recorder([]);
    for (const req of [{ prompt: '' }, { prompt: 'x'.repeat(1001) }, { prompt: 'a', durationSec: 0.4 }, { prompt: 'a', durationSec: 30.1 }, { prompt: 'a', promptInfluence: 1.1 }, { prompt: 'a', durationSec: Number.NaN }]) {
      expect((await elevenlabsSoundEffect(deps(fetchImpl), req).catch((e) => e)).status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });
  it('maps 401/403/429/422 without leaking the key', async () => {
    const run = async (res: Response) => (await elevenlabsSoundEffect(deps(recorder([res]).fetchImpl), { prompt: 'a' }).catch((e) => e)) as { status: number; upstreamStatus?: number; message: string };
    const e401 = await run(new Response(`bad ${KEY}`, { status: 401 }));
    expect(e401).toMatchObject({ status: 401, upstreamStatus: 401 });
    expect((await run(new Response('', { status: 403 }))).upstreamStatus).toBe(403);
    expect((await run(new Response('', { status: 429 }))).status).toBe(429);
    const e422 = await run(new Response(JSON.stringify({ detail: [{ loc: ['body', 'text'], msg: `too long ${KEY}`, type: 'x' }] }), { status: 422 }));
    expect(e422.status).toBe(502);
    for (const e of [e401, e422]) expect(JSON.stringify({ m: e.message })).not.toContain(KEY);
  });
  it('stops when the request is aborted', async () => {
    const ac = new AbortController();
    const fetchImpl = ((_u: string, init: RequestInit) => new Promise((_res, rej) => { init.signal!.addEventListener('abort', () => rej(new Error(`aborted ${KEY}`))); })) as unknown as typeof fetch;
    const p = elevenlabsSoundEffect({ fetch: ((u: string, i: RequestInit) => (fetchImpl as unknown as (u: string, i: RequestInit) => Promise<Response>)(u, { ...i, signal: ac.signal })) as typeof fetch, apiKey: KEY }, { prompt: 'a' }).catch((e) => e);
    ac.abort();
    const e = await p as Error;
    expect(e.message).not.toContain(KEY);
    expect((e as { status?: number }).status).toBe(502);
  });
});

describe('limits passed to http.ts', () => {
  it('refuses a response over 50 MB and hands fetch a live signal (timeout) and redirect:error', async () => {
    let init: RequestInit | undefined;
    const big = (async (_u: string, i: RequestInit) => { init = i; return new Response(new Uint8Array(50 * 1024 * 1024 + 1), { status: 200 }); }) as unknown as typeof fetch;
    const e = await elevenlabsSoundEffect({ fetch: big, apiKey: KEY }, { prompt: 'a' }).catch((x) => x);
    expect(e.status).toBe(413);
    expect(init!.redirect).toBe('error');
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });
  it('honours the deps timeout', async () => {
    const hang = ((_u: string, i: RequestInit) => new Promise((_r, rej) => i.signal!.addEventListener('abort', () => rej(new Error('t'))))) as unknown as typeof fetch;
    expect((await elevenlabsMusic({ fetch: hang, apiKey: KEY, timeoutMs: 20 }, { prompt: 'a', durationSec: 12 }).catch((x) => x)).status).toBe(502);
  });
});

describe('elevenlabsMusic', () => {
  it('posts the prompt, the length in milliseconds and the instrumental flag', async () => {
    const { calls, fetchImpl } = recorder([audio()]);
    await elevenlabsMusic(deps(fetchImpl), { prompt: 'calm piano', durationSec: 30, instrumental: true });
    expect(calls[0]!.url).toBe('https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ prompt: 'calm piano', music_length_ms: 30000, force_instrumental: true, model_id: 'music_v1' });
  });
  it('keeps 10 to 300 seconds and 1000 characters', async () => {
    const { calls, fetchImpl } = recorder([]);
    for (const req of [{ prompt: 'a', durationSec: 9.9 }, { prompt: 'a', durationSec: 300.1 }, { prompt: ' ', durationSec: 20 }, { prompt: 'x'.repeat(1001), durationSec: 20 }]) {
      expect((await elevenlabsMusic(deps(fetchImpl), req).catch((e) => e)).status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });
});

describe('elevenlabsVoices', () => {
  it('lists voices with a clamped page size and the search', async () => {
    const body = { voices: [{ voice_id: 'v1', name: 'Bella', labels: { accent: 'it', n: 3 }, preview_url: 'https://x/p.mp3' }, { voice_id: 'v2', name: 'Tom', labels: null, preview_url: null }], has_more: false };
    const { calls, fetchImpl } = recorder([new Response(JSON.stringify(body), { status: 200 })]);
    const v = await elevenlabsVoices(deps(fetchImpl), { search: 'bel la', pageSize: 500 });
    expect(calls[0]!.url).toBe('https://api.elevenlabs.io/v2/voices?page_size=100&search=bel+la');
    expect(calls[0]!.init.method ?? 'GET').toBe('GET');
    expect(v).toEqual([{ id: 'v1', name: 'Bella', labels: { accent: 'it' }, previewUrl: 'https://x/p.mp3' }, { id: 'v2', name: 'Tom', labels: {}, previewUrl: null }]);
  });
});

describe('KeyCheckCache', () => {
  it('holds capability statuses in memory per provider', () => {
    const c = new KeyCheckCache();
    expect(c.get('elevenlabs')).toEqual({});
    c.record('elevenlabs', 'sfx', 'missing', 'sound_generation');
    expect(c.get('elevenlabs').sfx).toMatchObject({ status: 'missing', permission: 'sound_generation' });
    c.record('elevenlabs', 'sfx', 'ok');
    expect(c.get('elevenlabs').sfx).toMatchObject({ status: 'ok' });
    expect(c.get('elevenlabs').sfx!.permission).toBeUndefined();
  });
});
