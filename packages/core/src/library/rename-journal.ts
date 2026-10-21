import { lstat, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { relativeFileSchema } from '@motion-studio/shared';
import { z } from 'zod';
import { isCreativeFolderShape } from '../creatives/creative-store.ts';
import { realDirChain } from '../creatives/core-files.ts';
import { writeJsonFileAtomic } from '../json-file.ts';

/**
 * The intent of a rename in progress (decisions log 336): written before the file moves and removed when every step is done.
 * A leftover journal means the process died in between; the next open of the workspace finishes or undoes the rename.
 */
export const renameJournalSchema = z.object({
  schemaVersion: z.literal(1),
  from: relativeFileSchema,
  to: relativeFileSchema,
  startedAt: z.iso.datetime(),
  /** Whether a brand logo or font pointed at the file when the rename started. */
  brandRefs: z.boolean(),
  /**
   * The creatives whose brief listed the file when the rename started. Phase 15: a variant sister's slug has the shape too;
   * whether it is still a real sister is checked when the briefs are changed (`CreativeStore.renameBriefAsset`).
   */
  briefSlugs: z.array(z.string().refine(isCreativeFolderShape)).max(10_000),
  /** Decision 1495: whether the video had an analysis file (`assets/.analysis/…`) when the rename started (older journals: no). */
  sidecar: z.boolean().default(false),
});
export type RenameJournal = z.infer<typeof renameJournalSchema>;

export const journalPathOf = (projectDir: string) => join(projectDir, '.studio', 'rename-journal.json');

/** Writes the journal (atomically, noted as an app write) into a real `.studio` folder; false when that folder is a link. */
export async function writeRenameJournal(projectDir: string, journal: RenameJournal): Promise<boolean> {
  if (!(await realDirChain(projectDir, ['.studio']))) return false;
  await writeJsonFileAtomic(journalPathOf(projectDir), journal);
  return true;
}

export async function removeRenameJournal(projectDir: string): Promise<void> {
  await rm(journalPathOf(projectDir), { recursive: true, force: true });
}

/** The leftover journal, null when there is none; `'invalid'` when it exists but cannot be read. */
export async function readRenameJournal(projectDir: string): Promise<RenameJournal | null | 'invalid'> {
  const file = journalPathOf(projectDir);
  const st = await lstat(file).catch(() => null);
  if (!st) return null;
  if (!st.isFile()) return 'invalid';
  try {
    const parsed = renameJournalSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
    return parsed.success ? parsed.data : 'invalid';
  } catch { return 'invalid'; }
}
