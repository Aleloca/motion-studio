import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { execCommand } from '../src/exec.ts';
import { Git } from '../src/git.ts';
import { slugify, WorkspaceError, WorkspaceStore } from '../src/workspace-store.ts';
import { SettingsHoldStore } from '../src/settings-hold.ts';

let base: string;
beforeEach(async () => { base = await mkdtemp(join(tmpdir(), 'ms-ws-')); });

describe('slugify', () => {
  it('normalizes accents, spaces and symbols', () => {
    expect(slugify('  Lumen Caffè — Primavera 2026! ')).toBe('lumen-caffe-primavera-2026');
  });
  it('falls back to "project" for names without letters or digits', () => {
    expect(slugify('***')).toBe('project');
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
    // The usage ledger stays versioned and merges line by line.
    expect(await readFile(join(dir, '.gitattributes'), 'utf8')).toBe('.studio/usage.jsonl merge=union\n');
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toContain('creatives/*/work/out/');
    expect((await readFile(join(dir, '.gitignore'), 'utf8')).split('\n')).toEqual(expect.arrayContaining(['.*.part', 'assets/.describe/', '.cache/', 'creatives/*/work/tmp/', '.studio/cache/']));
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
    const before = await ws.getProject(slug);
    await new Promise((r) => setTimeout(r, 5));
    const u = await ws.updateProject(slug, { name: 'Acme 2', description: 'd', linkedCodebases: undefined });
    expect(u).toMatchObject({ name: 'Acme 2', description: 'd', linkedCodebases: [{ path: '/Users/me/app', note: 'iOS' }] });
    expect(u.updatedAt).not.toBe(before.updatedAt);
    expect((await ws.updateProject(slug, { name: undefined })).name).toBe('Acme 2');
  }, { timeout: 20_000 });
  it('refuses codebases that contain the project or the workspace or sit inside them', async () => {
    const ws = await WorkspaceStore.open(join(base, 'ws'), new Git());
    const { slug } = await ws.createProject({ name: 'Acme' });
    const dir = ws.projectDir(slug);
    await mkdir(join(base, 'ws-sibling'));
    for (const path of [dir, `${dir}/`, join(dir, 'assets'), ws.root, base, join(ws.root, 'altro'), join(dir, '..', slug, 'brand')]) {
      const err = await ws.updateProject(slug, { linkedCodebases: [{ path }] }).catch((e) => e);
      expect(err.status, path).toBe(400);
      expect(err.message, path).toBe('La cartella collegata non può contenere il progetto né trovarsi al suo interno');
    }
    // A sibling whose name only shares the prefix is fine.
    expect((await ws.updateProject(slug, { linkedCodebases: [{ path: join(base, 'ws-sibling') }] })).linkedCodebases).toEqual([{ path: join(base, 'ws-sibling') }]);
  });
  it('compares real paths, so a symlink to the project is refused', async () => {
    const ws = await WorkspaceStore.open(join(base, 'ws'), new Git());
    const { slug } = await ws.createProject({ name: 'Acme' });
    await symlink(ws.projectDir(slug), join(base, 'link'));
    expect((await ws.updateProject(slug, { linkedCodebases: [{ path: join(base, 'link') }] }).catch((e) => e)).status).toBe(400);
  });
});

describe('stored domains', () => {
  it('loads a workspace whose settings hold an invalid domain, without rewriting the file, and keeps writes strict', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ms-ws-dom-'));
    const ws = await WorkspaceStore.open(root, new Git());
    const file = join(root, '.studio', 'settings.json');
    const raw = JSON.stringify({ schemaVersion: 1, extraAllowedDomains: ['api.acme.io', 'printer.local'] });
    await writeFile(file, raw);
    const settings = await ws.readSettings();
    expect(settings.extraAllowedDomains).toEqual(['api.acme.io']);
    expect(settings.droppedDomains).toEqual(['printer.local']);
    expect(await readFile(file, 'utf8')).toBe(raw);
    await expect(ws.updateSettings({ extraAllowedDomains: ['printer.local'] })).rejects.toMatchObject({ status: 400 });
    const next = await ws.updateSettings({ expertMode: true });
    expect(next).not.toHaveProperty('droppedDomains');
    expect(JSON.parse(await readFile(file, 'utf8'))).not.toHaveProperty('droppedDomains');
  });
});

