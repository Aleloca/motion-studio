// @vitest-environment node
/**
 * Phase 12 (Task 5): a localized preview serves the fallback fonts (`assets/fonts/`) and generated voices (`assets/audio/`) the
 * localization row references, from the project folder: only the listed files, verified against the recorded sha256, confined.
 */
import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMPOSITION_PLACEHOLDER } from '@motion-studio/composition-runtime/page';
import { startCompositionServer, type CompositionServer, type CompositionSession } from '../src/compositions/composition-server.ts';

const UI = 'http://127.0.0.1:4318';
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const FONT = Buffer.from('wOF2-noto-jp');
const VOICE = Buffer.from('0123456789abcdefghij');

let work: string; let project: string; let creative: string; let server: CompositionServer; let host: string;

function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Buffer; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.port, path, headers: { host, ...headers }, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'ms-locale-assets-'));
  project = join(work, 'project');
  creative = join(project, 'creatives', 'creative');
  const dist = join(work, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), `<!doctype html><html><head>${COMPOSITION_PLACEHOLDER}</head><body></body></html>`);
  for (const f of ['runtime.js', 'layer.js', 'preview.js', 'clock.js']) writeFileSync(join(dist, f), '/* x */');
  mkdirSync(join(creative, 'outputs', 'v1', 'compositions', 'story', 'assets'), { recursive: true });
  mkdirSync(join(project, 'assets', 'fonts'), { recursive: true });
  mkdirSync(join(project, 'assets', 'audio'), { recursive: true });
  mkdirSync(join(project, 'assets', 'images'), { recursive: true });
  writeFileSync(join(project, 'assets', 'fonts', 'NotoSansJP-400.woff2'), FONT);
  writeFileSync(join(project, 'assets', 'audio', 'voice-ja.mp3'), VOICE);
  writeFileSync(join(project, 'assets', 'audio', 'unlisted.mp3'), VOICE);
  writeFileSync(join(project, 'assets', 'audio', 'changed.mp3'), 'new bytes');
  writeFileSync(join(project, 'assets', 'images', 'logo.png'), 'png');
  writeFileSync(join(work, 'secret.mp3'), 'SECRET');
  symlinkSync(join(work, 'secret.mp3'), join(project, 'assets', 'audio', 'link.mp3'));
  linkSync(join(work, 'secret.mp3'), join(project, 'assets', 'audio', 'hard.mp3'));
  mkdirSync(join(creative, 'outputs', 'v1', 'compositions', 'story', 'assets', 'audio'), { recursive: true });
  writeFileSync(join(creative, 'outputs', 'v1', 'compositions', 'story', 'assets', 'audio', 'shadow.mp3'), 'COMP');
  writeFileSync(join(project, 'assets', 'audio', 'shadow.mp3'), 'PROJECT');
  server = await startCompositionServer({ uiOrigins: [UI], distDir: dist });
  host = `127.0.0.1:${server.port}`;
});
afterAll(async () => { await server?.close(); if (work) rmSync(work, { recursive: true, force: true }); });

const mint = () => server.mintSession({ creativeDir: creative, versionDir: 'outputs/v1', format: 'story', composition: { $schema: 'x' }, mode: 'preview', parentOrigin: UI });
const at = (s: CompositionSession, rel: string) => `/${s.token}/outputs/v1/compositions/story/${rel}`;
const LISTED = {
  'assets/fonts/NotoSansJP-400.woff2': sha(FONT), 'assets/audio/voice-ja.mp3': sha(VOICE),
  'assets/audio/changed.mp3': sha('old bytes'), 'assets/audio/link.mp3': sha('SECRET'), 'assets/audio/hard.mp3': sha('SECRET'),
  'assets/audio/shadow.mp3': sha('PROJECT'),
};

describe('attachLocaleAssets', () => {
  it('serves a listed font and voice from the project, with byte ranges', async () => {
    const s = await mint();
    expect((await get(at(s, 'assets/fonts/NotoSansJP-400.woff2'))).status).toBe(404); // nothing attached yet
    await s.attachLocaleAssets(project, LISTED);
    const font = await get(at(s, 'assets/fonts/NotoSansJP-400.woff2'), { origin: 'null' });
    expect(font.status).toBe(200);
    expect(font.body.equals(FONT)).toBe(true);
    expect(font.headers['access-control-allow-origin']).toBe('null');
    expect(font.headers['content-type']).toBe('font/woff2');
    const part = await get(at(s, 'assets/audio/voice-ja.mp3'), { range: 'bytes=2-5' });
    expect(part.status).toBe(206);
    expect(part.body.toString()).toBe('2345');
    expect(part.headers['content-range']).toBe('bytes 2-5/20');
  });
  it('refuses a file that is not listed, even in the same folder, and any other folder', async () => {
    const s = await mint();
    await s.attachLocaleAssets(project, LISTED);
    expect((await get(at(s, 'assets/audio/unlisted.mp3'))).status).toBe(404);
    expect((await get(at(s, 'assets/images/logo.png'))).status).toBe(404);
  });
  it('refuses a file whose hash changed, a symlink and a hard link', async () => {
    const s = await mint();
    await s.attachLocaleAssets(project, LISTED);
    for (const f of ['changed', 'link', 'hard']) expect((await get(at(s, `assets/audio/${f}.mp3`))).status).toBe(404);
  });
  it('lets the composition folder win over the project file', async () => {
    const s = await mint();
    await s.attachLocaleAssets(project, LISTED);
    expect((await get(at(s, 'assets/audio/shadow.mp3'))).body.toString()).toBe('COMP');
  });
  it('rejects paths outside assets/audio and assets/fonts, traversal and bad hashes', async () => {
    const s = await mint();
    await expect(s.attachLocaleAssets(project, { 'assets/images/logo.png': sha('png') })).rejects.toThrow();
    await expect(s.attachLocaleAssets(project, { 'assets/audio/../x.mp3': sha('x') })).rejects.toThrow();
    await expect(s.attachLocaleAssets(project, { 'assets/audio/voice-ja.mp3': 'nothex' })).rejects.toThrow();
  });
  it('refuses another project folder and a render session', async () => {
    const s = await mint();
    mkdirSync(join(work, 'elsewhere'), { recursive: true });
    await expect(s.attachLocaleAssets(join(work, 'elsewhere'), LISTED)).rejects.toThrow();
    await expect(s.attachLocaleAssets(join(work, 'other'), LISTED)).rejects.toThrow();
    const render = await server.mintSession({ creativeDir: creative, versionDir: 'outputs/v1', format: 'story', composition: { $schema: 'x' }, mode: 'render' });
    await expect(render.attachLocaleAssets(project, LISTED)).rejects.toThrow();
  });
  it('stops serving when the session ends', async () => {
    const s = await mint();
    await s.attachLocaleAssets(project, LISTED);
    s.revoke();
    expect((await get(at(s, 'assets/audio/voice-ja.mp3'))).status).toBe(404);
  });
});
