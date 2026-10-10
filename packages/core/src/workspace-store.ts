import { assertNotRealUserData } from './app-config.ts';
import { access, constants, mkdir, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
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
  constructor(public readonly status: 400 | 404 | 409 | 413 | 422 | 500 | 503, message: string, public readonly code?: WorkspaceProblemCode) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

/**
 * A WorkspaceError whose response also carries a stable machine-readable `code` (e.g. `link-chain`), for the UI to branch on;
 * `retryAfterSec` adds a `Retry-After` header (503).
 */
export class CodedError extends WorkspaceError {
  constructor(status: 400 | 404 | 409 | 503, message: string, public readonly apiCode: string, public readonly retryAfterSec?: number) {
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

export class WorkspaceStore {
  private readonly createLock = new KeyedMutex();
  private readonly projectLock = new KeyedMutex();
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

  /** Never rewrites the file: invalid stored domains are skipped and listed in `droppedDomains`. */
  readSettings(): Promise<WorkspaceSettingsView> {
    return readJsonFile<WorkspaceSettingsView>(this.settingsPath(), storedWorkspaceSettingsSchema);
  }

  async updateSettings(patch: Partial<Omit<WorkspaceSettings, 'schemaVersion'>>): Promise<WorkspaceSettings> {
    const { droppedDomains: _dropped, ...current } = await this.readSettings();
    const parsed = workspaceSettingsSchema.safeParse({ ...current, ...patch, schemaVersion: 1 });
    if (!parsed.success) throw new WorkspaceError(400, t().errors.invalidSettings({ fields: parsed.error.issues.map((i) => i.path.join('.')).join(', ') }));
    await writeJsonFileAtomic(this.settingsPath(), parsed.data);
    return parsed.data;
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