// Final wave P9: an agent run without the sandbox can write .studio/settings.json; the core holds the settings for the run
// and undoes any change after it.
describe('WorkspaceStore settings guard (sandbox off)', () => {
  const file = (root: string) => join(root, '.studio', 'settings.json');
  const agentWrites = async (root: string) => {
    const cur = JSON.parse(await readFile(file(root), 'utf8'));
    await writeFile(file(root), JSON.stringify({ ...cur, sandboxMode: 'off', confirmPaidProviders: false, agentLiveInput: true }));
  };

  it('during the run the settings are those it started with; after it, an agent write is undone byte for byte and reported', async () => {
    const root = join(base, 'ws');
    const ws = await WorkspaceStore.open(root, new Git());
    await ws.updateSettings({ expertMode: true });
    const before = await readFile(file(root), 'utf8');
    const release = await ws.guardSettings();
    await agentWrites(root);
    expect(await ws.readSettings()).toMatchObject({ sandboxMode: 'auto', confirmPaidProviders: true, agentLiveInput: false, expertMode: true });
    expect(await release()).toEqual({ changed: true, reverted: true });
    expect(await readFile(file(root), 'utf8')).toBe(before);
    expect(await ws.readSettings()).toMatchObject({ sandboxMode: 'auto', confirmPaidProviders: true });
    // Released twice: nothing more happens.
    expect(await release()).toEqual({ changed: false, reverted: false });
  });

  it('no change: nothing is reported; a user save during the run is kept', async () => {
    const root = join(base, 'ws2');
    const ws = await WorkspaceStore.open(root, new Git());
    const release = await ws.guardSettings();
    await ws.updateSettings({ theme: 'dark' });
    expect(await ws.readSettings()).toMatchObject({ theme: 'dark' });
    expect(await release()).toEqual({ changed: false, reverted: false });
    expect(JSON.parse(await readFile(file(root), 'utf8')).theme).toBe('dark');
  });

  it('two overlapping runs: the settings are held until both end', async () => {
    const root = join(base, 'ws3');
    const ws = await WorkspaceStore.open(root, new Git());
    const a = await ws.guardSettings();
    const b = await ws.guardSettings();
    await agentWrites(root);
    expect(await a()).toEqual({ changed: true, reverted: true });
    await agentWrites(root);
    expect((await ws.readSettings()).sandboxMode).toBe('auto');
    expect(await b()).toEqual({ changed: true, reverted: true });
    expect(JSON.parse(await readFile(file(root), 'utf8')).sandboxMode).toBe('auto');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a change that cannot be undone is reported, and the changed fields are not applied until the user saves', async () => {
    const root = join(base, 'ws4');
    const ws = await WorkspaceStore.open(root, new Git());
    const release = await ws.guardSettings();
    await agentWrites(root);
    await chmod(join(root, '.studio'), 0o500); // the folder refuses the temp file: no undo possible
    try {
      expect(await release()).toEqual({ changed: true, reverted: false });
      expect(JSON.parse(await readFile(file(root), 'utf8')).sandboxMode).toBe('off');
      // Still the settings from before the run: no sandbox off, no paid call without confirmation, no opt-in.
      expect(await ws.readSettings()).toMatchObject({ sandboxMode: 'auto', confirmPaidProviders: true, agentLiveInput: false });
    } finally {
      await chmod(join(root, '.studio'), 0o700);
    }
    // The user saves the settings (their confirmation): from the trusted values, written to the file.
    await ws.updateSettings({ theme: 'light' });
    expect(JSON.parse(await readFile(file(root), 'utf8'))).toMatchObject({ sandboxMode: 'auto', confirmPaidProviders: true, theme: 'light' });
    await writeFile(file(root), JSON.stringify({ ...JSON.parse(await readFile(file(root), 'utf8')), theme: 'dark' }));
    expect((await ws.readSettings()).theme).toBe('dark'); // served from the file again
  });
});

