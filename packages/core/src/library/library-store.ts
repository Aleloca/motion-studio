import { lstat, readdir, rm } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import {
  assetKindOf, assetsFileSchema, referencesFileSchema, relativeFileSchema,
  type AssetEntry, type AssetOrigin, type ReferenceEntry,
} from '@motion-studio/shared';
import { JsonFileError, readJsonFile, writeJsonFileAtomic } from '../json-file.ts';
import { KeyedMutex } from '../keyed-mutex.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { WorkspaceError } from '../workspace-store.ts';

export type LibraryKind = 'assets' | 'references';
const now = () => new Date().toISOString();

export class LibraryStore {
  private readonly lock = new KeyedMutex();
  constructor(private readonly projectDir: string, private readonly media: MediaTools) {}

  dir(kind: LibraryKind) { return join(this.projectDir, kind); }

  resolve(kind: LibraryKind, file: string): string {
    if (!relativeFileSchema.safeParse(file).success) throw new WorkspaceError(400, `Percorso non valido: ${file}`);
    return join(this.dir(kind), ...file.split('/'));
  }

  private async mustBeFile(kind: LibraryKind, file: string): Promise<string> {
    const abs = this.resolve(kind, file);
    const info = await lstat(abs).catch(() => null);
    if (!info?.isFile()) throw new WorkspaceError(400, `File non trovato o non valido: ${kind}/${file}`);
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

  private writeAssets(assets: AssetEntry[]) { return writeJsonFileAtomic(join(this.dir('assets'), 'assets.json'), { schemaVersion: 1, assets }); }
  private writeReferences(references: ReferenceEntry[]) { return writeJsonFileAtomic(join(this.dir('references'), 'references.json'), { schemaVersion: 1, references }); }

  registerAssets(items: Array<{ file: string; origin: AssetOrigin; sourceUrl?: string | null; description?: string; tags?: string[] }>): Promise<AssetEntry[]> {
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
          addedAt: existing?.addedAt ?? now(),
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
      const parsed = assetsFileSchema.safeParse({ schemaVersion: 1, assets: assets.map((a, k) => (k === i ? next : a)) });
      if (!parsed.success) throw new WorkspaceError(400, 'Metadati dell\'asset non validi');
      await this.writeAssets(parsed.data.assets);
      return parsed.data.assets[i]!;
    });
  }

  removeAsset(file: string): Promise<void> {
    return this.lock.run('assets', async () => {
      const assets = await this.listAssets();
      if (!assets.some((a) => a.file === file)) throw new WorkspaceError(404, `Asset ${file} non trovato`);
      const abs = this.resolve('assets', file);
      if ((await lstat(abs).catch(() => null))?.isFile()) await rm(abs);
      await this.writeAssets(assets.filter((a) => a.file !== file));
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
      refs[i] = { ...refs[i]!, ...patch };
      const parsed = referencesFileSchema.safeParse({ schemaVersion: 1, references: refs });
      if (!parsed.success) throw new WorkspaceError(400, 'Metadati del riferimento non validi');
      await this.writeReferences(parsed.data.references);
      return parsed.data.references[i]!;
    });
  }

  removeReference(file: string): Promise<void> {
    return this.lock.run('references', async () => {
      const refs = await this.listReferences();
      if (!refs.some((r) => r.file === file)) throw new WorkspaceError(404, `Riferimento ${file} non trovato`);
      const abs = this.resolve('references', file);
      if ((await lstat(abs).catch(() => null))?.isFile()) await rm(abs);
      await this.writeReferences(refs.filter((r) => r.file !== file));
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
          if (rel !== 'assets.json' && !known.has(rel)) found.push(rel);
        }
      }
    };
    await walk(root);
    return found.sort();
  }
}
