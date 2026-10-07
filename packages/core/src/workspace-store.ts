import { access, constants, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import {
  type WorkspaceProblemCode,
  projectFileSchema,
  workspaceSettingsSchema,
  type ProjectFile,
  type LinkedCodebase,
  type ProjectListItem,
  type WorkspaceSettings,
} from '@motion-studio/shared';
import type { Git } from './git.ts';
import { JsonFileError, readJsonFile, writeJsonFileAtomic } from './json-file.ts';
import { KeyedMutex } from './keyed-mutex.ts';
import { CLAUDE_MD, CONTEXT_MD, GITIGNORE, PROJECT_DIRS } from './project-template.ts';

export class WorkspaceError extends Error {
  constructor(public readonly status: 400 | 404 | 409 | 413 | 422, message: string, public readonly code?: WorkspaceProblemCode) {
    super(message);
    this.name = 'WorkspaceError';
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
  if (!isAbsolute(s)) throw new WorkspaceError(400, `La cartella collegata deve essere un percorso assoluto: ${p}`);
  return s.length > 1 ? s.replace(/[\\/]+$/, '') : s;
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
  return s || 'progetto';
}

export class WorkspaceStore {
  private readonly createLock = new KeyedMutex();
  private readonly projectLock = new KeyedMutex();
  private constructor(public readonly root: string, private readonly git: Git) {}

  /** `create: false` (used at startup) refuses to recreate a workspace folder that disappeared. */
  static async open(root: string, git: Git, opts: { create?: boolean } = {}): Promise<WorkspaceStore> {
    const info = await stat(root).catch(() => null);
    if (info && !info.isDirectory()) throw new WorkspaceError(400, `Il percorso ${root} è un file, non una cartella`, 'not-found');
    if (!info && opts.create === false) throw new WorkspaceError(404, `Cartella del workspace non trovata: ${root}`, 'not-found');
    try {
      await mkdir(join(root, '.studio'), { recursive: true });
      await access(root, constants.W_OK);
    } catch {
      throw new WorkspaceError(400, `Impossibile scrivere nella cartella ${root}: controlla i permessi`, 'not-writable');
    }
    const store = new WorkspaceStore(root, git);
    const settingsPath = store.settingsPath();
    if (!(await stat(settingsPath).catch(() => null))) {
      await writeJsonFileAtomic(settingsPath, workspaceSettingsSchema.parse({ schemaVersion: 1 }));
    }
    return store;
  }

  private settingsPath() { return join(this.root, '.studio', 'settings.json'); }

  readSettings(): Promise<WorkspaceSettings> {
    return readJsonFile(this.settingsPath(), workspaceSettingsSchema);
  }

  async updateSettings(patch: Partial<Omit<WorkspaceSettings, 'schemaVersion'>>): Promise<WorkspaceSettings> {
    const parsed = workspaceSettingsSchema.safeParse({ ...(await this.readSettings()), ...patch, schemaVersion: 1 });
    if (!parsed.success) throw new WorkspaceError(400, `Impostazioni non valide: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
    await writeJsonFileAtomic(this.settingsPath(), parsed.data);
    return parsed.data;
  }

  projectDir(slug: string): string {
    if (!SLUG_RE.test(slug)) throw new WorkspaceError(400, `Identificativo progetto non valido: ${slug}`);
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
      if (err instanceof JsonFileError && err.reason === 'missing') throw new WorkspaceError(404, `Progetto ${slug} non trovato`);
      throw err;
    }
  }

  async createProject(input: { name: string; description?: string }): Promise<{ slug: string; project: ProjectFile }> {
    const name = input.name.trim();
    if (!name) throw new WorkspaceError(400, 'Il nome del progetto è obbligatorio');
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
      await writeJsonFileAtomic(join(dir, 'project.json'), project);
      await this.git.init(dir);
      await this.git.commitAll(dir, `Crea progetto ${name}`);
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
        ? patch.linkedCodebases.map((c) => ({ path: normalizeCodebasePath(c.path), ...(c.note?.trim() ? { note: c.note.trim() } : {}) }))
            .filter((c, i, all) => all.findIndex((x) => x.path === c.path) === i)
        : current.linkedCodebases;
      const parsed = projectFileSchema.safeParse({ ...current, ...patch, linkedCodebases, updatedAt: new Date().toISOString() });
      if (!parsed.success) throw new WorkspaceError(400, `Progetto non valido: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
      const dir = this.projectDir(slug);
      await writeJsonFileAtomic(join(dir, 'project.json'), parsed.data);
      await this.git.commitAll(dir, 'Progetto aggiornato');
      return parsed.data;
    });
  }
}
