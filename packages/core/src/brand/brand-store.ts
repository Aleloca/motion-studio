import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BRAND_KIT_LIMITS, brandKitIssues, issuesText, brandKitSchema, brandProposalSchema, brandSourcesFileSchema, brandSourceSchema, EMPTY_BRAND_KIT,
  type BrandKit, type BrandProposal, type BrandSource,
} from '@motion-studio/shared';
import { JsonFileError, readJsonFile, writeJsonFileAtomic } from '../json-file.ts';
import { fileLock } from '../file-locks.ts';
import { CodedError, codebaseOverlaps, WorkspaceError } from '../workspace-store.ts';
import { currentLocale, t } from '../i18n.ts';
import { noteCoreChange } from '../core-changes.ts';
import { KeyedMutex } from '../keyed-mutex.ts';

/** Serializes everything that decides or rewrites a project's proposals: apply, discard, a new analysis and a rename. */
export const proposalLocks = new KeyedMutex();
export const applyLockKey = (projectDir: string) => `apply:${projectDir}`;

const PROPOSAL_RE = /^p-\d{8}-\d{6}(-\d+)?$/;

function isPrivateIPv4Octets(a: number, b: number, c: number, d: number): boolean {
  // 0.0.0.0/8 (this network)
  if (a === 0) return true;

  // 127.0.0.0/8 (loopback)
  if (a === 127) return true;

  // 10.0.0.0/8 (private)
  if (a === 10) return true;

  // 172.16.0.0/12 (private)
  if (a === 172 && b >= 16 && b <= 31) return true;

  // 192.168.0.0/16 (private)
  if (a === 192 && b === 168) return true;

  // 169.254.0.0/16 (link-local)
  if (a === 169 && b === 254) return true;

  return false;
}

function isPrivateIPv4(ipStr: string): boolean {
  const parts = ipStr.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d+$/.test(p))) return false;

  const nums = parts.map((p) => Number(p));
  return isPrivateIPv4Octets(nums[0]!, nums[1]!, nums[2]!, nums[3]!);
}

export function isPrivateHost(hostname: string): boolean {
  let h = hostname.toLowerCase();

  // Strip trailing dot
  if (h.endsWith('.')) h = h.slice(0, -1);

  // localhost variants
  if (h === 'localhost' || h.endsWith('.localhost')) return true;

  // Remove brackets for IPv6 literals
  const host = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;

  // Check if this is an IPv6 literal (contains ':')
  const isIPv6Literal = host.includes(':');

  if (isIPv6Literal) {
    // IPv6 loopback ::1 and ::
    if (host === '::1' || host === '::') return true;

    // IPv6 link-local fe80::/10 (fe80-febf::/10)
    // Match patterns like fe80::, fe81::, ..., febf::
    if (host.startsWith('fe')) {
      const firstByte = host.slice(2, 4);
      if (/^[89a-f]/.test(firstByte) && host[4] === ':') return true;
    }

    // IPv6 unique local fc00::/7 (fc00-fdff::/7)
    // Match patterns like fc00::, fd00::, etc.
    if (host.startsWith('fc:') || host.startsWith('fd:')) return true;
    if ((host.startsWith('fc') || host.startsWith('fd')) && host.length > 2) {
      const thirdChar = host[2]!;
      if (thirdChar === ':' || (thirdChar >= '0' && thirdChar <= '9') || (thirdChar >= 'a' && thirdChar <= 'f')) return true;
    }

    // IPv4-mapped IPv6: ::ffff:a.b.c.d or ::ffff:HHHH:HHHH
    if (host.startsWith('::ffff:')) {
      const ipPart = host.slice(7);
      // Check for dotted-quad form ::ffff:a.b.c.d
      if (ipPart.includes('.')) {
        return isPrivateIPv4(ipPart);
      }
      // Check for hex form ::ffff:HHHH:HHHH - convert to IPv4
      const parts = ipPart.split(':');
      if (parts.length === 2) {
        const a = parseInt(parts[0]!, 16) >> 8;
        const b = parseInt(parts[0]!, 16) & 0xff;
        const c = parseInt(parts[1]!, 16) >> 8;
        const d = parseInt(parts[1]!, 16) & 0xff;
        return isPrivateIPv4Octets(a, b, c, d);
      }
    }
    return false;
  }

  // IPv4 check (only for non-IPv6 literals)
  return isPrivateIPv4(host);
}

export class BrandStore {
  private readonly dir: string;
  private readonly projectDir: string;
  // Shared with every other instance (one per request) and with the brand jobs' guards: keys are the files' absolute paths.
  private readonly lock = { run: <T>(name: string, fn: () => Promise<T>): Promise<T> => fileLock.run(this.path(name), fn) };
  constructor(projectDir: string) { this.projectDir = projectDir; this.dir = join(projectDir, 'brand'); }

