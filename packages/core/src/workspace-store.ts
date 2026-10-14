import { assertNotRealUserData } from './app-config.ts';
import { randomBytes } from 'node:crypto';
import { access, chmod, constants, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { SettingsHoldStore } from './settings-hold.ts';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import {
  type WorkspaceProblemCode,
  projectFileSchema,
  storedWorkspaceSettingsSchema,
  workspaceSettingsSchema,
  type ProjectFile,
  type LinkedCodebase,
  type ProjectListItem,
  type WorkspaceSettings,
  type WorkspaceSettingsView,
} from '@motion-studio/shared';
import type { Git } from './git.ts';
import { JsonFileError, readJsonFile, writeJsonFileAtomic } from './json-file.ts';
import { KeyedMutex } from './keyed-mutex.ts';
import { noteCoreChange } from './core-changes.ts';
import { CLAUDE_MD, CONTEXT_MD, GITATTRIBUTES, GITIGNORE, PROJECT_DIRS } from './project-template.ts';
import { t } from './i18n.ts';

export class WorkspaceError extends Error {
  constructor(public readonly status: 400 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 503, message: string, public readonly code?: WorkspaceProblemCode) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

/**
 * A WorkspaceError whose response also carries a stable machine-readable `code` (e.g. `link-chain`), for the UI to branch on;
 * `retryAfterSec` adds a `Retry-After` header (503).
 */
export class CodedError extends WorkspaceError {
  /** `problems`: every translated problem behind a refusal (a draft that does not validate), sent as `problems`. */
  problems?: string[];
  constructor(status: 400 | 403 | 404 | 409 | 413 | 422 | 429 | 503, message: string, public readonly apiCode: string, public readonly retryAfterSec?: number) {
    super(status, message);
    this.name = 'CodedError';
  }
}

/** `~` and `~/…` refer to the user's home folder. */
export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

export function normalizeCodebasePath(p: string): string {
  const s = normalize(expandHome(p.trim()));
  if (!isAbsolute(s)) throw new WorkspaceError(400, t().errors.codebaseNotAbsolute({ path: p }));
  const stripped = s.replace(/\/+$/, '');
  if (!stripped) throw new WorkspaceError(400, t().errors.codebaseDiskRoot);
  if (stripped === homedir().replace(/\/+$/, '')) throw new WorkspaceError(400, t().errors.codebaseHome);
  return stripped;
}

/** Normalizes paths, trims notes (blank dropped) and dedupes by path (the first wins). Throws on invalid paths. */
export function normalizeCodebaseList(list: LinkedCodebase[]): LinkedCodebase[] {
  const seen = new Set<string>();
  const out: LinkedCodebase[] = [];
  for (const c of list) {
    const path = normalizeCodebasePath(c.path);
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ path, ...(c.note?.trim() ? { note: c.note.trim() } : {}) });
  }
  return out;
}

export const codebaseOverlapMessage = (): string => t().errors.codebaseOverlap;

const isWithin = (inner: string, outer: string) => inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);
/** The normalised path, plus its real path when it exists and differs (symlinks). */
const pathForms = async (p: string) => {
  const n = resolve(p);
  const real = await realpath(n).catch(() => null);
  return real && real !== n ? [n, real] : [n];
};

/** True when `path` is one of `protectedDirs`, an ancestor of one, or inside one (normalised and real paths compared). */
export async function codebaseOverlaps(path: string, protectedDirs: string[]): Promise<boolean> {
  const mine = await pathForms(path);
  for (const dir of protectedDirs) {
    for (const b of await pathForms(dir)) if (mine.some((a) => isWithin(a, b) || isWithin(b, a))) return true;
  }
  return false;
}

/** Refuses (400) linked folders overlapping the project or the workspace: they would hand the project to --add-dir. */
export async function assertCodebasesOutside(list: LinkedCodebase[], protectedDirs: string[]): Promise<void> {
  for (const c of list) if (await codebaseOverlaps(c.path, protectedDirs)) throw new WorkspaceError(400, codebaseOverlapMessage());
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
  return s || 'project';
}

/** What an unsandboxed agent run did to the workspace settings (final wave P9). */
export interface SettingsCheck { changed: boolean; reverted: boolean }

