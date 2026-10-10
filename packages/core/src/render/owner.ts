import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every temp folder the renderer makes in the OS temp folder (`ms-render-<6>`, `ms-render-chrome-<6>`,
 * `ms-render-media-<6>`, `ms-render-vtcheck-<6>`) holds this file with the core's pid. The startup sweep removes only
 * folders with exactly these names AND this marker, whose pid is gone (render-sweep.ts).
 */
export const RENDER_OWNER_FILE = 'owner.pid';
/** The names of the renderer's temp folders (mkdtemp adds six letters or digits). */
export const RENDER_TEMP_DIR_RE = /^ms-render-(?:(?:chrome|media|vtcheck)-)?[A-Za-z0-9]{6}$/;

export function markOwned(dir: string): void {
  writeFileSync(join(dir, RENDER_OWNER_FILE), String(process.pid));
}
