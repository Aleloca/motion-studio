import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { EMPTY_BRAND_KIT } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AppConfigStore } from '../src/app-config.ts';
import { Git } from '../src/git.ts';
import { buildServer } from '../src/server/app.ts';
import { WorkspaceStore } from '../src/workspace-store.ts';
import { multipart } from './helpers/multipart.ts';

// Report 44: the project's icon, automatic from the brand and the library, or chosen in Project settings.
const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
let app: FastifyInstance;
let base: string;
const P = '/api/projects/acme';
const dir = () => join(base, 'ws', 'acme');
const listed = async () => (await app.inject('/api/projects')).json().find((p: { slug: string }) => p.slug === 'acme');
const detail = async () => (await app.inject(P)).json();
const put = (payload: Record<string, unknown>) => app.inject({ method: 'PUT', url: P, payload });

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ms-pi-'));
  app = await buildServer({ uiToken: null, sandbox: async () => ({ available: false, reason: 'test' }), appConfig: new AppConfigStore(join(base, 'config')), git: new Git(), doctor: async () => [],
    runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }) });
  await app.inject({ method: 'PUT', url: '/api/workspace', payload: { path: join(base, 'ws') } });
  await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
  await app.inject({ method: 'POST', url: `${P}/assets`, ...multipart([{ name: 'mark.png', content: 'p' }, { name: 'pick.png', content: 'p' }, { name: 'Inter.woff2', content: 'f' }]) });
});
afterEach(async () => { vi.restoreAllMocks(); await app.close(); });

describe('project icon', () => {
  it('automatic: the brand\'s icon logo, in the list and the detail; the initials (null) when its file is gone', async () => {
    expect((await listed()).icon).toBeNull();
    await mkdir(join(dir(), 'brand'), { recursive: true });
    await writeFile(join(dir(), 'brand', 'brand-kit.json'), JSON.stringify({ ...EMPTY_BRAND_KIT, logos: [{ id: 'i', file: 'assets/mark.png', variant: 'icon', background: 'any', source: { kind: 'manual', ref: null } }] }));
    expect((await listed()).icon).toBe('assets/mark.png');
    expect((await detail()).icon).toBe('assets/mark.png');
    expect((await app.inject(`${P}/files/assets/mark.png`)).statusCode).toBe(200);
    await rm(join(dir(), 'assets', 'mark.png'));
    expect((await listed()).icon).toBeNull();
  });

  it('chosen: an image of the library, the initials, or back to automatic; stored in project.json', async () => {
    const r = await put({ icon: { asset: 'pick.png' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ project: { icon: { asset: 'pick.png' } }, icon: 'assets/pick.png' });
    expect((await listed()).icon).toBe('assets/pick.png');
    expect(JSON.parse(await readFile(join(dir(), 'project.json'), 'utf8')).icon).toEqual({ asset: 'pick.png' });
    expect((await put({ icon: 'initials' })).json().icon).toBeNull();
    const auto = await put({ icon: null });
    expect(auto.json().project.icon).toBeUndefined();
    expect(JSON.parse(await readFile(join(dir(), 'project.json'), 'utf8'))).not.toHaveProperty('icon');
    // Another change keeps the choice.
    await put({ icon: { asset: 'pick.png' } });
    expect((await put({ description: 'x' })).json().project.icon).toEqual({ asset: 'pick.png' });
  });

  it('a chosen image whose file is gone falls back to the initials', async () => {
    await put({ icon: { asset: 'pick.png' } });
    await rm(join(dir(), 'assets', 'pick.png'));
    expect((await detail()).icon).toBeNull();
  });

  it('a renamed image stays the icon', async () => {
    await put({ icon: { asset: 'pick.png' } });
    const r = await app.inject({ method: 'PATCH', url: `${P}/assets/item/pick.png`, payload: { name: 'chosen.png' } });
    expect(r.json(), r.body).toMatchObject({ file: 'chosen.png' });
    expect((await detail())).toMatchObject({ project: { icon: { asset: 'chosen.png' } }, icon: 'assets/chosen.png' });
  });

  it('review 7: the icon failing to follow a rename never fails the rename', async () => {
    await put({ icon: { asset: 'pick.png' } });
    vi.spyOn(WorkspaceStore.prototype, 'updateProject').mockRejectedValue(new Error('disk full'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await app.inject({ method: 'PATCH', url: `${P}/assets/item/pick.png`, payload: { name: 'chosen.png' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ file: 'chosen.png' });
  });

  it('review 4: an icon logo whose file is gone gives way to the next candidate', async () => {
    await mkdir(join(dir(), 'brand'), { recursive: true });
    await writeFile(join(dir(), 'brand', 'brand-kit.json'), JSON.stringify({ ...EMPTY_BRAND_KIT, logos: [
      { id: 'gone', file: 'assets/gone.png', variant: 'icon', background: 'any', source: { kind: 'manual', ref: null } },
      { id: 'refs', file: 'references/icon.png', variant: 'icon', background: 'any', source: { kind: 'manual', ref: null } },
    ] }));
    await app.inject({ method: 'POST', url: `${P}/assets`, ...multipart([{ name: 'favicon.png', content: 'p' }]) });
    expect((await listed()).icon).toBe('assets/favicon.png');
  });

  it('review 1: a bad icon in project.json leaves the project readable (automatic)', async () => {
    const file = join(dir(), 'project.json');
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), icon: { asset: '../../x.png' } }));
    const item = await listed();
    expect(item.ok).toBe(true);
    expect(item.project.icon).toBeUndefined();
  });

  it('review 5: deleting the chosen image resets the icon to automatic', async () => {
    await put({ icon: { asset: 'pick.png' } });
    expect((await app.inject({ method: 'DELETE', url: `${P}/assets/item/pick.png` })).statusCode).toBe(200);
    expect((await detail()).project.icon).toBeUndefined();
    // Another image chosen is kept when an unrelated one is deleted.
    await put({ icon: { asset: 'mark.png' } });
    await app.inject({ method: 'DELETE', url: `${P}/assets/item/Inter.woff2` });
    expect((await detail()).project.icon).toEqual({ asset: 'mark.png' });
  });

  it('a symlinked image of the library is never the icon', async () => {
    await writeFile(join(base, 'outside.png'), 'p');
    await symlink(join(base, 'outside.png'), join(dir(), 'assets', 'link.png'));
    const json = join(dir(), 'assets', 'assets.json');
    const lib = JSON.parse(await readFile(json, 'utf8'));
    lib.assets.push({ ...lib.assets[0], file: 'link.png' });
    await writeFile(json, JSON.stringify(lib));
    expect((await put({ icon: { asset: 'link.png' } })).statusCode).toBe(400);
    const file = join(dir(), 'project.json');
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), icon: { asset: 'link.png' } }));
    expect((await detail()).icon).toBeNull();
  });

  it('refuses a file that is not an image of the library', async () => {
    for (const icon of [{ asset: 'missing.png' }, { asset: 'Inter.woff2' }, { asset: '../project.json' }, 'logo']) {
      const r = await put({ icon });
      expect(r.statusCode, JSON.stringify(icon)).toBe(400);
    }
    expect(JSON.parse(await readFile(join(dir(), 'project.json'), 'utf8'))).not.toHaveProperty('icon');
  });
});