/** Puts back exactly `text` at `path`, through a temp file and a rename (never a half-written settings file). */
async function writeThroughAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Fix round 1 (I-A): the fields an agent could use to get more power or to spend without asking; while an undone change is
 * held, they come from the trusted copy whatever the file says.
 */
const HELD_FIELDS = ['sandboxMode', 'autoApproveSandboxed', 'confirmPaidProviders', 'agentLiveInput', 'agentInterrupt'] as const;
/** The trusted copy's settings; unreadable or absent content holds the defaults (the safe values). */
function parseHeld(raw: string | null): WorkspaceSettingsView {
  if (raw !== null) {
    try { const r = storedWorkspaceSettingsSchema.safeParse(JSON.parse(raw)); if (r.success) return r.data; } catch { /* defaults */ }
  }
  return workspaceSettingsSchema.parse({ schemaVersion: 1 });
}

export class WorkspaceStore {
  private readonly createLock = new KeyedMutex();
  private readonly projectLock = new KeyedMutex();
  /**
   * Final wave P9: `.studio/settings.json` is protected by the sandbox only; an agent run with the sandbox off can write it
   * (e.g. through `Bash(node:*)`). While such runs are going (`guardSettings`), the settings are served from the content
   * they had when the first one started, and after each one any change is undone. If undoing fails, the trusted content
   * keeps being served (no changed sandbox mode, opt-in or paid-provider field applies) until the user saves the settings.
   */
  private guarded = 0;
  private trusted: { raw: string | null; settings: WorkspaceSettingsView | null } | null = null;
  private untrusted = false;
  /** Where a hold that must survive a restart is kept (the core's config folder); absent: memory only. */
  private hold: SettingsHoldStore | null = null;
  private readonly settingsLock = new KeyedMutex();
  private constructor(public readonly root: string, private readonly git: Git) {}

  /** `create: false` (used at startup) refuses to recreate a workspace folder that disappeared. */
  static async open(root: string, git: Git, opts: { create?: boolean } = {}): Promise<WorkspaceStore> {
    assertNotRealUserData(root);
    const info = await stat(root).catch(() => null);
    if (info && !info.isDirectory()) throw new WorkspaceError(400, t().errors.pathIsFile({ path: root }), 'not-found');
    if (!info && opts.create === false) throw new WorkspaceError(404, t().errors.workspaceNotFound({ path: root }), 'not-found');
    try {
      await mkdir(join(root, '.studio'), { recursive: true });
      await access(root, constants.W_OK);
    } catch {
      throw new WorkspaceError(400, t().errors.notWritable({ path: root }), 'not-writable');
    }
    const store = new WorkspaceStore(root, git);
    const settingsPath = store.settingsPath();
    if (!(await stat(settingsPath).catch(() => null))) {
      await writeJsonFileAtomic(settingsPath, workspaceSettingsSchema.parse({ schemaVersion: 1 }));
    }
    return store;
  }

  private settingsPath() { return join(this.root, '.studio', 'settings.json'); }

  /**
   * Final wave fix round 1 (I-A): attaches the persisted hold (config folder). A hold left by an earlier run of the app (a
   * change the core could not undo) is honoured from now on, and the revert is retried at once.
   */
  async attachSettingsHold(hold: SettingsHoldStore): Promise<void> {
    this.hold = hold;
    const rec = await hold.load(this.root).catch(() => null);
    if (!rec) return;
    await this.settingsLock.run('settings', async () => {
      this.trusted = { raw: rec.raw, settings: parseHeld(rec.raw) };
      this.untrusted = true;
      await this.retryRevert();
    });
  }

  /** Whether the settings file holds a change the core could not undo, so some of its fields are not applied (doctor). */
  settingsHeld(): boolean { return this.untrusted; }

