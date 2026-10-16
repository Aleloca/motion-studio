// @vitest-environment node
/**
 * Phase 15, Task 6: the group export. Each format comes from its group ★ (any variant) or from the default rule on variant A,
 * with the file names the host would give; "export this variant" is today's export; an ungrouped creative is untouched; a
 * missing member or output is reported, never thrown; a group's store pack takes the group selection per format.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_FORMATS, type Brief, type StorePack, type VersionEntry } from '@motion-studio/shared';
import { CreativeSideStateStore } from '../src/creatives/creative-side-state.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { CreativeTurnService, type CreativeRef } from '../src/creatives/creative-turns.ts';
import { exportGroup, planGroupExport, resolveGroupLocalized } from '../src/creatives/variant-export.ts';
import { exportPicks, exportVersion } from '../src/creatives/export.ts';
import { VariantGroupService } from '../src/creatives/variant-group.ts';
import { exportStorePack } from '../src/store-pack/pack-export.ts';
import { Git } from '../src/git.ts';
import { JobQueue } from '../src/jobs/job-queue.ts';
import { NoMediaTools } from '../src/media/media-tools.ts';
import { MemoryVault } from '../src/secrets/vault.ts';
import { WorkspaceStore } from '../src/workspace-store.ts';
import { ControlledRunner } from './helpers/controlled-runner.ts';
import { testLauncher } from './helpers/launcher.ts';
import { makePng } from './helpers/store-images.ts';

const POST = 'instagram-post-1x1';
const BANNER = 'web-banner-300x250';
const brief: Brief = { goal: 'Lancio app', message: '', formats: [POST, BANNER], durationSec: 10, assets: [], notes: '' };

let base: string;
let projectDir: string;
let dest: string;
let store: CreativeStore;
let queue: JobQueue;
let svc: VariantGroupService;
let host: CreativeRef;
const sis = (l: string) => `${host.creativeSlug}~${l}`;
const refOf = (slug: string): CreativeRef => ({ ...host, creativeSlug: slug });

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ms-vx-'));
  const ws = await WorkspaceStore.open(join(base, 'ws'), new Git());
  const { slug } = await ws.createProject({ name: 'Acme' });
  projectDir = ws.projectDir(slug);
  dest = join(base, 'Consegna');
  store = new CreativeStore(projectDir);
  const created = await store.create({ title: 'Lancio', brief });
  host = { root: ws.root, projectSlug: slug, projectDir, creativeSlug: created.slug };
  queue = new JobQueue({ concurrency: 1 });
  const turns = new CreativeTurnService({
    agentContract: 'media', maxAttempts: 1, queue, git: new Git(), media: NoMediaTools, vault: new MemoryVault(), launcher: testLauncher(new ControlledRunner()),
    presets: async () => DEFAULT_FORMATS, model: async () => null, broadcast: () => {}, sideState: new CreativeSideStateStore(join(base, 'config')),
  });
  svc = new VariantGroupService({ store, turns });
  await svc.addVariants(host, [{}, {}]);
});
afterEach(async () => { await queue.whenIdle(); await rm(base, { recursive: true, force: true }); });

const ext = (f: string) => (f === POST ? 'png' : 'png');
/** A version with a rendered file per format, whose content names its origin (`<slug>:<format>:v<n>`). */
async function render(slug: string, n: number, formats = [POST, BANNER]): Promise<void> {
  const v: VersionEntry = {
    n, commit: null, sessionId: null, status: 'complete', createdAt: new Date().toISOString(), request: `v${n}`, problems: [], tools: [], renderCommand: null, basedOn: null,
    outputs: formats.map((format) => ({ format, file: `${format}.${ext(format)}`, width: 300, height: 250, durationSec: null, verified: true, preview: null })),
  };
  await mkdir(join(projectDir, 'creatives', slug, 'outputs', `v${n}`), { recursive: true });
  for (const f of formats) await writeFile(join(projectDir, 'creatives', slug, 'outputs', `v${n}`, `${f}.${ext(f)}`), `${slug}:${f}:v${n}`);
  await store.appendVersion(slug, v);
}
const common = () => ({ creativeDir: join(projectDir, 'creatives', host.creativeSlug), destination: dest, slug: host.creativeSlug, title: 'Lancio', presets: DEFAULT_FORMATS });
const listing = async () => Object.fromEntries(await Promise.all((await readdir(dest)).sort().map(async (f) => [f, await readFile(join(dest, f), 'utf8')] as const)));

