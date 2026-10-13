import { appendFile, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  creativeFileSchema, versionsFileSchema,
  type Brief, type ConversationEntry, type CreativeFile, type CreativeListItem, type VersionEntry,
  issuesText,
} from '@motion-studio/shared';
import { JsonFileError, readJsonFile, writeJsonFileAtomic } from '../json-file.ts';
import { KeyedMutex } from '../keyed-mutex.ts';
import { slugify, WorkspaceError } from '../workspace-store.ts';
import { currentLocale, t } from '../i18n.ts';
import { noteCoreChange } from '../core-changes.ts';

export const CREATIVE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

const pad2 = (n: number) => String(n).padStart(2, '0');
/**
 * versions.json writes, by file, for the whole process: a turn appends its version while a render job (Task 5) records a
 * render in an earlier one, each through its own `CreativeStore`, and neither may lose the other's write.
 */
const versionsLock = new KeyedMutex();
/** conversation.jsonl appends, by file, for the whole process (same reason). */
const conversationLock = new KeyedMutex();
/** yyyy-mm-dd in the user's local time zone (a creative made at 23:30 belongs to that day). */
const localDay = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** Per-creative and create locks for the whole process, keyed by the creatives folder: every store instance of a project shares them. */
const creativeLocks = new KeyedMutex();

/** What a creative's brief `assets` held before a rename changed it. */
export interface BriefAssetChange { slug: string; before: string[] }

export class CreativeStore {
  private readonly root: string;
  private readonly lock = { run: <T>(key: string, fn: () => Promise<T>): Promise<T> => creativeLocks.run(`${this.root}\0${key}`, fn) };

  constructor(private readonly projectDir: string) { this.root = join(projectDir, 'creatives'); }

  dir(slug: string): string {
    if (!CREATIVE_SLUG_RE.test(slug)) throw new WorkspaceError(400, t().errors.invalidCreativeId({ slug }));
    return join(this.root, slug);
  }
  workDir(slug: string) { return join(this.dir(slug), 'work'); }
  outputsDir(slug: string, n: number) { return join(this.dir(slug), 'outputs', `v${n}`); }
  private file(slug: string, name: string) { return join(this.dir(slug), name); }

  async create(input: { title: string; brief: Brief }, now = new Date()): Promise<{ slug: string; creative: CreativeFile }> {
    const at = now.toISOString();
    const parsed = creativeFileSchema.safeParse({
      schemaVersion: 1, title: input.title, brief: input.brief, status: 'draft', error: null, createdAt: at, updatedAt: at, resumeFrom: null,
    });
    if (!parsed.success) throw new WorkspaceError(400, t().errors.invalidBrief({ detail: issuesText(parsed.error, currentLocale()) }));
    const creative = parsed.data;
    await mkdir(this.root, { recursive: true });
    const slug = await this.lock.run('create', async () => {
      const base = `${localDay(now)}-${slugify(creative.title)}`.slice(0, 70).replace(/-+$/, '');
      for (let n = 1; ; n++) {
        const candidate = n === 1 ? base : `${base}-${n}`;
        try {
          await mkdir(join(this.root, candidate));
          await noteCoreChange(this.root);
          return candidate;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        }
      }
    });
    await mkdir(this.workDir(slug), { recursive: true });
    await writeFile(join(this.workDir(slug), '.gitkeep'), '');
    await writeJsonFileAtomic(this.file(slug, 'creative.json'), creative);
    await writeJsonFileAtomic(this.file(slug, 'versions.json'), { schemaVersion: 1, versions: [] });
    await writeFile(this.file(slug, 'conversation.jsonl'), '');
    await noteCoreChange(this.dir(slug));
    return { slug, creative };
  }

