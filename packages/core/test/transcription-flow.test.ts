/**
 * The transcription in the analysis (spec §6): the method resolution, the dialog's hold and its answers, the settings
 * routes. Fake Whisper scripts (never a real one), a fake fetch (never the network), MemoryVault (never the keychain).
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { copyFile, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { usageRecordSchema, type JobSummary, type TranscriptionStatus, type VideoAnalysisView } from '@motion-studio/shared';
import { parseSidecar } from '../src/analysis/sidecar.ts';
import { WHISPER_MODELS, type WhisperModelManifest } from '../src/transcription/models.ts';
import { estimateSttCost } from '../src/transcription/pricing.ts';
import { usageLedgerFile } from '../src/usage/usage-ledger.ts';
import { analysisApp, analysisHelpers, wholeWrite, type AnalysisApp } from './helpers/analysis-app.ts';
import { hasFfmpeg, twoScenes } from './helpers/analysis-fixtures.ts';
import { fakeWhisper, fixturePath } from './helpers/fake-whisper.ts';

let fx: { tone: string; silent: string };
const model = randomBytes(32 * 1024);
let server: Server;
let base = '';
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/ggml-small.bin') { res.writeHead(200, { 'content-length': String(model.length) }); res.end(model); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  if (!hasFfmpeg) return;
  const dir = await mkdtemp(join(tmpdir(), 'ms-tf-fx-'));
  fx = { tone: await twoScenes(join(dir, 'tone.mp4'), 'tone'), silent: await twoScenes(join(dir, 'silent.mp4'), 'silent') };
}, 60_000);
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** A fetch for the fake loopback server and the fake OpenAI / ElevenLabs answers; anything else fails the test. */
function fakeNet() {
  const calls: Array<{ url: string; form: FormData | null }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(base)) return fetch(input, init);
    calls.push({ url, form: (init?.body as FormData) ?? null });
    if (url === 'https://api.openai.com/v1/audio/transcriptions') {
      return new Response(JSON.stringify({ language: 'italian', segments: [{ start: 0.5, end: 2.5, text: ' Ciao a tutti.' }] }), { status: 200 });
    }
    throw new Error(`test tried to reach ${url}`);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const sidecarOf = async (t: AnalysisApp, name: string) => {
  const text = await readFile(join(t.projectDir, 'assets', '.analysis', `${name}.md`), 'utf8').catch(() => null);
  return text === null ? null : parseSidecar(text);
};
const choose = (t: AnalysisApp, payload: Record<string, unknown>) => t.app.inject({ method: 'POST', url: '/api/projects/acme/video-analyses/transcription-choice', payload });
/** Queues the analysis of `file` and waits for its audio check to end (decision 1547): the view once it asks, or is released. */
async function ensured(t: AnalysisApp, file: string): Promise<VideoAnalysisView> {
  await t.analyses.ensure(t.ref, [file], { from: 'brief' });
  await vi.waitFor(async () => {
    const jobs = (await t.app.inject('/api/jobs')).json() as JobSummary[];
    expect(jobs.some((j) => j.kind === 'video-analysis' && j.waitReason === 'transcription-check')).toBe(false);
  }, { timeout: 10_000 });
  return t.analyses.view(t.ref, file);
}
/** Lets the agent run of an analysis write and end, then waits for the job. */
async function finishRun(t: AnalysisApp, h: ReturnType<typeof analysisHelpers>, jobId: string, index = 0) {
  const run = await t.runner.next(index);
  expect((await h.tool(run, 'write_video_analysis', wholeWrite(8))).statusCode).toBe(200);
  run.finish({ write: false });
  await t.analyses.settled(jobId);
  return run;
}