describe('planGroupExport and exportGroup', () => {
  it('a mixed selection exports each format from its ★ or from A, with the host\'s file names (never ~)', async () => {
    await render(host.creativeSlug, 1);
    await render(sis('c'), 1);
    await svc.setPick(host, BANNER, { slug: sis('c'), version: 1 });
    const plan = await planGroupExport(svc, store, host);
    expect(plan.map((p) => [p.format, p.slug, p.version, p.source, p.state])).toEqual([
      [POST, host.creativeSlug, 1, 'default', 'ready'], [BANNER, sis('c'), 1, 'pick', 'ready'],
    ]);
    const r = await exportGroup(plan, common());
    expect(r.unavailable).toEqual([]);
    expect(await listing()).toEqual({
      [`lancio-${POST}-v1.png`]: `${host.creativeSlug}:${POST}:v1`,
      [`lancio-${BANNER}-v1.png`]: `${sis('c')}:${BANNER}:v1`,
    });
    expect(Object.keys(await listing()).some((f) => f.includes('~'))).toBe(false);
  });

  it('is the same from any variant of the group', async () => {
    await render(host.creativeSlug, 1);
    await render(sis('b'), 1);
    await svc.setPick(host, POST, { slug: sis('b'), version: 1 });
    expect(await planGroupExport(svc, store, refOf(sis('b')))).toEqual(await planGroupExport(svc, store, host));
  });

  it('a removed format is absent', async () => {
    await render(host.creativeSlug, 1);
    await render(sis('b'), 1);
    await svc.propagateBrief(host, { ...brief, formats: [POST] });
    const plan = await planGroupExport(svc, store, host);
    expect(plan.map((p) => p.format)).toEqual([POST]);
    await exportGroup(plan, common());
    expect(Object.keys(await listing())).toEqual([`lancio-${POST}-v1.png`]);
  });

  it('a discarded variant is never used: its ★ goes back to the default rule', async () => {
    await render(host.creativeSlug, 1);
    await render(sis('c'), 1);
    await svc.setPick(host, BANNER, { slug: sis('c'), version: 1 });
    await svc.discard(host, 'c');
    const plan = await planGroupExport(svc, store, host);
    expect(plan.find((p) => p.format === BANNER)).toMatchObject({ slug: host.creativeSlug, source: 'default' });
    await exportGroup(plan, common());
    expect((await listing())[`lancio-${BANNER}-v1.png`]).toBe(`${host.creativeSlug}:${BANNER}:v1`);
  });

  it('a missing output file is reported, not thrown; the other formats are exported', async () => {
    await render(host.creativeSlug, 1);
    await render(sis('c'), 1);
    await svc.setPick(host, BANNER, { slug: sis('c'), version: 1 });
    await rm(join(projectDir, 'creatives', sis('c'), 'outputs', 'v1', `${BANNER}.png`));
    const plan = await planGroupExport(svc, store, host);
    expect(plan.find((p) => p.format === BANNER)!.state).toBe('missing');
    const r = await exportGroup(plan, common());
    expect(r.unavailable.map((u) => [u.format, u.slug, u.version, u.state])).toEqual([[BANNER, sis('c'), 1, 'missing']]);
    expect(Object.keys(await listing())).toEqual([`lancio-${POST}-v1.png`]);
  });

  it('a missing member folder does not throw: its formats are skipped', async () => {
    await render(host.creativeSlug, 1);
    await render(sis('c'), 1);
    await svc.setPick(host, BANNER, { slug: sis('c'), version: 1 });
    await rm(join(projectDir, 'creatives', sis('c')), { recursive: true });
    const plan = await planGroupExport(svc, store, host);
    expect(plan.map((p) => [p.format, p.slug])).toEqual([[POST, host.creativeSlug], [BANNER, host.creativeSlug]]);
    expect((await exportGroup(plan, common())).files).toHaveLength(2);
  });

  it('nothing exportable: no files, everything listed, no throw', async () => {
    await render(host.creativeSlug, 1);
    await rm(join(projectDir, 'creatives', host.creativeSlug, 'outputs'), { recursive: true });
    const r = await exportGroup(await planGroupExport(svc, store, host), common());
    expect(r.files).toEqual([]);
    expect(r.unavailable).toHaveLength(2);
  });

  it('a composition without a render is "needs-render" and is not copied by the core function', async () => {
    await render(host.creativeSlug, 1, [POST]);
    const v: VersionEntry = { n: 2, commit: null, sessionId: null, status: 'complete', createdAt: new Date().toISOString(), request: '', outputs: [], problems: [], tools: [], renderCommand: null, basedOn: null,
      compositions: [{ format: BANNER, dir: `compositions/${BANNER}`, hash: 'a'.repeat(64), problems: [] }] };
    await store.appendVersion(host.creativeSlug, v);
    const plan = await planGroupExport(svc, store, host);
    expect(plan.find((p) => p.format === BANNER)).toMatchObject({ version: 2, state: 'needs-render', file: '' });
  });

  it('final wave (deferred 99): with languages, a missing source is listed per language and a needs-render one is resolved, never skipped silently', async () => {
    await render(host.creativeSlug, 1, [POST]);
    await rm(join(projectDir, 'creatives', host.creativeSlug, 'outputs', 'v1', `${POST}.png`));
    const v: VersionEntry = { n: 2, commit: null, sessionId: null, status: 'complete', createdAt: new Date().toISOString(), request: '', outputs: [], problems: [], tools: [], renderCommand: null, basedOn: null,
      compositions: [{ format: BANNER, dir: `compositions/${BANNER}`, hash: 'a'.repeat(64), problems: [] }] };
    await store.appendVersion(host.creativeSlug, v);
    const plan = await planGroupExport(svc, store, host);
    expect(plan.map((p) => [p.format, p.state])).toEqual([[POST, 'missing'], [BANNER, 'needs-render']]);
    const r = await resolveGroupLocalized(plan, store, ['de']);
    expect(r.unavailable.map((u) => [u.plan.format, u.locale, u.state])).toEqual([[POST, 'de', 'missing'], [BANNER, 'de', 'no-translation']]);
    expect(r.items).toEqual([]);
  });

  it('an ungrouped creative is refused by the plan (409) and its export is exactly today\'s', async () => {
    const solo = await store.create({ title: 'Solo', brief });
    await expect(planGroupExport(svc, store, refOf(solo.slug))).rejects.toMatchObject({ status: 409 });
    await render(solo.slug, 1);
    const versions = await store.readVersions(solo.slug);
    const r = await exportPicks({ creativeDir: store.dir(solo.slug), destination: dest, slug: solo.slug, title: 'Solo', versions, picks: { [POST]: 1, [BANNER]: 1 } });
    expect(r.files.map((f) => f.to.split('/').pop())).toEqual([`solo-${POST}-v1.png`, `solo-${BANNER}-v1.png`]);
    expect(await listing()).toEqual({ [`solo-${POST}-v1.png`]: `${solo.slug}:${POST}:v1`, [`solo-${BANNER}-v1.png`]: `${solo.slug}:${BANNER}:v1` });
  });

  it('"export this variant" is today\'s export of that member', async () => {
    await render(sis('b'), 1);
    const [v] = await store.readVersions(sis('b'));
    const r = await exportVersion({ creativeDir: store.dir(sis('b')), version: v!, destination: dest, slug: sis('b'), title: 'Lancio' });
    expect(r.files).toHaveLength(2);
    expect((await listing())[`lancio-${POST}-v1.png`]).toBe(`${sis('b')}:${POST}:v1`);
  });
});

