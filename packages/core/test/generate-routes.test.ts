import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AppConfigStore } from '../src/app-config.ts';
import { ApprovalBroker } from '../src/approvals/broker.ts';
import { PermissionsStore } from '../src/approvals/permissions-store.ts';
import { Git } from '../src/git.ts';
import { LibraryStore } from '../src/library/library-store.ts';
import { NoMediaTools, type MediaTools } from '../src/media/media-tools.ts';
import { KeyCheckCache } from '../src/providers/key-check.ts';
import { MemoryVault } from '../src/secrets/vault.ts';
import { buildServer } from '../src/server/app.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const OPENAI = 'sk-test-openai-0123456789';
const ELEVEN = 'xi-secret-key-0123456789';
const PNG = Buffer.from('iVBORw0KGgo=', 'base64');
const P = '/api/projects/acme';
let app: FastifyInstance;
let base: string;
let broker: ApprovalBroker;
let keyChecks: KeyCheckCache;
let calls: Array<{ url: string; body: string }>;
let status: number;
let hang: boolean;
let voicesDenied = false;
const media: MediaTools = { ...NoMediaTools, available: true, probe: async () => ({ width: 8, height: 8, durationSec: null }) as never, probeAudio: async () => ({ durationSec: 4.5 }) };

const fakeFetch = (async (url: string, init?: RequestInit) => {
  calls.push({ url, body: typeof init?.body === 'string' ? init.body : '' });
  if (voicesDenied && url.startsWith('https://api.elevenlabs.io/v2/voices')) return new Response(JSON.stringify({ detail: { status: 'missing_permissions', message: 'The API key you used is missing the permission voices_read to execute this operation.' } }), { status: 401 });
  if (hang) return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
  if (status !== 200) return new Response('{"error":"denied"}', { status });
  if (url.startsWith('https://api.openai.com/v1/images')) return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }), { status: 200 });
  if (url.startsWith('https://api.openai.com/v1/audio/speech') || url.startsWith('https://api.elevenlabs.io/v1/')) return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
  if (url.startsWith('https://api.elevenlabs.io/v2/voices')) return new Response(JSON.stringify({ voices: [{ voice_id: 'v1' }] }), { status: 200 });
  return new Response('no', { status: 404 });
}) as unknown as typeof fetch;

async function boot(keys: Record<string, string> = { openai: OPENAI, elevenlabs: ELEVEN }, settings: { confirmPaidProviders?: boolean } = { confirmPaidProviders: false }) {
  const vault = new MemoryVault();
  for (const [k, v] of Object.entries(keys)) await vault.set(k as 'openai', v);
  app = await buildServer({
    uiToken: null, sandbox: async () => ({ available: false, reason: 'test' }), appConfig: new AppConfigStore(join(base, 'config')), git: new Git(), doctor: async () => [],
    runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }), vault, approvals: broker, keyChecks, media, generateHttp: { fetch: fakeFetch },
  });
  await app.inject({ method: 'PUT', url: '/api/workspace', payload: { path: join(base, 'ws') } });
  await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
  if (Object.keys(settings).length) await app.inject({ method: 'PUT', url: '/api/settings', payload: settings });
}
const post = (payload: unknown) => app.inject({ method: 'POST', url: `${P}/generate`, payload: payload as never });
const settle = async (jobId: string) => {
  await vi.waitFor(async () => { const j = (await app.inject('/api/jobs')).json().find((x: { id: string }) => x.id === jobId); expect(['succeeded', 'failed', 'cancelled']).toContain(j.state); }, { timeout: 10_000 });
  return (await app.inject('/api/jobs')).json().find((x: { id: string }) => x.id === jobId);
};
const assets = async () => new LibraryStore(join(base, 'ws', 'acme'), media).listAssets();

beforeEach(async () => { base = await mkdtemp(join(tmpdir(), 'ms-gen-')); broker = new ApprovalBroker({ broadcast: () => {} }); keyChecks = new KeyCheckCache(); calls = []; status = 200; hang = false; voicesDenied = false; });
afterEach(async () => { await app.close(); vi.restoreAllMocks(); });

