import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  creativeFileSchema, versionsFileSchema,
  type Brief, type ConversationEntry, type CreativeFile, type CreativeListItem, type VersionEntry,
  issueText,
} from '@motion-studio/shared';
import { JsonFileError, readJsonFile, writeJsonFileAtomic } from '../json-file.ts';
import { KeyedMutex } from '../keyed-mutex.ts';
import { slugify, WorkspaceError } from '../workspace-store.ts';
import { currentLocale, t } from '../i18n.ts';

export const CREATIVE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

const pad2 = (n: number) => String(n).padStart(2, '0');
/** yyyy-mm-dd in the user's local time zone (a creative made at 23:30 belongs to that day). */
const localDay = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const issues = (e: { issues: Array<{ path: PropertyKey[]; message: string }> }) =>
  e.issues.map((i) => `${i.path.map(String).join('.')}: ${issueText(i, currentLocale())}`).join('; ');

export class CreativeStore {
  private readonly root: string;
  private readonly lock = new KeyedMutex();

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
    if (!parsed.success) throw new WorkspaceError(400, t().errors.invalidBrief({ detail: issues(parsed.error) }));
    const creative = parsed.data;
    await mkdir(this.root, { recursive: true });
    const slug = await this.lock.run('create', async () => {
      const base = `${localDay(now)}-${slugify(creative.title)}`.slice(0, 70).replace(/-+$/, '');
      for (let n = 1; ; n++) {
        const candidate = n === 1 ? base : `${base}-${n}`;
        try {
          await mkdir(join(this.root, candidate));
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

  update(slug: string, patch: Partial<Pick<CreativeFile, 'title' | 'brief' | 'status' | 'error' | 'resumeFrom' | 'linkedCodebases'>>): Promise<CreativeFile> {
    return this.lock.run(`c:${slug}`, async () => {
      const current = await this.get(slug);
      const nowIso = new Date().toISOString();
      const updatedAt = nowIso > current.updatedAt ? nowIso : new Date(Date.parse(current.updatedAt) + 1).toISOString();
      const parsed = creativeFileSchema.safeParse({ ...current, ...patch, updatedAt });
      if (!parsed.success) throw new WorkspaceError(400, t().errors.invalidCreative({ detail: issues(parsed.error) }));
      await writeJsonFileAtomic(this.file(slug, 'creative.json'), parsed.data);
      return parsed.data;
    });
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
    return this.lock.run(`v:${slug}`, async () => {
      const versions = await this.readVersions(slug);
      await writeJsonFileAtomic(this.file(slug, 'versions.json'), { schemaVersion: 1, versions: [...versions, entry] });
    });
  }

  appendConversation(slug: string, entry: ConversationEntry): Promise<void> {
    return this.lock.run(`l:${slug}`, () => appendFile(this.file(slug, 'conversation.jsonl'), `${JSON.stringify(entry)}\n`));
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
