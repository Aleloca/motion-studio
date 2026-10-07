import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { execCommand } from '../src/exec.ts';
import { Git } from '../src/git.ts';
import { slugify, WorkspaceError, WorkspaceStore } from '../src/workspace-store.ts';

let base: string;
beforeEach(async () => { base = await mkdtemp(join(tmpdir(), 'ms-ws-')); });

describe('slugify', () => {
  it('normalizes accents, spaces and symbols', () => {
    expect(slugify('  Lumen Caffè — Primavera 2026! ')).toBe('lumen-caffe-primavera-2026');
  });
  it('falls back to "progetto" for names without letters or digits', () => {
    expect(slugify('***')).toBe('progetto');
  });
});

describe('WorkspaceStore.open', () => {
  it('creates a missing workspace with default settings (path with spaces and accents)', async () => {
    const root = join(base, 'Il mio spazio è qui');
    const ws = await WorkspaceStore.open(root, new Git());
    expect(await ws.readSettings()).toMatchObject({ maxConcurrentJobs: 2, theme: 'system' });
    expect(JSON.parse(await readFile(join(root, '.studio', 'settings.json'), 'utf8')).schemaVersion).toBe(1);
  });
  it('rejects a path that is a file', async () => {
    const file = join(base, 'file.txt');
    await writeFile(file, 'x');
    const err = await WorkspaceStore.open(file, new Git()).catch((e) => e);
    expect(err).toBeInstanceOf(WorkspaceError);
    expect(err.status).toBe(400);
  });
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('rejects a non-writable folder', async () => {
    const ro = join(base, 'readonly');
    await WorkspaceStore.open(ro, new Git());
    await chmod(ro, 0o500);
    const err = await WorkspaceStore.open(join(ro, 'child'), new Git()).catch((e) => e);
    await chmod(ro, 0o700);
    expect(err).toBeInstanceOf(WorkspaceError);
    expect(err.status).toBe(400);
  });
});

describe('projects', () => {
  it('creates a project folder with the full skeleton and an initial commit', async () => {
    const ws = await WorkspaceStore.open(join(base, 'ws'), new Git());
    const { slug, project } = await ws.createProject({ name: 'Acme', description: 'Campagne Acme' });
    expect(slug).toBe('acme');
    expect(project).toMatchObject({ schemaVersion: 1, name: 'Acme', description: 'Campagne Acme', linkedCodebases: [] });
    const dir = ws.projectDir(slug);
    for (const rel of ['project.json', 'brand', 'assets', 'references', 'creatives', '.studio/context.md', 'CLAUDE.md', '.gitignore']) {
      await expect(stat(join(dir, rel))).resolves.toBeTruthy();
    }
    expect(await readFile(join(dir, 'CLAUDE.md'), 'utf8')).toContain('@.studio/context.md');
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toContain('outputs/');
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toContain('creatives/*/work/out/');
    const log = await execCommand('git', ['log', '--format=%s'], { cwd: dir });
    expect(log.stdout.trim()).toBe('Crea progetto Acme');
  });
  it('gives unique slugs to projects with the same name', async () => {
    const ws = await WorkspaceStore.open(join(base, 'ws'), new Git());
    const [a, b] = await Promise.all([ws.createProject({ name: 'Acme' }), ws.createProject({ name: 'Acme' })]);
    expect(new Set([a.slug, b.slug])).toEqual(new Set(['acme', 'acme-2']));
  });
  it('rejects an empty name with 400', async () => {
    const ws = await WorkspaceStore.open(join(base, 'ws'), new Git());
    const err = await ws.createProject({ name: '   ' }).catch((e) => e);
    expect(err.status).toBe(400);
  });
  it('lists projects sorted by slug and reports a corrupted one without rewriting it', async () => {
    const ws = await WorkspaceStore.open(join(base, 'ws'), new Git());
    await ws.createProject({ name: 'Orto Urbano' });
    const { slug } = await ws.createProject({ name: 'Acme' });
    const broken = join(ws.projectDir(slug), 'project.json');
    await writeFile(broken, '{ "schemaVersion": 1, "name": ');
    const items = await ws.listProjects();
    expect(items.map((i) => i.slug)).toEqual(['acme', 'orto-urbano']);
    const bad = items.find((i) => i.slug === 'acme');
    expect(bad).toMatchObject({ ok: false });
    expect(bad && !bad.ok && bad.error).toContain('JSON non valido');
    expect(await readFile(broken, 'utf8')).toBe('{ "schemaVersion": 1, "name": ');
  });
  it('reports a schema-invalid project.json with the reason', async () => {
    const ws = await WorkspaceStore.open(join(base, 'ws'), new Git());
    const { slug } = await ws.createProject({ name: 'Acme' });
    await writeFile(join(ws.projectDir(slug), 'project.json'), JSON.stringify({ schemaVersion: 1, name: 'Acme' }));
    const [item] = await ws.listProjects();
    expect(item).toMatchObject({ slug, ok: false });
    expect(item && !item.ok && item.error).toContain('contenuto non valido');
  });
  it('removes the just-created project folder when a later step fails', async () => {
    class BrokenGit extends Git { override async init(): Promise<void> { throw new Error('git init rotto'); } }
    const ws = await WorkspaceStore.open(join(base, 'ws'), new BrokenGit());
    await mkdir(join(base, 'ws', 'altro'));
    await expect(ws.createProject({ name: 'Acme' })).rejects.toThrow('git init rotto');
    expect(await stat(join(base, 'ws', 'acme')).catch(() => null)).toBeNull();
    expect((await stat(join(base, 'ws', 'altro'))).isDirectory()).toBe(true);
  });
  it('ignores folders without project.json and the .studio folder', async () => {
    const ws = await WorkspaceStore.open(join(base, 'ws'), new Git());
    await (await import('node:fs/promises')).mkdir(join(base, 'ws', 'random-folder'));
    expect(await ws.listProjects()).toEqual([]);
  });
  it('getProject throws 404 for an unknown slug and 400 for path traversal', async () => {
    const ws = await WorkspaceStore.open(join(base, 'ws'), new Git());
    expect((await ws.getProject('nope').catch((e) => e)).status).toBe(404);
    expect((await ws.getProject('../etc').catch((e) => e)).status).toBe(400);
  });
  it('updates settings with validation', async () => {
    const ws = await WorkspaceStore.open(join(base, 'ws'), new Git());
    expect(await ws.updateSettings({ maxConcurrentJobs: 3 })).toMatchObject({ maxConcurrentJobs: 3 });
    expect((await ws.updateSettings({ maxConcurrentJobs: 99 }).catch((e) => e)).status).toBe(400);
  });
});

describe('updateProject', () => {
  it('normalizes and stores linked codebases and commits', async () => {
    const ws = await WorkspaceStore.open(join(base, 'ws'), new Git());
    const { slug } = await ws.createProject({ name: 'Acme' });
    const p = await ws.updateProject(slug, { linkedCodebases: [{ path: '/Users/me/app/', note: 'iOS' }, { path: '/Users/me/app' }] });
    expect(p.linkedCodebases).toEqual([{ path: '/Users/me/app', note: 'iOS' }]);
    const log = await execCommand('git', ['log', '-1', '--format=%s'], { cwd: ws.projectDir(slug) });
    expect(log.stdout.trim()).toBe('Progetto aggiornato');
    expect((await ws.updateProject(slug, { linkedCodebases: [{ path: 'relative' }] }).catch((e) => e)).status).toBe(400);
    expect((await ws.updateProject(slug, { name: ' ' }).catch((e) => e)).status).toBe(400);
  });
});
