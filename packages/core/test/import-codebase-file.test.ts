import { mkdir, mkdtemp, open, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ServerMessage } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeContext } from '../src/bridge/bridge.ts';
import { CODEBASE_IMPORT_CALLS_PER_JOB, importCodebaseFile, importCodebaseTool, type CodebaseImportContext } from '../src/bridge/import-codebase-tool.ts';
import { LibraryStore } from '../src/library/library-store.ts';
import { NoMediaTools } from '../src/media/media-tools.ts';
import { ProviderError } from '../src/providers/http.ts';
import { FIXTURE_SECRET_MARKER, fixtureCodebase } from './helpers/brand-codebase.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const cleanup: string[] = [];
let cb: string;
let project: string;
let outside: string;
let library: LibraryStore;
beforeEach(async () => {
  cb = await fixtureCodebase();
  cleanup.push(dirname(cb));
  project = await realpath(await mkdtemp(join(tmpdir(), 'ms-imp-proj-')));
  // Stands in for "a folder outside the codebase" (e.g. ~/.ssh): a temp folder of the test, never a real one.
  outside = await realpath(await mkdtemp(join(tmpdir(), 'ms-imp-outside-')));
  cleanup.push(project, outside);
  await writeFile(join(outside, 'id_ed25519.png'), 'outside-content');
  await writeFile(join(outside, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  library = new LibraryStore(project, NoMediaTools);
});
afterEach(async () => { for (const d of cleanup.splice(0)) await rm(d, { recursive: true, force: true }); });

const ctx = (over: Partial<CodebaseImportContext> = {}): CodebaseImportContext => ({ projectDir: project, codebases: [cb], callsSoFar: 0, library, ...over });
/** The destination extension that matches the source's, so each case reaches the check it is about. */
const sameExt = (source: unknown) => (typeof source === 'string' && /\.(png|svg)$/i.test(source) ? source.split('.').pop()!.toLowerCase() : 'svg');
const assetFiles = async () => {
  const out: string[] = [];
  const walk = async (d: string, rel: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory()) await walk(join(d, e.name), `${rel}${e.name}/`);
      else out.push(`${rel}${e.name}`);
    }
  };
  await walk(join(project, 'assets'), '');
  return out.filter((f) => f !== 'assets.json');
};

describe('importCodebaseFile: a good copy', () => {
  it('copies into assets/brand with origin codebase and the brand tag', async () => {
    expect(await importCodebaseFile(ctx(), { source: 'public/logo.svg', dest: 'assets/brand/logo.svg' })).toEqual({ file: 'assets/brand/logo.svg' });
    expect(await readFile(join(project, 'assets', 'brand', 'logo.svg'), 'utf8')).toBe(await readFile(join(cb, 'public', 'logo.svg'), 'utf8'));
    expect((await library.listAssets()).find((a) => a.file === 'brand/logo.svg')).toMatchObject({ origin: 'codebase', sourceUrl: null, tags: ['brand'] });
    // Absolute inside the codebase works too, and a font goes to assets/fonts.
    await writeFile(join(cb, 'src', 'Inter.woff2'), 'font');
    expect(await importCodebaseFile(ctx(), { source: join(cb, 'src', 'Inter.woff2'), dest: 'assets/fonts/Inter.woff2' })).toEqual({ file: 'assets/fonts/Inter.woff2' });
    // A link that stays inside the codebase and is no secret is fine.
    await symlink(join(cb, 'public', 'logo.svg'), join(cb, 'public', 'mark.svg'));
    expect(await importCodebaseFile(ctx(), { source: 'public/mark.svg', dest: 'assets/brand/mark.svg' })).toEqual({ file: 'assets/brand/mark.svg' });
  });
  it('relative sources are tried against each codebase', async () => {
    const other = await fixtureCodebase({ git: false, name: 'other' });
    cleanup.push(dirname(other));
    await writeFile(join(other, 'public', 'only-here.png'), 'png');
    expect(await importCodebaseFile(ctx({ codebases: [cb, other] }), { source: 'public/only-here.png', dest: 'assets/brand/x.png' })).toEqual({ file: 'assets/brand/x.png' });
    expect(await importCodebaseFile(ctx({ codebases: [cb, other] }), { source: join(other, 'public', 'only-here.png'), dest: 'assets/brand/y.png' })).toEqual({ file: 'assets/brand/y.png' });
    expect(await importCodebaseFile(ctx({ codebases: [cb] }), { source: join(other, 'public', 'only-here.png'), dest: 'assets/brand/z.png' })).toEqual({ error: 'outside' });
  });
});

