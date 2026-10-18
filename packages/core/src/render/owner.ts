import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Every temp folder the renderer makes in the OS temp folder (`ms-render-<6>`, `ms-render-chrome-<6>`,
 * `ms-render-media-<6>`, `ms-render-vtcheck-<6>`, and `ms-render-export-<6>` for the renders of one export, review #3)
 * holds this file with the core's pid, written atomically. The startup
 * sweep removes only folders with exactly these names that hold the marker of a gone pid, or that are still empty (a
 * crash between creating the folder and marking it) (render-sweep.ts).
 */
export const RENDER_OWNER_FILE = 'owner.pid';
/** The names of the renderer's temp folders (mkdtemp adds six letters or digits). */
export const RENDER_TEMP_DIR_RE = /^ms-render-(?:(?:chrome|media|vtcheck|export)-)?[A-Za-z0-9]{6}$/;

/** Writes the owner marker atomically (a temp name, then a rename): a reader never sees a partial pid. */
export function markOwned(dir: string): void {
  const tmp = join(dir, `.${RENDER_OWNER_FILE}.tmp`);
  writeFileSync(tmp, String(process.pid));
  renameSync(tmp, join(dir, RENDER_OWNER_FILE));
}

/** `mkdtemp` plus the marker; the folder is removed again if marking fails. */
export function makeOwnedTempDirSync(prefix: string): string {
  const dir = mkdtempSync(prefix);
  try { markOwned(dir); } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
  return dir;
}

export async function makeOwnedTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(prefix);
  try { markOwned(dir); } catch (e) { await rm(dir, { recursive: true, force: true }).catch(() => {}); throw e; }
  return dir;
}