  private path(name: string) { return join(this.dir, name); }

  async readKit(): Promise<BrandKit> {
    try { return await readJsonFile(this.path('brand-kit.json'), brandKitSchema); }
    catch (e) { if (e instanceof JsonFileError && e.reason === 'missing') return EMPTY_BRAND_KIT; throw e; }
  }

  /** Replaces the kit, but refuses (JsonFileError) when the file on disk is corrupt: checked under the same lock as the write. */
  replaceReadableKit(kit: unknown): Promise<BrandKit> {
    return this.updateReadableKit(() => kit);
  }

  /** Read-modify-write of the kit under its lock; a corrupt file on disk refuses (JsonFileError). */
  updateReadableKit(updater: (current: BrandKit) => unknown): Promise<BrandKit> {
    return this.lock.run('brand-kit.json', async () => this.writeKitUnlocked(updater(await this.readKit())));
  }

  /** Whether a logo or a font of the kit uses project file `path` (a corrupt kit refuses with JsonFileError). */
  async usesFile(path: string): Promise<boolean> {
    const kit = await this.readKit();
    return kit.logos.some((l) => l.file === path) || kit.fonts.some((f) => f.file === path);
  }

  /**
   * Points the logos and fonts that use project file `from` (e.g. `assets/logo.png`) at `to`, under the kit's lock. Returns
   * whether anything changed; a corrupt kit refuses (JsonFileError) before anything is written.
   */
  renameFileRefs(from: string, to: string): Promise<boolean> {
    return this.lock.run('brand-kit.json', async () => {
      const kit = await this.readKit();
      const uses = kit.logos.some((l) => l.file === from) || kit.fonts.some((f) => f.file === from);
      if (!uses) return false;
      await this.writeKitUnlocked({
        ...kit,
        logos: kit.logos.map((l) => (l.file === from ? { ...l, file: to } : l)),
        fonts: kit.fonts.map((f) => (f.file === from ? { ...f, file: to } : f)),
      });
      return true;
    });
  }

  /**
   * Points the open proposals' logo and font changes (and their added assets) at project file `from` → `to` (M5): a proposal
   * applied after a rename must not link a file that no longer exists. Applied and discarded proposals are history and stay.
   * Idempotent; returns the ids of the proposals that changed.
   *
   * Runs under the `apply:<projectDir>` lock, the one apply, discard and a new analysis take, and re-reads each proposal inside
   * it: one that was applied or discarded meanwhile is skipped, never reopened. Lock order: the rename holds the library
   * `assets` lock, then this lock, then one proposal.json file lock at a time; apply holds this lock and then the kit and
   * proposal file locks, and nothing under this lock ever takes the `assets` lock, so there is no cycle. If a write fails,
   * the proposals already rewritten are restored before the error goes on.
   */
  renameProposalRefs(from: string, to: string): Promise<string[]> {
    return proposalLocks.run(applyLockKey(this.projectDir), () => this.renameProposalRefsUnlocked(from, to));
  }

  /**
   * The whole brand step of a rename under ONE apply lock: the kit's logo and font refs, then the open proposals' (M5). An
   * apply that holds the lock with the pre-rename proposal finishes first and writes its kit; the rename then rewrites that kit,
   * so the kit never ends up linking the old, missing name. `kit: false` skips the kit (recovery of a rename that never
   * touched it). If the proposals fail, the kit change is undone before the error goes on. Order: assets, apply, kit/proposal.
   */
  renameAllRefs(from: string, to: string, o: { kit?: boolean } = {}): Promise<{ kit: boolean; proposals: string[] }> {
    return proposalLocks.run(applyLockKey(this.projectDir), async () => {
      const kit = o.kit === false ? false : await this.renameFileRefs(from, to);
      try { return { kit, proposals: await this.renameProposalRefsUnlocked(from, to) }; }
      catch (err) { if (kit) await this.renameFileRefs(to, from).catch(() => false); throw err; }
    });
  }

  private async renameProposalRefsUnlocked(from: string, to: string): Promise<string[]> {
    const prefix = 'assets/';
    const bare = (ref: string) => (ref.startsWith(prefix) ? ref.slice(prefix.length) : ref);
    const point = (v: unknown): unknown => (v && typeof v === 'object' && (v as { file?: unknown }).file === from ? { ...(v as object), file: to } : v);
    {
      const done: BrandProposal[] = []; // the proposals as they were, in the order they were rewritten
      try {
        for (const listed of await this.listProposals()) {
          if (listed.status !== 'open') continue;
          let p: BrandProposal;
          try { p = await this.readProposal(listed.id); } catch { continue; } // unreadable now: left alone
          if (p.status !== 'open') continue;
          const changes = p.changes.map((c) => (c.field === 'logos' || c.field === 'fonts') ? { ...c, before: point(c.before), after: point(c.after) } : c);
          const assetsAdded = p.assetsAdded.map((f) => (f === bare(from) ? bare(to) : f));
          if (JSON.stringify(changes) === JSON.stringify(p.changes) && assetsAdded.every((f, i) => f === p.assetsAdded[i])) continue;
          done.push(p); // registered before the write: a write that fails half-way is restored too
          await this.writeProposal({ ...p, changes, assetsAdded });
        }
      } catch (err) {
        for (const original of done.reverse()) await this.writeProposal(original).catch(() => {});
        throw err;
      }
      return done.map((p) => p.id);
    }
  }