describe('importCodebaseFile: Review Focus 1, a codebase that tries to escape', () => {
  it('refuses traversal, absolute paths elsewhere and links whose real path leaves the codebase', async () => {
    await symlink(join(outside, 'id_ed25519.png'), join(cb, 'public', 'key.png'));
    await symlink(outside, join(cb, 'public', 'dir-out'));
    await writeFile(join(project, 'mine.svg'), '<svg/>');
    await symlink(project, join(cb, 'public', 'project'));
    const cases: Array<[unknown, string]> = [
      ['../outside.svg', 'outside'],
      ['public/../../x.svg', 'outside'],
      [`../${'acme-app'}/../../${outside.split('/').pop()}/logo.svg`, 'outside'],
      [join(outside, 'logo.svg'), 'outside'],
      [join(project, 'mine.svg'), 'outside'],
      ['public/key.png', 'outside'],
      ['public/dir-out/logo.svg', 'outside'],
      ['public/project/mine.svg', 'outside'],
      [cb, 'outside'],
      ['', 'outside'],
      [42, 'outside'],
      ['public/a\u0000.svg', 'outside'],
    ];
    for (const [source, error] of cases) expect(await importCodebaseFile(ctx(), { source, dest: `assets/brand/x.${sameExt(source)}` }), String(source)).toEqual({ error });
    expect(await assetFiles()).toEqual([]);
  });
  it('refuses secret files by the requested path and by the real path, whatever the case', async () => {
    await mkdir(join(cb, 'config', 'secrets'), { recursive: true });
    await writeFile(join(cb, 'config', 'secrets', 'logo.svg'), '<svg/>');
    await symlink(join(cb, 'config', 'secrets', 'logo.svg'), join(cb, 'public', 'alias.svg'));
    await writeFile(join(cb, 'public', 'Credentials.PNG'), 'x');
    await symlink(join(cb, '.env'), join(cb, 'public', 'env.png'));
    const cases: Array<[string, string]> = [
      ['config/.env.production', 'secret'],
      ['.env', 'secret'],
      [join(cb, '.env'), 'secret'],
      ['.git/config', 'secret'],
      ['config/secrets/logo.svg', 'secret'],
      ['public/alias.svg', 'secret'],
      ['public/Credentials.PNG', 'secret'],
      ['public/env.png', 'secret'],
      ['./public/../.ENV', 'secret'],
    ];
    for (const [source, error] of cases) expect(await importCodebaseFile(ctx(), { source, dest: `assets/brand/x.${sameExt(source)}` }), source).toEqual({ error });
    expect(await assetFiles()).toEqual([]);
  });
  it('refuses a 60 MB file before reading it, and non-files', async () => {
    const big = await open(join(cb, 'public', 'huge.png'), 'w');
    await big.truncate(60 * 1024 * 1024);
    await big.close();
    expect(await importCodebaseFile(ctx(), { source: 'public/huge.png', dest: 'assets/brand/huge.png' })).toEqual({ error: 'too-big' });
    await mkdir(join(cb, 'public', 'folder.svg'));
    expect(await importCodebaseFile(ctx(), { source: 'public/folder.svg', dest: 'assets/brand/f.svg' })).toEqual({ error: 'not-file' });
    expect(await importCodebaseFile(ctx(), { source: 'public/nope.svg', dest: 'assets/brand/n.svg' })).toEqual({ error: 'missing' });
    expect(await assetFiles()).toEqual([]);
  });
  it('allows only asset extensions, the same at both ends', async () => {
    for (const [source, dest] of [['tailwind.config.js', 'assets/brand/t.js'], ['src/theme.css', 'assets/brand/theme.css'], ['public/manifest.json', 'assets/brand/m.json'], ['public/logo.svg', 'assets/brand/logo.png'], ['public/logo.svg', 'assets/brand/logo']]) {
      expect(await importCodebaseFile(ctx(), { source, dest }), `${source} → ${dest}`).toEqual({ error: 'extension' });
    }
    expect(await assetFiles()).toEqual([]);
  });
  it('confines the destination to assets/brand or assets/fonts', async () => {
    for (const dest of ['assets/brand/../x.svg', 'assets/../x.svg', '../x.svg', '/tmp/x.svg', 'assets/x.svg', 'assets/other/x.svg', 'assets/brand/sub/x.svg', 'assets/brand/.hidden.svg', 'assets/brand/', 42, 'assets\\brand\\x.svg', 'assets/brand/a\nb.svg']) {
      expect(await importCodebaseFile(ctx(), { source: 'public/logo.svg', dest }), String(dest)).toEqual({ error: 'dest' });
    }
    expect(await assetFiles()).toEqual([]);
  });
  it('refuses the 41st call of a job', async () => {
    expect(await importCodebaseFile(ctx({ callsSoFar: CODEBASE_IMPORT_CALLS_PER_JOB }), { source: 'public/logo.svg', dest: 'assets/brand/logo.svg' })).toEqual({ error: 'limit' });
    expect(await assetFiles()).toEqual([]);
  });
});

