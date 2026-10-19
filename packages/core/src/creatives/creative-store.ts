import { createHash } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { appendFile, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  activeMembers, creativeFileSchema, entriesOfVariant, hostOf, isSessionId, letterOfSlug, sisterSlug, turnEndOf, versionsFileSchema,
  type Brief, type ChatMergeCopy, type CompositionStill, type ConversationEntry, type CreativeFile, type CreativeListItem, type VariantGroup, type VariantId, type VariantListInfo, type VersionEntry,
  issuesText,
} from '@motion-studio/shared';
import { JsonFileError, readJsonFile, writeJsonFileAtomic, writeTextFileAtomic } from '../json-file.ts';
import { helperTagOf, MERGED_FILE, mergeConversations, parseConversation, PREMERGE_FILE, serializeConversation, stampEntries } from './group-conversation.ts';
import { KeyedMutex } from '../keyed-mutex.ts';
import { CodedError, slugify, WorkspaceError } from '../workspace-store.ts';
import { currentLocale, t } from '../i18n.ts';
import { noteCoreChange } from '../core-changes.ts';
import { readRegularFile, readRegularFileSync } from '../safe-read.ts';

/** A creative's folder name as the user's creation makes it (never a `~`: reserved for variant sisters, phase 15). */
export const CREATIVE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
/** The SHAPE of a variant sister's folder, `<host>~b`, `~z`, `~aa`… (decision 978): whether it is a real sister is `creativeKind`'s question. */
export const SISTER_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}~(?!a$)[a-z]{1,3}$/;
/** Whether `name` has the shape of a creative folder (a plain one or a sister's). Shape only: see `creativeKind`. */
export const isCreativeFolderShape = (name: string): boolean => CREATIVE_SLUG_RE.test(name) || SISTER_SLUG_RE.test(name);
/** Most bytes of a creative.json read to tell a real sister (the host's file). */
const CREATIVE_JSON_MAX = 4 * 1024 * 1024;

/**
 * Phase 15, ruling R2 (and its amendment): whether `group`, stored on host `hostSlug`, is well tied to its folders: member
 * `a` is the host itself and every other member's slug is exactly `sisterSlug(host, letter)`. A group that is not (a hand
 * edit) makes none of its sisters real.
 */
export function groupTiedTo(hostSlug: string, group: VariantGroup): boolean {
  return group.members.every((m) => m.slug === sisterSlug(hostSlug, m.letter));
}

/** The member of the host's group that `slug` is, when it is a real one (see `groupTiedTo`); never member a. */
/**
 * Phase 15 (spec §7, final wave M7): whether a sister member of `hostSlug`'s group is there: its folder has a readable
 * creative.json that names that host. The one rule of "mancante" for the list and the group service.
 */
export function memberPresent(hostSlug: string, sister: CreativeFile | null | undefined): boolean {
  return sister?.variantOf === hostSlug;
}

export function sisterIn(hostSlug: string, host: CreativeFile | null, slug: string): { letter: VariantId } | null {
  const g = host?.variantGroup;
  if (!g || !SISTER_SLUG_RE.test(slug) || hostOf(slug) !== hostSlug || !groupTiedTo(hostSlug, g)) return null;
  const m = g.members.find((x) => x.slug === slug && x.letter !== 'a');
  return m ? { letter: m.letter } : null;
}

const parseCreative = (r: ReturnType<typeof readRegularFileSync>): CreativeFile | null => {
  if (r.kind !== 'file') return null;
  try { return creativeFileSchema.safeParse(JSON.parse(r.data.toString('utf8'))).data ?? null; } catch { return null; }
};

/**
 * THE check of ruling R2 (amended): `slug` names a REAL variant sister of this project, that is its host folder is a real
 * folder whose creative.json reads and has a `variantGroup` listing `slug`, tied to its letter (`groupTiedTo`). A plain
 * `x~b` folder with no group is not one: sweeps, approvals, usage and the asset-rename journal ignore it, and the list
 * does not show it. Never follows a link (the host's folder and file are checked as entries).
 */
