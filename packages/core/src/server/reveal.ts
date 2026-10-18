import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * What `open -R` selects to show the folder `dir` itself in Finder (user report 21): `open -R <folder>` opens its parent with
 * the folder selected, so a visible entry inside is selected instead (Finder then shows the folder's own contents). Never
 * `open <folder>`: a folder the agent could shape as an app bundle would be launched. An empty or unreadable folder: itself.
 */
export async function revealTarget(dir: string): Promise<string> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const first = names.filter((n) => !n.startsWith('.')).sort((a, b) => a.localeCompare(b))[0];
  return first !== undefined ? join(dir, first) : dir;
}
