import { constants } from 'node:fs';
import { lstat, open, realpath, rm } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { isSecretPath, relativeFileSchema, type ServerMessage } from '@motion-studio/shared';
import { hasUnsafePathChars } from '../codebases.ts';
import { LibraryStore } from '../library/library-store.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { saveGeneratedFile } from '../providers/files.ts';
import { ProviderError } from '../providers/http.ts';
import { t } from '../i18n.ts';
import type { BridgeContext } from './bridge.ts';
import type { BridgeHandler } from './bridge-routes.ts';

/** `import_codebase_file` calls allowed per brand analysis (decision 723); every call counts, refused ones too. */
export const CODEBASE_IMPORT_CALLS_PER_JOB = 40;
/** The largest file copied (same cap as `download_file`). */
export const CODEBASE_IMPORT_MAX_BYTES = 50 * 1024 * 1024;
/** Same extensions as `download_file` (spec §2.2): logos, images, icons and fonts. */
const EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'ico', 'avif', 'woff', 'woff2', 'ttf', 'otf']);
/** Destination folders. Every copy is tagged `brand` (spec §2.2), fonts included: the kind is already in the asset entry. */
const DIRS = { brand: 'brand', fonts: 'fonts' } as const;
const MAX_SOURCE = 4096;

export type CodebaseImportError = 'outside' | 'secret' | 'not-file' | 'too-big' | 'extension' | 'dest' | 'limit' | 'missing';
export interface CodebaseImportContext { projectDir: string; codebases: readonly string[]; callsSoFar: number; library: LibraryStore }

const ext = (name: string) => extname(name).slice(1).toLowerCase();
const sameKind = (a: string, b: string) => a === b || (['jpg', 'jpeg'].includes(a) && ['jpg', 'jpeg'].includes(b));
/** `rel` (from path.relative) stays inside its base and is not the base itself. */
const inside = (rel: string) => rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);

function destination(raw: unknown): { dir: keyof typeof DIRS; name: string } | null {
  if (typeof raw !== 'string' || !relativeFileSchema.safeParse(raw).success) return null;
  const parts = raw.split('/');
  if (parts.length !== 3 || parts[0] !== 'assets' || !Object.hasOwn(DIRS, parts[1]!) || parts.some((p) => p === '' || p.startsWith('.'))) return null;
  if (hasUnsafePathChars(raw)) return null;
  return { dir: parts[1] as keyof typeof DIRS, name: parts[2]! };
}

/**
 * Where `source` may lie: for each codebase that contains it as written (a relative source is resolved against each codebase
 * in turn), the absolute path and the path relative to that codebase. Lexical only: links are checked after.
 */
function locate(source: string, codebases: readonly string[]): Array<{ root: string; abs: string; rel: string }> {
  const out: Array<{ root: string; abs: string; rel: string }> = [];
  for (const root of codebases) {
    const abs = isAbsolute(source) ? normalize(source) : resolve(root, source);
    const rel = relative(root, abs);
    if (inside(rel)) out.push({ root, abs, rel });
  }
  return out;
}

/**
 * Copies one file of a codebase source into the project's assets (brand analysis, spec §2.2). The checks run in this order,
 * each refusal leaving nothing behind:
 * 1. the call limit (`limit`);
 * 2. the destination: `assets/brand/<name>` or `assets/fonts/<name>`, no traversal, no hidden name, no control character (`dest`);
 * 3. the source is a non-empty string without control characters, inside a codebase as written; a relative source is
 *    resolved against each codebase (`outside`);
 * 4. the secret patterns on that codebase-relative path, case-insensitively, before anything is touched: a secret's
 *    existence is never revealed (`secret`);
 * 5. the extension allow-list, source and destination of the same kind (`extension`);
 * 6. the entry exists in one of the candidate codebases (`missing`);
 * 7. its real path inside that codebase's real path: a link (or a linked folder) that leads out is refused (`outside`);
 * 8. the secret patterns on the real relative path too (`secret`), and the real file's extension (`extension`);
 * 9. opened without following a last link and without blocking; a regular file, and still the same file (dev/ino) at the
 *    real path after the open (`not-file`);
 * 10. the size from the open handle, before reading (`too-big`), and a read capped one byte past it (`not-file` if it grew).
 * The copy is written to a temporary name and claimed atomically (saveGeneratedFile); a failed registration removes it.
 */
