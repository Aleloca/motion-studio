import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { t } from './i18n.ts';
import { CodedError } from './workspace-store.ts';

/**
 * Decision 915: moves a file or folder to the user's Trash, recoverable until the Trash is emptied. The desktop app passes
 * Electron's `shell.trashItem`; the core's own (`moveToTrash`) is used by the CLI. The server gets it as a dependency: a
 * server built without one (every test) refuses to delete, so nothing ever reaches a real Trash by mistake.
 */
export type TrashFn = (absPath: string) => Promise<void>;

/** Refuses: no Trash was given to this server. */
export const noTrash: TrashFn = async () => { throw new CodedError(409, t().errors.trashUnavailable({ detail: t().errors.trashUnsupported }), 'trash-unavailable'); };

export interface TrashOptions { platform?: NodeJS.Platform; home?: string; env?: Record<string, string | undefined>; now?: Date }

const exists = (p: string) => lstat(p).then(() => true, () => false);

/** `name`, else `name 2`, `name 3`… : the first one free in `dir` (as the Finder names a second item of the same name). */
async function freeName(dir: string, name: string, taken: (candidate: string) => Promise<boolean> = (c) => exists(join(dir, c))): Promise<string> {
  for (let n = 1; n < 10_000; n++) {
    const candidate = n === 1 ? name : `${name} ${n}`;
    if (!(await taken(candidate))) return candidate;
  }
  throw new CodedError(409, t().errors.trashUnavailable({ detail: name }), 'trash-unavailable');
}

const pad = (n: number) => String(n).padStart(2, '0');
const trashInfoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/**
 * The core's own Trash, without any automation of other apps:
 * - macOS: a plain rename into `~/.Trash` under a free name (the Finder lists it and "Put Back" is not offered, as for any
 *   item moved there by a tool; the user drags it back). Only on the Trash's own disk: a project on another disk is refused
 *   (`trash-unavailable`), never copied.
 * - Linux: the freedesktop.org Trash (`$XDG_DATA_HOME/Trash`, else `~/.local/share/Trash`): `info/<name>.trashinfo` is
 *   reserved first (created exclusively), then the item is renamed into `files/<name>`. Same-disk only, as above.
 * - Other systems: refused (`trash-unavailable`); the desktop app's Electron Trash covers Windows.
 */
export async function moveToTrash(absPath: string, opts: TrashOptions = {}): Promise<void> {
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  const fail = (detail: string) => new CodedError(409, t().errors.trashUnavailable({ detail }), 'trash-unavailable');
  const renameInto = async (from: string, to: string) => {
    try { await rename(from, to); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') throw fail(t().errors.trashOtherVolume);
      throw fail((err as Error).message);
    }
  };
  if (platform === 'darwin') {
    const dir = join(home, '.Trash');
    await mkdir(dir, { recursive: true });
    await renameInto(absPath, join(dir, await freeName(dir, basename(absPath))));
    return;
  }
  if (platform === 'linux') {
    const env = opts.env ?? process.env;
    const root = env.XDG_DATA_HOME ? join(env.XDG_DATA_HOME, 'Trash') : join(home, '.local', 'share', 'Trash');
    const files = join(root, 'files');
    const info = join(root, 'info');
    await mkdir(files, { recursive: true });
    await mkdir(info, { recursive: true });
    let reserved: string | null = null;
    const name = await freeName(files, basename(absPath), async (c) => {
      if (await exists(join(files, c))) return true;
      try {
        const fh = await open(join(info, `${c}.trashinfo`), 'wx');
        await fh.writeFile(`[Trash Info]\nPath=${encodeURI(absPath)}\nDeletionDate=${trashInfoDate(opts.now ?? new Date())}\n`);
        await fh.close();
        reserved = join(info, `${c}.trashinfo`);
        return false;
      } catch { return true; }
    });
    try { await renameInto(absPath, join(files, name)); } catch (err) {
      if (reserved) await unlink(reserved).catch(() => {});
      throw err;
    }
    return;
  }
  throw fail(t().errors.trashUnsupported);
}