describe.skipIf(!hasFfmpeg)('transcription in the analysis', () => {
  it('asks: no engine and an OpenAI key → a held job, the offer with the OpenAI cost only; OpenAI chosen → one request, sidecar openai, a usage line', async () => {
    const net = fakeNet();
    const t = await analysisApp({ transcription: { method: 'ask', fetch: net.fetchImpl } });
    const h = analysisHelpers(t);
    await t.vault.set('openai', 'sk-test');
    await copyFile(fx.tone, join(t.projectDir, 'assets', 'tone.mp4'));
    const v = await ensured(t, 'assets/tone.mp4');
    expect(v.state).toBe('waiting');
    expect(v.pending).toMatchObject({ kind: 'transcription', openai: { costUsd: estimateSttCost('openai', 8) }, elevenlabs: null, whisper: { available: false, installed: false, canInstall: false, sizeBytes: WHISPER_MODELS.small.sizeBytes } });
    expect((await h.analysisJobs())[0]).toMatchObject({ state: 'queued', waitReason: 'transcription-choice' });
    // A held analysis never holds a creative's first turn.
    expect(t.analyses.activeFor(t.ref, ['assets/tone.mp4'])).toEqual([]);
    const r = await choose(t, { file: 'assets/tone.mp4', choice: 'openai', remember: false });
    expect(r.statusCode).toBe(200);
    expect((r.json() as VideoAnalysisView).pending).toBeNull();
    await finishRun(t, h, v.jobId!);
    expect(net.calls.map((c) => c.url)).toEqual(['https://api.openai.com/v1/audio/transcriptions']);
    const s = await sidecarOf(t, 'tone.mp4');
    expect(s!.header).toMatchObject({ transcript: 'openai', language: 'it' });
    expect(s!.body).toContain('Ciao a tutti.');
    const lines = (await readFile(usageLedgerFile(t.projectDir), 'utf8')).trim().split('\n').map((l) => usageRecordSchema.parse(JSON.parse(l)));
    expect(lines.filter((l) => l.kind === 'transcription')).toMatchObject([{ jobId: v.jobId, costUsd: estimateSttCost('openai', 8) }]);
  }, 60_000);

  it('"none" remembered: settings never, sidecar none-skipped, the next video is not held', async () => {
    const t = await analysisApp({ transcription: { method: 'ask' } });
    const h = analysisHelpers(t);
    await copyFile(fx.tone, join(t.projectDir, 'assets', 'a.mp4'));
    const v = await ensured(t, 'assets/a.mp4');
    expect(v.pending?.kind).toBe('transcription');
    expect((await choose(t, { file: 'assets/a.mp4', choice: 'none', remember: true })).statusCode).toBe(200);
    expect(((await t.app.inject('/api/transcription')).json() as TranscriptionStatus).settings.method).toBe('never');
    await finishRun(t, h, v.jobId!);
    expect((await sidecarOf(t, 'a.mp4'))!.header.transcript).toBe('none-skipped');
    await copyFile(fx.tone, join(t.projectDir, 'assets', 'b.mp4'));
    await (await import('node:fs/promises')).appendFile(join(t.projectDir, 'assets', 'b.mp4'), Buffer.from([0]));
    const w = await ensured(t, 'assets/b.mp4');
    expect(w.pending).toBeNull();
    expect(w.state).not.toBe('waiting');
  }, 60_000);

  it('remember on one dialog answers the other analyses still asking', async () => {
    const t = await analysisApp({ transcription: { method: 'ask' } });
    await copyFile(fx.tone, join(t.projectDir, 'assets', 'a.mp4'));
    const { appendFile } = await import('node:fs/promises');
    await copyFile(fx.tone, join(t.projectDir, 'assets', 'b.mp4'));
    await appendFile(join(t.projectDir, 'assets', 'b.mp4'), Buffer.from([0]));
    await ensured(t, 'assets/a.mp4');
    await ensured(t, 'assets/b.mp4');
    expect((await t.analyses.view(t.ref, 'assets/b.mp4')).pending?.kind).toBe('transcription');
    await choose(t, { file: 'assets/a.mp4', choice: 'none', remember: true });
    await vi.waitFor(async () => expect((await t.analyses.view(t.ref, 'assets/b.mp4')).pending).toBeNull());
  }, 60_000);

  it('settings whisper with a (fake) Python Whisper set in Settings: no hold, sidecar whisper-small with the speech in the timeline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-tf-'));
    const program = await fakeWhisper(dir, 'whisper', { fixture: fixturePath('openai-whisper.json') });
    const t = await analysisApp({ transcription: { method: 'whisper' } });
    const h = analysisHelpers(t);
    const put = await t.app.inject({ method: 'PUT', url: '/api/transcription', payload: { custom: { program, engine: 'openai-whisper' } } });
    expect(put.statusCode).toBe(200);
    expect((put.json() as TranscriptionStatus).whisper).toMatchObject({ engine: 'openai-whisper', program, model: 'small', source: 'settings' });
    await copyFile(fx.tone, join(t.projectDir, 'assets', 'tone.mp4'));
    const v = await ensured(t, 'assets/tone.mp4');
    expect(v.pending).toBeNull();
    await finishRun(t, h, v.jobId!);
    const s = await sidecarOf(t, 'tone.mp4');
    expect(s!.header).toMatchObject({ transcript: 'whisper-small', language: 'en' });
    expect(s!.body).toMatch(/Hello everyone, welcome\./);
  }, 60_000);

  it('a saved ElevenLabs method whose key was deleted asks again', async () => {
    const t = await analysisApp({ transcription: { method: 'elevenlabs' } });
    await copyFile(fx.tone, join(t.projectDir, 'assets', 'tone.mp4'));
    const v = await ensured(t, 'assets/tone.mp4');
    expect(v.pending).toMatchObject({ kind: 'transcription', elevenlabs: null });
    const r = await choose(t, { file: 'assets/tone.mp4', choice: 'elevenlabs', remember: false });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ code: 'transcription-no-key' });
  }, 60_000);

  it('a silent track: none-no-speech, never asks', async () => {
    const t = await analysisApp({ transcription: { method: 'ask' } });
    const h = analysisHelpers(t);
    await copyFile(fx.silent, join(t.projectDir, 'assets', 'silent.mp4'));
    const v = await ensured(t, 'assets/silent.mp4');
    expect(v.pending).toBeNull();
    await finishRun(t, h, v.jobId!);
    expect((await sidecarOf(t, 'silent.mp4'))!.header.transcript).toBe('none-no-speech');
  }, 60_000);

  it('Whisper chosen with a bundled (fake) whisper-cli: the model is downloaded with the size shown, then the analysis goes on', async () => {
    const bundled = await mkdtemp(join(tmpdir(), 'ms-tf-bundled-'));
    await fakeWhisper(bundled, 'whisper-cli', { fixture: fixturePath('whisper-cpp.json') });
    const models: WhisperModelManifest = { ...WHISPER_MODELS, small: { file: 'ggml-small.bin', sizeBytes: model.length, sha256: createHash('sha256').update(model).digest('hex'), url: `${base}/ggml-small.bin` } };
    const t = await analysisApp({ transcription: { method: 'ask', whisperDir: bundled, models, redirectHosts: [] } });
    const h = analysisHelpers(t);
    await copyFile(fx.tone, join(t.projectDir, 'assets', 'tone.mp4'));
    const v = await ensured(t, 'assets/tone.mp4');
    expect(v.pending).toMatchObject({ whisper: { available: true, installed: false, canInstall: true, sizeBytes: model.length } });
    const wrong = await choose(t, { file: 'assets/tone.mp4', choice: 'whisper', remember: true, sizeBytes: model.length + 1 });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json()).toMatchObject({ code: 'download-size-changed' });
    expect((await choose(t, { file: 'assets/tone.mp4', choice: 'whisper', remember: true, sizeBytes: model.length })).statusCode).toBe(200);
    await finishRun(t, h, v.jobId!);
    expect((await sidecarOf(t, 'tone.mp4'))!.header).toMatchObject({ transcript: 'whisper-small', language: 'it' });
    const st = (await t.app.inject('/api/transcription')).json() as TranscriptionStatus;
    expect(st.settings.method).toBe('whisper');
    expect(st.models.find((m) => m.id === 'small')).toMatchObject({ installed: true });
    expect(st.whisper).toMatchObject({ source: 'bundled', engine: 'whisper.cpp' });
    expect(st.download).toMatchObject({ state: 'done', model: 'small' });
  }, 60_000);

  it('remember + a model download: the other analyses asking go ahead once the model is there, not before', async () => {
    const bundled = await mkdtemp(join(tmpdir(), 'ms-tf-bundled-'));
    await fakeWhisper(bundled, 'whisper-cli', { fixture: fixturePath('whisper-cpp.json') });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const gated = (async (input: string | URL | Request, init?: RequestInit) => { await gate; return fetch(input, init); }) as typeof fetch;
    const models: WhisperModelManifest = { ...WHISPER_MODELS, small: { file: 'ggml-small.bin', sizeBytes: model.length, sha256: createHash('sha256').update(model).digest('hex'), url: `${base}/ggml-small.bin` } };
    const t = await analysisApp({ transcription: { method: 'ask', whisperDir: bundled, models, redirectHosts: [], fetch: gated } });
    const { appendFile } = await import('node:fs/promises');
    await copyFile(fx.tone, join(t.projectDir, 'assets', 'a.mp4'));
    await copyFile(fx.tone, join(t.projectDir, 'assets', 'b.mp4'));
    await appendFile(join(t.projectDir, 'assets', 'b.mp4'), Buffer.from([0]));
    await ensured(t, 'assets/a.mp4');
    await ensured(t, 'assets/b.mp4');
    expect((await choose(t, { file: 'assets/a.mp4', choice: 'whisper', remember: true, sizeBytes: model.length })).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    expect((await t.analyses.view(t.ref, 'assets/b.mp4')).pending?.kind).toBe('transcription');
    release();
    await vi.waitFor(async () => expect((await t.analyses.view(t.ref, 'assets/b.mp4')).pending).toBeNull(), { timeout: 10_000 });
    await vi.waitFor(async () => expect((await t.analyses.view(t.ref, 'assets/a.mp4')).pending).toBeNull());
  }, 60_000);

  it('a failed model download keeps the dialog with the error', async () => {
    const bundled = await mkdtemp(join(tmpdir(), 'ms-tf-bundled-'));
    await fakeWhisper(bundled, 'whisper-cli', {});
    const models: WhisperModelManifest = { ...WHISPER_MODELS, small: { file: 'ggml-small.bin', sizeBytes: model.length, sha256: '0'.repeat(64), url: `${base}/ggml-small.bin` } };
    const t = await analysisApp({ transcription: { method: 'ask', whisperDir: bundled, models, redirectHosts: [] } });
    const h = analysisHelpers(t);
    await copyFile(fx.tone, join(t.projectDir, 'assets', 'tone.mp4'));
    await ensured(t, 'assets/tone.mp4');
    await choose(t, { file: 'assets/tone.mp4', choice: 'whisper', remember: false, sizeBytes: model.length });
    await vi.waitFor(async () => expect((await t.analyses.view(t.ref, 'assets/tone.mp4')).pending).toMatchObject({ kind: 'transcription', error: expect.stringMatching(/sha256/) }));
    expect((await h.analysisJobs())[0]).toMatchObject({ state: 'queued', waitReason: 'transcription-choice' });
  }, 60_000);
});

