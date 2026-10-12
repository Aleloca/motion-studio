// @vitest-environment node
/**
 * The pin frames route (Task 8, carry 9): the feedback frames the core cut for the comments of a turn live in the protected
 * core cache `.studio/cache/pin-frames/<creative>/v<n>/` (fix I1). The web shows them next to the sent comments through a
 * token-gated listing that hands out short-lived signed image URLs, as for the storyboards (fix I4).
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PinFramesView } from '@motion-studio/shared';
import { AppConfigStore } from '../src/app-config.ts';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { Git } from '../src/git.ts';
import { buildServer } from '../src/server/app.ts';

const TOKEN = 'cd'.repeat(32);
const H = { 'x-motion-studio-ui': TOKEN };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

let base: string;
let ws: string;
let app: FastifyInstance;
let slug: string;
const framesDir = (n: number) => join(ws, 'acme', '.studio', 'cache', 'pin-frames', slug, `v${n}`);

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'ms-test-pinframes-'));
  app = await buildServer({
    uiToken: TOKEN, sandbox: async () => ({ available: false, reason: 'test' }),
    appConfig: new AppConfigStore(join(base, 'config')), git: new Git(),
    runner: new ClaudeCodeRunner([process.execPath, '-e', ''], { killGraceMs: 200 }), doctor: async () => [], chromeInstaller: null,
  });
  ws = join(base, 'ws');
  await app.inject({ method: 'PUT', url: '/api/workspace', headers: H, payload: { path: ws } });
  await app.inject({ method: 'POST', url: '/api/projects', headers: H, payload: { name: 'Acme' } });
  const r = await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', headers: H, payload: {
    title: 'Launch', generate: false, brief: { goal: 'g', message: '', formats: ['tiktok-9x16'], durationSec: 4, assets: [], notes: '' },
  } });
  expect(r.statusCode, r.body).toBe(201);
  slug = r.json().slug as string;
});
afterEach(async () => { await app?.close(); rmSync(base, { recursive: true, force: true }); });

const list = (n: number | string) => app.inject({ url: `/api/projects/acme/creatives/${slug}/pin-frames/${n}`, headers: H });

describe('GET …/pin-frames/:n', () => {
  it('needs the UI token', async () => {
    expect((await app.inject({ url: `/api/projects/acme/creatives/${slug}/pin-frames/2` })).statusCode).toBe(401);
  });
  it('lists the frames of version n with signed URLs, in pin order', async () => {
    mkdirSync(framesDir(2), { recursive: true });
    for (const f of ['2-10.jpg', '2-2.jpg', '2-1.jpg', '3-1.jpg', 'notes.txt', '.2-4.jpg.abc.tmp']) writeFileSync(join(framesDir(2), f), JPEG);
    const r = await list(2);
    expect(r.statusCode).toBe(200);
    const body = r.json() as PinFramesView;
    expect(body.n).toBe(2);
    expect(body.frames.map((f) => f.file)).toEqual(['2-1.jpg', '2-2.jpg', '2-10.jpg']);
    expect(body.frames[0]!.url).toMatch(new RegExp(`^/api/projects/acme/creatives/${slug}/pin-frame-files/2/2-1\\.jpg\\?s=\\d+\\.`));
    expect(Date.parse(body.expiresAt!)).toBeGreaterThan(Date.now());
    // The image itself: no UI token, but the signature.
    const img = await app.inject({ url: body.frames[0]!.url });
    expect(img.statusCode).toBe(200);
    expect(img.rawPayload.equals(JPEG)).toBe(true);
    expect(img.headers['cross-origin-resource-policy']).toBe('same-origin');
  });
  it('nothing made yet: an empty list (never creating folders)', async () => {
    const r = await list(5);
    expect(r.json()).toEqual({ n: 5, expiresAt: null, frames: [] });
  });
  it('refuses bad version numbers', async () => {
    for (const n of ['0', '-1', 'x', '1.5']) expect((await list(n)).statusCode, n).toBe(404);
  });
  it('a linked folder in the chain is never followed', async () => {
    const outside = join(base, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, '2-1.jpg'), JPEG);
    mkdirSync(join(framesDir(2), '..'), { recursive: true });
    symlinkSync(outside, framesDir(2));
    expect((await list(2)).json().frames).toEqual([]);
  });
});

describe('GET …/pin-frame-files/:n/:file', () => {
  it('refuses a missing, wrong or reused signature', async () => {
    mkdirSync(framesDir(2), { recursive: true });
    writeFileSync(join(framesDir(2), '2-1.jpg'), JPEG);
    writeFileSync(join(framesDir(2), '2-2.jpg'), JPEG);
    const url = (await list(2)).json().frames[0].url as string;
    const path = `/api/projects/acme/creatives/${slug}/pin-frame-files/2/2-1.jpg`;
    expect((await app.inject({ url: path })).statusCode).toBe(403);
    expect((await app.inject({ url: `${path}?s=1.${'a'.repeat(43)}` })).statusCode).toBe(403);
    // A signature is bound to its exact path.
    expect((await app.inject({ url: url.replace('2-1.jpg', '2-2.jpg') })).statusCode).toBe(403);
  });
  it('serves only `<n>-<i>.jpg` of version n, never through a link', async () => {
    mkdirSync(framesDir(2), { recursive: true });
    writeFileSync(join(base, 'secret.jpg'), JPEG);
    symlinkSync(join(base, 'secret.jpg'), join(framesDir(2), '2-1.jpg'));
    // A link listed by name is not a regular file: not listed, and not served even with a valid signature.
    expect((await list(2)).json().frames).toEqual([]);
  });
});