export async function isRealSister(projectDir: string, slug: string): Promise<boolean> {
  if (!SISTER_SLUG_RE.test(slug)) return false;
  const host = hostOf(slug);
  const dir = join(projectDir, 'creatives', host);
  if (!(await lstat(dir).catch(() => null))?.isDirectory()) return false;
  return sisterIn(host, parseCreative(await readRegularFile(join(dir, 'creative.json'), CREATIVE_JSON_MAX).catch(() => ({ kind: 'missing' as const }))), slug) !== null;
}

/** `isRealSister` for the synchronous callers (the approval card's explanation). The same rule, the same safe read. */
export function isRealSisterSync(projectDir: string, slug: string): boolean {
  if (!SISTER_SLUG_RE.test(slug)) return false;
  const host = hostOf(slug);
  const dir = join(projectDir, 'creatives', host);
  try {
    if (!lstatSync(dir).isDirectory()) return false;
    return sisterIn(host, parseCreative(readRegularFileSync(join(dir, 'creative.json'), CREATIVE_JSON_MAX)), slug) !== null;
  } catch { return false; }
}

/**
 * What the creative folder `slug` is (phase 15): `plain` (any creative outside a group, and every group host), `sister`
 * (`isRealSister`), `orphan` (sister-shaped, not real, but its own creative.json says `variantOf` its host: a sister whose
 * group was lost, spec §7, opened as a single creative), `none` (anything else, a hand-made `x~b` included).
 */
export async function creativeKind(projectDir: string, slug: string): Promise<'plain' | 'sister' | 'orphan' | 'none'> {
  if (CREATIVE_SLUG_RE.test(slug)) return 'plain';
  if (!SISTER_SLUG_RE.test(slug)) return 'none';
  if (await isRealSister(projectDir, slug)) return 'sister';
  const own = parseCreative(await readRegularFile(join(projectDir, 'creatives', slug, 'creative.json'), CREATIVE_JSON_MAX).catch(() => ({ kind: 'missing' as const })));
  return own?.variantOf === hostOf(slug) ? 'orphan' : 'none';
}

/**
 * Whether sweeps, approvals, usage and the rename journal treat `slug` as a creative: a plain one, a real sister, or an
 * orphan sister (its own creative.json says `variantOf` its host; decisions log 833). A sister-shaped folder without that
 * (a hand-made `x~b`) never is.
 */
export async function isAcceptedCreative(projectDir: string, slug: string): Promise<boolean> {
  return (await creativeKind(projectDir, slug)) !== 'none';
}

/** `isAcceptedCreative` for the synchronous callers (the approval card's explanation). The same rule, the same safe read. */
export function isAcceptedCreativeSync(projectDir: string, slug: string): boolean {
  if (CREATIVE_SLUG_RE.test(slug)) return true;
  if (!SISTER_SLUG_RE.test(slug)) return false;
  if (isRealSisterSync(projectDir, slug)) return true;
  try {
    return parseCreative(readRegularFileSync(join(projectDir, 'creatives', slug, 'creative.json'), CREATIVE_JSON_MAX))?.variantOf === hostOf(slug);
  } catch { return false; }
}

const pad2 = (n: number) => String(n).padStart(2, '0');
/**
 * versions.json writes, by file, for the whole process: a turn appends its version while a render job (Task 5) records a
 * render in an earlier one, each through its own `CreativeStore`, and neither may lose the other's write.
 */
const versionsLock = new KeyedMutex();
/**
 * conversation.jsonl appends and reads, for the whole process (same reason), by the HOST's log: a member of a variant group
 * and its host take the same lock, so a write never lands in a log the group's merge has just retired (decision 982).
 */
const conversationLock = new KeyedMutex();
const sha256Of = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
/** A creative.json read for the conversation routing, kept while the file is the same one (an atomic write is a new inode). */
const creativeCache = new Map<string, { ino: number; size: number; mtimeMs: number; ctimeMs: number; file: CreativeFile | null }>();

/** Where a group member's conversation lives (`CreativeStore.chatPlace`). */
interface ChatPlace { host: string; letter: VariantId; group: VariantGroup; single: boolean }
export type ChatMigration = 'migrated' | 'busy' | 'done' | 'none';
/** Test hooks of `migrateConversation`: a throw from one leaves the disk as a crash at that point would. */
export interface ChatMigrationHooks {
  afterMerged?(): Promise<void>; afterFlag?(): Promise<void>; afterAdopt?(): Promise<void>;
  /** The copies this merge took (absolute paths): the only copy files its caller commits (decision 1168). */
  copies?(files: string[]): Promise<void>;
}
/** yyyy-mm-dd in the user's local time zone (a creative made at 23:30 belongs to that day). */
const localDay = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** Per-creative and create locks for the whole process, keyed by the creatives folder: every store instance of a project shares them. */
const creativeLocks = new KeyedMutex();

