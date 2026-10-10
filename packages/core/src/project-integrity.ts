import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readdir, readFile, readlink, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { t } from './i18n.ts';
import { KeyedMutex } from './keyed-mutex.ts';

/**
 * Integrity of the project files that run or configure something OUTSIDE the sandbox (decisions log 141): git's config,
 * layout and hooks, the attributes that drive filters, the agent's own configuration (`.claude/**`, `.mcp.json`,
 * `CLAUDE*.md`) and the project's permissions (`.studio/permissions.json`). The core never writes them during a run except
 * through its own writers, which note what they wrote (`noteCoreFile`). A snapshot maps each present path to its content
 * hash or kind; comparing two snapshots sees changed, removed AND added paths (a new `.claude/settings.json`, a new
 * `.git/commondir`).
 *
 * `IntegrityStore` keeps, per project and in the app config folder (out of the agent's reach): the last snapshot a run
 * ended with cleanly ("last good"), and the quarantine record when a tamper was found. A quarantined project gets no agent
 * launch and no git until its files match the recorded snapshot again; then it clears by itself.
 */

/** rel path → `f:<sha256>` (regular file), `l:<target>` (symlink), `d` (folder in place of a file) or `o` (anything else). */
export type IntegritySnapshot = Record<string, string>;

/** Single files: their absence is recorded by omission. */
const STATIC_FILES = [
  'CLAUDE.md', 'CLAUDE.local.md', '.mcp.json', '.gitattributes',
  '.git/config', '.git/HEAD', '.git/info/attributes', '.git/commondir', '.git/config.worktree',
  '.studio/permissions.json',
];
/** Whole trees, walked without following links. */
const STATIC_TREES = ['.git/hooks', '.claude'];
/** Folders whose own kind matters: a `.git` file (`gitdir:`) or a `.claude`/`.studio` link is recorded. */
const STATIC_ROOTS = ['.git', '.claude', '.studio'];