  writeKit(kit: unknown): Promise<BrandKit> {
    return this.lock.run('brand-kit.json', () => this.writeKitUnlocked(kit));
  }

  private async writeKitUnlocked(kit: unknown): Promise<BrandKit> {
    {
      const parsed = brandKitSchema.safeParse(kit);
      if (!parsed.success) throw new WorkspaceError(400, t().errors.invalidBrandKit({ detail: brandKitIssues(parsed.error, currentLocale()) }));
      await writeJsonFileAtomic(this.path('brand-kit.json'), parsed.data);
      fileLock.noteWrite(this.path('brand-kit.json'));
      return parsed.data;
    }
  }

  async readGuidelines(): Promise<string> {
    return readFile(this.path('guidelines.md'), 'utf8').catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return ''; throw e; });
  }

  writeGuidelines(text: string): Promise<void> {
    if (text.length > 200_000) throw new WorkspaceError(400, t().errors.guidelinesTooLong);
    return this.lock.run('guidelines.md', async () => {
      await mkdir(this.dir, { recursive: true });
      await writeFile(this.path('guidelines.md'), text);
      fileLock.noteWrite(this.path('guidelines.md'));
    });
  }

  async readSources(): Promise<BrandSource[]> {
    try { return (await readJsonFile(this.path('sources.json'), brandSourcesFileSchema)).sources; }
    catch (e) { if (e instanceof JsonFileError && e.reason === 'missing') return []; throw e; }
  }

  /**
   * Codebase sources (Phase 14) arrive already validated and normalised by the caller (resolveBrandCodebase): `path` is the
   * normalised spelling, `real` its real path. Here, under the sources lock: a folder already listed (same spelling or same
   * real path) is refused (409 `codebase-duplicate`), and so is a sixth codebase (400 `codebase-limit`).
   */
  addSource(input: { kind: 'website'; url: string } | { kind: 'image'; file: string } | { kind: 'codebase'; path: string; real: string; note?: string }): Promise<BrandSource> {
    return this.lock.run('sources.json', async () => {
      const sources = await this.readSources();
      const n = Math.max(0, ...sources.map((s) => Number(s.id.slice(2)) || 0)) + 1;

      // For website sources: parse URL and validate host before schema validation
      if (input.kind === 'website') {
        let url: URL;
        try {
          url = new URL(input.url.trim());
        } catch {
          throw new WorkspaceError(400, t().errors.invalidSourceUrl);
        }
        if (isPrivateHost(url.hostname)) throw new WorkspaceError(400, t().errors.privateSourceUrl);
      }

      if (input.kind === 'codebase') {
        const listed = sources.filter((x) => x.kind === 'codebase' && x.path !== undefined);
        for (const x of listed) {
          const real = await realpath(x.path!).catch(() => x.path!);
          if (x.path === input.path || real === input.real || x.path === input.real) throw new CodedError(409, t().errors.codebaseSourceDuplicate({ path: input.path }), 'codebase-duplicate');
        }
        // Nested or around another codebase source (fix round 1): one would hand the other's files twice, with other rules.
        if (await codebaseOverlaps(input.real, listed.map((x) => x.path!))) throw new CodedError(400, t().errors.codebaseNestedBrand, 'codebase-nested');
        if (listed.length >= BRAND_KIT_LIMITS.codebaseSources) throw new CodedError(400, t().errors.codebaseSourceLimit({ max: BRAND_KIT_LIMITS.codebaseSources }), 'codebase-limit');
      }
      const note = input.kind === 'codebase' ? input.note?.trim() : undefined;
      const parsed = brandSourceSchema.safeParse({
        id: `s-${n}`, kind: input.kind, url: input.kind === 'website' ? input.url.trim() : null,
        file: input.kind === 'image' ? input.file : null, addedAt: new Date().toISOString(), lastAnalyzedAt: null,
        ...(input.kind === 'codebase' ? { path: input.path, ...(note ? { note } : {}) } : {}),
      });
      if (!parsed.success) throw new WorkspaceError(400, t().errors.invalidSource({ detail: issuesText(parsed.error, currentLocale()) }));
      const s = parsed.data;
      if (sources.some((x) => (s.url && x.url === s.url) || (s.file && x.file === s.file))) throw new WorkspaceError(409, t().errors.sourceExists);
      await this.writeSourcesUnlocked({ schemaVersion: 1, sources: [...sources, s] });
      return s;
    });
  }

  removeSource(id: string): Promise<void> {
    return this.lock.run('sources.json', async () => {
      const sources = await this.readSources();
      if (!sources.some((s) => s.id === id)) throw new WorkspaceError(404, t().errors.sourceNotFound({ id }));
      await this.writeSourcesUnlocked({ schemaVersion: 1, sources: sources.filter((s) => s.id !== id) });
    });
  }

  /**
   * Keeps image sources in step with the references (`references/<file>` paths): drops the image sources in `drop`,
   * adds one for each file in `add` that has none. Returns whether sources.json changed.
   */
  syncImageSources(add: string[], drop: string[]): Promise<boolean> {
    return this.lock.run('sources.json', async () => {
      const sources = await this.readSources();
      const kept = sources.filter((s) => s.kind !== 'image' || s.file === null || !drop.includes(s.file));
      let n = Math.max(0, ...sources.map((s) => Number(s.id.slice(2)) || 0));
      const added: BrandSource[] = [];
      for (const file of add) {
        if (drop.includes(file) || [...kept, ...added].some((s) => s.file === file)) continue;
        const parsed = brandSourceSchema.safeParse({ id: `s-${++n}`, kind: 'image', url: null, file, addedAt: new Date().toISOString(), lastAnalyzedAt: null });
        if (parsed.success) added.push(parsed.data);
      }
      if (kept.length === sources.length && added.length === 0) return false;
      await this.writeSourcesUnlocked({ schemaVersion: 1, sources: [...kept, ...added] });
      return true;
    });
  }

  /** Drops the image source pointing at `file` (e.g. `references/x.png`), if any. Returns whether one was removed. */
  removeImageSource(file: string): Promise<boolean> {
    return this.lock.run('sources.json', async () => {
      const sources = await this.readSources();
      const kept = sources.filter((s) => !(s.kind === 'image' && s.file === file));
      if (kept.length === sources.length) return false;
      await this.writeSourcesUnlocked({ schemaVersion: 1, sources: kept });
      return true;
    });
  }

  markAnalyzed(ids: string[], at: string): Promise<void> {
    return this.lock.run('sources.json', async () => {
      const sources = await this.readSources();
      await this.writeSourcesUnlocked({ schemaVersion: 1, sources: sources.map((s) => (ids.includes(s.id) ? { ...s, lastAnalyzedAt: at } : s)) });
    });
  }

  private async writeSourcesUnlocked(data: { schemaVersion: 1; sources: BrandSource[] }): Promise<void> {
    await writeJsonFileAtomic(this.path('sources.json'), data);
    fileLock.noteWrite(this.path('sources.json'));
  }

  newProposalId(now = new Date()): Promise<string> {
    return this.lock.run('proposals', async () => {
      const pad = (n: number) => String(n).padStart(2, '0');
      const base = `p-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      await mkdir(join(this.dir, 'proposals'), { recursive: true });
      for (let i = 1; ; i++) {
        const id = i === 1 ? base : `${base}-${i}`;
        try { await mkdir(join(this.dir, 'proposals', id)); await noteCoreChange(join(this.dir, 'proposals')); return id; }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      }
    });
  }

  proposalDir(id: string): string {
    if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(id)) throw new WorkspaceError(400, t().errors.invalidProposalId({ id }));
    return join(this.dir, 'proposals', id);
  }

  async readProposal(id: string): Promise<BrandProposal> {
    try { return await readJsonFile(join(this.proposalDir(id), 'proposal.json'), brandProposalSchema); }
    catch (e) { if (e instanceof JsonFileError && e.reason === 'missing') throw new WorkspaceError(404, t().errors.proposalNotFound({ id })); throw e; }
  }

  writeProposal(p: BrandProposal): Promise<void> {
    const parsed = brandProposalSchema.safeParse(p);
    if (!parsed.success) return Promise.reject(new Error(t().errors.proposalInvalid({ detail: issuesText(parsed.error, currentLocale()) })));
    return fileLock.run(join(this.proposalDir(p.id), 'proposal.json'), () => writeJsonFileAtomic(join(this.proposalDir(p.id), 'proposal.json'), parsed.data));
  }

  async listProposals(): Promise<BrandProposal[]> {
    const entries = await readdir(join(this.dir, 'proposals'), { withFileTypes: true }).catch(() => []);
    const out: BrandProposal[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || !PROPOSAL_RE.test(e.name)) continue;
      try { out.push(await this.readProposal(e.name)); } catch { /* in progress or unreadable */ }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
