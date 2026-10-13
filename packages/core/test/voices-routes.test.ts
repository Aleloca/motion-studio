import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AppConfigStore } from '../src/app-config.ts';
import { Git } from '../src/git.ts';
import { fetchTransport } from '../src/providers/safe-fetch.ts';
import { KeyCheckCache } from '../src/providers/key-check.ts';
import { isElevenLabsPreviewUrl, OPENAI_VOICES } from '../src/providers/voices.ts';
import { buildServer } from '../src/server/app.ts';
import { MemoryVault } from '../src/secrets/vault.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const TOKEN = 'a'.repeat(64);
const KEY = 'xi-secret-key-0123456789';
let app: FastifyInstance;
let base: string;
let calls: Array<{ url: string; key: string | null }>;
let listStatus: number;
let big: boolean;

const voice = (id: string, name: string, preview: unknown, labels: Record<string, unknown> = { accent: 'british' }) => ({ voice_id: id, name, labels, preview_url: preview });
const voicesJson = () => ({ voices: [
  voice('v1', 'Rachel', 'https://storage.googleapis.com/eleven-public-prod/premade/v1/p.mp3'),
  voice('v2', 'Adam', 'https://files.elevenlabs.io/p2.mp3'),
  voice('v3', 'Evil', 'https://evil.example/p3.mp3'),
  voice('v4', 'Plain', 'http://files.elevenlabs.io/p4.mp3'),
  voice('v5', 'Redirected', 'https://files.elevenlabs.io/redirect.mp3'),
  voice('v6', 'Nopreview', null),
  voice('bad id!', 'Weird', 'https://files.elevenlabs.io/p7.mp3'),
  voice('v8', 'Rebucketed', 'https://files.elevenlabs.io/to-bucket.mp3'),
  voice('v9', 'Squatter', 'https://storage.googleapis.com/eleven-public-attacker/p9.mp3'),
] });
const fakeFetch = (async (url: string, init?: RequestInit) => {
  const h = new Headers(init?.headers);
  calls.push({ url, key: h.get('xi-api-key') });
  if (url.startsWith('https://api.elevenlabs.io/v2/voices')) {
    if (listStatus !== 200) return new Response('denied', { status: listStatus });
    const s = new URL(url).searchParams.get('search');
    const all = voicesJson();
    return new Response(JSON.stringify(s ? { voices: all.voices.filter((v) => v.name.toLowerCase().includes(s.toLowerCase())) } : all), { status: 200 });
  }
  if (url === 'https://files.elevenlabs.io/to-bucket.mp3') return new Response(null, { status: 302, headers: { location: 'https://storage.googleapis.com/eleven-public-attacker/p.mp3' } });
  if (url === 'https://files.elevenlabs.io/redirect.mp3') return new Response(null, { status: 302, headers: { location: 'https://evil.example/stolen.mp3' } });
  if (url.startsWith('https://files.elevenlabs.io/') || url.startsWith('https://storage.googleapis.com/eleven-public-prod/')) {
    return new Response(new Uint8Array(big ? 2 * 1024 * 1024 + 1 : 8).fill(7), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  }
  return new Response('no', { status: 404 });
}) as unknown as typeof fetch;

async function boot(opts: { key?: boolean; extra?: Record<string, unknown> } = {}) {
  const vault = new MemoryVault();
  if (opts.key !== false) await vault.set('elevenlabs', KEY);
  app = await buildServer({
    uiToken: TOKEN, sandbox: async () => ({ available: false, reason: 'test' }), appConfig: new AppConfigStore(join(base, 'config')), configDir: join(base, 'config'),
    git: new Git(), doctor: async () => [], runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }), vault,
    voicesHttp: { fetch: fakeFetch, transport: fetchTransport(fakeFetch), lookup: async () => [{ address: '142.250.180.3', family: 4 }] }, ...opts.extra,
  });
  return { 'x-motion-studio-ui': TOKEN };
}
beforeEach(async () => { base = await mkdtemp(join(tmpdir(), 'ms-vr-')); calls = []; listStatus = 200; big = false; });
afterEach(async () => { await app.close(); vi.restoreAllMocks(); });