/** What a creative's brief `assets` held before a rename changed it. */
export interface BriefAssetChange { slug: string; before: string[] }

/** The still a cover uses when the version has no file: the first brief format with a composition, else its first composition. */
export function coverStill(v: VersionEntry, formats: readonly string[]): CompositionStill | null {
  const comps = v.compositions ?? [];
  const c = formats.map((f) => comps.find((x) => x.format === f)).find((x) => x !== undefined) ?? comps[0];
  return c ? { n: v.n, format: c.format, hash: c.hash } : null;
}

export class CreativeStore {
  private readonly root: string;
  private readonly lock = { run: <T>(key: string, fn: () => Promise<T>): Promise<T> => creativeLocks.run(`${this.root}\0${key}`, fn) };

  constructor(private readonly projectDir: string) { this.root = join(projectDir, 'creatives'); }

  /** The creative's folder. Shape only (a sister's `~b` too); routes check the kind first (`assertOpenable`). */
  dir(slug: string): string {
    if (!isCreativeFolderShape(slug)) throw new WorkspaceError(400, t().errors.invalidCreativeId({ slug }));
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

  /**
   * Every creative of the project, one row per GROUP (phase 15, spec §2): a host row carries `variants` (members, active,
   * missing), its real sisters are not listed on their own; an orphan sister is listed as a single creative (`orphan`); a
   * sister-shaped folder that is neither (a hand-made `x~b`) is not a creative and is left out.
   */
  async list(): Promise<CreativeListItem[]> {
    return (await this.scan()).filter((r) => r.kind !== 'sister').map((r) => r.item);
  }

  /** Like `list`, with the real sisters as rows of their own (recovery at startup: each sister is a creative to recover). */
  async listAll(): Promise<CreativeListItem[]> {
    return (await this.scan()).map((r) => r.item);
  }

  private async scan(): Promise<Array<{ item: CreativeListItem; kind: 'plain' | 'sister' | 'orphan' }>> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    const read = new Map<string, { item: CreativeListItem; creative: CreativeFile | null }>();
    for (const e of entries) {
      if (!e.isDirectory() || !isCreativeFolderShape(e.name)) continue;
      try {
        const c = await readJsonFile(this.file(e.name, 'creative.json'), creativeFileSchema);
        const versions = await this.readVersions(e.name);
        const last = versions.at(-1);
        const first = last?.outputs[0];
        const cover = last && first ? `outputs/v${last.n}/${first.preview ?? first.file}` : null;
        // Reports 45/47: a version without a file (decision 974) shows a still of its composition instead.
        const still = cover === null && last ? coverStill(last, c.brief.formats) : null;
        read.set(e.name, { creative: c, item: { ok: true, slug: e.name, title: c.title, status: c.status, formats: c.brief.formats, ...(c.brief.formatLabels ? { formatLabels: c.brief.formatLabels } : {}), versions: versions.length, updatedAt: c.updatedAt, cover, ...(still ? { coverFrame: still } : {}), ...(c.archivedAt ? { archivedAt: c.archivedAt } : {}) } });
      } catch (err) {
        if (err instanceof JsonFileError && err.reason === 'missing') continue;
        read.set(e.name, { creative: null, item: { ok: false, slug: e.name, error: (err as Error).message } });
      }
    }
    const out: Array<{ item: CreativeListItem; kind: 'plain' | 'sister' | 'orphan' }> = [];
    for (const [name, r] of read) {
      if (CREATIVE_SLUG_RE.test(name)) {
        const g = r.creative?.variantGroup;
        if (r.item.ok && g && groupTiedTo(name, g)) {
          // A member whose folder has no readable creative.json naming this host is "mancante" (spec §7, `memberPresent`).
          const missing = g.members.filter((m) => m.letter !== 'a' && !memberPresent(name, read.get(m.slug)?.creative)).map((m) => m.letter);
          const variants: VariantListInfo = { count: g.members.length, active: activeMembers(g).length, missing };
          out.push({ kind: 'plain', item: { ...r.item, variants } });
        } else out.push({ kind: 'plain', item: r.item });
        continue;
      }
      // Sister-shaped: real only when its host (read above, a real folder) lists it (ruling R2, as `isRealSister`).
      const host = hostOf(name);
      if (sisterIn(host, read.get(host)?.creative ?? null, name)) { out.push({ kind: 'sister', item: r.item }); continue; }
      if (r.creative?.variantOf === host && r.item.ok) out.push({ kind: 'orphan', item: { ...r.item, orphan: true } });
    }
    const key = (i: CreativeListItem) => (i.ok ? i.updatedAt : '');
    return out.sort((a, b) => key(b.item).localeCompare(key(a.item)));
  }

