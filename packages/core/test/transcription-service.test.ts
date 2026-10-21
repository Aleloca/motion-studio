/**
 * TranscriptionService and programs (review of phase 2, items 6–8): reading the status or planning runs no program; detection
 * runs in the background or on request, test-runs each detected Whisper once per binary (path + mtime) and lists the ones
 * that fail with their problem; saving a Python engine never makes it transcribe. Fake engines only.
 */
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppConfigStore } from '../src/app-config.ts';
import { MemoryVault } from '../src/secrets/vault.ts';
import { TranscriptionService } from '../src/transcription/transcriber.ts';
import { UsageLedger } from '../src/usage/usage-ledger.ts';
import { callsOf, fakeWhisper, fixturePath } from './helpers/fake-whisper.ts';

const temp = () => mkdtemp(join(tmpdir(), 'ms-ts-'));
async function service(o: { pathDir: string; method?: 'ask' | 'whisper' }) {
  const app = await temp();
  const config = new AppConfigStore(join(app, 'config'));
  await config.setTranscription({ method: o.method ?? 'ask' });
  const svc = new TranscriptionService({
    config, vault: new MemoryVault({}), ledger: new UsageLedger(), appDataDir: app, fetch: (async () => { throw new Error('no network'); }) as typeof fetch,
    pathEnv: o.pathDir, extraDirs: [], env: { HOME: await temp() },
  });
  return { svc, app, config };
}
const model = async (app: string) => { await mkdir(join(app, 'whisper'), { recursive: true }); await writeFile(join(app, 'whisper', 'ggml-small.bin'), 'x'); };

describe('no program runs unless detection is asked for', () => {
  it('status and plan run nothing; detect() test-runs once per binary and caches by path and mtime', async () => {
    const d = await temp();
    const program = await fakeWhisper(d, 'whisper-cli', { fixture: fixturePath('whisper-cpp.json') });
    const { svc, app } = await service({ pathDir: d, method: 'whisper' });
    await model(app);
    const before = await svc.status();
    expect(before.detected).toEqual([]);
    expect(before.detection.state).toBe('idle');
    expect(await svc.plan(10)).toHaveProperty('ask');
    expect(await callsOf(program)).toEqual([]);
    const found = await svc.detect();
    expect(found).toMatchObject([{ engine: 'whisper.cpp', program, source: 'detected' }]);
    expect(found[0]).not.toHaveProperty('problem');
    const runs = (await callsOf(program)).filter((a) => a.includes('-f')).length;
    expect(runs).toBe(1);
    expect(await svc.plan(10)).toEqual({ run: 'whisper' });
    await svc.detect();
    expect((await callsOf(program)).filter((a) => a.includes('-f'))).toHaveLength(1);
    await utimes(program, new Date(), new Date(Date.now() + 5000));
    await svc.detect();
    expect((await callsOf(program)).filter((a) => a.includes('-f'))).toHaveLength(2);
    expect((await svc.status()).detection).toMatchObject({ state: 'done', at: expect.any(String) });
  });

  it('a detected Whisper that fails its test-run is listed with its problem and never used', async () => {
    const d = await temp();
    await fakeWhisper(d, 'whisper-cli', { stderr: 'error: failed to load model\n', exit: 1 });
    const { svc, app } = await service({ pathDir: d, method: 'whisper' });
    await model(app);
    expect(await svc.detect()).toMatchObject([{ engine: 'whisper.cpp', problem: 'error: failed to load model' }]);
    expect(await svc.whisper()).toBeNull();
    expect(await svc.plan(10)).toHaveProperty('ask');
  });

  it('a detected whisper.cpp with no model: needs one (the dialog can install it), then works after the download\'s re-detection', async () => {
    const d = await temp();
    await fakeWhisper(d, 'whisper-cli', { fixture: fixturePath('whisper-cpp.json') });
    const { svc, app } = await service({ pathDir: d });
    expect(await svc.detect()).toMatchObject([{ needsModel: true }]);
    expect((await svc.offer(10)).whisper).toMatchObject({ available: true, installed: false, canInstall: true, engine: 'whisper.cpp', downloadsOwnModel: false });
    await model(app);
    await svc.detect();
    expect(await svc.whisper()).toMatchObject({ engine: 'whisper.cpp', source: 'detected' });
  });

  it('a detected Python engine without its model in its cache is never used on its own: the dialog asks, and says it downloads its model', async () => {
    const d = await temp();
    await fakeWhisper(d, 'whisper', { fixture: fixturePath('openai-whisper.json') });
    const { svc } = await service({ pathDir: d, method: 'whisper' });
    expect(await svc.detect()).toMatchObject([{ engine: 'openai-whisper', downloadsOwnModel: true }]);
    const plan = await svc.plan(10);
    expect((plan as { ask: { whisper: unknown } }).ask.whisper).toMatchObject({ available: true, installed: false, engine: 'openai-whisper', downloadsOwnModel: true });
    expect((await callsOf(join(d, 'whisper'))).every((a) => a.includes('--help') || a.includes('--version'))).toBe(true);
  });

  it('saving a Python engine checks it without transcribing', async () => {
    const d = await temp();
    const program = await fakeWhisper(d, 'whisper-ctranslate2', { fixture: fixturePath('faster-whisper.json') });
    const { svc } = await service({ pathDir: await temp() });
    await svc.update({ custom: { program, engine: 'faster-whisper' } });
    expect((await callsOf(program)).every((a) => a.includes('--help') || a.includes('--version'))).toBe(true);
    expect((await svc.status()).whisper).toMatchObject({ program, source: 'settings' });
  });
});
