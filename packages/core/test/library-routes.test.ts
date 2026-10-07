import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AppConfigStore } from '../src/app-config.ts';
import { Git } from '../src/git.ts';
import { buildServer } from '../src/server/app.ts';
import { multipart } from './helpers/multipart.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
let app: FastifyInstance;
let base: string;
const P = '/api/projects/acme';

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ms-lr-'));
  app = await buildServer({ appConfig: new AppConfigStore(join(base, 'config')), git: new Git(), doctor: async () => [],
    runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }) });
  await app.inject({ method: 'PUT', url: '/api/workspace', payload: { path: join(base, 'ws') } });
  await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
});
afterEach(() => app.close());

describe('assets API', () => {
  it('uploads, lists, edits, serves and deletes assets', async () => {
    const up = await app.inject({ method: 'POST', url: `${P}/assets`, ...multipart([{ name: 'Logo Acme.svg', content: '<svg/>' }, { name: '../x.png', content: 'p' }]) });
    expect(up.statusCode).toBe(201);
    expect(up.json().assets.map((a: { file: string }) => a.file)).toEqual(['Logo-Acme.svg', 'x.png']);
    const edited = await app.inject({ method: 'PATCH', url: `${P}/assets/item/Logo-Acme.svg`, payload: { description: 'Logo', tags: ['logo'] } });
    expect(edited.json()).toMatchObject({ description: 'Logo', tags: ['logo'] });
    const file = await app.inject(`${P}/files/assets/Logo-Acme.svg`);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-security-policy']).toBe('sandbox');
    expect((await app.inject({ method: 'DELETE', url: `${P}/assets/item/x.png` })).json()).toEqual({ ok: true });
    expect((await app.inject(`${P}/assets`)).json().assets).toHaveLength(1);
  });
  it('lists unregistered files and registers them', async () => {
    await writeFile(join(base, 'ws', 'acme', 'assets', 'manual.png'), 'x');
    expect((await app.inject(`${P}/assets`)).json().unregistered).toEqual(['manual.png']);
    const r = await app.inject({ method: 'POST', url: `${P}/assets/register`, payload: { files: ['manual.png'] } });
    expect(r.json().assets[0]).toMatchObject({ file: 'manual.png', origin: 'upload' });
  });
  it('refuses uploads while assets.json is corrupt, without touching it', async () => {
    const json = join(base, 'ws', 'acme', 'assets', 'assets.json');
    await writeFile(json, '{bad');
    const list = (await app.inject(`${P}/assets`)).json();
    expect(list.error).toContain('assets.json');
    const up = await app.inject({ method: 'POST', url: `${P}/assets`, ...multipart([{ name: 'a.png', content: 'x' }]) });
    expect(up.statusCode).toBe(422);
    expect(await readFile(json, 'utf8')).toBe('{bad');
  });
  it('never serves project files outside assets/ and references/', async () => {
    await symlink(join(base, 'ws', 'acme', 'project.json'), join(base, 'ws', 'acme', 'assets', 'leak.json'));
    for (const p of ['project.json', 'assets/../project.json', 'assets/leak.json', 'brand/brand-kit.json']) {
      expect((await app.inject(`${P}/files/${p}`)).statusCode, p).toBe(404);
    }
  });
});

describe('references API', () => {
  it('uploads and updates references', async () => {
    const up = await app.inject({ method: 'POST', url: `${P}/references`, ...multipart([{ name: 'mood.jpg', content: 'x' }]) });
    expect(up.json().references[0]).toMatchObject({ file: 'mood.jpg', useForBrand: true });
    const r = await app.inject({ method: 'PATCH', url: `${P}/references/item/mood.jpg`, payload: { note: 'Luce calda', useForBrand: false } });
    expect(r.json()).toMatchObject({ note: 'Luce calda', useForBrand: false });
  });
});

describe('project settings API', () => {
  it('updates linked codebases and reports their existence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-app è '));
    const r = await app.inject({ method: 'PUT', url: P, payload: { linkedCodebases: [{ path: `${dir}/`, note: 'iOS' }, { path: join(base, 'missing') }] } });
    expect(r.json().project.linkedCodebases).toEqual([{ path: dir, note: 'iOS' }, { path: join(base, 'missing') }]);
    expect((await app.inject(`${P}/codebases`)).json()).toEqual([{ path: dir, note: 'iOS', exists: true }, { path: join(base, 'missing'), exists: false }]);
    expect((await app.inject({ method: 'PUT', url: P, payload: { linkedCodebases: [{ path: 'rel' }] } })).statusCode).toBe(400);
  });
});

describe('loopback guard on new routes', () => {
  it('rejects non-local Host on multipart uploads and file serving', async () => {
    const up = await app.inject({ method: 'POST', url: `${P}/assets`, ...multipart([{ name: 'a.png', content: 'x' }]), headers: { ...multipart([]).headers, host: 'evil.example' } });
    expect(up.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `${P}/files/assets/a.png`, headers: { host: 'evil.example' } })).statusCode).toBe(403);
  });
});