describe('the import_codebase_file bridge tool', () => {
  const broadcasts: ServerMessage[] = [];
  const context = (over: Partial<BridgeContext> = {}): BridgeContext => ({
    jobId: 'j1', kind: 'brand-analysis', projectSlug: 'acme', projectDir: project, creativeSlug: null, sandboxed: false, autoApproveAtStart: false,
    emit: () => {}, signal: new AbortController().signal, codebases: [cb], ...over,
  });
  const refusal = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e as ProviderError; } };

  it('counts every call of the job and refuses the 41st with a clear reason; the analysis goes on', async () => {
    const tool = importCodebaseTool({ media: NoMediaTools, broadcast: (m) => broadcasts.push(m) });
    const c = context();
    for (let n = 0; n < CODEBASE_IMPORT_CALLS_PER_JOB; n++) {
      const e = await refusal(tool(c, { source: 'config/.env.production', dest: 'assets/brand/x.png' }));
      expect(e).toBeInstanceOf(ProviderError);
      expect(e!.status).toBe(403);
      expect(e!.message).toMatch(/^secret: /);
      // Never the secret's content in a refusal.
      expect(e!.message).not.toContain(FIXTURE_SECRET_MARKER);
    }
    const last = await refusal(tool(c, { source: 'public/logo.svg', dest: 'assets/brand/logo.svg' }));
    expect(last!.status).toBe(429);
    expect(last!.message).toMatch(/^limit: .*40/);
    // Another job has its own count.
    expect(await tool(context(), { source: 'public/logo.svg', dest: 'assets/brand/logo.svg' })).toEqual({ file: 'assets/brand/logo.svg' });
    expect(broadcasts).toContainEqual({ type: 'library', project: 'acme' });
  });
  it('maps each refusal to a status and a reason', async () => {
    const tool = importCodebaseTool({ media: NoMediaTools, broadcast: () => {} });
    const expectations: Array<[Record<string, unknown>, number, string]> = [
      [{ source: '../x.svg', dest: 'assets/brand/x.svg' }, 403, 'outside'],
      [{ source: 'public/nope.svg', dest: 'assets/brand/x.svg' }, 404, 'missing'],
      [{ source: 'src/theme.css', dest: 'assets/brand/x.css' }, 400, 'extension'],
      [{ source: 'public/logo.svg', dest: 'assets/x.svg' }, 400, 'dest'],
    ];
    for (const [args, status, code] of expectations) {
      const e = await refusal(tool(context(), args));
      expect(e!.status, code).toBe(status);
      expect(e!.message.startsWith(`${code}: `), e!.message).toBe(true);
    }
  });
  it('is refused to other jobs and without codebases', async () => {
    const tool = importCodebaseTool({ media: NoMediaTools, broadcast: () => {} });
    expect((await refusal(tool(context({ kind: 'creative' }), { source: 'public/logo.svg', dest: 'assets/brand/x.svg' })))!.status).toBe(403);
    expect((await refusal(tool(context({ codebases: undefined }), { source: 'public/logo.svg', dest: 'assets/brand/x.svg' })))!.message).toMatch(/^outside: /);
    expect(await assetFiles()).toEqual([]);
  });
});