  /**
   * Phase 15: 404 unless `slug` is a creative the routes open: a plain one (validated as today), a real sister, or an orphan
   * sister (spec §7: it opens as a single creative). A sister-shaped folder that is none of these is not a creative.
   */
  async assertOpenable(slug: string): Promise<void> {
    this.dir(slug);
    if (CREATIVE_SLUG_RE.test(slug)) return;
    if ((await creativeKind(this.projectDir, slug)) === 'none') throw new WorkspaceError(404, t().errors.creativeNotFound({ slug }));
  }

  /**
   * Phase 15: makes the sister folder `<host>~<letter>` with `creative` as its creative.json, like `create` does for a new
   * creative (an empty work/, versions and conversation). The folder must not exist (409). Only the variant service calls it,
   * under the host's lock, BEFORE the host's group lists the sister (until then it is no creative: `isRealSister`).
   */
  async createSister(hostSlug: string, letter: Exclude<VariantId, 'a'>, creative: CreativeFile): Promise<string> {
    const slug = sisterSlug(hostSlug, letter);
    this.dir(slug);
    const parsed = creativeFileSchema.safeParse(creative);
    if (!parsed.success) throw new WorkspaceError(400, t().errors.invalidCreative({ detail: issuesText(parsed.error, currentLocale()) }));
    await mkdir(this.root, { recursive: true });
    await this.lock.run('create', async () => {
      try {
        await mkdir(join(this.root, slug));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new CodedError(409, t().errors.variantFolderExists({ slug }), 'variant-folder-exists');
        throw e;
      }
      await noteCoreChange(this.root);
    });
    try {
      await mkdir(this.workDir(slug), { recursive: true });
      await writeFile(join(this.workDir(slug), '.gitkeep'), '');
      await writeJsonFileAtomic(this.file(slug, 'creative.json'), parsed.data);
      await writeJsonFileAtomic(this.file(slug, 'versions.json'), { schemaVersion: 1, versions: [] });
      await writeFile(this.file(slug, 'conversation.jsonl'), '');
      await noteCoreChange(this.dir(slug));
    } catch (err) {
      await this.removeSisterFolder(slug);
      throw err;
    }
    return slug;
  }

  /** Removes a sister folder this process just made (a failed `addVariants`); a link is removed as an entry, never followed. */
  async removeSisterFolder(slug: string): Promise<void> {
    if (!SISTER_SLUG_RE.test(slug)) return;
    const p = join(this.root, slug);
    const st = await lstat(p).catch(() => null);
    if (!st) return;
    await rm(p, st.isDirectory() ? { recursive: true, force: true } : { force: true });
    await noteCoreChange(this.root).catch(() => {});
  }

  async get(slug: string): Promise<CreativeFile> {
    try {
      return await readJsonFile(this.file(slug, 'creative.json'), creativeFileSchema);
    } catch (err) {
      if (err instanceof JsonFileError && err.reason === 'missing') throw new WorkspaceError(404, t().errors.creativeNotFound({ slug }));
      throw err;
    }
  }