  /** Under `settingsLock`: puts the trusted content back (`.studio`'s mode restored first); on success the hold ends. */
  private async retryRevert(): Promise<boolean> {
    const want = this.trusted;
    if (!want) return false;
    const dir = join(this.root, '.studio');
    const st = await lstat(dir).catch(() => null);
    if (st?.isDirectory() && !st.isSymbolicLink() && (process.getuid === undefined || st.uid === process.getuid()) && (st.mode & 0o700) !== 0o700) {
      await chmod(dir, (st.mode & 0o777) | 0o700).catch(() => {});
    }
    try {
      const now = await readFile(this.settingsPath(), 'utf8').catch(() => null);
      if (now !== want.raw) {
        if (want.raw === null) await rm(this.settingsPath(), { force: true });
        else await writeThroughAtomic(this.settingsPath(), want.raw);
      }
    } catch { return false; }
    this.untrusted = false;
    await this.hold?.clear(this.root).catch(() => {});
    if (this.guarded === 0) this.trusted = null;
    return true;
  }

  /**
   * Never rewrites the file: invalid stored domains are skipped and listed in `droppedDomains`. During an unsandboxed run
   * the settings are those it started with; while a change could not be undone, the held fields come from the trusted copy.
   */
  async readSettings(): Promise<WorkspaceSettingsView> {
    const held = this.trusted?.settings;
    if (held && this.guarded > 0) return structuredClone(held);
    if (held && this.untrusted) {
      const file = await readJsonFile<WorkspaceSettingsView>(this.settingsPath(), storedWorkspaceSettingsSchema).catch(() => null);
      if (!file) return structuredClone(held);
      const kept = Object.fromEntries(HELD_FIELDS.map((k) => [k, held[k]]));
      return { ...file, ...kept };
    }
    return readJsonFile<WorkspaceSettingsView>(this.settingsPath(), storedWorkspaceSettingsSchema);
  }

  async updateSettings(patch: Partial<Omit<WorkspaceSettings, 'schemaVersion'>>): Promise<WorkspaceSettings> {
    return this.settingsLock.run('settings', async () => {
      const { droppedDomains: _dropped, ...current } = await this.readSettings();
      const parsed = workspaceSettingsSchema.safeParse({ ...current, ...patch, schemaVersion: 1 });
      if (!parsed.success) throw new WorkspaceError(400, t().errors.invalidSettings({ fields: parsed.error.issues.map((i) => i.path.join('.')).join(', ') }));
      await writeJsonFileAtomic(this.settingsPath(), parsed.data);
      // The user's own save: it is the trusted content from now on (and confirms it after a change that could not be
      // undone). Taken from what was written, never re-read from the file (fix round 1, M1: an agent write could land
      // between the rename and a read).
      if (this.trusted) this.trusted = { raw: `${JSON.stringify(parsed.data, null, 2)}\n`, settings: structuredClone(parsed.data) };
      if (this.untrusted) { this.untrusted = false; await this.hold?.clear(this.root).catch(() => {}); }
      if (this.guarded === 0) this.trusted = null;
      return parsed.data;
    });
  }

  /**
   * Final wave P9: call before an agent run without the sandbox; call the returned function once the run is over. It says
   * whether the settings file changed meanwhile and whether the change was undone. A change not undone earlier is retried
   * first; while it still cannot be undone, the trusted copy stays the one held.
   */
  async guardSettings(): Promise<() => Promise<SettingsCheck>> {
    await this.settingsLock.run('settings', async () => {
      if (this.untrusted) await this.retryRevert();
      if (this.guarded === 0 && !this.untrusted) {
        const raw = await readFile(this.settingsPath(), 'utf8').catch(() => null);
        this.trusted = { raw, settings: parseHeld(raw) };
      }
      this.guarded++;
    });
    let released = false;
    return () => this.settingsLock.run('settings', async (): Promise<SettingsCheck> => {
      if (released) return { changed: false, reverted: false };
      released = true;
      this.guarded--;
      const want = this.trusted;
      const now = await readFile(this.settingsPath(), 'utf8').catch(() => null);
      let out: SettingsCheck = { changed: false, reverted: false };
      if (want && now !== want.raw) {
        try {
          if (want.raw === null) await rm(this.settingsPath(), { force: true });
          else await writeThroughAtomic(this.settingsPath(), want.raw);
          out = { changed: true, reverted: true };
        } catch {
          // Not undone: the trusted copy stays in force, also after a restart (held in the config folder), until the revert
          // succeeds (retried at startup and at the next guard) or the user saves the settings.
          this.untrusted = true;
          await this.hold?.save(this.root, want.raw).catch(() => {});
          out = { changed: true, reverted: false };
        }
      }
      if (this.guarded === 0 && !this.untrusted) this.trusted = null;
      return out;
    });
  }