describe('generate route', () => {
  it('generates an image as an asset-generation job and registers it with provider and model', async () => {
    await boot();
    const r = await post({ kind: 'image', provider: 'openai', prompt: 'A blue banner', options: { width: 1024, height: 1024 } });
    expect(r.statusCode).toBe(202);
    const job = await settle(r.json().jobId);
    expect(job).toMatchObject({ kind: 'asset-generation', state: 'succeeded' });
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/images/generations');
    const [a] = await assets();
    expect(a).toMatchObject({ origin: 'generated', kind: 'image', provider: 'openai', model: 'gpt-image-2', description: 'A blue banner' });
    expect(a!.file).toMatch(/^generated\/.+\.png$/);
    expect(a!.bytes).toBeGreaterThan(0);
  });
  it('generates a voice-over with each provider', async () => {
    await boot();
    const o = await settle((await post({ kind: 'voice', provider: 'openai', text: 'Hello there', options: { voice: 'marin' } })).json().jobId);
    expect(o.state).toBe('succeeded');
    const e = await settle((await post({ kind: 'voice', provider: 'elevenlabs', text: 'Ciao a tutti', options: { voice: 'v1', name: 'ciao' } })).json().jobId);
    expect(e.state).toBe('succeeded');
    const list = await assets();
    expect(list.map((x) => x.provider).sort()).toEqual(['elevenlabs', 'openai']);
    expect(list.find((x) => x.provider === 'elevenlabs')).toMatchObject({ kind: 'audio', durationSec: 4.5, model: 'eleven_multilingual_v2', file: 'audio/ciao.mp3', attribution: 'Voce generata con AI (ElevenLabs)' });
    expect(list.find((x) => x.provider === 'openai')!.model).toBe('gpt-4o-mini-tts');
  });
  it('generates a sound effect and music, probed and attributed', async () => {
    await boot();
    expect((await settle((await post({ kind: 'sfx', provider: 'elevenlabs', prompt: 'Door slam', options: { durationSec: 2, loop: true } })).json().jobId)).state).toBe('succeeded');
    expect((await settle((await post({ kind: 'music', provider: 'elevenlabs', prompt: 'Calm piano', options: { durationSec: 30, instrumental: true } })).json().jobId)).state).toBe('succeeded');
    const list = await assets();
    expect(list.find((x) => x.model === 'eleven_text_to_sound_v2')).toMatchObject({ provider: 'elevenlabs', loop: true, durationSec: 4.5, bytes: 4, attribution: 'Generato con AI (ElevenLabs)' });
    expect(list.find((x) => x.model === 'music_v1')).toMatchObject({ provider: 'elevenlabs', description: 'Calm piano' });
    expect(JSON.parse(calls.find((c) => c.url.includes('/v1/music'))!.body)).toMatchObject({ music_length_ms: 30_000, force_instrumental: true });
    expect(keyChecks.capabilities('elevenlabs')).toMatchObject({ sfx: { status: 'ok' }, music: { status: 'ok' } });
  });
  it('asks for confirmation (the approval card) and runs only after "once"', async () => {
    await boot({ openai: OPENAI, elevenlabs: ELEVEN }, { confirmPaidProviders: true });
    const { jobId } = (await post({ kind: 'music', provider: 'elevenlabs', prompt: 'Calm piano', options: { durationSec: 30 } })).json();
    await vi.waitFor(() => expect(broker.pending()).toHaveLength(1), { timeout: 10_000 });
    expect(broker.pending()[0]).toMatchObject({ jobId, kind: 'provider', toolName: 'provider:music-elevenlabs', projectSlug: 'acme' });
    expect(calls).toEqual([]);
    await broker.decide(broker.pending()[0]!.id, 'once');
    expect((await settle(jobId)).state).toBe('succeeded');
    expect(calls).toHaveLength(1);
  });
  it('"always" stores the per-project rule so the next Generate does not ask', async () => {
    await boot({ openai: OPENAI, elevenlabs: ELEVEN }, { confirmPaidProviders: true });
    const { jobId } = (await post({ kind: 'sfx', provider: 'elevenlabs', prompt: 'Whoosh' })).json();
    await vi.waitFor(() => expect(broker.pending()).toHaveLength(1), { timeout: 10_000 });
    await broker.decide(broker.pending()[0]!.id, 'always');
    await settle(jobId);
    expect(await new PermissionsStore(join(base, 'ws', 'acme')).has('provider:sfx-elevenlabs')).toBe(true);
    const next = await settle((await post({ kind: 'sfx', provider: 'elevenlabs', prompt: 'Whoosh 2' })).json().jobId);
    expect(next.state).toBe('succeeded');
    expect(broker.pending()).toEqual([]);
  });
  it('a denied confirmation makes no provider call and registers nothing', async () => {
    await boot({ openai: OPENAI, elevenlabs: ELEVEN }, { confirmPaidProviders: true });
    const { jobId } = (await post({ kind: 'image', provider: 'openai', prompt: 'x', options: {} })).json();
    await vi.waitFor(() => expect(broker.pending()).toHaveLength(1), { timeout: 10_000 });
    await broker.decide(broker.pending()[0]!.id, 'deny');
    expect((await settle(jobId)).state).toBe('failed');
    expect(calls).toEqual([]);
    expect(await assets()).toEqual([]);
  });
  it('cancelling while the approval is pending drops the card; cancelling during the call aborts it and leaves no file', async () => {
    await boot({ openai: OPENAI, elevenlabs: ELEVEN }, { confirmPaidProviders: true });
    const a = (await post({ kind: 'sfx', provider: 'elevenlabs', prompt: 'Whoosh' })).json().jobId;
    await vi.waitFor(() => expect(broker.pending()).toHaveLength(1), { timeout: 10_000 });
    expect((await app.inject({ method: 'POST', url: `/api/jobs/${a}/cancel` })).json()).toEqual({ cancelled: true });
    expect((await settle(a)).state).toBe('cancelled');
    expect(broker.pending()).toEqual([]);
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { confirmPaidProviders: false } });
    hang = true;
    const b = (await post({ kind: 'sfx', provider: 'elevenlabs', prompt: 'Whoosh' })).json().jobId;
    await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 10_000 });
    await app.inject({ method: 'POST', url: `/api/jobs/${b}/cancel` });
    expect((await settle(b)).state).toBe('cancelled');
    expect(await assets()).toEqual([]);
    expect(await readdir(join(base, 'ws', 'acme', 'assets')).then((l) => l.filter((f) => f !== '.gitkeep' && f !== 'audio' && f !== 'assets.json'))).toEqual([]);
  });
  it('a 401 or 403 records the capability as missing and fails without the key anywhere', async () => {
    await boot();
    status = 403;
    const job = await settle((await post({ kind: 'music', provider: 'elevenlabs', prompt: 'Calm piano', options: { durationSec: 30 } })).json().jobId);
    expect(job.state).toBe('failed');
    expect(keyChecks.capabilities('elevenlabs').music).toMatchObject({ status: 'missing', permission: 'music_generation' });
    status = 401;
    await settle((await post({ kind: 'image', provider: 'openai', prompt: 'x' })).json().jobId);
    expect(keyChecks.capabilities('openai').images).toMatchObject({ status: 'missing' });
    const everything = JSON.stringify([(await app.inject('/api/jobs')).json(), keyChecks.get('elevenlabs'), keyChecks.get('openai')]);
    expect(everything).not.toContain(ELEVEN);
    expect(everything).not.toContain(OPENAI);
  });
  it('ElevenLabs voice with no voice id: a refused voice list blames voices_read, not text_to_speech (Review Focus 3 key)', async () => {
    await boot();
    voicesDenied = true;
    const job = await settle((await post({ kind: 'voice', provider: 'elevenlabs', text: 'Ciao a tutti', options: {} })).json().jobId);
    expect(job.state).toBe('failed');
    expect(keyChecks.capabilities('elevenlabs').voices).toMatchObject({ status: 'missing', permission: 'voices_read' });
    expect(keyChecks.capabilities('elevenlabs').tts).toBeUndefined();
    expect(calls.some((c) => c.url.includes('/v1/text-to-speech/'))).toBe(false);
    voicesDenied = false;
    const ok = await settle((await post({ kind: 'voice', provider: 'elevenlabs', text: 'Ciao a tutti', options: {} })).json().jobId);
    expect(ok.state).toBe('succeeded');
    expect(keyChecks.capabilities('elevenlabs')).toMatchObject({ voices: { status: 'ok' }, tts: { status: 'ok' } });
  });
  it('validates before queuing anything: shapes, limits and missing keys, with localized messages', async () => {
    await boot({ elevenlabs: ELEVEN });
    const bad = async (payload: unknown, code = 400) => { const r = await post(payload); expect(r.statusCode).toBe(code); expect((await app.inject('/api/jobs')).json()).toEqual([]); return r.json().error as string; };
    await bad({ kind: 'nope' });
    await bad({ kind: 'sfx', provider: 'openai', prompt: 'x' });
    await bad({ kind: 'sfx', provider: 'elevenlabs', prompt: '   ' });
    expect(await bad({ kind: 'sfx', provider: 'elevenlabs', prompt: 'x', options: { durationSec: 31 } })).toContain('30');
    expect(await bad({ kind: 'music', provider: 'elevenlabs', prompt: 'x', options: { durationSec: 5 } })).toContain('300');
    await bad({ kind: 'music', provider: 'elevenlabs', prompt: 'x', options: {} });
    await bad({ kind: 'sfx', provider: 'elevenlabs', prompt: 'x'.repeat(1001) });
    await bad({ kind: 'voice', provider: 'elevenlabs', text: 'hi', options: { voice: '../x' } });
    await bad({ kind: 'sfx', provider: 'elevenlabs', prompt: 'x', extra: 1 });
    expect(await bad({ kind: 'image', provider: 'openai', prompt: 'x' })).toContain('OpenAI');
    expect((await app.inject({ method: 'POST', url: '/api/projects/ghost/generate', payload: { kind: 'sfx', provider: 'elevenlabs', prompt: 'x' } })).statusCode).toBe(404);
    expect(calls).toEqual([]);
  });
  it('refuses at POST a voice of the other provider, before any job, confirmation or request (final review I1)', async () => {
    await boot(undefined, { confirmPaidProviders: true });
    const refused = async (payload: unknown) => { const r = await post(payload); expect(r.statusCode).toBe(400); return r.json().error as string; };
    expect(await refused({ kind: 'voice', provider: 'openai', text: 'Ciao', options: { voice: 'JBFqnCBsd6RMkjVDRZzb' } })).toBe('La voce JBFqnCBsd6RMkjVDRZzb non è una voce OpenAI: scegline una fra le voci OpenAI');
    expect(await refused({ kind: 'voice', provider: 'elevenlabs', text: 'Ciao', options: { voice: 'alloy' } })).toContain('ElevenLabs');
    expect((await app.inject('/api/jobs')).json()).toEqual([]);
    expect(broker.pending()).toEqual([]);
    expect(calls).toEqual([]);
  });
  it('ElevenLabs with no voice: the default voice is read before the confirmation, so a key without voices_read gets no approval card (M3)', async () => {
    await boot(undefined, { confirmPaidProviders: true });
    voicesDenied = true;
    const created = vi.spyOn(broker, 'request');
    const job = await settle((await post({ kind: 'voice', provider: 'elevenlabs', text: 'Ciao a tutti', options: {} })).json().jobId);
    expect(job.state).toBe('failed');
    expect(created).not.toHaveBeenCalled();
    expect(calls.some((c) => c.url.includes('/v1/text-to-speech/'))).toBe(false);
  });
  it('a result that comes back after the key was replaced is not recorded for the new key (M2)', async () => {
    await boot(undefined, { confirmPaidProviders: true });
    status = 401;
    const jobId = (await post({ kind: 'image', provider: 'openai', prompt: 'x' })).json().jobId;
    await vi.waitFor(() => expect(broker.pending()).toHaveLength(1), { timeout: 10_000 });
    // The user saves another key while the card waits: the route sets it and forgets what was known.
    expect((await app.inject({ method: 'PUT', url: '/api/secrets/openai', payload: { value: 'sk-test-other-0123456789', check: false } })).statusCode).toBe(200);
    await broker.decide(broker.pending()[0]!.id, 'once');
    expect((await settle(jobId)).state).toBe('failed');
    expect(keyChecks.get('openai')).toBeNull();
  });
  it('accepts an OpenAI voice name in any case and sends it in lower case (review minor)', async () => {
    await boot();
    const job = await settle((await post({ kind: 'voice', provider: 'openai', text: 'Hello', options: { voice: 'Alloy' } })).json().jobId);
    expect(job.state).toBe('succeeded');
    expect(JSON.parse(calls.find((c) => c.url.includes('/v1/audio/speech'))!.body).voice).toBe('alloy');
    expect((await post({ kind: 'voice', provider: 'elevenlabs', text: 'Ciao', options: { voice: 'ALLOY' } })).statusCode).toBe(400);
  });
});