describe('voices routes', () => {
  it('lists the fixed OpenAI voices, filtered by q, without previews and without any network call', async () => {
    const h = await boot();
    expect((await app.inject('/api/voices?provider=openai')).statusCode).toBe(401);
    const all = (await app.inject({ url: '/api/voices?provider=openai', headers: h })).json();
    expect(all.voices.map((v: { id: string }) => v.id)).toEqual([...OPENAI_VOICES]);
    expect(all.voices.every((v: { previewUrl: unknown }) => v.previewUrl === null)).toBe(true);
    expect(all.configured).toBe(false);
    expect((await app.inject({ url: '/api/voices?provider=openai&q=MAR', headers: h })).json().voices.map((v: { id: string }) => v.id)).toEqual(['marin']);
    expect(calls).toEqual([]);
  });
  it('lists ElevenLabs voices through the core, with signed previews only for allowed hosts', async () => {
    const cache = new KeyCheckCache();
    const h = await boot({ extra: { keyChecks: cache } });
    const r = (await app.inject({ url: '/api/voices?provider=elevenlabs', headers: h })).json();
    expect(cache.capabilities('elevenlabs').voices).toMatchObject({ status: 'ok' });
    expect(r.configured).toBe(true);
    expect(r.voices.map((v: { id: string }) => v.id)).toEqual(['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v8', 'v9']);
    const prev = Object.fromEntries(r.voices.map((v: { id: string; previewUrl: string | null }) => [v.id, v.previewUrl]));
    expect(prev.v1).toMatch(/^\/api\/voices\/preview\/elevenlabs\/v1\?s=\d+\./);
    expect(prev.v2).toMatch(/^\/api\/voices\/preview\/elevenlabs\/v2\?s=/);
    expect([prev.v3, prev.v4, prev.v6, prev.v9]).toEqual([null, null, null, null]);
    expect(r.voices[0]).toMatchObject({ name: 'Rachel', labels: { accent: 'british' } });
    expect(JSON.stringify(r)).not.toContain('evil.example');
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(calls[0]).toEqual({ url: 'https://api.elevenlabs.io/v2/voices?page_size=30', key: KEY });
  });
  it('passes the search to ElevenLabs', async () => {
    const h = await boot();
    const r = (await app.inject({ url: '/api/voices?provider=elevenlabs&q=adam', headers: h })).json();
    expect(r.voices.map((v: { id: string }) => v.id)).toEqual(['v2']);
    expect(calls[0]!.url).toContain('search=adam');
  });
  it('without a key: configured false, no voices, and no call to ElevenLabs', async () => {
    const h = await boot({ key: false });
    const r = (await app.inject({ url: '/api/voices?provider=elevenlabs', headers: h })).json();
    expect(r).toMatchObject({ provider: 'elevenlabs', configured: false, voices: [] });
    expect(calls).toEqual([]);
  });
  it('rejects an unknown provider and an oversized search', async () => {
    const h = await boot();
    expect((await app.inject({ url: '/api/voices?provider=acme', headers: h })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/voices?provider=openai&q=${'x'.repeat(101)}`, headers: h })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/voices', headers: h })).statusCode).toBe(400);
  });
  it('serves a preview only through the signed URL of the authenticated list, as audio, nosniff', async () => {
    const h = await boot();
    const prev = (await app.inject({ url: '/api/voices?provider=elevenlabs', headers: h })).json().voices[0].previewUrl as string;
    const r = await app.inject(prev); // no header token: <audio> cannot send one
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('audio/mpeg');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.rawPayload.length).toBe(8);
    expect(calls.at(-1)).toEqual({ url: 'https://storage.googleapis.com/eleven-public-prod/premade/v1/p.mp3', key: null });
    expect((await app.inject({ method: 'HEAD', url: prev })).statusCode).toBe(200);
  });
  it('refuses unsigned, expired, forged or retargeted preview URLs without any fetch', async () => {
    const h = await boot();
    const list = (await app.inject({ url: '/api/voices?provider=elevenlabs', headers: h })).json().voices as Array<{ id: string; previewUrl: string }>;
    const sig = new URL(list[0]!.previewUrl, 'http://x').searchParams.get('s');
    const before = calls.length;
    for (const bad of ['/api/voices/preview/elevenlabs/v1', '/api/voices/preview/elevenlabs/v1?s=1.abc', `/api/voices/preview/elevenlabs/v2?s=${sig}`, `/api/voices/preview/openai/v1?s=${sig}`]) {
      expect([bad, (await app.inject(bad)).statusCode]).toEqual([bad, 403]);
    }
    expect(calls.length).toBe(before);
    await app.close();
    const h2 = await boot({ extra: { signedUrlTtlMs: 30 } });
    const url = (await app.inject({ url: '/api/voices?provider=elevenlabs', headers: h2 })).json().voices[0].previewUrl;
    await new Promise((res) => setTimeout(res, 60));
    expect((await app.inject(url)).statusCode).toBe(403);
  });
  it('never fetches an id the list did not return, nor a disallowed host', async () => {
    const h = await boot();
    const sign = async (id: string) => {
      // a signed URL for an id the core never saw: only possible through the list, so forge the path with the real signer is impossible; ask for a missing id after a list
      const prev = (await app.inject({ url: '/api/voices?provider=elevenlabs', headers: h })).json().voices[0].previewUrl as string;
      return prev.replace('/v1?', `/${id}?`);
    };
    expect((await app.inject(await sign('v3'))).statusCode).toBe(403); // MAC covers the id
    expect(calls.filter((c) => c.url.includes('evil.example'))).toEqual([]);
  });
  it('refuses a preview whose redirect leaves the ElevenLabs hosts, and one over 2 MB', async () => {
    const h = await boot();
    const list = (await app.inject({ url: '/api/voices?provider=elevenlabs', headers: h })).json().voices as Array<{ id: string; previewUrl: string }>;
    const redirected = list.find((v) => v.id === 'v5')!.previewUrl;
    const r = await app.inject(redirected);
    expect(r.statusCode).toBe(503);
    expect(calls.filter((c) => c.url.includes('evil.example'))).toEqual([]);
    big = true;
    expect((await app.inject(list[0]!.previewUrl)).statusCode).toBe(503);
  });
  it('refuses a preview whose redirect hops to another Google Cloud Storage bucket', async () => {
    const h = await boot();
    const list = (await app.inject({ url: '/api/voices?provider=elevenlabs', headers: h })).json().voices as Array<{ id: string; previewUrl: string }>;
    const r = await app.inject(list.find((v) => v.id === 'v8')!.previewUrl);
    expect(r.statusCode).toBe(503);
    expect(calls.filter((c) => c.url.includes('eleven-public-attacker'))).toEqual([]);
  });
  it('a 401 from ElevenLabs is an answer, not a UI-token failure, never carries the key and feeds the key check', async () => {
    listStatus = 401;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cache = new KeyCheckCache();
    const h = await boot({ extra: { keyChecks: cache } });
    const r = await app.inject({ url: '/api/voices?provider=elevenlabs', headers: h });
    expect(r.statusCode).toBe(503);
    expect(cache.capabilities('elevenlabs').voices).toMatchObject({ status: 'missing', permission: 'voices_read' });
    expect(r.body).not.toContain(KEY);
    expect(JSON.stringify([warn.mock.calls, log.mock.calls, err.mock.calls])).not.toContain(KEY);
  });
});

describe('isElevenLabsPreviewUrl', () => {
  it('accepts https on the ElevenLabs hosts and their public bucket only', () => {
    for (const ok of ['https://files.elevenlabs.io/a.mp3', 'https://elevenlabs.io/a.mp3', 'https://storage.googleapis.com/eleven-public-prod/a.mp3', 'https://storage.googleapis.com/eleven-public-prod/premade/voices/v1/0f1e2d3c.mp3']) expect(isElevenLabsPreviewUrl(ok)).toBe(true);
    for (const bad of ['http://files.elevenlabs.io/a.mp3', 'https://evilelevenlabs.io/a.mp3', 'https://files.elevenlabs.io.evil.example/a', 'https://storage.googleapis.com/other-bucket/a.mp3', 'https://u:p@files.elevenlabs.io/a', 'https://files.elevenlabs.io:8443/a', 'ftp://files.elevenlabs.io/a', 'javascript:alert(1)', '/relative', '']) expect([bad, isElevenLabsPreviewUrl(bad)]).toEqual([bad, false]);
  });
  it('pins the bucket to exactly eleven-public-prod (anyone can create a bucket with the same prefix)', () => {
    for (const bad of [
      'https://storage.googleapis.com/eleven-public-attacker/a.mp3', 'https://storage.googleapis.com/eleven-public-prodx/a.mp3',
      'https://storage.googleapis.com/eleven-public-cdn/a.mp3', 'https://storage.googleapis.com/eleven-public-prod', 'https://storage.googleapis.com/eleven-public-prod/',
      'https://eleven-public-prod.storage.googleapis.com/a.mp3',
    ]) expect([bad, isElevenLabsPreviewUrl(bad)]).toEqual([bad, false]);
  });
  it('refuses an encoded traversal, an encoded slash or a backslash out of the bucket', () => {
    for (const bad of [
      'https://storage.googleapis.com/eleven-public-prod/../eleven-public-attacker/a.mp3',
      'https://storage.googleapis.com/eleven-public-prod/%2e%2e/eleven-public-attacker/a.mp3',
      'https://storage.googleapis.com/eleven-public-prod/%2E%2E/eleven-public-attacker/a.mp3',
      'https://storage.googleapis.com/eleven-public-prod%2Fx/a.mp3',
      'https://storage.googleapis.com/eleven-public-prod/%2F..%2Feleven-public-attacker/a.mp3',
      'https://storage.googleapis.com/eleven-public-prod/a%2fb.mp3',
      'https://storage.googleapis.com/eleven-public-prod/a%5Cb.mp3',
      'https://storage.googleapis.com/eleven-public-prod/..%2Fx.mp3',
    ]) expect([bad, isElevenLabsPreviewUrl(bad)]).toEqual([bad, false]);
  });
});