  projectDir(slug: string): string {
    if (!SLUG_RE.test(slug)) throw new WorkspaceError(400, t().errors.invalidProjectId({ slug }));
    return join(this.root, slug);
  }

  async listProjects(): Promise<ProjectListItem[]> {
    const entries = await readdir(this.root, { withFileTypes: true });
    const items: ProjectListItem[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || !SLUG_RE.test(e.name)) continue;
      try {
        items.push({ slug: e.name, ok: true, project: await readJsonFile(join(this.root, e.name, 'project.json'), projectFileSchema) });
      } catch (err) {
        if (err instanceof JsonFileError && err.reason === 'missing') continue;
        items.push({ slug: e.name, ok: false, error: (err as Error).message });
      }
    }
    return items.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  async getProject(slug: string): Promise<ProjectFile> {
    const dir = this.projectDir(slug);
    try {
      return await readJsonFile(join(dir, 'project.json'), projectFileSchema);
    } catch (err) {
      if (err instanceof JsonFileError && err.reason === 'missing') throw new WorkspaceError(404, t().errors.projectNotFound({ slug }));
      throw err;
    }
  }

  async createProject(input: { name: string; description?: string }): Promise<{ slug: string; project: ProjectFile }> {
    const name = input.name.trim();
    if (!name) throw new WorkspaceError(400, t().errors.projectNameRequired);
    const { slug, dir } = await this.createLock.run('create', async () => {
      const base = slugify(name);
      for (let n = 1; ; n++) {
        const candidate = n === 1 ? base : `${base}-${n}`;
        const candidateDir = join(this.root, candidate);
        try {
          await mkdir(candidateDir);
          return { slug: candidate, dir: candidateDir };
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        }
      }
    });
    const now = new Date().toISOString();
    const project: ProjectFile = { schemaVersion: 1, name, description: input.description?.trim() ?? '', createdAt: now, updatedAt: now, linkedCodebases: [] };
    try {
      for (const d of PROJECT_DIRS) {
        await mkdir(join(dir, d), { recursive: true });
        await writeFile(join(dir, d, '.gitkeep'), '');
      }
      await mkdir(join(dir, '.studio'), { recursive: true });
      await writeFile(join(dir, '.studio', 'context.md'), CONTEXT_MD);
      await writeFile(join(dir, 'CLAUDE.md'), CLAUDE_MD);
      await writeFile(join(dir, '.gitignore'), GITIGNORE);
      await writeFile(join(dir, '.gitattributes'), GITATTRIBUTES);
      await writeJsonFileAtomic(join(dir, 'project.json'), project);
      await this.git.init(dir);
      await this.git.commitAll(dir, t().jobs.createProjectCommit({ name }));
      // The new project folder and the workspace root both gained an entry: a later tripwire must not read this as a move.
      await noteCoreChange(this.root);
      await noteCoreChange(dir);
    } catch (err) {
      // Only the folder created above: never leave a half-built project behind.
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    return { slug, project };
  }

  updateProject(slug: string, patch: { name?: string; description?: string; linkedCodebases?: LinkedCodebase[] }): Promise<ProjectFile> {
    return this.projectLock.run(slug, async () => {
      const current = await this.getProject(slug);
      const linkedCodebases = patch.linkedCodebases
        ? normalizeCodebaseList(patch.linkedCodebases)
        : current.linkedCodebases;
      if (patch.linkedCodebases) await assertCodebasesOutside(linkedCodebases, [this.projectDir(slug), this.root]);
      const parsed = projectFileSchema.safeParse({ ...current, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), linkedCodebases, updatedAt: new Date().toISOString() });
      if (!parsed.success) throw new WorkspaceError(400, t().errors.invalidProject({ fields: parsed.error.issues.map((i) => i.path.join('.')).join(', ') }));
      const dir = this.projectDir(slug);
      await writeJsonFileAtomic(join(dir, 'project.json'), parsed.data);
      await this.git.commitAll(dir, t().jobs.updateProjectCommit);
      return parsed.data;
    });
  }
}
