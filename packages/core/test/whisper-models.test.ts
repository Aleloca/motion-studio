/**
 * Whisper models (spec §7), against a FAKE local server only: every fetch goes through a guard that fails the test for any
 * non-loopback URL. A 64 KB fake model and a test manifest; the real Hugging Face is never contacted.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installedModels, installWhisperModel, removeWhisperModel, WHISPER_MODELS, WHISPER_REDIRECT_HOSTS, type WhisperModelManifest } from '../src/transcription/models.ts';

const model = randomBytes(64 * 1024);
const sha = createHash('sha256').update(model).digest('hex');
let server: Server;
let port = 0;
const guardedFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new Error(`test tried to reach ${url.origin}`);
  return fetch(input, init);
};

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/model.bin') { res.writeHead(200, { 'content-length': String(model.length) }); res.end(model); return; }
    if (req.url === '/to-localhost') { res.writeHead(302, { location: `http://localhost:${port}/model.bin` }); res.end(); return; }
    if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const manifest = (path: string, o: { sha256?: string; sizeBytes?: number } = {}): WhisperModelManifest => ({
  ...WHISPER_MODELS,
  small: { file: 'ggml-small.bin', sizeBytes: o.sizeBytes ?? model.length, sha256: o.sha256 ?? sha, url: `http://127.0.0.1:${port}${path}` },
});
const app = () => mkdtemp(join(tmpdir(), 'ms-wm-'));

describe('the manifest', () => {
  it('pins the spec sizes and hashes to Hugging Face commits, never main', () => {
    expect(WHISPER_MODELS.small).toMatchObject({ file: 'ggml-small.bin', sizeBytes: 487_601_967, sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b' });
    expect(WHISPER_MODELS['large-v3-turbo']).toMatchObject({ sizeBytes: 1_624_555_275, sha256: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69' });
    expect(WHISPER_MODELS.silero).toMatchObject({ file: 'ggml-silero-v6.2.0.bin', sizeBytes: 885_098, sha256: '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987' });
    for (const m of Object.values(WHISPER_MODELS)) expect(m.url).toMatch(/^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\/ggml-[a-z0-9.-]+\.bin$/);
    expect(WHISPER_REDIRECT_HOSTS).toContain('huggingface.co');
  });
});

describe('installWhisperModel (fake server)', () => {
  it('installs with progress into <appData>/whisper/, folder 0700 and file 0600, no staging file left', async () => {
    const dir = await app();
    const seen: number[] = [];
    const file = await installWhisperModel({ id: 'small', appDataDir: dir, consent: true, sizeBytes: model.length, fetchImpl: guardedFetch, manifest: manifest('/model.bin'), onProgress: (p) => seen.push(p.bytes) });
    expect(file).toBe(join(dir, 'whisper', 'ggml-small.bin'));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'whisper'))).mode & 0o777).toBe(0o700);
    expect(seen.at(-1)).toBe(model.length);
    expect(await readdir(join(dir, 'whisper'))).toEqual(['ggml-small.bin']);
    expect((await installedModels(dir, manifest('/model.bin'))).find((m) => m.id === 'small')).toEqual({ id: 'small', sizeBytes: model.length, installed: true, bytesOnDisk: model.length });
    await removeWhisperModel('small', dir, manifest('/model.bin'));
    expect(existsSync(file)).toBe(false);
  });
  it('a wrong hash: nothing left, hashMismatch', async () => {
    const dir = await app();
    await expect(installWhisperModel({ id: 'small', appDataDir: dir, consent: true, sizeBytes: model.length, fetchImpl: guardedFetch, manifest: manifest('/model.bin', { sha256: '0'.repeat(64) }) }))
      .rejects.toMatchObject({ code: 'hashMismatch' });
    expect(await readdir(join(dir, 'whisper'))).toEqual([]);
  });
  it('a redirect to a host not allowed is refused; to an allowed alias it is followed; a loop stops', async () => {
    const dir = await app();
    await expect(installWhisperModel({ id: 'small', appDataDir: dir, consent: true, sizeBytes: model.length, fetchImpl: guardedFetch, manifest: manifest('/to-localhost'), allowRedirectHosts: ['127.0.0.1'] }))
      .rejects.toMatchObject({ code: 'badUrl' });
    expect(await installWhisperModel({ id: 'small', appDataDir: dir, consent: true, sizeBytes: model.length, fetchImpl: guardedFetch, manifest: manifest('/to-localhost'), allowRedirectHosts: ['localhost'] }))
      .toBe(join(dir, 'whisper', 'ggml-small.bin'));
    const other = await app();
    await expect(installWhisperModel({ id: 'small', appDataDir: other, consent: true, sizeBytes: model.length, fetchImpl: guardedFetch, manifest: manifest('/loop'), allowRedirectHosts: ['127.0.0.1'] }))
      .rejects.toThrow(/too many redirects/);
  });
  it('no consent, or a size other than the manifest\'s: refused before any request', async () => {
    const dir = await app();
    const never: typeof fetch = async () => { throw new Error('no request expected'); };
    await expect(installWhisperModel({ id: 'small', appDataDir: dir, consent: false as unknown as true, sizeBytes: model.length, fetchImpl: never, manifest: manifest('/model.bin') }))
      .rejects.toMatchObject({ code: 'consentRequired' });
    await expect(installWhisperModel({ id: 'small', appDataDir: dir, consent: true, sizeBytes: model.length + 1, fetchImpl: never, manifest: manifest('/model.bin') }))
      .rejects.toMatchObject({ code: 'downloadSizeChanged' });
  });
  it('the server announcing another size: refused, nothing left', async () => {
    const dir = await app();
    await expect(installWhisperModel({ id: 'small', appDataDir: dir, consent: true, sizeBytes: model.length + 5, fetchImpl: guardedFetch, manifest: manifest('/model.bin', { sizeBytes: model.length + 5 }) }))
      .rejects.toMatchObject({ code: 'sizeMismatch' });
    expect(await readdir(join(dir, 'whisper'))).toEqual([]);
  });
});