  update(slug: string, patch: Partial<Pick<CreativeFile, 'title' | 'brief' | 'status' | 'error' | 'resumeFrom' | 'linkedCodebases' | 'exportPicks' | 'freedInstances' | 'queued' | 'stoppedSession' | 'variantGroup' | 'variantOf' | 'archivedAt' | 'variantNext'>>): Promise<CreativeFile> {
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
      // Phase 15: a real sister's brief is a creative's brief too (ruling R2).
      if (!e.isDirectory() || !(await isAcceptedCreative(this.projectDir, e.name))) continue;
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
        if (!e.isDirectory() || (only && !only.includes(e.name)) || !(await isAcceptedCreative(this.projectDir, e.name))) continue;
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

  /**
   * Appends `entry` to `slug`'s conversation. Decision 982: a member of a variant group writes into the group's one
   * conversation, stamped with its `variant` (unless the entry names one): the host's log once the group is migrated
   * (`variantGroup.chat: 'single'`), its own log until then (merged on read). Every caller keeps passing its own slug.
   */
  appendConversation(slug: string, entry: ConversationEntry): Promise<void> {
    // Process-wide per file (M7): a render job and a turn append through their own stores.
    return conversationLock.run(this.chatKey(slug), async () => {
      const place = await this.finishedPlace(slug);
      const target = place?.single ? place.host : slug;
      const file = this.file(target, 'conversation.jsonl');
      // Phase 3 of the single agent: the group's own entries (the coordinator's) carry no variant; a helper's carry its group turn.
      const tag = !entry.group && entry.groupJobId === undefined ? helperTagOf(this.projectDir, slug) : undefined;
      const withTag = tag ? { ...entry, groupJobId: tag } : entry;
      const stamped = place && withTag.variant === undefined && !withTag.group ? { ...withTag, variant: place.letter } : withTag;
      // Creating the log (an old or hand-made creative, or one git removed) adds an entry to the creative folder: note it
      // so the post-run tripwire does not read it as a move (FP3).
      const existed = await lstat(file).then(() => true, () => false);
      await appendFile(file, `${JSON.stringify(stamped)}\n`);
      if (!existed) await noteCoreChange(this.dir(target));
    });
  }

  /**
   * `slug`'s conversation. For a member of a variant group (decision 980): the group's one conversation, the same from any
   * member (the host's log once migrated, else the members' logs merged in time order, each entry stamped). `own`: only
   * this member's entries (`entriesOfVariant`): the readers that reason about one variant's turns. A sister that left its
   * group (an orphan) reads its log from before the merge first, when there is one; outside a group, `own` drops the entries
   * of other variants (a host whose group is gone keeps the merged chat).
   */
  async readConversation(slug: string, opts: { own?: boolean } = {}): Promise<ConversationEntry[]> {
    // Decision 1167: a merged group with no merge in progress is read without the group's lock (an append adds whole lines; a
    // line still being written is skipped like a truncated one, and comes with the next read).
    const quick = await this.chatPlace(slug);
    if (quick?.single && !quick.group.chatMerge) {
      const all = await this.readLog(quick.host, 'conversation.jsonl');
      return opts.own ? entriesOfVariant(all, quick.letter) : all;
    }
    return conversationLock.run(this.chatKey(slug), async () => {
      const place = await this.finishedPlace(slug);
      if (!place) {
        const all = await this.orphanLog(slug);
        // A host whose group is gone keeps the merged chat: its own readers skip the other variants' entries.
        const self = letterOfSlug(slug);
        return opts.own ? all.filter((e) => !e.group && (e.variant === undefined || e.variant === self)) : all;
      }
      if (place.single) {
        const all = await this.readLog(place.host, 'conversation.jsonl');
        return opts.own ? entriesOfVariant(all, place.letter) : all;
      }
      if (opts.own) return stampEntries(await this.readLog(slug, 'conversation.jsonl'), place.letter).filter((e) => !e.group);
      const lists = [];
      for (const m of place.group.members) lists.push({ letter: m.letter, entries: await this.readLog(m.slug, 'conversation.jsonl'), own: true });
      return mergeConversations(lists);
    });
  }

  /** Finishes a merge of `slug`'s group past its commit point, if any (decision 1169: before the group dissolves). */
  async settleChat(slug: string): Promise<void> {
    await conversationLock.run(this.chatKey(slug), () => this.finishedPlace(slug));
  }

  /**
   * Whether `slug`'s group has merge work to do (decision 1167, read without locks: the locked call decides again): an
   * unmigrated group, a merge to finish, or a member's own log found again after the merge (decision 1165).
   */
  async chatNeedsMerge(slug: string): Promise<boolean> {
    const place = await this.chatPlace(slug);
    if (!place) return false;
    if (!place.single || place.group.chatMerge) return true;
    return (await this.strayLogs(place)).length > 0;
  }

  /**
   * Decision 982: merges the conversations of `hostSlug`'s group into the host's log. Only when `idle(group)` says no member
   * has a turn running or queued ('busy' otherwise: nothing changes, readers keep merging in memory). Steps, each safe to cut
   * by a crash: (1) a copy of every log taken in (never over an earlier copy: decision 1164); (2) the merged log written to
   * `conversation.merged.jsonl`; (3) the commit point: `variantGroup.chat: 'single'` and `chatMerge` (the merged log's hash and
   * size, the copies, the logs to retire) in the host's creative.json; (4) `finishMerge`. Before (3) a crash leaves the group
   * as it was with every log whole; after it, the next read or write of the group finishes (4) first. Once merged, a member's
   * own log found again later (its folder was missing at the merge, decision 1165) is merged in the same way. Appends wait on
   * the same lock, so none lands in a retired log. The caller holds the host's creative lock. 'none': not a group's host;
   * 'done': nothing (more) to merge.
   */
  migrateConversation(hostSlug: string, idle: (group: VariantGroup) => Promise<boolean>, hooks: ChatMigrationHooks = {}): Promise<ChatMigration> {
    return conversationLock.run(this.chatKey(hostSlug), async () => {
      const place = await this.finishedPlace(hostSlug, hooks);
      if (!place || place.host !== hostSlug) return 'none';
      const sources = place.single ? [hostSlug, ...(await this.strayLogs(place))] : place.group.members.map((m) => m.slug);
      if (place.single && sources.length === 1) return 'done';
      if (!(await idle(place.group))) return 'busy';
      const lists: Array<{ letter: VariantId; entries: ConversationEntry[]; own: boolean }> = [];
      const copies: ChatMergeCopy[] = [];
      for (const slug of sources) {
        const raw = await this.readRaw(slug, 'conversation.jsonl');
        if (raw === null) continue;
        const letter = place.group.members.find((m) => m.slug === slug)!.letter;
        // Every entry of a member's own log is its own (decision 1169); only an already merged host log keeps its stamps.
        const own = !(place.single && slug === hostSlug);
        copies.push({ slug, file: await this.keepCopy(slug, raw), letter, own });
        lists.push({ letter, entries: parseConversation(raw), own });
      }
      await hooks.copies?.(copies.map((c) => this.file(c.slug, c.file)));
      const text = serializeConversation(mergeConversations(lists));
      await writeTextFileAtomic(this.file(hostSlug, MERGED_FILE), text);
      await hooks.afterMerged?.();
      const chatMerge = { sha256: sha256Of(text), size: Buffer.byteLength(text), copies, retire: copies.map((c) => c.slug).filter((x) => x !== hostSlug) };
      await this.writeChatState(hostSlug, (g) => ({ ...g, chat: 'single', chatMerge }));
      await hooks.afterFlag?.();
      await this.finishMerge({ ...place, single: true, group: { ...place.group, chat: 'single', chatMerge } }, hooks);
      return 'migrated';
    });
  }

  /** The group conversation lock of `slug`: its host's log (see `conversationLock`). */
  private chatKey(slug: string): string { return this.file(hostOf(slug), 'conversation.jsonl'); }

  /** Where `slug`'s conversation lives: null outside a group (and for a sister that is not a member of its host's group). */
  private async chatPlace(slug: string): Promise<ChatPlace | null> {
    const host = hostOf(slug);
    const hostFile = await this.cachedCreative(host);
    const g = hostFile?.variantGroup;
    if (!g || !groupTiedTo(host, g)) return null;
    const m = g.members.find((x) => x.slug === slug);
    return m ? { host, letter: m.letter, group: g, single: g.chat === 'single' } : null;
  }

  /** `chatPlace` after finishing a merge past its commit point (the caller holds the group's lock). */
  private async finishedPlace(slug: string, hooks: ChatMigrationHooks = {}): Promise<ChatPlace | null> {
    const place = await this.chatPlace(slug);
    if (!place?.group.chatMerge) return place;
    await this.finishMerge(place, hooks);
    return this.chatPlace(slug);
  }

  private async cachedCreative(slug: string): Promise<CreativeFile | null> {
    const file = this.file(slug, 'creative.json');
    const st = await lstat(file).catch(() => null);
    if (!st?.isFile()) { creativeCache.delete(file); return null; }
    const hit = creativeCache.get(file);
    if (hit && hit.ino === st.ino && hit.size === st.size && hit.mtimeMs === st.mtimeMs && hit.ctimeMs === st.ctimeMs) return hit.file;
    const parsed = await readJsonFile(file, creativeFileSchema).catch(() => null);
    if (creativeCache.size > 500) creativeCache.clear();
    creativeCache.set(file, { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, file: parsed });
    return parsed;
  }

  /**
   * Step 4 of `migrateConversation`, again after a crash, driven only by `chatMerge` (decision 1163): a
   * `conversation.merged.jsonl` is adopted only when its hash and size are the recorded ones; one that does not match (it was
   * written by someone else) is never renamed, and the merge is rebuilt from the recorded copies instead. A host log that
   * already starts with the merged content was adopted before the cut. Then every log to retire goes (its copy holds the
   * same content; a log that differs is kept under a new copy name) and `chatMerge` is cleared. Without `chatMerge` nothing
   * here reads or moves a file.
   */
  private async finishMerge(place: ChatPlace, hooks: ChatMigrationHooks = {}): Promise<void> {
    const cm = place.group.chatMerge;
    if (!cm) return;
    const hostLog = this.file(place.host, 'conversation.jsonl');
    const merged = this.file(place.host, MERGED_FILE);
    const matches = (b: Buffer | null) => b !== null && b.length >= cm.size && sha256Of(b.subarray(0, cm.size)) === cm.sha256;
    const mergedBuf = await readFile(merged).catch(() => null);
    const adopt = mergedBuf !== null && mergedBuf.length === cm.size && matches(mergedBuf);
    if (mergedBuf !== null && !adopt) {
      // Not the merge's own (decision 1169): said once and removed, never renamed onto the chat.
      console.warn(`Motion Studio: ${place.host}/${MERGED_FILE} was not the merge's own: it was removed.`);
      await rm(merged, { force: true });
      await noteCoreChange(this.dir(place.host));
    }
    if (adopt) {
      await rename(merged, hostLog);
      await noteCoreChange(this.dir(place.host));
    } else if (!matches(await readFile(hostLog).catch(() => null))) {
      // Not adopted yet and no trustworthy merged log: the same merge again, from the copies taken before the commit point.
      // As recorded (decision 1169): each copy with the letter it was merged as, whoever is a member now.
      const lists: Array<{ letter: VariantId; entries: ConversationEntry[]; own: boolean }> = [];
      for (const c of cm.copies) lists.push({ letter: c.letter, entries: parseConversation((await this.readRaw(c.slug, c.file)) ?? ''), own: c.own });
      const text = serializeConversation(mergeConversations(lists));
      if (sha256Of(text) !== cm.sha256 || Buffer.byteLength(text) !== cm.size) {
        console.warn(`Motion Studio: the merge of the chats of ${place.host} cannot be finished: its copies changed. Nothing was moved.`);
        return;
      }
      await writeTextFileAtomic(hostLog, text);
    }
    await hooks.afterAdopt?.();
    for (const slug of cm.retire) {
      // A sister that left the group meanwhile keeps its log (decision 1169: it reads it as an orphan).
      if (!place.group.members.some((m) => m.slug === slug)) continue;
      const own = this.file(slug, 'conversation.jsonl');
      const content = await readFile(own).catch(() => null);
      if (content === null) continue;
      const recorded = cm.copies.find((c) => c.slug === slug);
      const copy = recorded ? await readFile(this.file(slug, recorded.file)).catch(() => null) : null;
      if (copy !== null && copy.equals(content)) await rm(own, { force: true });
      else await rename(own, this.file(slug, await this.freeCopyName(slug)));
      await noteCoreChange(this.dir(slug));
    }
    await this.writeChatState(place.host, (g) => { const { chatMerge: _done, ...rest } = g; return rest; });
  }

  /** Member logs (not the host's) with content in a merged group: logs found again after the merge (decision 1165). */
  private async strayLogs(place: ChatPlace): Promise<string[]> {
    const out: string[] = [];
    for (const m of place.group.members) {
      if (m.slug === place.host) continue;
      const st = await lstat(this.file(m.slug, 'conversation.jsonl')).catch(() => null);
      if (st?.isFile() && st.size > 0) out.push(m.slug);
    }
    return out;
  }

  /** Writes a copy of `slug`'s log under a name no earlier copy has (decision 1164); returns the name. */
  private async keepCopy(slug: string, raw: string): Promise<string> {
    const name = await this.freeCopyName(slug);
    await writeTextFileAtomic(this.file(slug, name), raw);
    return name;
  }

  private async freeCopyName(slug: string): Promise<string> {
    if (!existsSync(this.file(slug, PREMERGE_FILE))) return PREMERGE_FILE;
    for (let i = 0; ; i++) {
      const name = `conversation.premerge-${Date.now().toString(36)}${i ? i.toString(36) : ''}.jsonl`;
      if (!existsSync(this.file(slug, name))) return name;
    }
  }

  /**
   * An orphan sister's chat: its first copy from before a merge (`conversation.premerge.jsonl`, a core file the agent cannot
   * write; later copies have other names and are not read), unless its log already starts with it, then its own log.
   */
  private async orphanLog(slug: string): Promise<ConversationEntry[]> {
    const own = (await this.readRaw(slug, 'conversation.jsonl')) ?? '';
    const before = SISTER_SLUG_RE.test(slug) ? (await this.readRaw(slug, PREMERGE_FILE)) ?? '' : '';
    return parseConversation(before && own.startsWith(before) ? own : before + own);
  }

  /** Writes the host's group merge state (`chat`, `chatMerge`). Not a user change: `updatedAt` stays. */
  private writeChatState(slug: string, fn: (g: VariantGroup) => VariantGroup): Promise<void> {
    return this.lock.run(`c:${slug}`, async () => {
      const current = await this.get(slug);
      if (!current.variantGroup) throw new WorkspaceError(409, t().jobs.conflict);
      const parsed = creativeFileSchema.parse({ ...current, variantGroup: fn(current.variantGroup) });
      await writeJsonFileAtomic(this.file(slug, 'creative.json'), parsed);
    });
  }

  private async readRaw(slug: string, name: string): Promise<string | null> {
    return readFile(this.file(slug, name), 'utf8').catch(() => null);
  }

  private async readLog(slug: string, name: string): Promise<ConversationEntry[]> {
    return parseConversation((await this.readRaw(slug, name)) ?? '');
  }

  /** The session the agent reported in the turn after the last version (the latest one), with its job; null: none. */
  async lastTurnSession(slug: string): Promise<{ sessionId: string; at: string; jobId: string } | null> {
    // A variant's own turns only (decision 982): another variant's session is never this one's.
    const entries = await this.readConversation(slug, { own: true });
    // Only the cut turn's job (the last agent job after the last version): never an earlier, failed turn's session.
    let cut: string | null = null;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      // Decision 1060: a turn that ended without a version (nothing changed) is over too.
      if (turnEndOf(e)) return null;
      if (e.type !== 'agent' || typeof e.jobId !== 'string' || !e.jobId) continue;
      cut ??= e.jobId;
      if (e.jobId !== cut) return null;
      const sid = e.event?.kind === 'session' || e.event?.kind === 'result' ? e.event.sessionId : undefined;
      if (isSessionId(sid)) return { sessionId: sid, at: new Date().toISOString(), jobId: e.jobId };
    }
    return null;
  }

  /** `remember`: where the cut turn's session goes (the core's side state, creative-side-state.ts); absent: not remembered. */
  async recoverInterrupted(isActive: (slug: string) => boolean = () => false, remember?: (slug: string, s: NonNullable<CreativeFile['stoppedSession']>) => Promise<unknown>): Promise<string[]> {
    const recovered: string[] = [];
    // Phase 15: every creative, the real and orphan sisters included (each one's turn may have been cut).
    for (const item of await this.listAll()) {
      if (!item.ok || item.status !== 'working' || isActive(item.slug)) continue;
      try {
        // Phase 13 (spec §5): the session of the turn the restart cut is remembered like a stopped one, so the next turn
        // resumes it as a fork. Only a session this turn's agent reported (after the last version) counts.
        const stopped = remember ? await this.lastTurnSession(item.slug).catch(() => null) : null;
        if (stopped) await remember!(item.slug, stopped);
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