export async function importCodebaseFile(ctx: CodebaseImportContext, args: { source: unknown; dest: unknown }): Promise<{ file: string } | { error: CodebaseImportError }> {
  if (ctx.callsSoFar >= CODEBASE_IMPORT_CALLS_PER_JOB) return { error: 'limit' };
  const dest = destination(args.dest);
  if (!dest) return { error: 'dest' };
  const source = args.source;
  if (typeof source !== 'string' || source.trim() === '' || source.length > MAX_SOURCE || hasUnsafePathChars(source)) return { error: 'outside' };
  const candidates = locate(source, ctx.codebases);
  if (candidates.length === 0) return { error: 'outside' };
  if (candidates.some((c) => isSecretPath(c.rel))) return { error: 'secret' };
  if (!EXTENSIONS.has(ext(source)) || !EXTENSIONS.has(ext(dest.name)) || !sameKind(ext(source), ext(dest.name))) return { error: 'extension' };
  // The first codebase where the file exists (as an entry: a dangling link is found here and refused below).
  let where: (typeof candidates)[number] | null = null;
  for (const c of candidates) if (await lstat(c.abs).catch(() => null)) { where = c; break; }
  if (!where) return { error: 'missing' };
  const [real, realRoot] = await Promise.all([realpath(where.abs).catch(() => null), realpath(where.root).catch(() => null)]);
  if (real === null || realRoot === null) return { error: 'missing' };
  const realRel = relative(realRoot, real);
  if (!inside(realRel)) return { error: 'outside' };
  if (isSecretPath(realRel)) return { error: 'secret' };
  if (!EXTENSIONS.has(ext(real))) return { error: 'extension' };

  // O_NOFOLLOW: the real path has no link left, so a link appearing there now is a swap; O_NONBLOCK: a FIFO never blocks.
  const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
  if (!handle) return { error: 'not-file' };
  let bytes: Buffer;
  try {
    const fst = await handle.stat();
    if (!fst.isFile()) return { error: 'not-file' };
    // The file opened must still be the one at the checked real path (fix round 1): a swap between the checks and the open
    // (another file moved in its place) is refused.
    const now = await lstat(real).catch(() => null);
    if (!now || !now.isFile() || now.ino !== fst.ino || now.dev !== fst.dev) return { error: 'not-file' };
    if (fst.size > CODEBASE_IMPORT_MAX_BYTES) return { error: 'too-big' };
    // Read through the handle into a buffer one byte larger than the size checked: more bytes than that means the file
    // changed while it was read, and it is refused rather than copied in part.
    const buf = Buffer.alloc(fst.size + 1);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buf, total, buf.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > fst.size) return { error: 'not-file' };
    }
    bytes = buf.subarray(0, total);
  } finally {
    await handle.close().catch(() => {});
  }

  const file = await saveGeneratedFile(ctx.projectDir, dest.dir, dest.name, bytes);
  try {
    await ctx.library.registerAssets([{ file, origin: 'codebase', sourceUrl: null, description: '', tags: ['brand'] }]);
  } catch (e) {
    await rm(join(ctx.projectDir, 'assets', ...file.split('/')), { force: true }).catch(() => {});
    throw e;
  }
  return { file: `assets/${file}` };
}

const STATUS: Record<CodebaseImportError, 400 | 403 | 404 | 413 | 429> = {
  outside: 403, secret: 403, 'not-file': 400, 'too-big': 413, extension: 400, dest: 400, limit: 429, missing: 404,
};

/** The refusal shown to the agent: the stable code first, then the reason in the current language. */
export const codebaseImportMessage = (code: CodebaseImportError): string => `${code}: ${t().providers.codebaseImport[code === 'not-file' ? 'notFile' : code === 'too-big' ? 'tooBig' : code]({ max: code === 'limit' ? CODEBASE_IMPORT_CALLS_PER_JOB : 50 })}`;

/**
 * MCP tool `import_codebase_file` (brand analysis only): copies a logo, icon or font from one of the analysis's codebases
 * into assets/brand or assets/fonts and registers it with origin `codebase`. Calls are counted per job; a refusal is a tool
 * error with a clear reason and the analysis goes on.
 */
export function importCodebaseTool(deps: { media: MediaTools; broadcast(m: ServerMessage): void }): BridgeHandler {
  // Per job, keyed by the job's own abort signal (one per run): nothing to clean up when the job ends.
  const calls = new WeakMap<AbortSignal, number>();
  return async (c: BridgeContext, a) => {
    if (c.kind !== 'brand-analysis') throw new ProviderError(403, t().errors.toolUnavailable);
    if (c.signal.aborted) throw new ProviderError(499, t().errors.jobCancelled);
    const callsSoFar = calls.get(c.signal) ?? 0;
    calls.set(c.signal, callsSoFar + 1);
    const out = await importCodebaseFile({ projectDir: c.projectDir, codebases: c.codebases ?? [], callsSoFar, library: new LibraryStore(c.projectDir, deps.media) }, { source: a.source, dest: a.dest });
    if ('error' in out) throw new ProviderError(STATUS[out.error], codebaseImportMessage(out.error));
    deps.broadcast({ type: 'library', project: c.projectSlug });
    return out;
  };
}
