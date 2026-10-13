import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

/**
 * The path arguments of Claude Code's file tools that a permission prompt can carry: Read/Edit/Write/MultiEdit (`file_path`),
 * Grep/Glob/LS (`path`) and NotebookEdit (`notebook_path`). A Glob `pattern` is checked on its own (`patternReaches`).
 */
const PATH_FIELDS = ['file_path', 'path', 'notebook_path'] as const;

/** Every path a tool input names (strings only, no NUL). */
export function inputPaths(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const f of PATH_FIELDS) {
    const v = input[f];
    if (typeof v === 'string' && v !== '' && !v.includes('\0')) out.push(v);
  }
  return out;
}

const segRegex = (seg: string): RegExp | null => {
  // Classes and alternatives are not worth parsing here: such a segment counts as matching (this only ever denies).
  if (/[[\]{}]/.test(seg)) return null;
  const body = seg.replace(/[.+^$()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`^${body}$`, process.platform === 'darwin' || process.platform === 'win32' ? 'i' : '');
};

/**
 * Whether a glob pattern (absolute, after `~` and the base folder are applied) can match a path inside `root`: each of the
 * root's segments must be matched by the pattern's segment at the same depth (a `**` matches the rest), and the pattern must
 * go deeper than the root. A pattern that stops above the root only names folders, never a file inside it.
 */
export function patternReaches(pattern: string, root: string): boolean {
  const pat = pattern.split('/').filter((x, i) => i === 0 || x !== '');
  const segs = root.split('/').filter((x, i) => i === 0 || x !== '');
  for (let i = 0; i < segs.length; i++) {
    const ps = pat[i];
    if (ps === undefined) return false;
    if (ps.includes('**')) return true;
    const re = segRegex(ps);
    if (re && !re.test(segs[i]!)) return false;
  }
  return pat.length > segs.length;
}

// macOS and Windows file systems are case-insensitive by default: compare folded there.
const fold = (p: string) => (process.platform === 'darwin' || process.platform === 'win32' ? p.toLowerCase() : p);
const under = (p: string, root: string) => {
  const a = fold(p);
  const r = fold(root.endsWith(sep) && root.length > 1 ? root.slice(0, -1) : root);
  return a === r || a.startsWith(r + sep);
};

/** `p` with every symlink of its longest existing ancestor resolved (the rest appended as written). */
async function realish(p: string): Promise<string> {
  const rest: string[] = [];
  let cur = p;
  for (;;) {
    try { return join(await realpath(cur), ...rest.reverse()); }
    catch {
      const parent = dirname(cur);
      if (parent === cur) return p;
      rest.push(basename(cur));
      cur = parent;
    }
  }
}

/**
 * Whether a permission prompt's input names a path inside one of `roots`, or (Glob) a pattern that can match one (as written, resolved against the agent's working
 * folder and `~`, and after resolving symlinks). Any doubt about a root counts against the request: this only ever denies.
 */
export async function namesProtectedPath(toolName: string, input: Record<string, unknown>, roots: readonly string[], cwd: string, home = homedir()): Promise<boolean> {
  if (roots.length === 0) return false;
  const tilde = (raw: string) => (raw === '~' ? home : raw.startsWith('~/') ? join(home, raw.slice(2)) : raw);
  const rootForms = (await Promise.all(roots.map(async (r) => [resolve(r), await realish(resolve(r))]))).flat();
  for (const raw of inputPaths(input)) {
    const written = resolve(cwd, tilde(raw));
    const forms = [written, await realish(written)];
    if (forms.some((f) => rootForms.some((r) => under(f, r)))) return true;
  }
  // Glob: the pattern applies under its `path` (or the working folder); its wildcards can reach the folder from above.
  // (Grep's `pattern` is a regular expression over contents, not a path.)
  if (toolName === 'Glob' && typeof input.pattern === 'string' && input.pattern !== '' && !input.pattern.includes('\0')) {
    const base = typeof input.path === 'string' && input.path !== '' ? resolve(cwd, tilde(input.path)) : cwd;
    const full = isAbsolute(tilde(input.pattern)) ? tilde(input.pattern) : join(base, input.pattern);
    const bases = [full];
    // The pattern's literal folder may be a symlink to the protected one.
    const literal = full.split('/').findIndex((seg) => /[*?[\]{}]/.test(seg));
    if (literal > 1) {
      const segs = full.split('/');
      bases.push(join(await realish(segs.slice(0, literal).join('/')), ...segs.slice(literal)));
    }
    if (bases.some((b) => rootForms.some((r) => patternReaches(b, r)))) return true;
  }
  return false;
}