describe('group store pack', () => {
  const pack = { app: { name: 'Tasky', tagline: '' }, stores: ['appstore'], devices: { appstore: ['iphone-69'] }, screenshots: [{ caption: 'First', screen: null }, { caption: 'Second', screen: null }], preview: false } as unknown as StorePack;
  it('takes each pack format from the member the selection names, at that version', async () => {
    const dirA = join(base, 'a'); const dirC = join(base, 'c');
    for (const [d, n] of [[dirA, 1], [dirC, 3]] as const) await mkdir(join(d, 'outputs', `v${n}`), { recursive: true });
    await writeFile(join(dirA, 'outputs', 'v1', 'shot.png'), makePng(1290, 2796));
    await writeFile(join(dirC, 'outputs', 'v3', 'shot.png'), makePng(1290, 2796, 2, [], 0x10));
    const out = join(base, 'pack');
    const r = await exportStorePack({
      creativeDir: dirA, n: 1, destination: out, title: 'Tasky', storePack: pack, presets: DEFAULT_FORMATS, date: '2026-10-16', order: ['appstore-iphone-69', 'appstore-iphone-69@2'], probe: async () => null,
      files: [
        { format: 'appstore-iphone-69', width: 1290, height: 2796, file: 'shot.png', dir: dirA, n: 1 },
        { format: 'appstore-iphone-69@2', width: 1290, height: 2796, file: 'shot.png', dir: dirC, n: 3 },
      ],
    });
    expect(r.written).toEqual(['AppStore/iPhone-6.9/01-first.png', 'AppStore/iPhone-6.9/02-second.png']);
    const first = await readFile(join(r.folder, 'AppStore/iPhone-6.9/01-first.png'));
    const second = await readFile(join(r.folder, 'AppStore/iPhone-6.9/02-second.png'));
    expect(first.equals(makePng(1290, 2796))).toBe(true);
    expect(second.equals(makePng(1290, 2796, 2, [], 0x10))).toBe(true);
  });
});

