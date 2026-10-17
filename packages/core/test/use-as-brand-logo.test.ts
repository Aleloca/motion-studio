import { mkdir, mkdtemp, readdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AppConfigStore } from '../src/app-config.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { Git } from '../src/git.ts';
import { buildServer } from '../src/server/app.ts';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const GOOD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#0a7"/></svg>';
const BAD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><script>alert(1)</script></svg>';
const TOKEN = 'ab'.repeat(32);
const H = { 'x-motion-studio-ui': TOKEN };
let app: FastifyInstance;
let base: string;
let slug: string;
let projectDir: string;

const FORMAT = 'identity-logo';
const url = (n = 1, f = FORMAT) => `/api/projects/acme/creatives/${slug}/versions/${n}/formats/${encodeURIComponent(f)}/use-as-brand-logo`;
const post = (payload: unknown, n = 1, f = FORMAT) => app.inject({ method: 'POST', url: url(n, f), headers: H, payload: payload as object });

/** A version 1 whose logo format has a set; `svg` is written into the set folder (or not, with null). */
const seed = async (o: { svg: string | null; set?: boolean; format?: string; dark?: string }) => {
  const format = o.format ?? FORMAT;
  const store = new CreativeStore(projectDir);
  const dir = store.dir(slug);
  await mkdir(join(dir, 'outputs', 'v1', format), { recursive: true });
  await writeFile(join(dir, 'outputs', 'v1', `${format}.png`), 'png');
  if (o.svg !== null) await writeFile(join(dir, 'outputs', 'v1', format, 'logo.svg'), o.svg);
  if (o.dark !== undefined) await writeFile(join(dir, 'outputs', 'v1', format, 'logo-dark.svg'), o.dark);
  const darkFiles = o.dark !== undefined ? [{ path: 'logo-dark.svg', role: 'vector-dark' }, { path: 'logo-dark.png', width: 1024, height: 1024, alpha: true, role: 'raster-dark' }] : [];
  await store.appendVersion(slug, {
    n: 1, commit: null, sessionId: null, status: 'complete', createdAt: new Date().toISOString(), request: '', problems: [], tools: [], renderCommand: null, basedOn: null,
    outputs: [{ format, file: `${format}.png`, width: 1024, height: 1024, durationSec: null, verified: true, preview: null,
      ...(o.set === false ? {} : { identitySet: { dir: format, files: [{ path: 'logo.svg', role: 'vector' }, { path: 'logo.png', width: 1024, height: 1024, alpha: true, role: 'raster' }, ...darkFiles], warnings: [] } }) }],
  });
};

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ms-ubl-'));
  app = await buildServer({ agentContract: 'media', uiToken: TOKEN, sandbox: async () => ({ available: false, reason: 'test' }),
    appConfig: new AppConfigStore(join(base, 'config')), git: new Git(),
    runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }), doctor: async () => [], openPath: async () => {} });
  await app.inject({ method: 'PUT', url: '/api/workspace', headers: H, payload: { path: join(base, 'ws') } });
  await app.inject({ method: 'POST', url: '/api/projects', headers: H, payload: { name: 'Acme' } });
  const brief = { goal: 'Logo', message: '', formats: [FORMAT], durationSec: null, assets: [], notes: '' };
  slug = (await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', headers: H, payload: { title: 'Logo', brief, generate: false } })).json().slug;
  projectDir = join(base, 'ws', 'acme');
});
afterEach(async () => { await app.close(); });

const brandFiles = async () => (await readdir(join(projectDir, 'assets', 'brand')).catch(() => [])).filter((f) => !f.startsWith('.'));
const kit = async () => (await app.inject({ url: '/api/projects/acme/brand', headers: H })).json().kit;

