import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KeyCheckResult } from '@motion-studio/shared';
import { checkKey, KEY_CHECK_TIMEOUT_MS, KeyCheckCache } from '../src/providers/key-check.ts';

// Fake fetch only: no request ever leaves the process, not even with these fake keys.
const KEY = 'sk-key-check-secret-0123456789';
type Answer = (url: string, init: RequestInit) => Response | Promise<Response>;
interface Sent { url: string; init: RequestInit; headers: Headers }
const fake = (answer: Answer) => {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    sent.push({ url, init, headers: new Headers(init.headers) });
    return answer(url, init);
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch };
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const cap = (r: KeyCheckResult, c: string) => r.capabilities.find((x) => x.capability === c);
const statuses = (r: KeyCheckResult) => Object.fromEntries(r.capabilities.map((x) => [x.capability, x.status]));
const noKey = (r: unknown) => expect(JSON.stringify(r)).not.toContain(KEY);
// The words ElevenLabs uses for a key that is valid but restricted, and for a key it does not know.
const elevenMissing = (perm: string) => json(401, { detail: { status: 'missing_permissions', message: `The API key you used is missing the permission ${perm} to execute this operation.` } });
const elevenInvalid = () => json(401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } });

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('checkKey · OpenAI', () => {
  it('lists the models, then reads the two models Motion Studio uses, read-only and without redirects', async () => {
    const f = fake(() => json(200, { id: 'x' }));
    const r = await checkKey({ fetch: f.fetch }, 'openai', KEY);
    expect(r.provider).toBe('openai');
    expect(statuses(r)).toEqual({ key: 'ok', images: 'ok', tts: 'ok' });
    expect(f.sent.map((s) => s.url).sort()).toEqual(['https://api.openai.com/v1/models', 'https://api.openai.com/v1/models/gpt-4o-mini-tts', 'https://api.openai.com/v1/models/gpt-image-2']);
    for (const s of f.sent) {
      expect(s.init.method ?? 'GET').toBe('GET');
      expect(s.init.body).toBeUndefined();
      expect(s.init.redirect).toBe('error');
      expect(s.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    }
    noKey(r);
  });
  it('a 401 on the model list is an invalid key: every capability is missing, without a permission', async () => {
    const r = await checkKey({ fetch: fake(() => json(401, { error: { message: `Incorrect API key provided: ${KEY}` } })).fetch }, 'openai', KEY);
    expect(statuses(r)).toEqual({ key: 'missing', images: 'missing', tts: 'missing' });
    expect(r.capabilities.every((c) => c.permission === undefined)).toBe(true);
    noKey(r);
  });
  it('a model the account cannot see is missing with the model name; a restricted key leaves images and voice unverified', async () => {
    const a = await checkKey({ fetch: fake((u) => (u.endsWith('gpt-image-2') ? json(404, { error: { message: 'model not found' } }) : json(200, {}))).fetch }, 'openai', KEY);
    expect(cap(a, 'images')).toMatchObject({ status: 'missing', permission: 'gpt-image-2' });
    expect(cap(a, 'tts')).toMatchObject({ status: 'ok' });
    const scopes = () => json(401, { error: { message: 'You have insufficient permissions for this operation. Missing scopes: api.model.read.' } });
    const b = await checkKey({ fetch: fake(scopes).fetch }, 'openai', KEY);
    expect(statuses(b)).toEqual({ key: 'ok', images: 'unverified', tts: 'unverified' });
    expect(cap(b, 'images')!.permission).toBe('model.request');
  });
});

describe('checkKey · ElevenLabs (Review Focus 3)', () => {
  it('a key with only text_to_speech is not invalid: read permissions missing, generation unverified', async () => {
    const f = fake((u) => (u.startsWith('https://api.elevenlabs.io/v1/user') ? elevenMissing('user_read') : elevenMissing('voices_read')));
    const r = await checkKey({ fetch: f.fetch }, 'elevenlabs', KEY);
    expect(statuses(r)).toEqual({ key: 'ok', account: 'missing', voices: 'missing', tts: 'unverified', sfx: 'unverified', music: 'unverified' });
    expect(cap(r, 'account')!.permission).toBe('user_read');
    expect(cap(r, 'voices')!.permission).toBe('voices_read');
    expect(cap(r, 'tts')!.permission).toBe('text_to_speech');
    expect(cap(r, 'sfx')!.permission).toBe('sound_generation');
    expect(cap(r, 'music')!.permission).toBe('music_generation');
    // Only the two free reads were called: generation is never tried.
    expect(f.sent.map((s) => s.url).sort()).toEqual(['https://api.elevenlabs.io/v1/user', 'https://api.elevenlabs.io/v2/voices?page_size=1']);
    for (const s of f.sent) { expect(s.headers.get('xi-api-key')).toBe(KEY); expect(s.init.method ?? 'GET').toBe('GET'); }
  });
  it('a full key: account and voices ok, generation still unverified', async () => {
    const r = await checkKey({ fetch: fake(() => json(200, { voices: [] })).fetch }, 'elevenlabs', KEY);
    expect(statuses(r)).toEqual({ key: 'ok', account: 'ok', voices: 'ok', tts: 'unverified', sfx: 'unverified', music: 'unverified' });
  });
  it('a 403 on the voices probe marks voices missing; an unknown key is invalid', async () => {
    const a = await checkKey({ fetch: fake((u) => (u.includes('/v2/voices') ? new Response('', { status: 403 }) : json(200, {}))).fetch }, 'elevenlabs', KEY);
    expect(cap(a, 'voices')).toMatchObject({ status: 'missing', permission: 'voices_read' });
    expect(cap(a, 'key')!.status).toBe('ok');
    const b = await checkKey({ fetch: fake(elevenInvalid).fetch }, 'elevenlabs', KEY);
    expect(statuses(b)).toEqual({ key: 'missing', account: 'missing', voices: 'missing', tts: 'missing', sfx: 'missing', music: 'missing' });
  });
  it('a network error or a 5xx is error, never missing', async () => {
    const down = await checkKey({ fetch: fake(() => { throw new TypeError(`fetch failed for ${KEY}`); }).fetch }, 'elevenlabs', KEY);
    expect(statuses(down)).toEqual({ key: 'error', account: 'error', voices: 'error', tts: 'unverified', sfx: 'unverified', music: 'unverified' });
    expect(cap(down, 'account')!.detail).toBeTruthy();
    noKey(down);
    const busy = await checkKey({ fetch: fake(() => new Response(`overloaded ${KEY}`, { status: 503 })).fetch }, 'elevenlabs', KEY);
    expect(cap(busy, 'voices')).toMatchObject({ status: 'error', detail: expect.stringContaining('503') });
    expect(busy.capabilities.some((c) => c.status === 'missing')).toBe(false);
    noKey(busy);
    // One probe down, the other one answering: the key is known to work, the failed probe stays an error.
    const half = await checkKey({ fetch: fake((u) => (u.includes('/v1/user') ? new Response('', { status: 500 }) : json(200, {}))).fetch }, 'elevenlabs', KEY);
    expect(statuses(half)).toMatchObject({ key: 'ok', account: 'error', voices: 'ok' });
  });
});

describe('checkKey · stock', () => {
  it('Pexels: one search of one result', async () => {
    const f = fake(() => json(200, { photos: [] }));
    const r = await checkKey({ fetch: f.fetch }, 'pexels', KEY);
    expect(statuses(r)).toEqual({ key: 'ok', search: 'ok' });
    expect(f.sent[0]!.url).toBe('https://api.pexels.com/v1/search?query=test&per_page=1');
    expect(f.sent[0]!.headers.get('authorization')).toBe(KEY);
    expect(statuses(await checkKey({ fetch: fake(() => new Response('', { status: 401 })).fetch }, 'pexels', KEY))).toEqual({ key: 'missing', search: 'missing' });
  });
  it('Unsplash: one search with the Client-ID header; its 403 "Rate Limit Exceeded" is an error', async () => {
    const f = fake(() => json(200, { results: [] }));
    const r = await checkKey({ fetch: f.fetch }, 'unsplash', KEY);
    expect(statuses(r)).toEqual({ key: 'ok', search: 'ok' });
    expect(f.sent[0]!.url).toBe('https://api.unsplash.com/search/photos?query=test&per_page=1');
    expect(f.sent[0]!.headers.get('authorization')).toBe(`Client-ID ${KEY}`);
    const limited = await checkKey({ fetch: fake(() => new Response('Rate Limit Exceeded', { status: 403 })).fetch }, 'unsplash', KEY);
    expect(statuses(limited)).toEqual({ key: 'error', search: 'error' });
    const r429 = await checkKey({ fetch: fake(() => new Response('', { status: 429 })).fetch }, 'pexels', KEY);
    expect(statuses(r429)).toEqual({ key: 'error', search: 'error' });
    expect(statuses(await checkKey({ fetch: fake(() => new Response('', { status: 401 })).fetch }, 'unsplash', KEY))).toEqual({ key: 'missing', search: 'missing' });
  });
});

describe('checkKey · timing', () => {
  it('runs the probes in parallel, each with a 15 s deadline', async () => {
    expect(KEY_CHECK_TIMEOUT_MS).toBe(15_000);
    vi.useFakeTimers();
    const f = fake((_u, init) => new Promise<Response>((_res, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted')))));
    let done: KeyCheckResult | null = null;
    void checkKey({ fetch: f.fetch }, 'openai', KEY).then((r) => { done = r; });
    await vi.advanceTimersByTimeAsync(0);
    // All three requests are out before any answer.
    expect(f.sent).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(KEY_CHECK_TIMEOUT_MS - 1);
    expect(done).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    // One deadline for all of them (parallel), not three in a row.
    expect(done).not.toBeNull();
    expect(statuses(done!)).toEqual({ key: 'error', images: 'error', tts: 'error' });
    expect(cap(done!, 'key')!.detail).toMatch(/15/);
    for (const s of f.sent) expect(s.init.signal!.aborted).toBe(true);
  });
  it('never throws, whatever fetch does', async () => {
    const r = await checkKey({ fetch: (() => Promise.reject(new Error(KEY))) as unknown as typeof fetch }, 'unsplash', KEY);
    expect(statuses(r)).toEqual({ key: 'error', search: 'error' });
    noKey(r);
  });
});

describe('KeyCheckCache', () => {
  const check = (caps: KeyCheckResult['capabilities']): KeyCheckResult => ({ provider: 'elevenlabs', checkedAt: '2026-10-13T10:00:00.000Z', capabilities: caps });
  it('a first real music call answering 403 marks music missing with its permission', () => {
    const c = new KeyCheckCache();
    expect(c.get('elevenlabs')).toBeNull();
    c.merge('elevenlabs', check([{ capability: 'key', status: 'ok' }, { capability: 'music', status: 'unverified', permission: 'music_generation' }]));
    c.record('elevenlabs', 'music', 'missing', 'music_generation');
    expect(c.capabilities('elevenlabs').music).toMatchObject({ status: 'missing', permission: 'music_generation' });
    c.record('elevenlabs', 'music', 'ok');
    expect(c.capabilities('elevenlabs').music).toEqual({ capability: 'music', status: 'ok' });
  });
  it('a new check keeps what real use learned for capabilities it cannot verify, and replaces the rest', () => {
    const c = new KeyCheckCache();
    c.record('elevenlabs', 'tts', 'ok');
    c.record('elevenlabs', 'voices', 'missing', 'voices_read');
    const out = c.merge('elevenlabs', check([{ capability: 'key', status: 'ok' }, { capability: 'voices', status: 'ok' }, { capability: 'tts', status: 'unverified', permission: 'text_to_speech' }]));
    expect(statuses(out)).toEqual({ key: 'ok', voices: 'ok', tts: 'ok' });
    // An invalid key replaces everything.
    const bad = c.merge('elevenlabs', check([{ capability: 'key', status: 'missing' }, { capability: 'tts', status: 'missing' }]));
    expect(statuses(bad)).toMatchObject({ key: 'missing', tts: 'missing' });
    c.clear('elevenlabs');
    expect(c.get('elevenlabs')).toBeNull();
  });
  it('a success proves the key; results come in a stable order', () => {
    const c = new KeyCheckCache();
    c.merge('elevenlabs', check([{ capability: 'key', status: 'missing' }]));
    c.record('elevenlabs', 'music', 'ok');
    c.record('elevenlabs', 'sfx', 'ok');
    expect(c.get('elevenlabs')!.capabilities.map((x) => x.capability)).toEqual(['key', 'sfx', 'music']);
    expect(c.capabilities('elevenlabs').key!.status).toBe('ok');
  });
  it('caps and cleans the permission and detail strings (Task 0 minor)', () => {
    const c = new KeyCheckCache();
    c.merge('openai', { provider: 'openai', checkedAt: 'x', capabilities: [{ capability: 'key', status: 'error', detail: `bad\u0007${'y'.repeat(5000)}` }] });
    c.record('openai', 'images', 'missing', `perm\u0000\n${'x'.repeat(500)}`);
    const r = c.get('openai')!;
    expect(cap(r, 'images')!.permission!.length).toBeLessThanOrEqual(64);
    expect(cap(r, 'images')!.permission).not.toMatch(/[\u0000-\u001f]/);
    expect(cap(r, 'key')!.detail!.length).toBeLessThanOrEqual(200);
    expect(cap(r, 'key')!.detail).not.toMatch(/[\u0000-\u001f]/);
  });
});