const isMissing = (e: unknown) => { const c = (e as NodeJS.ErrnoException).code; return c === 'ENOENT' || c === 'ENOTDIR'; };
type Lstat = Awaited<ReturnType<typeof lstat>>;
async function lstatOrNull(p: string): Promise<Lstat | null> {
  try { return await lstat(p); } catch (e) { if (isMissing(e)) return null; throw e; }
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
export const sha256Text = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

async function describe(p: string, st: Lstat): Promise<string> {
  if (st.isFile()) return `f:${await sha256File(p)}`;
  if (st.isSymbolicLink()) return `l:${await readlink(p)}`;
  return st.isDirectory() ? 'd' : 'o';
}

/**
 * Snapshot of the protected files of `projectDir`, re-enumerated on every call. Throws on any read error other than a
 * missing entry (the callers fail closed). Paths under a root that is not a real folder are not followed: the root's own
 * kind is recorded instead.
 */
export async function snapshotProtected(projectDir: string): Promise<IntegritySnapshot> {
  const out: IntegritySnapshot = {};
  const realRoots = new Set<string>();
  for (const r of STATIC_ROOTS) {
    const st = await lstatOrNull(join(projectDir, r));
    if (st === null) continue;
    if (st.isDirectory()) realRoots.add(r);
    else out[r] = await describe(join(projectDir, r), st);
  }
  const reachable = (rel: string) => { const root = rel.split('/')[0]!; return !STATIC_ROOTS.includes(root) || realRoots.has(root); };
  for (const rel of STATIC_FILES) {
    if (!reachable(rel)) continue;
    // `.git/info` must itself be a real folder for `.git/info/attributes` to be read.
    if (rel === '.git/info/attributes') {
      const info = await lstatOrNull(join(projectDir, '.git', 'info'));
      if (info === null) continue;
      if (!info.isDirectory()) { out['.git/info'] = await describe(join(projectDir, '.git', 'info'), info); continue; }
    }
    const p = join(projectDir, ...rel.split('/'));
    const st = await lstatOrNull(p);
    if (st !== null) out[rel] = await describe(p, st);
  }
  for (const tree of STATIC_TREES) {
    if (!reachable(tree)) continue;
    const top = join(projectDir, ...tree.split('/'));
    const st = await lstatOrNull(top);
    if (st === null) continue;
    if (!st.isDirectory()) { out[tree] = await describe(top, st); continue; }
    const walk = async (d: string): Promise<void> => {
      let names: string[];
      try { names = await readdir(d); } catch (e) { if (isMissing(e)) return; throw e; }
      for (const n of names.sort()) {
        const p = join(d, n);
        const s = await lstatOrNull(p);
        if (s === null) continue;
        if (s.isDirectory()) await walk(p);
        else out[relative(projectDir, p).split(sep).join('/')] = await describe(p, s);
      }
    };
    await walk(top);
  }
  return out;
}

/** Core writes of protected files, by absolute path: the value the core itself left there (in memory, this process). */
const coreWrites = new Map<string, string>();

/** Paths (relative to `projectDir`) that differ between `base` and `current`, added and removed ones included, leaving out the core's own last write. */
export function snapshotDiff(projectDir: string, base: IntegritySnapshot, current: IntegritySnapshot): string[] {
  const out: string[] = [];
  for (const rel of new Set([...Object.keys(base), ...Object.keys(current)])) {
    if (base[rel] === current[rel]) continue;
    const core = coreWrites.get(resolve(projectDir, rel));
    if (core !== undefined && core === current[rel]) continue;
    out.push(rel);
  }
  return out.sort();
}

/** The project a protected file belongs to, for the files the core writes itself (permissions, attributes). */
function ownerProject(file: string): string | null {
  for (const rel of ['.studio/permissions.json', '.gitattributes']) {
    const suffix = `${sep}${rel.split('/').join(sep)}`;
    if (file.endsWith(suffix)) return file.slice(0, -suffix.length);
  }
  return null;
}

/**
 * Call right after the core wrote `file` with `content` (awaited): a later comparison accepts exactly that content, and
 * the project's stored "last good" snapshot follows it (so a core write between runs, or before a restart, is not taken
 * for a tamper). Called by `writeJsonFileAtomic` for every JSON record and by the `.gitattributes` maintenance.
 */
export async function noteCoreFile(file: string, content: string | Buffer): Promise<void> {
  const abs = resolve(file);
  const value = `f:${sha256Text(content)}`;
  coreWrites.set(abs, value);
  // Both spellings: a workspace reached through a link is compared under the launcher's own spelling.
  const real = await realpath(dirname(abs)).then((d) => join(d, basename(abs)), () => null);
  if (real !== null) coreWrites.set(real, value);
  const project = ownerProject(abs);
  if (project !== null && activeStore !== null) {
    await activeStore.noteCoreWrite(project, relative(project, abs).split(sep).join('/'), value).catch(() => { /* best effort: the in-memory note covers this process */ });
  }
}

export class ProjectQuarantinedError extends Error {
  constructor(message: string, readonly files: string[]) {
    super(message);
    this.name = 'ProjectQuarantinedError';
  }
}

export type QuarantineReason = 'tampered' | 'check-failed' | 'between-runs';
interface IntegrityRecord {
  schemaVersion: 1;
  projectDir: string;
  lastGood?: IntegritySnapshot;
  quarantine?: { at: string; reason: QuarantineReason; files: string[]; expected: IntegritySnapshot };
}

const isSnapshot = (x: unknown): x is IntegritySnapshot => typeof x === 'object' && x !== null && !Array.isArray(x) && Object.values(x).every((v) => typeof v === 'string');
function parseRecord(text: string): IntegrityRecord {
  const r = JSON.parse(text) as IntegrityRecord;
  if (r?.schemaVersion !== 1 || typeof r.projectDir !== 'string') throw new Error('invalid integrity record');
  if (r.lastGood !== undefined && !isSnapshot(r.lastGood)) throw new Error('invalid integrity record');
  if (r.quarantine !== undefined && (!isSnapshot(r.quarantine.expected) || !Array.isArray(r.quarantine.files))) throw new Error('invalid integrity record');
  return r;
}

/** Where Git (which has no config folder of its own) finds the store; set by the launcher. Null: memory only. */
let activeStore: IntegrityStore | null = null;
export function activeIntegrityStore(): IntegrityStore { return activeStore ?? (activeStore = new IntegrityStore(null)); }

/** Per-project integrity records under `<configDir>/integrity/` (null: memory only, for tests and tools). */
export class IntegrityStore {
  private readonly lock = new KeyedMutex();
  private readonly memory = new Map<string, IntegrityRecord>();
  constructor(private readonly configDir: string | null) {}

  /** Makes this the store Git consults before every operation. */
  activate(): this { activeStore = this; return this; }

  private async key(projectDir: string): Promise<string> { return realpath(projectDir).catch(() => resolve(projectDir)); }
  private file(key: string): string | null {
    return this.configDir === null ? null : join(this.configDir, 'integrity', `${sha256Text(key).slice(0, 32)}.json`);
  }

  /** The record, or an empty one. An unreadable or corrupt record throws (callers treat it as quarantined). */
  private async load(key: string): Promise<IntegrityRecord> {
    const mem = this.memory.get(key);
    if (mem) return mem;
    const file = this.file(key);
    let rec: IntegrityRecord = { schemaVersion: 1, projectDir: key };
    if (file !== null) {
      try { rec = parseRecord(await readFile(file, 'utf8')); } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
    this.memory.set(key, rec);
    return rec;
  }

  private async save(key: string, rec: IntegrityRecord): Promise<void> {
    this.memory.set(key, rec);
    const file = this.file(key);
    if (file === null) return;
    await mkdir(join(this.configDir!, 'integrity'), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
      await rename(tmp, file);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }

  private update(projectDir: string, fn: (rec: IntegrityRecord) => IntegrityRecord | null): Promise<void> {
    return this.key(projectDir).then((key) => this.lock.run(key, async () => {
      const next = fn(await this.load(key));
      if (next) await this.save(key, next);
    }));
  }

  /** Quarantines the project: no launch and no git until its protected files match `expected` again. */
  quarantine(projectDir: string, reason: QuarantineReason, files: string[], expected: IntegritySnapshot): Promise<void> {
    return this.update(projectDir, (r) => ({ ...r, quarantine: { at: new Date().toISOString(), reason, files, expected } })).catch(async () => {
      // The disk write failed: the memory record still blocks this process.
      const key = await this.key(projectDir);
      const r = this.memory.get(key) ?? { schemaVersion: 1 as const, projectDir: key };
      this.memory.set(key, { ...r, quarantine: { at: new Date().toISOString(), reason, files, expected } });
    });
  }

  /** The snapshot the last clean run ended with, or null when none is known yet (a new project, or before this feature). */
  async lastGood(projectDir: string): Promise<IntegritySnapshot | null> {
    const key = await this.key(projectDir);
    return this.lock.run(key, async () => (await this.load(key)).lastGood ?? null);
  }

  setLastGood(projectDir: string, snap: IntegritySnapshot): Promise<void> {
    return this.update(projectDir, (r) => (r.quarantine ? null : { ...r, lastGood: snap }));
  }

  /** A core write of a protected file: the stored "last good" (and a quarantine's expected state) follows it. */
  noteCoreWrite(projectDir: string, rel: string, value: string): Promise<void> {
    return this.update(projectDir, (r) => {
      if (!r.lastGood && !r.quarantine) return null;
      const next: IntegrityRecord = { ...r };
      if (r.lastGood) next.lastGood = { ...r.lastGood, [rel]: value };
      return next;
    });
  }

  /**
   * Throws `ProjectQuarantinedError` while the project is quarantined. Clears the quarantine by itself once the protected
   * files match the recorded state again (the user restored them). Fails closed: an unreadable record or snapshot blocks.
   */
  async assertUsable(projectDir: string): Promise<void> {
    const key = await this.key(projectDir);
    await this.lock.run(key, async () => {
      let rec: IntegrityRecord;
      try { rec = await this.load(key); } catch {
        throw new ProjectQuarantinedError(t().errors.projectQuarantined({ list: t().errors.integrityRecordUnreadable }), []);
      }
      if (!rec.quarantine) return;
      let current: IntegritySnapshot;
      try { current = await snapshotProtected(projectDir); } catch {
        throw new ProjectQuarantinedError(t().errors.projectQuarantined({ list: rec.quarantine.files.join(', ') }), rec.quarantine.files);
      }
      const still = snapshotDiff(projectDir, rec.quarantine.expected, current);
      if (still.length === 0) {
        await this.save(key, { schemaVersion: 1, projectDir: key, lastGood: current });
        return;
      }
      const shown = still.slice(0, 5).join(', ') + (still.length > 5 ? ', …' : '');
      throw new ProjectQuarantinedError(t().errors.projectQuarantined({ list: shown }), still);
    });
  }

  /** True while a quarantine record exists (no re-check). */
  async isQuarantined(projectDir: string): Promise<boolean> {
    const key = await this.key(projectDir);
    try { return Boolean((await this.load(key)).quarantine); } catch { return true; }
  }
}

export function resetIntegrityForTests(): void { coreWrites.clear(); activeStore = null; }
