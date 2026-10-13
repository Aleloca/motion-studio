import type { Git } from '../git.ts';
import { NoMediaTools } from '../media/media-tools.ts';
import { t } from '../i18n.ts';
import { LibraryStore } from './library-store.ts';

/**
 * Startup / workspace-open repair of an interrupted rename: finishes it when the new file exists (assets.json, brand and
 * briefs follow, one commit), otherwise points everything back at the old name. The journal goes away only when the
 * project is consistent. Returns what it did.
 */
export async function recoverRenameJournal(projectDir: string, git?: Git): Promise<'completed' | 'rolled-back' | 'discarded' | null> {
  const lib = new LibraryStore(projectDir, NoMediaTools);
  const result = await lib.recoverRename();
  if (result === 'completed' && git) await git.commitAll(projectDir, t().jobs.renameAssetRecoveredCommit);
  return result;
}