// Fix round 1 (I-A): a change the core could not undo stays held across a restart (config folder), and the revert is
// retried at startup (`.studio`'s mode restored first) and at the next guard.
describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('WorkspaceStore settings hold across a restart', () => {
  const file = (root: string) => join(root, '.studio', 'settings.json');
  const agentValues = { sandboxMode: 'off', confirmPaidProviders: false, autoApproveSandboxed: true, agentLiveInput: true, agentInterrupt: true };

  it('chmod 500 .studio: not undone in the run; after a restart the mode is restored, the file put back, nothing of the agent applies', async () => {
    const root = join(base, 'ws');
    const config = join(base, 'config');
    const ws = await WorkspaceStore.open(root, new Git());
    await ws.attachSettingsHold(new SettingsHoldStore(config));
    await ws.updateSettings({ autoApproveSandboxed: false });
    const before = await readFile(file(root), 'utf8');
    const release = await ws.guardSettings();
    await writeFile(file(root), JSON.stringify({ ...JSON.parse(before), ...agentValues }));
    await chmod(join(root, '.studio'), 0o500);
    try {
      expect(await release()).toEqual({ changed: true, reverted: false });
      expect(ws.settingsHeld()).toBe(true);
      // The app restarts: a new store, the hold read back from the config folder.
      const ws2 = await WorkspaceStore.open(root, new Git(), { create: false });
      await ws2.attachSettingsHold(new SettingsHoldStore(config));
      // The file is made at least as strict as the hold (Ruling AA: the record is never copied in as such).
      expect(JSON.parse(await readFile(file(root), 'utf8'))).toMatchObject({ sandboxMode: 'auto', confirmPaidProviders: true, autoApproveSandboxed: false, agentLiveInput: false, agentInterrupt: false });
      expect(await ws2.readSettings()).toMatchObject({ sandboxMode: 'auto', confirmPaidProviders: true, autoApproveSandboxed: false, agentLiveInput: false, agentInterrupt: false });
      expect(ws2.settingsHeld()).toBe(false);
      expect(await new SettingsHoldStore(config).load(root)).toBeNull();
    } finally {
      await chmod(join(root, '.studio'), 0o700).catch(() => {});
    }
  });

  it('still not undoable after the restart: the held fields come from the trusted copy until the user saves', async () => {
    const root = join(base, 'ws2');
    const config = join(base, 'config2');
    const ws = await WorkspaceStore.open(root, new Git());
    await ws.attachSettingsHold(new SettingsHoldStore(config));
    const release = await ws.guardSettings();
    // The agent replaces the file with a folder (a rename onto it fails) and leaves its values next to it.
    await rm(file(root));
    await mkdir(file(root));
    await writeFile(join(file(root), 'x'), 'x');
    expect(await release()).toEqual({ changed: true, reverted: false });
    // Restart: the hold is read back, the revert is retried and fails again.
    const ws2 = await WorkspaceStore.open(root, new Git(), { create: false });
    await ws2.attachSettingsHold(new SettingsHoldStore(config));
    expect(ws2.settingsHeld()).toBe(true);
    expect(await ws2.readSettings()).toMatchObject({ sandboxMode: 'auto', confirmPaidProviders: true });
    // The file becomes readable with the agent's values: the held fields still win, the others are read.
    await rm(file(root), { recursive: true });
    await writeFile(file(root), JSON.stringify({ schemaVersion: 1, theme: 'dark', ...agentValues }));
    expect(await ws2.readSettings()).toMatchObject({ theme: 'dark', sandboxMode: 'auto', confirmPaidProviders: true, autoApproveSandboxed: true, agentLiveInput: false, agentInterrupt: false });
    // The next guard retries the revert: it succeeds now, the hold ends.
    const r2 = await ws2.guardSettings();
    expect(ws2.settingsHeld()).toBe(false);
    expect(JSON.parse(await readFile(file(root), 'utf8'))).toMatchObject({ sandboxMode: 'auto', confirmPaidProviders: true });
    await r2();
    expect(await new SettingsHoldStore(config).load(root)).toBeNull();
  });

  it('the user saving the settings confirms them and ends the hold (also on disk)', async () => {
    const root = join(base, 'ws3');
    const config = join(base, 'config3');
    const ws = await WorkspaceStore.open(root, new Git());
    await ws.attachSettingsHold(new SettingsHoldStore(config));
    const release = await ws.guardSettings();
    await rm(file(root));
    await mkdir(file(root));
    expect(await release()).toEqual({ changed: true, reverted: false });
    await rm(file(root), { recursive: true });
    await ws.updateSettings({ theme: 'light' });
    expect(ws.settingsHeld()).toBe(false);
    expect(await new SettingsHoldStore(config).load(root)).toBeNull();
  });
});

