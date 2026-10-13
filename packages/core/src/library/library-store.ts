import { link, lstat, mkdir, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import {
  assetKindOf, assetsFileSchema, referencesFileSchema, relativeFileSchema,
  type AssetEntry, type AssetOrigin, type ReferenceEntry,
} from '@motion-studio/shared';
import { JsonFileError, readJsonFile, writeJsonFileAtomic } from '../json-file.ts';
import { readAssetMeta, needsMeta } from './asset-meta.ts';
import { realDirChain } from '../creatives/core-files.ts';
import { BrandStore } from '../brand/brand-store.ts';
import { CreativeStore } from '../creatives/creative-store.ts';
import { sanitizeFileName } from './upload.ts';
import { fileLock } from '../file-locks.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { WorkspaceError } from '../workspace-store.ts';
import { t } from '../i18n.ts';

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

  registerAssets(items: Array<{ file: string; origin: AssetOrigin; sourceUrl?: string | null; description?: string; tags?: string[]; attribution?: string | null; bytes?: number }>): Promise<AssetEntry[]> {
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
          ...(existing?.provider ? { provider: existing.provider } : {}), ...(existing?.model ? { model: existing.model } : {}), ...(existing?.loop !== undefined ? { loop: existing.loop } : {}),
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
        if (!abs) { next.push(a); continue; }
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
   * fonts and every creative's brief `assets` at the new path, each under its own lock. Anything that fails undoes the steps
   * before it. Editor staging copies are not touched (they are copies in `.studio/cache`). Returns the new entry and what changed.
   */
  renameAsset(file: string, name: string): Promise<{ entry: AssetEntry; brand: boolean; creatives: string[] }> {
    return this.lock.run('assets', async () => {
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
      if (taken) {
        // Only a change of letter case of the very same file is allowed onto an existing name (case-insensitive volumes).
        const src = await lstat(from);
        if (!(src.ino === taken.ino && src.dev === taken.dev && file.toLowerCase() === toFile.toLowerCase())) throw new WorkspaceError(409, t().errors.assetRenameExists({ file: clean }));
        await rename(from, to);
      } else {
        // link + unlink claims the new name without ever replacing a file; volumes without hard links fall back to rename.
        try { await link(from, to); await unlink(from); }
        catch (err) {
          const code = (err as { code?: string }).code;
          if (code === 'EEXIST') throw new WorkspaceError(409, t().errors.assetRenameExists({ file: clean }));
          if (code && ['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS'].includes(code) && !(await lstat(to).catch(() => null))) await rename(from, to);
          else throw err;
        }
      }
      const undo: Array<() => Promise<unknown>> = [() => rename(to, from)];
      try {
        const brand = new BrandStore(this.projectDir), creatives = new CreativeStore(this.projectDir);
        const brandChanged = await brand.renameFileRefs(`assets/${file}`, `assets/${toFile}`);
        if (brandChanged) undo.unshift(() => brand.renameFileRefs(`assets/${toFile}`, `assets/${file}`));
        const slugs = await creatives.renameBriefAsset(`assets/${file}`, `assets/${toFile}`);
        if (slugs.length) undo.unshift(() => creatives.renameBriefAsset(`assets/${toFile}`, `assets/${file}`));
        const renamed = { ...entry, file: toFile };
        await this.writeAssets(assets.map((a, k) => (k === i ? renamed : a)));
        return { entry: renamed, brand: brandChanged, creatives: slugs };
      } catch (err) {
        for (const step of undo) await step().catch(() => {});
        if (err instanceof WorkspaceError || err instanceof JsonFileError) throw err;
        throw new WorkspaceError(500, t().errors.assetRenameFailed);
      }
    });
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
