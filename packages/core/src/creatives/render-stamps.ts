import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { manifestV2Schema, type OutputFileInfo } from '@motion-studio/shared';
import { hashConfinedFile } from '../brand/agent-guard.ts';
import { readJsonFile, writeJsonFileAtomic } from '../json-file.ts';
import { KeyedMutex } from '../keyed-mutex.ts';
import type { CreativeStore } from './creative-store.ts';

/**
 * The size and mtime each recorded render had when the core recorded it, in
 * `<project>/.studio/cache/renders/<creative>/v<N>.json` (out of the agent's reach, never versioned). A render job writes
 * them with each record. `reconcileRenders` runs when renders are read for display or export: a render whose file no
 * longer has its recorded size or mtime (a crash between the rename and the record, or anything else) is hashed again,
 * and its record in versions.json and the manifest's `renders[]` is corrected when the hash differs.
 */

const stampSchema = z.object({ size: z.number(), mtimeMs: z.number(), sha256: z.string().regex(/^[0-9a-f]{64}$/) });
const fileSchema = z.object({ schemaVersion: z.literal(1), files: z.record(z.string(), stampSchema) });
type Stamps = Record<string, z.infer<typeof stampSchema>>;
const lock = new KeyedMutex();

export const renderStampPath = (projectDir: string, creativeSlug: string, n: number) =>
  join(projectDir, '.studio', 'cache', 'renders', creativeSlug, `v${n}.json`);

const read = (path: string): Promise<Stamps> => readJsonFile(path, fileSchema).then((f) => f.files, () => ({}));

/** Records the current size and mtime of each recorded render file (`outputs/v<n>/<file>`) with its hash. */
export async function noteRenderStamps(projectDir: string, creativeDir: string, creativeSlug: string, n: number, infos: ReadonlyArray<Pick<OutputFileInfo, 'file' | 'sha256'>>): Promise<void> {
  const path = renderStampPath(projectDir, creativeSlug, n);
  await lock.run(path, async () => {
    const files = await read(path);
    for (const i of infos) {
      if (!i.sha256) continue;
      const st = await lstat(join(creativeDir, 'outputs', `v${n}`, i.file)).catch(() => null);
      if (st?.isFile()) files[i.file] = { size: st.size, mtimeMs: st.mtimeMs, sha256: i.sha256 };
    }
    await writeJsonFileAtomic(path, { schemaVersion: 1, files });
  });
}

/**
 * Checks the rendered outputs (`fromComposition` set) of every v2 version against their stamps; returns whether a record
 * was corrected. A missing file is left to the callers (export reports it); a file that cannot be hashed is skipped.
 */
export async function reconcileRenders(o: { projectDir: string; store: CreativeStore; creativeSlug: string }): Promise<boolean> {
  const creativeDir = o.store.dir(o.creativeSlug);
  let changed = false;
  for (const v of await o.store.readVersions(o.creativeSlug)) {
    if (!v.compositions?.length) continue;
    const renders = v.outputs.filter((x) => x.sha256 && x.fromComposition);
    if (renders.length === 0) continue;
    const path = renderStampPath(o.projectDir, o.creativeSlug, v.n);
    const fixes = new Map<string, string>();
    await lock.run(path, async () => {
      const stamps = await read(path);
      let dirty = false;
      for (const r of renders) {
        const st = await lstat(join(creativeDir, 'outputs', `v${v.n}`, r.file)).catch(() => null);
        if (!st?.isFile()) continue;
        const s = stamps[r.file];
        if (s && s.size === st.size && s.mtimeMs === st.mtimeMs && s.sha256 === r.sha256) continue;
        const h = await hashConfinedFile(creativeDir, `outputs/v${v.n}/${r.file}`);
        if (!h || 'skipped' in h) continue;
        stamps[r.file] = { size: h.size, mtimeMs: h.mtimeMs, sha256: h.sha256 };
        dirty = true;
        if (h.sha256 !== r.sha256) fixes.set(r.format, h.sha256);
      }
      if (dirty) await writeJsonFileAtomic(path, { schemaVersion: 1, files: stamps });
    });
    if (fixes.size === 0) continue;
    changed = true;
    await o.store.updateVersion(o.creativeSlug, v.n, (e) => ({ ...e, outputs: e.outputs.map((x) => (fixes.has(x.format) ? { ...x, sha256: fixes.get(x.format)! } : x)) }));
    const mpath = join(creativeDir, 'outputs', `v${v.n}`, 'manifest.json');
    const manifest = await readJsonFile(mpath, manifestV2Schema).catch(() => null);
    if (manifest) {
      await writeJsonFileAtomic(mpath, { ...manifest, renders: manifest.renders.map((r) => (fixes.has(r.format) ? { ...r, sha256: fixes.get(r.format)! } : r)) });
    }
  }
  return changed;
}