  async list(): Promise<CreativeListItem[]> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    const items: CreativeListItem[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || !CREATIVE_SLUG_RE.test(e.name)) continue;
      try {
        const c = await readJsonFile(this.file(e.name, 'creative.json'), creativeFileSchema);
        const versions = await this.readVersions(e.name);
        const last = versions.at(-1);
        const first = last?.outputs[0];
        const cover = last && first ? `outputs/v${last.n}/${first.preview ?? first.file}` : null;
        items.push({ ok: true, slug: e.name, title: c.title, status: c.status, formats: c.brief.formats, versions: versions.length, updatedAt: c.updatedAt, cover });
      } catch (err) {
        if (err instanceof JsonFileError && err.reason === 'missing') continue;
        items.push({ ok: false, slug: e.name, error: (err as Error).message });
      }
    }
    const key = (i: CreativeListItem) => (i.ok ? i.updatedAt : '');
    return items.sort((a, b) => key(b).localeCompare(key(a)));
  }

  async get(slug: string): Promise<CreativeFile> {
    try {
      return await readJsonFile(this.file(slug, 'creative.json'), creativeFileSchema);
    } catch (err) {
      if (err instanceof JsonFileError && err.reason === 'missing') throw new WorkspaceError(404, t().errors.creativeNotFound({ slug }));
      throw err;
    }
  }

  update(slug: string, patch: Partial<Pick<CreativeFile, 'title' | 'brief' | 'status' | 'error' | 'resumeFrom' | 'linkedCodebases' | 'exportPicks'>>): Promise<CreativeFile> {
    return this.lock.run(`c:${slug}`, async () => {
      const current = await this.get(slug);
      const nowIso = new Date().toISOString();
      const updatedAt = nowIso > current.updatedAt ? nowIso : new Date(Date.parse(current.updatedAt) + 1).toISOString();
      const parsed = creativeFileSchema.safeParse({ ...current, ...patch, updatedAt });
      if (!parsed.success) throw new WorkspaceError(400, t().errors.invalidCreative({ detail: issuesText(parsed.error, currentLocale()) }));
      await writeJsonFileAtomic(this.file(slug, 'creative.json'), parsed.data);
      return parsed.data;
    });
  }

  /** The creatives whose brief lists project path `path`. Unreadable ones are left out (they cannot be opened either). */
  async briefSlugsUsing(path: string): Promise<string[]> {
    const out: string[] = [];
    for (const e of await readdir(this.root, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() || !CREATIVE_SLUG_RE.test(e.name)) continue;
      const c = await readJsonFile(this.file(e.name, 'creative.json'), creativeFileSchema).catch(() => null);
      if (c?.brief.assets.includes(path)) out.push(e.name);
    }
    return out;
  }

  /**
   * Replaces the project path `from` with `to` in every creative's brief `assets`, each creative under its own lock. A
   * creative that cannot be read is left alone (it cannot be opened either). `only` limits it to those creatives. Returns what each changed brief held before,
   * exactly, so `restoreBriefAssets` can put it back. The record of a creative is made BEFORE its write: when a write fails,
   * every creative already changed (and the failing one) is restored before the error goes on.
   */
  async renameBriefAsset(from: string, to: string, only?: readonly string[]): Promise<BriefAssetChange[]> {
    const changes: BriefAssetChange[] = [];
    try {
      for (const e of await readdir(this.root, { withFileTypes: true }).catch(() => [])) {
        if (!e.isDirectory() || !CREATIVE_SLUG_RE.test(e.name) || (only && !only.includes(e.name))) continue;
        await this.lock.run(`c:${e.name}`, async () => {
          const current = await readJsonFile(this.file(e.name, 'creative.json'), creativeFileSchema).catch(() => null);
          if (!current?.brief.assets.includes(from)) return;
          changes.push({ slug: e.name, before: [...current.brief.assets] });
          const assets = [...new Set(current.brief.assets.map((a) => (a === from ? to : a)))];
          const parsed = creativeFileSchema.safeParse({ ...current, brief: { ...current.brief, assets } });
          if (!parsed.success) throw new WorkspaceError(400, t().errors.invalidCreative({ detail: issuesText(parsed.error, currentLocale()) }));
          await writeJsonFileAtomic(this.file(e.name, 'creative.json'), parsed.data);
        });
      }
    } catch (err) {
      await this.restoreBriefAssets(changes).catch(() => { /* the journal repairs what could not be restored */ });
      throw err;
    }
    return changes;
  }

  /** Puts back the `assets` of the briefs `renameBriefAsset` changed, exactly as they were (only where they differ now). */
  async restoreBriefAssets(changes: readonly BriefAssetChange[]): Promise<void> {
    let failure: unknown = null;
    for (const c of [...changes].reverse()) {
      try {
        await this.lock.run(`c:${c.slug}`, async () => {
          const current = await readJsonFile(this.file(c.slug, 'creative.json'), creativeFileSchema);
          if (current.brief.assets.length === c.before.length && current.brief.assets.every((a, i) => a === c.before[i])) return;
          await writeJsonFileAtomic(this.file(c.slug, 'creative.json'), { ...current, brief: { ...current.brief, assets: [...c.before] } });
        });
      } catch (err) { failure ??= err; }
    }
    if (failure) throw failure;
  }

  async readVersions(slug: string): Promise<VersionEntry[]> {
    try {
      return (await readJsonFile(this.file(slug, 'versions.json'), versionsFileSchema)).versions;
    } catch (err) {
      if (err instanceof JsonFileError && err.reason === 'missing') return [];
      throw err;
    }
  }

  async nextVersionNumber(slug: string): Promise<number> {
    const versions = await this.readVersions(slug);
    return (versions.at(-1)?.n ?? 0) + 1;
  }

  appendVersion(slug: string, entry: VersionEntry): Promise<void> {
    const file = this.file(slug, 'versions.json');
    return versionsLock.run(file, async () => {
      const versions = await this.readVersions(slug);
      await writeJsonFileAtomic(file, { schemaVersion: 1, versions: [...versions, entry] });
    });
  }

  /**
   * Rewrites version `n` with `fn` (read, changed and written under the process-wide versions.json lock). Returns the new
   * entry; 404 when the version does not exist.
   */
  updateVersion(slug: string, n: number, fn: (v: VersionEntry) => VersionEntry): Promise<VersionEntry> {
    const file = this.file(slug, 'versions.json');
    return versionsLock.run(file, async () => {
      const versions = await this.readVersions(slug);
      const at = versions.findIndex((v) => v.n === n);
      if (at < 0) throw new WorkspaceError(404, t().errors.versionNNotFound({ n }));
      const next = fn(versions[at]!);
      const all = versions.map((v, i) => (i === at ? next : v));
      await writeJsonFileAtomic(file, { schemaVersion: 1, versions: all });
      return next;
    });
  }

  appendConversation(slug: string, entry: ConversationEntry): Promise<void> {
    // Process-wide per file (M7): a render job and a turn append through their own stores.
    return conversationLock.run(this.file(slug, 'conversation.jsonl'), async () => {
      const file = this.file(slug, 'conversation.jsonl');
      // Creating the log (an old or hand-made creative, or one git removed) adds an entry to the creative folder: note it
      // so the post-run tripwire does not read it as a move (FP3).
      const existed = await lstat(file).then(() => true, () => false);
      await appendFile(file, `${JSON.stringify(entry)}\n`);
      if (!existed) await noteCoreChange(this.dir(slug));
    });
  }

  async readConversation(slug: string): Promise<ConversationEntry[]> {
    const raw = await readFile(this.file(slug, 'conversation.jsonl'), 'utf8').catch(() => '');
    const out: ConversationEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as ConversationEntry;
        if (e && typeof e === 'object' && typeof e.type === 'string') out.push(e);
      } catch { /* a hand-edited or truncated line: skip it */ }
    }
    return out;
  }

  async recoverInterrupted(isActive: (slug: string) => boolean = () => false): Promise<string[]> {
    const recovered: string[] = [];
    for (const item of await this.list()) {
      if (!item.ok || item.status !== 'working' || isActive(item.slug)) continue;
      try {
        await this.update(item.slug, { status: 'interrupted', error: t().jobs.interruptedError });
        await this.appendConversation(item.slug, {
          type: 'system', at: new Date().toISOString(), level: 'error',
          text: t().jobs.interruptedNote,
        });
        recovered.push(item.slug);
      } catch (err) {
        // One broken creative must not stop the others from being recovered.
        console.warn(`Motion Studio: recovery failed for creative ${basename(this.projectDir)}/${item.slug}: ${(err as Error).message}`);
      }
    }
    return recovered;
  }
}