// Fix round 2 (Ruling AA): with the sandbox off the hold is best-effort detection. It is tighten-only, it holds every
// security-relevant field, and a hold that cannot be kept is loud and refuses unsandboxed runs until the user saves.
describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('WorkspaceStore settings hold, tighten-only and loud', () => {
  const file = (root: string) => join(root, '.studio', 'settings.json');
  // The agent keeps the user's domain and adds its own: only the user's survives (the intersection).
  const evil = { sandboxMode: 'off', confirmPaidProviders: false, autoApproveSandboxed: true, agentLiveInput: true, agentInterrupt: true, extraAllowedDomains: ['ok.example.com', 'evil.example.com'], model: 'opus', maxConcurrentJobs: 8 };
  const holdDir = (config: string) => join(config, 'settings-hold');
  const holdFile = async (config: string, root: string) => join(holdDir(config), `${createHash('sha256').update(await realpath(root)).digest('hex').slice(0, 32)}.json`);
  const setup = async (name: string) => {
    const root = join(base, name);
    const config = join(base, `${name}-config`);
    const ws = await WorkspaceStore.open(root, new Git());
    await ws.attachSettingsHold(new SettingsHoldStore(config));
    await ws.updateSettings({ extraAllowedDomains: ['ok.example.com'], autoApproveSandboxed: false });
    return { root, config, ws, before: await readFile(file(root), 'utf8') };
  };
  const restart = async (root: string, config: string) => {
    const ws = await WorkspaceStore.open(root, new Git(), { create: false });
    await ws.attachSettingsHold(new SettingsHoldStore(config));
    return ws;
  };

  it('probe A: a forged hold record can never loosen anything (it is never copied into settings.json)', async () => {
    const { root, config, ws, before } = await setup('a');
    const release = await ws.guardSettings();
    await writeFile(file(root), JSON.stringify({ ...JSON.parse(before), ...evil }));
    await mkdir(holdDir(config), { recursive: true });
    await writeFile(await holdFile(config, root), JSON.stringify({ schemaVersion: 2, root: await realpath(root), held: { ...evil, extraAllowedDomains: ['ok.example.com', 'evil.example.com'] }, at: new Date().toISOString() }));
    expect(await release()).toEqual({ changed: true, reverted: true });
    const ws2 = await restart(root, config);
    expect(await ws2.readSettings()).toMatchObject({ sandboxMode: 'auto', confirmPaidProviders: true, autoApproveSandboxed: false, agentLiveInput: false, extraAllowedDomains: ['ok.example.com'] });
    expect(JSON.parse(await readFile(file(root), 'utf8'))).toMatchObject({ sandboxMode: 'auto', confirmPaidProviders: true, extraAllowedDomains: ['ok.example.com'] });
  });

  it('probe B: the hold folder made read-only is made ours again: the hold is saved and survives the restart', async () => {
    const { root, config, ws, before } = await setup('b');
    const release = await ws.guardSettings();
    await writeFile(file(root), JSON.stringify({ ...JSON.parse(before), ...evil }));
    await mkdir(holdDir(config), { recursive: true });
    await chmod(holdDir(config), 0o500);
    await chmod(join(root, '.studio'), 0o500);
    try {
      expect(await release()).toEqual({ changed: true, reverted: false });
      expect(ws.settingsHoldBroken()).toBe(false);
      await chmod(await holdFile(config, root), 0o000); // the agent hides the record: it is made readable again
      const ws2 = await restart(root, config);
      expect(await ws2.readSettings()).toMatchObject({ sandboxMode: 'auto', confirmPaidProviders: true, agentLiveInput: false, extraAllowedDomains: ['ok.example.com'], model: null, maxConcurrentJobs: 2 });
    } finally {
      await chmod(join(root, '.studio'), 0o700).catch(() => {});
      await chmod(holdDir(config), 0o700).catch(() => {});
    }
  });

  it.skipIf(process.platform !== 'darwin')('a hold that cannot be saved (folder locked) is loud: unsandboxed runs refused until the user saves, also after a restart', async () => {
    const { root, config, ws, before } = await setup('b2');
    const release = await ws.guardSettings();
    await writeFile(file(root), JSON.stringify({ ...JSON.parse(before), ...evil }));
    await mkdir(holdDir(config), { recursive: true });
    execFileSync('chflags', ['uchg', holdDir(config)]);
    execFileSync('chflags', ['uchg', file(root)]);
    try {
      expect(await release()).toEqual({ changed: true, reverted: false, holdBroken: true });
      expect(ws.settingsHoldBroken()).toBe(true);
      await expect(ws.guardSettings()).rejects.toMatchObject({ apiCode: 'settings-hold-broken', status: 409 });
      // Restart: nothing on disk, but the locked hold folder is seen: still loud, still refused.
      const ws2 = await restart(root, config);
      expect(ws2.settingsHoldBroken()).toBe(true);
      await expect(ws2.guardSettings()).rejects.toMatchObject({ apiCode: 'settings-hold-broken' });
      execFileSync('chflags', ['nouchg', holdDir(config)]);
      execFileSync('chflags', ['nouchg', file(root)]);
      await ws2.updateSettings({ sandboxMode: 'auto', confirmPaidProviders: true, agentLiveInput: false, agentInterrupt: false });
      expect(ws2.settingsHoldBroken()).toBe(false);
      await (await ws2.guardSettings())();
    } finally {
      execFileSync('chflags', ['nouchg', holdDir(config)]);
      execFileSync('chflags', ['nouchg', file(root)]);
    }
  });

  it.skipIf(process.platform !== 'darwin')('probe C: settings.json locked (uchg): every security field held (domains, model, jobs too); a save says what to do', async () => {
    const { root, config, ws, before } = await setup('c');
    const release = await ws.guardSettings();
    await writeFile(file(root), JSON.stringify({ ...JSON.parse(before), ...evil, theme: 'dark' }));
    execFileSync('chflags', ['uchg', file(root)]);
    try {
      expect(await release()).toEqual({ changed: true, reverted: false });
      const held = { sandboxMode: 'auto', confirmPaidProviders: true, autoApproveSandboxed: false, agentLiveInput: false, agentInterrupt: false, extraAllowedDomains: ['ok.example.com'], model: null, maxConcurrentJobs: 2 };
      expect(await ws.readSettings()).toMatchObject({ ...held, theme: 'dark' }); // only the cosmetic field from the file
      const ws2 = await restart(root, config);
      expect(ws2.settingsHeld()).toBe(true);
      expect(await ws2.readSettings()).toMatchObject(held);
      const err = await ws2.updateSettings({ theme: 'light' }).catch((e: unknown) => e) as { apiCode?: string; message: string };
      expect(err.apiCode).toBe('settings-not-writable');
      expect(err.message).toContain('settings.json');
      expect(err.message).not.toMatch(/EPERM/);
    } finally {
      execFileSync('chflags', ['nouchg', file(root)]);
    }
  });

  it('a save while .studio and the file were made read-only: the modes are restored and the save works', async () => {
    const { root, ws } = await setup('d');
    await chmod(file(root), 0o400);
    await chmod(join(root, '.studio'), 0o500);
    try {
      await ws.updateSettings({ theme: 'dark' });
      expect(JSON.parse(await readFile(file(root), 'utf8')).theme).toBe('dark');
    } finally { await chmod(join(root, '.studio'), 0o700).catch(() => {}); }
  });
});