describe('group export routes', { timeout: 120_000 }, () => {
  it('GET/POST …/export-group: a mixed selection with the host\'s names; a missing file is reported, translated, not thrown; an ungrouped creative is 409', async () => {
    const { variantApp } = await import('./helpers/variant-app.ts');
    const v = await variantApp();
    try {
      const slug = await v.group([null, null, null]);
      const put = async (member: string, n: number, formats: string[]) => {
        const st = new CreativeStore(v.projectDir);
        const entry: VersionEntry = { n, commit: null, sessionId: null, status: 'complete', createdAt: new Date().toISOString(), request: '', problems: [], tools: [], renderCommand: null, basedOn: null,
          outputs: formats.map((format) => ({ format, file: `${format}.png`, width: 300, height: 250, durationSec: null, verified: true, preview: null })) };
        await mkdir(join(v.projectDir, 'creatives', member, 'outputs', `v${n}`), { recursive: true });
        for (const f of formats) await writeFile(join(v.projectDir, 'creatives', member, 'outputs', `v${n}`, `${f}.png`), `${member}:${f}`);
        await st.appendVersion(member, entry);
      };
      await put(slug, 1, [POST, BANNER]);
      await put(`${slug}~c`, 1, [POST, BANNER]);
      const pick = await v.app.inject({ method: 'PUT', url: `${v.url(slug)}/variants/picks/${BANNER}`, payload: { slug: `${slug}~c`, version: 1 } });
      expect(pick.statusCode, pick.body).toBe(200);
      const plan = (await v.app.inject({ url: `${v.url(`${slug}~b`)}/export-group` })).json() as { items: Array<{ format: string; slug: string; letter: string; version: number; source: string; state: string }> };
      expect(plan.items.map((i) => [i.format, i.letter, i.version, i.source, i.state])).toEqual([[POST, 'a', 1, 'default', 'ready'], [BANNER, 'c', 1, 'pick', 'ready']]);
      const out = join(v.base, 'out');
      const ok = await v.app.inject({ method: 'POST', url: `${v.url(`${slug}~b`)}/export-group`, payload: { destination: out, pattern: '{title}-{format}-v{v}', date: '2026-10-16' } });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toMatchObject({ unavailable: [] });
      expect((await readdir(out)).sort()).toEqual([`lancio-${POST}-v1.png`, `lancio-${BANNER}-v1.png`]);
      expect(await readFile(join(out, `lancio-${BANNER}-v1.png`), 'utf8')).toBe(`${slug}~c:${BANNER}`);
      // A missing file: reported with a translated message, the rest is exported (status 200).
      await rm(join(v.projectDir, 'creatives', `${slug}~c`, 'outputs', 'v1', `${BANNER}.png`));
      const out2 = join(v.base, 'out2');
      const part = await v.app.inject({ method: 'POST', url: `${v.url(slug)}/export-group`, payload: { destination: out2 } });
      expect(part.statusCode, part.body).toBe(200);
      const body = part.json() as { files: unknown[]; unavailable: Array<{ format: string; letter: string; message: string }> };
      expect(body.files).toHaveLength(1);
      expect(body.unavailable).toHaveLength(1);
      expect(body.unavailable[0]).toMatchObject({ format: BANNER, letter: 'c' });
      expect(body.unavailable[0]!.message).toContain('variante C v1');
      // An ungrouped creative: 409, its own export untouched.
      const solo = (await v.app.inject({ method: 'POST', url: '/api/projects/acme/creatives', payload: { title: 'Solo', brief: { goal: 'g', message: '', formats: [POST], durationSec: 5, assets: [], notes: '' }, generate: false } })).json() as { slug: string };
      expect((await v.app.inject({ url: `${v.url(solo.slug)}/export-group` })).statusCode).toBe(409);
      expect((await v.app.inject({ method: 'POST', url: `${v.url(solo.slug)}/export-group`, payload: { destination: out2 } })).statusCode).toBe(409);
    } finally { await v.close(); }
  });
});
