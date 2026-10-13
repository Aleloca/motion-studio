import { link, lstat, mkdir, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import {
  assetKindOf, assetsFileSchema, referencesFileSchema, relativeFileSchema,
  type AssetEntry, type AssetOrigin, type ReferenceEntry,
} from '@motion-studio/shared';
import { JsonFileError, readJsonFile, writeJsonFileAtomic } from '../json-file.ts';
import { readAssetMeta, needsMeta } from './asset-meta.ts';
import { isRealDirChain, realDirChain } from '../creatives/core-files.ts';
import { BrandStore } from '../brand/brand-store.ts';
import { CreativeStore } from '../creatives/creative-store.ts';
import { sanitizeFileName } from './upload.ts';
import { readRenameJournal, removeRenameJournal, writeRenameJournal } from './rename-journal.ts';
import { fileLock } from '../file-locks.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { WorkspaceError } from '../workspace-store.ts';
import { t } from '../i18n.ts';

/** The steps of a rename, in order. */
export type RenameStep = 'journal' | 'file' | 'assets' | 'brand' | 'briefs';
/** Thrown by a test seam to stand for the process dying: nothing is undone and the journal stays. */
export class RenameInterrupted extends Error {}
export interface RenameOptions { /** Called after each step (a test seam: throw `RenameInterrupted` to simulate a crash). */ afterStep?(step: RenameStep): void | Promise<void> }

export type LibraryKind = 'assets' | 'references';
const now = () => new Date().toISOString();

/** Name of a library's metadata file; it is reserved (also in other letter cases: macOS volumes ignore case). */
export const metadataFileOf = (kind: LibraryKind) => (kind === 'assets' ? 'assets.json' : 'references.json');
export const isReservedName = (kind: LibraryKind, file: string) => file.toLowerCase() === metadataFileOf(kind);

export class LibraryStore {
  // Shared with every other instance (one per request) and with the brand jobs' guards: keys are the metadata files' absolute paths.
  private readonly lock = { run: <T>(kind: LibraryKind, fn: () => Promise<T>): Promise<T> => fileLock.run(this.metadataPath(kind), fn) };
  constructor(private readonly projectDir: string, private readonly media: MediaTools) {}

  dir(kind: LibraryKind) { return join(this.projectDir, kind); }
  metadataPath(kind: LibraryKind) { return join(this.dir(kind), metadataFileOf(kind)); }

  resolve(kind: LibraryKind, file: string): string {
    if (!relativeFileSchema.safeParse(file).success) throw new WorkspaceError(400, t().errors.invalidPath({ file }));
    if (isReservedName(kind, file)) throw new WorkspaceError(400, t().errors.reservedFile({ file }));
    return join(this.dir(kind), ...file.split('/'));
  }

  /** Absolute path of an existing regular file confined to the library folder (symlinks out of it refused). */
  existingFile(kind: LibraryKind, file: string): Promise<string> { return this.mustBeFile(kind, file); }

  private async mustBeFile(kind: LibraryKind, file: string): Promise<string> {
    const abs = this.resolve(kind, file);
    const info = await lstat(abs).catch(() => null);
    if (!info?.isFile()) throw new WorkspaceError(400, t().errors.fileNotValid({ kind, file }));

    // Confine: check that the real path is inside the library directory
    const libDir = this.dir(kind);
    const realAbs = await realpath(abs).catch(() => null);
    const realLib = await realpath(libDir).catch(() => libDir);
    if (!realAbs) throw new WorkspaceError(400, t().errors.fileInaccessible({ kind, file }));
    if (!realAbs.startsWith(realLib + sep) && realAbs !== realLib) {
      throw new WorkspaceError(400, t().errors.fileOutsideFolder({ kind, file }));
    }

    return abs;
  }

  async listAssets(): Promise<AssetEntry[]> {
    try { return (await readJsonFile(join(this.dir('assets'), 'assets.json'), assetsFileSchema)).assets; }
    catch (e) { if (e instanceof JsonFileError && e.reason === 'missing') return []; throw e; }
  }

  async listReferences(): Promise<ReferenceEntry[]> {
    try { return (await readJsonFile(join(this.dir('references'), 'references.json'), referencesFileSchema)).references; }
    catch (e) { if (e instanceof JsonFileError && e.reason === 'missing') return []; throw e; }
  }

  /** The agent can replace the library folder with a link: metadata is only written into a real folder inside the project. */
  private async assertMetadataDir(kind: LibraryKind): Promise<void> {
    const dir = this.dir(kind);
    let info = await lstat(dir).catch(() => null);
    if (!info) { await mkdir(dir, { recursive: true }); info = await lstat(dir).catch(() => null); }
    const [real, realProject] = await Promise.all([realpath(dir).catch(() => null), realpath(this.projectDir).catch(() => null)]);
    if (!info || info.isSymbolicLink() || !info.isDirectory() || !real || !realProject || !real.startsWith(realProject + sep)) {
      throw new WorkspaceError(400, t().errors.folderInvalid({ kind }));
    }
  }

  private async writeAssets(assets: AssetEntry[]): Promise<void> {
    const data = { schemaVersion: 1, assets };
    const parsed = assetsFileSchema.safeParse(data);
    if (!parsed.success) throw new WorkspaceError(400, t().errors.assetsMetaInvalid);
    await this.assertMetadataDir('assets');
    await writeJsonFileAtomic(this.metadataPath('assets'), parsed.data);
    fileLock.noteWrite(this.metadataPath('assets'));
  }

  private async writeReferences(references: ReferenceEntry[]): Promise<void> {
    const data = { schemaVersion: 1, references };
    const parsed = referencesFileSchema.safeParse(data);
    if (!parsed.success) throw new WorkspaceError(400, t().errors.referencesMetaInvalid);
    await this.assertMetadataDir('references');
    await writeJsonFileAtomic(this.metadataPath('references'), parsed.data);
    fileLock.noteWrite(this.metadataPath('references'));
  }

  registerAssets(items: Array<{ file: string; origin: AssetOrigin; sourceUrl?: string | null; description?: string; tags?: string[]; attribution?: string | null; bytes?: number; provider?: string; model?: string; loop?: boolean }>): Promise<AssetEntry[]> {
    return this.lock.run('assets', async () => {
      const assets = await this.listAssets();
      const out: AssetEntry[] = [];
      for (const item of items) {
        const abs = await this.mustBeFile('assets', item.file);
        const kind = assetKindOf(item.file);
        // Metadata read once, here: size on disk, picture size, duration (SVG by a text scan, never ffprobe).
        const meta = await readAssetMeta({ media: this.media }, abs, kind);
        const existing = assets.find((a) => a.file === item.file);
        const entry: AssetEntry = {
          file: item.file, kind, origin: item.origin, sourceUrl: item.sourceUrl ?? existing?.sourceUrl ?? null,
          description: item.description || existing?.description || '', tags: item.tags?.length ? item.tags : existing?.tags ?? [],
          width: meta.width ?? existing?.width ?? null, height: meta.height ?? existing?.height ?? null,
          durationSec: meta.durationSec ?? existing?.durationSec ?? null, bytes: item.bytes ?? meta.bytes,
          addedAt: existing?.addedAt ?? now(), attribution: item.attribution ?? existing?.attribution ?? null,
          ...((item.provider ?? existing?.provider) ? { provider: (item.provider ?? existing?.provider)! } : {}), ...((item.model ?? existing?.model) ? { model: (item.model ?? existing?.model)! } : {}),
          ...((item.loop ?? existing?.loop) !== undefined ? { loop: (item.loop ?? existing?.loop)! } : {}),
        };
        if (existing) assets[assets.indexOf(existing)] = entry; else assets.push(entry);
        out.push(entry);
      }
      await this.writeAssets(assets);
      return out;
    });
  }

  /**
   * Entries registered before the metadata existed get it once: size, duration, picture size (stored, so it is never read
   * again). A file that is gone is left as it is. Returns the entries after the fill and whether any changed.
   */
  fillMissingMeta(): Promise<{ assets: AssetEntry[]; changed: boolean }> {
    return this.lock.run('assets', async () => {
      const assets = await this.listAssets();
      if (!assets.some(needsMeta)) return { assets, changed: false };
      let changed = false;
      const next: AssetEntry[] = [];
      for (const a of assets) {
        if (!needsMeta(a)) { next.push(a); continue; }
        const abs = await this.mustBeFile('assets', a.file).catch(() => null);
        // Without ffmpeg a picture or a clip cannot be measured yet: left for a later listing instead of recorded as empty.
        if (!abs || (!this.media.available && (a.kind === 'image' || a.kind === 'video' || a.kind === 'audio'))) { next.push(a); continue; }
        const meta = await readAssetMeta({ media: this.media }, abs, a.kind);
        next.push({ ...a, width: a.width ?? meta.width, height: a.height ?? meta.height, durationSec: a.durationSec ?? meta.durationSec, bytes: meta.bytes });
        changed = true;
      }
      if (changed) await this.writeAssets(next);
      return { assets: next, changed };
    });
  }

  /**
   * Renames a registered asset inside its own folder (no overwrite, never through a link), then points the brand's logos and
   * fonts and every creative's brief `assets` at the new path. Crash-consistent (decisions log 336): an intent journal
   * (`.studio/rename-journal.json`) is written first and removed last; the steps run in a fixed order (journal, file,
   * assets.json, brand, briefs). A failure undoes the steps already done in reverse; a crash leaves the journal, and the next
   * open of the workspace finishes or undoes the rename (`recoverRename`). Editor staging copies are not touched (they are
   * copies in `.studio/cache`). Returns the new entry and what changed.
   */
  renameAsset(file: string, name: string, o: RenameOptions = {}): Promise<{ entry: AssetEntry; brand: boolean; creatives: string[] }> {
    return this.lock.run('assets', async () => {
      await this.recoverRenameUnlocked(); // an earlier interrupted rename is settled first
      const assets = await this.listAssets();
      const i = assets.findIndex((a) => a.file === file);
      if (i < 0) throw new WorkspaceError(404, t().errors.assetNotFound({ file }));
      if (!name.trim() || /[\\/\0]/.test(name)) throw new WorkspaceError(400, t().errors.assetRenameInvalid);
      const clean = sanitizeFileName(name.trim());
      const slash = file.lastIndexOf('/');
      const folder = slash < 0 ? '' : file.slice(0, slash);
      const toFile = folder ? `${folder}/${clean}` : clean;
      if (!relativeFileSchema.safeParse(toFile).success || isReservedName('assets', toFile) || isReservedName('assets', clean)) throw new WorkspaceError(400, t().errors.assetRenameInvalid);
      const entry = assets[i]!;
      if (toFile === file) return { entry, brand: false, creatives: [] };
      if (assetKindOf(toFile) !== entry.kind) throw new WorkspaceError(400, t().errors.assetRenameKind({ file: clean }));
      if (assets.some((a) => a.file !== file && a.file.toLowerCase() === toFile.toLowerCase())) throw new WorkspaceError(409, t().errors.assetRenameExists({ file: clean }));

      // The source is a regular file inside the library, and every folder on the way is a real directory (no link anywhere).
      const from = await this.mustBeFile('assets', file);
      if (!(await realDirChain(this.dir('assets'), folder ? folder.split('/') : []))) throw new WorkspaceError(400, t().errors.fileOutsideFolder({ kind: 'assets', file }));
      const to = this.resolve('assets', toFile);
      const taken = await lstat(to).catch(() => null);
      let sameFile = false;
      if (taken) {
        // Only a change of letter case of the very same file is allowed onto an existing name (case-insensitive volumes).
        const src = await lstat(from);
        sameFile = src.ino === taken.ino && src.dev === taken.dev && file.toLowerCase() === toFile.toLowerCase();
        if (!sameFile) throw new WorkspaceError(409, t().errors.assetRenameExists({ file: clean }));
      }

      const brand = new BrandStore(this.projectDir), creatives = new CreativeStore(this.projectDir);
      const fromRef = `assets/${file}`, toRef = `assets/${toFile}`;
      // What is affected, known before anything moves (a corrupt brand kit refuses here, with nothing changed).
      const brandRefs = await brand.usesFile(fromRef);
      const briefSlugs = await creatives.briefSlugsUsing(fromRef);
      if (!(await writeRenameJournal(this.projectDir, { schemaVersion: 1, from: file, to: toFile, startedAt: now(), brandRefs, briefSlugs }))) {
        throw new WorkspaceError(500, t().errors.assetRenameFailed);
      }
      const undo: Array<() => Promise<unknown>> = [];
      const step = async (s: RenameStep) => { await o.afterStep?.(s); };
      try {
        await step('journal');
        if (sameFile) await rename(from, to);
        else {
          // link + unlink claims the new name without ever replacing a file; volumes without hard links fall back to rename.
          try { await link(from, to); }
          catch (err) {
            const code = (err as { code?: string }).code;
            if (code === 'EEXIST') throw new WorkspaceError(409, t().errors.assetRenameExists({ file: clean }));
            if (code && ['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS'].includes(code) && !(await lstat(to).catch(() => null))) await rename(from, to);
            else throw err;
          }
          if (await lstat(from).catch(() => null)) {
            try { await unlink(from); }
            catch { await rm(to, { force: true }).catch(() => {}); throw new WorkspaceError(500, t().errors.assetRenameFailed); }
          }
        }
        undo.unshift(() => rename(to, from));
        await step('file');
        const renamed = { ...entry, file: toFile };
        await this.writeAssets(assets.map((a, k) => (k === i ? renamed : a)));
        undo.unshift(() => this.writeAssets(assets));
        await step('assets');
        // Kit and open proposals under one apply lock (an apply holding the old proposal cannot slip its kit in between).
        const refs = await brand.renameAllRefs(fromRef, toRef);
        const brandChanged = refs.kit;
        if (refs.kit || refs.proposals.length) undo.unshift(() => brand.renameAllRefs(toRef, fromRef));
        await step('brand');
        const changes = await creatives.renameBriefAsset(fromRef, toRef);
        if (changes.length) undo.unshift(() => creatives.restoreBriefAssets(changes));
        await step('briefs');
        await removeRenameJournal(this.projectDir);
        return { entry: renamed, brand: brandChanged, creatives: changes.map((c) => c.slug) };
      } catch (err) {
        if (err instanceof RenameInterrupted) throw err; // a (simulated) crash: nothing is undone, the journal stays
        let undone = true;
        for (const u of undo) await u().catch(() => { undone = false; });
        if (undone) await removeRenameJournal(this.projectDir).catch(() => {});
        if (err instanceof WorkspaceError || err instanceof JsonFileError) throw err;
        throw new WorkspaceError(500, t().errors.assetRenameFailed);
      }
    });
  }

  /** Settles a rename a crash interrupted (see `rename-recovery.ts`). */
  recoverRename(): Promise<'completed' | 'rolled-back' | 'discarded' | null> {
    return this.lock.run('assets', () => this.recoverRenameUnlocked());
  }

  private async recoverRenameUnlocked(): Promise<'completed' | 'rolled-back' | 'discarded' | null> {
    const journal = await readRenameJournal(this.projectDir);
    if (journal === null) return null;
    // The journal sits where a sandboxed agent could once write: it is a hint, never trusted (decisions log 339).
    const discard = async (why: string): Promise<'discarded'> => {
      console.warn(`Motion Studio: a rename journal was discarded without changing anything (${why})`);
      await removeRenameJournal(this.projectDir);
      return 'discarded';
    };
    if (journal === 'invalid') return discard('unreadable');
    const { from, to } = journal;
    const folder = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
    const toFolder = to.includes('/') ? to.slice(0, to.lastIndexOf('/')) : '';
    const nameOf = (f: string) => f.slice(f.lastIndexOf('/') + 1);
    if (folder !== toFolder || from === to || assetKindOf(from) !== assetKindOf(to)) return discard('the names are not a rename within one folder');
    let fromPath: string, toPath: string;
    try { fromPath = this.resolve('assets', from); toPath = this.resolve('assets', to); }
    catch { return discard('reserved or invalid names'); }
    // The same confinement as the rename itself: assets/ and every folder on the way are real directories, no link anywhere.
    if ((await isRealDirChain(this.projectDir, ['assets', ...(folder ? folder.split('/') : [])])) !== 'ok') return discard('a folder is a link or missing');
    // Exact names, not lstat: on a case-insensitive volume both spellings of a case-only rename resolve to the one file.
    const names = new Set(await readdir(dirname(toPath)));
    const fromHere = names.has(nameOf(from)), toHere = names.has(nameOf(to));
    const fromInfo = fromHere ? await lstat(fromPath) : null, toInfo = toHere ? await lstat(toPath) : null;
    if ((fromInfo && !fromInfo.isFile()) || (toInfo && !toInfo.isFile())) return discard('not a regular file');
    const brand = new BrandStore(this.projectDir), creatives = new CreativeStore(this.projectDir);
    const assets = await this.listAssets().catch(() => null);
    const retarget = async (a: string, b: string) => {
      if (assets && assets.some((x) => x.file === a) && !assets.some((x) => x.file === b)) await this.writeAssets(assets.map((x) => (x.file === a ? { ...x, file: b } : x)));
    };
    // The repair is limited to what the journal recorded the rename affected (brand logos and fonts, those briefs).
    const refs = async (a: string, b: string) => {
      await brand.renameAllRefs(`assets/${a}`, `assets/${b}`, { kit: journal.brandRefs }).catch((e) => { if (journal.brandRefs) throw e; });
      if (journal.briefSlugs.length) await creatives.renameBriefAsset(`assets/${a}`, `assets/${b}`, journal.briefSlugs);
    };
    if (toInfo) {
      if (fromInfo) {
        // Both names exist: only the hard link the crash left between link and unlink is a rename in progress.
        if (!(fromInfo.ino === toInfo.ino && fromInfo.dev === toInfo.dev)) return discard('the old name is a different file');
        await unlink(fromPath);
      }
      await retarget(from, to);
      await refs(from, to);
      await removeRenameJournal(this.projectDir);
      return 'completed';
    }
    if (!fromInfo) return discard('neither name exists');
    // The file never moved: every reference goes back to the old name.
    await retarget(to, from);
    await refs(to, from);
    await removeRenameJournal(this.projectDir);
    return 'rolled-back';
  }

  updateAsset(file: string, patch: { description?: string; tags?: string[] }): Promise<AssetEntry> {
    return this.lock.run('assets', async () => {
      const assets = await this.listAssets();
      const i = assets.findIndex((a) => a.file === file);
      if (i < 0) throw new WorkspaceError(404, t().errors.assetNotFound({ file }));
      const next = { ...assets[i]!, ...(patch.description !== undefined ? { description: patch.description } : {}), ...(patch.tags ? { tags: patch.tags } : {}) };
      const updated = assets.map((a, k) => (k === i ? next : a));
      await this.writeAssets(updated);
      return updated[i]!;
    });
  }

  removeAsset(file: string): Promise<void> {
    return this.lock.run('assets', async () => {
      // Validate path first (before any write)
      this.resolve('assets', file);

      const assets = await this.listAssets();
      if (!assets.some((a) => a.file === file)) throw new WorkspaceError(404, t().errors.assetNotFound({ file }));
      // Write metadata first
      await this.writeAssets(assets.filter((a) => a.file !== file));
      // Then delete the file (only if inside the directory)
      const abs = this.resolve('assets', file);
      const libDir = this.dir('assets');
      const realAbs = await realpath(abs).catch(() => null);
      const realLib = await realpath(libDir).catch(() => libDir);
      if (realAbs && realAbs.startsWith(realLib + sep)) {
        await rm(abs).catch(() => { /* file already gone or inaccessible */ });
      }
    });
  }

  registerReferences(files: string[]): Promise<ReferenceEntry[]> {
    return this.lock.run('references', async () => {
      const refs = await this.listReferences();
      const out: ReferenceEntry[] = [];
      for (const file of files) {
        await this.mustBeFile('references', file);
        const entry = refs.find((r) => r.file === file) ?? { file, note: '', useForBrand: true, addedAt: now() };
        if (!refs.includes(entry)) refs.push(entry);
        out.push(entry);
      }
      await this.writeReferences(refs);
      return out;
    });
  }

  updateReference(file: string, patch: { note?: string; useForBrand?: boolean }): Promise<ReferenceEntry> {
    return this.lock.run('references', async () => {
      const refs = await this.listReferences();
      const i = refs.findIndex((r) => r.file === file);
      if (i < 0) throw new WorkspaceError(404, t().errors.referenceNotFound({ file }));
      const updated = refs.map((r, k) => (k === i ? { ...r, ...patch } : r));
      await this.writeReferences(updated);
      return updated[i]!;
    });
  }

  removeReference(file: string): Promise<void> {
    return this.lock.run('references', async () => {
      // Validate path first (before any write)
      this.resolve('references', file);

      const refs = await this.listReferences();
      if (!refs.some((r) => r.file === file)) throw new WorkspaceError(404, t().errors.referenceNotFound({ file }));
      // Write metadata first
      await this.writeReferences(refs.filter((r) => r.file !== file));
      // Then delete the file (only if inside the directory)
      const abs = this.resolve('references', file);
      const libDir = this.dir('references');
      const realAbs = await realpath(abs).catch(() => null);
      const realLib = await realpath(libDir).catch(() => libDir);
      if (realAbs && realAbs.startsWith(realLib + sep)) {
        await rm(abs).catch(() => { /* file already gone or inaccessible */ });
      }
    });
  }

  async unregisteredAssets(): Promise<string[]> {
    const known = new Set((await this.listAssets()).map((a) => a.file));
    const root = this.dir('assets');
    const found: string[] = [];
    const walk = async (dir: string) => {
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (e.name.startsWith('.')) continue;
        const abs = join(dir, e.name);
        if (e.isDirectory()) await walk(abs);
        else if (e.isFile()) {
          const rel = relative(root, abs).split(sep).join('/');
          if (!isReservedName('assets', rel) && !known.has(rel)) found.push(rel);
        }
      }
    };
    await walk(root);
    return found.sort();
  }
}
