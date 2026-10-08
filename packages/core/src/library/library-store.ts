import { lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import {
  assetKindOf, assetsFileSchema, referencesFileSchema, relativeFileSchema,
  type AssetEntry, type AssetOrigin, type ReferenceEntry,
} from '@motion-studio/shared';
import { JsonFileError, readJsonFile, writeJsonFileAtomic } from '../json-file.ts';
import { fileLock } from '../file-locks.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { WorkspaceError } from '../workspace-store.ts';

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
    if (!relativeFileSchema.safeParse(file).success) throw new WorkspaceError(400, `Percorso non valido: ${file}`);
    if (isReservedName(kind, file)) throw new WorkspaceError(400, `File riservato: ${file}`);
    return join(this.dir(kind), ...file.split('/'));
  }

  /** Absolute path of an existing regular file confined to the library folder (symlinks out of it refused). */
  existingFile(kind: LibraryKind, file: string): Promise<string> { return this.mustBeFile(kind, file); }

  private async mustBeFile(kind: LibraryKind, file: string): Promise<string> {
    const abs = this.resolve(kind, file);
    const info = await lstat(abs).catch(() => null);
    if (!info?.isFile()) throw new WorkspaceError(400, `File non trovato o non valido: ${kind}/${file}`);

    // Confine: check that the real path is inside the library directory
    const libDir = this.dir(kind);
    const realAbs = await realpath(abs).catch(() => null);
    const realLib = await realpath(libDir).catch(() => libDir);
    if (!realAbs) throw new WorkspaceError(400, `File non accessibile: ${kind}/${file}`);
    if (!realAbs.startsWith(realLib + sep) && realAbs !== realLib) {
      throw new WorkspaceError(400, `File al di fuori della cartella: ${kind}/${file}`);
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
      throw new WorkspaceError(400, `Cartella ${kind} non valida: è un collegamento o è fuori dal progetto`);
    }
  }

  private async writeAssets(assets: AssetEntry[]): Promise<void> {
    const data = { schemaVersion: 1, assets };
    const parsed = assetsFileSchema.safeParse(data);
    if (!parsed.success) throw new WorkspaceError(400, 'Metadati degli asset non validi');
    await this.assertMetadataDir('assets');
    await writeJsonFileAtomic(this.metadataPath('assets'), parsed.data);
    fileLock.noteWrite(this.metadataPath('assets'));
  }

  private async writeReferences(references: ReferenceEntry[]): Promise<void> {
    const data = { schemaVersion: 1, references };
    const parsed = referencesFileSchema.safeParse(data);
    if (!parsed.success) throw new WorkspaceError(400, 'Metadati dei riferimenti non validi');
    await this.assertMetadataDir('references');
    await writeJsonFileAtomic(this.metadataPath('references'), parsed.data);
    fileLock.noteWrite(this.metadataPath('references'));
  }

  registerAssets(items: Array<{ file: string; origin: AssetOrigin; sourceUrl?: string | null; description?: string; tags?: string[]; attribution?: string | null }>): Promise<AssetEntry[]> {
    return this.lock.run('assets', async () => {
      const assets = await this.listAssets();
      const out: AssetEntry[] = [];
      for (const item of items) {
        const abs = await this.mustBeFile('assets', item.file);
        const kind = assetKindOf(item.file);
        const probed = (kind === 'image' || kind === 'video') && this.media.available ? await this.media.probe(abs) : null;
        const existing = assets.find((a) => a.file === item.file);
        const entry: AssetEntry = {
          file: item.file, kind, origin: item.origin, sourceUrl: item.sourceUrl ?? existing?.sourceUrl ?? null,
          description: item.description || existing?.description || '', tags: item.tags?.length ? item.tags : existing?.tags ?? [],
          width: probed?.width ?? existing?.width ?? null, height: probed?.height ?? existing?.height ?? null,
          addedAt: existing?.addedAt ?? now(), attribution: item.attribution ?? existing?.attribution ?? null,
        };
        if (existing) assets[assets.indexOf(existing)] = entry; else assets.push(entry);
        out.push(entry);
      }
      await this.writeAssets(assets);
      return out;
    });
  }

  updateAsset(file: string, patch: { description?: string; tags?: string[] }): Promise<AssetEntry> {
    return this.lock.run('assets', async () => {
      const assets = await this.listAssets();
      const i = assets.findIndex((a) => a.file === file);
      if (i < 0) throw new WorkspaceError(404, `Asset ${file} non trovato`);
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
      if (!assets.some((a) => a.file === file)) throw new WorkspaceError(404, `Asset ${file} non trovato`);
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
      if (i < 0) throw new WorkspaceError(404, `Riferimento ${file} non trovato`);
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
      if (!refs.some((r) => r.file === file)) throw new WorkspaceError(404, `Riferimento ${file} non trovato`);
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