describe('transcription settings routes', () => {
  it('PUT a custom program that fails its test-run → 400 naming the problem; nothing saved', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-tf-'));
    const program = await fakeWhisper(dir, 'whisper', { stderr: 'Traceback\nModuleNotFoundError: No module named torch\n', exit: 1 });
    const t = await analysisApp({ transcription: { method: 'ask' } });
    const r = await t.app.inject({ method: 'PUT', url: '/api/transcription', payload: { custom: { program, engine: 'openai-whisper' } } });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code: 'whisper-probe-failed', error: expect.stringContaining('No module named torch') });
    expect(((await t.app.inject('/api/transcription')).json() as TranscriptionStatus).settings.custom).toBeNull();
  });
  it('probe infers the engine from the name; a relative program is refused', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-tf-'));
    const program = await fakeWhisper(dir, 'whisper-ctranslate2', { fixture: fixturePath('faster-whisper.json') });
    const t = await analysisApp();
    expect((await t.app.inject({ method: 'POST', url: '/api/transcription/probe', payload: { program } })).json()).toMatchObject({ engine: 'faster-whisper', gpu: null });
    expect((await t.app.inject({ method: 'POST', url: '/api/transcription/probe', payload: { program: 'whisper' } })).statusCode).toBe(400);
  });
  it('model download: a wrong size → 409 before any request; no consent → 400; an unknown model → 404', async () => {
    const net = fakeNet();
    const t = await analysisApp({ transcription: { fetch: net.fetchImpl } });
    const wrong = await t.app.inject({ method: 'POST', url: '/api/transcription/models/small/download', payload: { consent: true, sizeBytes: 1 } });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json()).toMatchObject({ code: 'download-size-changed' });
    expect((await t.app.inject({ method: 'POST', url: '/api/transcription/models/small/download', payload: { sizeBytes: WHISPER_MODELS.small.sizeBytes } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'POST', url: '/api/transcription/models/huge/download', payload: { consent: true, sizeBytes: 1 } })).statusCode).toBe(404);
    expect(net.calls).toEqual([]);
    const st = (await t.app.inject('/api/transcription')).json() as TranscriptionStatus;
    expect(st).toMatchObject({ bundled: false, whisper: null, detected: [], download: { state: 'idle' }, providers: { openai: false, elevenlabs: false }, prices: { openai: 0.006 } });
    expect(st.models.map((m) => [m.id, m.installed])).toEqual([['small', false], ['large-v3-turbo', false]]);
    expect((await t.app.inject({ method: 'DELETE', url: '/api/transcription/models/small' })).statusCode).toBe(204);
  });
  it('a choice for a video that does not ask → 409', async () => {
    const t = await analysisApp();
    await (await import('node:fs/promises')).writeFile(join(t.projectDir, 'assets', 'x.mp4'), 'not really');
    const r = await choose(t, { file: 'assets/x.mp4', choice: 'none', remember: false });
    expect([404, 409]).toContain(r.statusCode);
  });
});