describe('use as brand logo (Phase 14, decision 733)', () => {
  it('copies the checked SVG into assets/brand, registers it and adds the logo with its source', async () => {
    await seed({ svg: GOOD });
    const r = await post({ variant: 'icon' });
    expect(r.statusCode).toBe(200);
    const { file } = r.json() as { file: string };
    expect(file).toMatch(/^assets\/brand\/.+\.svg$/);
    expect(await readFile(join(projectDir, file), 'utf8')).toBe(GOOD);
    const logos = (await kit()).logos;
    expect(logos).toHaveLength(1);
    expect(logos[0]).toMatchObject({ file, variant: 'icon', background: 'any', source: { kind: 'manual', ref: `creative:${slug}/v1` } });
    const assets = (await app.inject({ url: '/api/projects/acme/assets', headers: H })).json().assets as Array<{ file: string }>;
    expect(assets.some((a) => `assets/${a.file}` === file)).toBe(true);
  });

  it('a logo with its negative adds both: the main one for light backgrounds, the negative for dark ones, same variant (note 9)', async () => {
    const DARK = GOOD.replace('#0a7', '#fff');
    await seed({ svg: GOOD, dark: DARK });
    const r = await post({ variant: 'primary' });
    expect(r.statusCode, r.body).toBe(200);
    const { file, dark } = r.json() as { file: string; dark?: string };
    expect(dark).toMatch(/^assets\/brand\/.+-dark\.svg$/);
    expect(await readFile(join(projectDir, file), 'utf8')).toBe(GOOD);
    expect(await readFile(join(projectDir, dark!), 'utf8')).toBe(DARK);
    const logos = (await kit()).logos;
    expect(logos.map((l: { file: string; variant: string; background: string }) => [l.file, l.variant, l.background])).toEqual([[file, 'primary', 'light'], [dark, 'primary', 'dark']]);
    const assets = (await app.inject({ url: '/api/projects/acme/assets', headers: H })).json().assets as Array<{ file: string }>;
    expect(assets.some((a) => `assets/${a.file}` === dark)).toBe(true);
    // A later primary pair steps both down (decision 784), so there is one primary logo per background.
    const again = (await post({ variant: 'primary' })).json() as { file: string; dark: string };
    const rows = (await kit()).logos.map((l: { file: string; variant: string; background: string }) => [l.file, l.variant, l.background]);
    expect(rows).toEqual([[file, 'secondary', 'light'], [dark, 'secondary', 'dark'], [again.file, 'primary', 'light'], [again.dark, 'primary', 'dark']]);
  });

  it('a negative that no longer passes the check refuses the whole use, leaving nothing behind', async () => {
    await seed({ svg: GOOD, dark: BAD });
    const r = await post({ variant: 'primary' });
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe('logo-refused');
    expect(await brandFiles()).toEqual([]);
    expect((await kit()).logos).toEqual([]);
  });

  it('a second use never overwrites: a new file and a new logo id', async () => {
    await seed({ svg: GOOD });
    const a = (await post({ variant: 'primary' })).json().file as string;
    const b = (await post({ variant: 'primary' })).json().file as string;
    expect(b).not.toBe(a);
    expect(await brandFiles()).toHaveLength(2);
    const ids = (await kit()).logos.map((l: { id: string }) => l.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('decision 784: the new logo takes the variant and the one holding it steps down (primary → secondary, icon → other)', async () => {
    await seed({ svg: GOOD });
    const first = (await post({ variant: 'primary' })).json().file as string;
    const icon = (await post({ variant: 'icon' })).json().file as string;
    const second = (await post({ variant: 'primary' })).json().file as string;
    const third = (await post({ variant: 'icon' })).json().file as string;
    const variants = Object.fromEntries((await kit()).logos.map((l: { file: string; variant: string }) => [l.file, l.variant]));
    expect(variants).toEqual({ [first]: 'secondary', [icon]: 'other', [second]: 'primary', [third]: 'icon' });
  });
  it('decision 784: a failed registration puts the demoted logo back', async () => {
    await seed({ svg: GOOD });
    const first = (await post({ variant: 'primary' })).json().file as string;
    await writeFile(join(projectDir, 'assets', 'assets.json'), '{ not json');
    expect((await post({ variant: 'primary' })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await kit()).logos.map((l: { file: string; variant: string }) => [l.file, l.variant])).toEqual([[first, 'primary']]);
  });

  it('refuses an SVG that no longer passes the check, leaving nothing behind', async () => {
    await seed({ svg: BAD });
    const r = await post({ variant: 'primary' });
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe('logo-refused');
    expect(await brandFiles()).toEqual([]);
    expect((await kit()).logos).toEqual([]);
  });

  it('refuses a version without a checked set, a set without an SVG, and a missing file', async () => {
    await seed({ svg: null, set: false });
    expect(await post({ variant: 'primary' })).toMatchObject({ statusCode: 409 });
    expect((await post({ variant: 'primary' })).json().code).toBe('logo-not-checked');
    // The set says there is a logo.svg but the file is gone.
    const store = new CreativeStore(projectDir);
    await store.updateVersion(slug, 1, (v) => ({ ...v, outputs: v.outputs.map((o) => ({ ...o, identitySet: { dir: FORMAT, files: [{ path: 'logo.svg', role: 'vector' }], warnings: [] } })) }));
    const missing = await post({ variant: 'primary' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('logo-missing');
    // A set made only of rasters (an app icon) has no SVG to use.
    await store.updateVersion(slug, 1, (v) => ({ ...v, outputs: v.outputs.map((o) => ({ ...o, identitySet: { dir: FORMAT, files: [{ path: 'logo.png', role: 'raster' }], warnings: [] } })) }));
    expect((await post({ variant: 'primary' })).json().code).toBe('logo-no-svg');
    expect(await brandFiles()).toEqual([]);
  });

  it('refuses a logo file that is a link out of the creative', async () => {
    await seed({ svg: null });
    const outside = join(base, 'outside.svg');
    await writeFile(outside, GOOD);
    await symlink(outside, join(new CreativeStore(projectDir).dir(slug), 'outputs', 'v1', FORMAT, 'logo.svg'));
    const r = await post({ variant: 'primary' });
    expect(r.statusCode).toBe(422);
    expect(await brandFiles()).toEqual([]);
  });

  it('validates the variant, the version and the format', async () => {
    await seed({ svg: GOOD });
    expect((await post({ variant: 'mono' })).json().code).toBe('bad-variant');
    expect((await post({})).statusCode).toBe(400);
    expect((await post({ variant: 'primary' }, 9)).statusCode).toBe(404);
    expect((await post({ variant: 'primary' }, 1, '../x')).statusCode).toBe(400);
    expect((await post({ variant: 'primary' }, 1, 'identity-logo@2')).statusCode).toBe(409);
  });

  it('refuses without the UI token', async () => {
    await seed({ svg: GOOD });
    const r = await app.inject({ method: 'POST', url: url(), payload: { variant: 'primary' } });
    expect(r.statusCode).toBe(401);
    expect(await brandFiles()).toEqual([]);
  });

  it('refuses a symlinked version folder and a ".." in the set folder, writing nothing', async () => {
    await seed({ svg: GOOD });
    const store = new CreativeStore(projectDir);
    const outputs = join(store.dir(slug), 'outputs');
    // vN replaced by a link to a folder that holds the same files.
    await rename(join(outputs, 'v1'), join(base, 'real-v1'));
    await symlink(join(base, 'real-v1'), join(outputs, 'v1'));
    const linked = await post({ variant: 'primary' });
    expect(linked.statusCode).toBe(422);
    expect(linked.json().code).toBe('logo-refused');
    // A set folder that climbs out of the version.
    await rename(join(base, 'real-v1', FORMAT), join(base, 'real-v1', 'x'));
    await store.updateVersion(slug, 1, (v) => ({ ...v, outputs: v.outputs.map((o) => ({ ...o, identitySet: { dir: '../v1/x', files: [{ path: 'logo.svg', role: 'vector' }], warnings: [] } })) }));
    expect((await post({ variant: 'primary' })).json().code).toBe('logo-refused');
    await store.updateVersion(slug, 1, (v) => ({ ...v, outputs: v.outputs.map((o) => ({ ...o, identitySet: { dir: FORMAT, files: [{ path: '../logo.svg', role: 'vector' }], warnings: [] } })) }));
    expect((await post({ variant: 'primary' })).json().code).toBe('logo-refused');
    expect(await brandFiles()).toEqual([]);
    expect((await kit()).logos).toEqual([]);
  });

  it('refuses a format that is not an identity format', async () => {
    await seed({ svg: GOOD, format: 'instagram-post-1x1' });
    const r = await post({ variant: 'primary' }, 1, 'instagram-post-1x1');
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('not-identity');
  });

  it('rolls back when the kit refuses (an unreadable kit): no copy is left', async () => {
    await seed({ svg: GOOD });
    await mkdir(join(projectDir, 'brand'), { recursive: true });
    await writeFile(join(projectDir, 'brand', 'brand-kit.json'), '{ not json');
    const r = await post({ variant: 'primary' });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(await brandFiles()).toEqual([]);
  });

  it('rolls back when the library registration fails: no copy and no kit entry', async () => {
    await seed({ svg: GOOD });
    await mkdir(join(projectDir, 'assets'), { recursive: true });
    await writeFile(join(projectDir, 'assets', 'assets.json'), '{ not json');
    const r = await post({ variant: 'primary' });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(await brandFiles()).toEqual([]);
    expect((await kit()).logos).toEqual([]);
  });
});
