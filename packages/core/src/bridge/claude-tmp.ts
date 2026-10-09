import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';

/**
 * Claude Code's own per-user temp root, where its sandboxed commands write ($TMPDIR inside the sandbox) and where an
 * agent's check frames end up. Claude Code 2.1.x computes it as `join(CLAUDE_CODE_TMPDIR || "/tmp", "claude-<uid>")`,
 * creates it 0700 and refuses it when another user owns it. The `claude` child inherits the core's environment
 * (launcher: `{ ...process.env, ...req.env }`, CLAUDE_CODE_TMPDIR is neither set nor unset), so the same formula
 * applies. Deliberately NOT $TMPDIR, nor `/tmp/claude` (shared by every user). null without a uid (Windows) or with a
 * relative override: nothing is then approved automatically.
 */
export function claudeTmpRootFor(env: Record<string, string | undefined>, uid: number | undefined): string | null {
  if (typeof uid !== 'number' || !Number.isInteger(uid) || uid < 0) return null;
  const base = env.CLAUDE_CODE_TMPDIR || '/tmp';
  if (!isAbsolute(base)) return null;
  return join(base, `claude-${uid}`);
}

export const defaultClaudeTmpRoot = (): string | null => claudeTmpRootFor(process.env, process.getuid?.());

const inside = (p: string, root: string) => p.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * True only when `file` is an absolute path that names a regular file inside `root`, both as written and after every
 * symlink is resolved (no escape through a link to a file or a folder), and `root` itself is a folder owned by this
 * user that nobody else can write. Any error or doubt: false.
 */
export async function isInsideClaudeTmp(file: unknown, root: string | null): Promise<boolean> {
  if (root === null || typeof file !== 'string' || file === '' || file.includes('\0') || !isAbsolute(file)) return false;
  try {
    const realRoot = await realpath(root);
    const info = await stat(realRoot);
    const uid = process.getuid?.();
    if (!info.isDirectory() || uid === undefined || info.uid !== uid || (info.mode & 0o022) !== 0) return false;
    const written = resolve(file);
    if (!inside(written, resolve(root)) && !inside(written, realRoot)) return false;
    const real = await realpath(written);
    if (!inside(real, realRoot)) return false;
    return (await stat(real)).isFile();
  } catch {
    return false;
  }
}