// Fix round 3: with the hold unreliable and no record the defaults act as the hold (R2-1); every held or tightened field is
// named (R2-2); a user save clears whatever sits at the record path, inside the config folder only (R2-3).
describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('WorkspaceStore settings hold, fix round 3', () => {
  const file = (root: string) => join(root, '.studio', 'settings.json');
  const holdDir = (config: string) => join(config, 'settings-hold');
  const holdFile = async (config: string, root: string) => join(holdDir(config), `${createHash('sha256').update(await realpath(root)).digest('hex').slice(0, 32)}.json`);
  const evil = { sandboxMode: 'off', confirmPaidProviders: false, autoApproveSandboxed: true, agentLiveInput: true, agentInterrupt: true, extraAllowedDomains: ['ok.example.com', 'evil.example.com'], model: 'opus', maxConcurrentJobs: 8 };
  const safe = { sandboxMode: 'auto', confirmPaidProviders: true, agentLiveInput: false, agentInterrupt: false, extraAllowedDomains: [], model: null, maxConcurrentJobs: 2 };
  const setup = async (name: string) => {
    const root = join(base, name);
    const config = join(base, `${name}-config`);
    const ws = await WorkspaceStore.open(root, new Git());
    await ws.attachSettingsHold(new SettingsHoldStore(config));
    await ws.updateSettings({ extraAllowedDomains: ['ok.example.com'], autoApproveSandboxed: false, model: 'sonnet' });
    return { root, config, ws, before: await readFile(file(root), 'utf8') };
  };
  const restart = async (root: string, config: string) => {
    const ws = await WorkspaceStore.open(root, new Git(), { create: false });
    await ws.attachSettingsHold(new SettingsHoldStore(config));
    return ws;
  };

  it.skipIf(process.platform !== 'darwin')('probe D: broken with no record after a restart: the defaults hold, also for sandboxed runs, until one user save', async () => {
    const { root, config, ws, before } = await setup('d');
    const release = await ws.guardSettings();
    await writeFile(file(root), JSON.stringify({ ...JSON.parse(before), sandboxMode: 'auto', autoApproveSandboxed: true, extraAllowedDomains: ['evil.example.com'], confirmPaidProviders: false }));
    await mkdir(await holdFile(config, root), { recursive: true }); // a folder where the record goes
    execFileSync('chflags', ['uchg', file(root)]);
    try {
      expect(await release()).toEqual({ changed: true, reverted: false, holdBroken: true });
      const ws2 = await restart(root, config);
      expect(ws2.settingsHoldBroken()).toBe(true);
      // Every held field at the stricter of the defaults and the file: no agent domain, paid calls confirmed.
      expect(await ws2.readSettings()).toMatchObject({ sandboxMode: 'auto', confirmPaidProviders: true, extraAllowedDomains: [], agentLiveInput: false, model: null, maxConcurrentJobs: 2 });
      const notice = await ws2.settingsNotice();
      expect(notice).toMatchObject({ kind: 'broken' });
      expect(notice!.fields).toEqual(expect.arrayContaining(['confirmPaidProviders', 'extraAllowedDomains']));
      execFileSync('chflags', ['nouchg', file(root)]);
      // One user save: the folder at the record path is moved aside (inside the config folder), the hold ends.
      await ws2.updateSettings({ theme: 'dark' });
      expect(ws2.settingsHoldBroken()).toBe(false);
      expect(await ws2.settingsNotice()).toBeNull();
      expect((await readdir(holdDir(config))).some((n) => n.includes('.moved-'))).toBe(true);
    } finally {
      execFileSync('chflags', ['nouchg', file(root)]);
    }
  });

  it.skipIf(process.platform !== 'darwin')('probe E: a forged loose record that cannot be cleared, and a locked file: safe values and the path to remove', async () => {
    const { root, config } = await setup('e');
    await writeFile(file(root), JSON.stringify({ schemaVersion: 1, ...evil }));
    const record = await holdFile(config, root);
    await mkdir(holdDir(config), { recursive: true });
    await writeFile(record, JSON.stringify({ schemaVersion: 2, root: await realpath(root), held: evil, at: new Date().toISOString() }));
    execFileSync('chflags', ['uchg', record]);
    execFileSync('chflags', ['uchg', file(root)]);
    try {
      const ws2 = await restart(root, config);
      expect(ws2.settingsHoldBroken()).toBe(true);
      expect(await ws2.readSettings()).toMatchObject(safe);
      expect(await ws2.settingsNotice()).toMatchObject({ kind: 'broken', stuck: record });
      await expect(ws2.guardSettings()).rejects.toMatchObject({ apiCode: 'settings-hold-broken' });
    } finally {
      execFileSync('chflags', ['nouchg', record]);
      execFileSync('chflags', ['nouchg', file(root)]);
    }
  });

  it('a forged record that tightens the file is never silent: the changed fields are named until the user saves', async () => {
    const { root, config } = await setup('a');
    await mkdir(holdDir(config), { recursive: true });
    await writeFile(await holdFile(config, root), JSON.stringify({ schemaVersion: 2, root: await realpath(root), held: { ...safe, autoApproveSandboxed: false, extraAllowedDomains: ['ok.example.com'], model: 'opus' }, at: new Date().toISOString() }));
    const ws2 = await restart(root, config);
    expect(JSON.parse(await readFile(file(root), 'utf8')).model).toBeNull(); // 'sonnet' vs 'opus': the CLI default
    expect(await ws2.settingsNotice()).toEqual({ kind: 'adjusted', fields: ['model'], stuck: null });
    await ws2.updateSettings({ model: 'sonnet' });
    expect(await ws2.settingsNotice()).toBeNull();
  });

  it('a link at the record path is never followed: the hold is unreliable, and a user save removes the link only', async () => {
    const { root, config } = await setup('l');
    const outside = join(base, 'outside-target.json');
    await writeFile(outside, JSON.stringify({ schemaVersion: 2, root: 'x', held: evil, at: 'x' }));
    await mkdir(holdDir(config), { recursive: true });
    const record = await holdFile(config, root);
    await symlink(outside, record);
    const ws2 = await restart(root, config);
    expect(ws2.settingsHoldBroken()).toBe(true);
    expect(await ws2.readSettings()).toMatchObject({ confirmPaidProviders: true, extraAllowedDomains: [] }); // the defaults hold
    await ws2.updateSettings({ theme: 'light' });
    expect(ws2.settingsHoldBroken()).toBe(false);
    await expect(lstat(record)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await readFile(outside, 'utf8')).held.model).toBe('opus'); // the target is untouched
  });
});
