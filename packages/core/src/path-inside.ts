import * as platformPath from 'node:path';

/** The parts of a platform path module the containment checks need (injectable: tests pass `path.win32` / `path.posix`). */
export type InsidePathModule = Pick<typeof platformPath.posix, 'relative' | 'resolve' | 'isAbsolute' | 'sep'>;

/**
 * The path of `child` relative to `parent` when `child` is `parent` itself ('') or lies inside it; null otherwise. Absolute
 * paths of the platform: on Windows (`path.win32`) `/` and `\` are the same separator and the comparison ignores case, as the
 * file system does (`path.win32.relative` folds case); a path on another drive is never inside. POSIX compares exactly.
 * Pure string work: no symlink is resolved (callers that need the real path resolve it first).
 */
export function relativeInside(child: string, parent: string, p: InsidePathModule = platformPath): string | null {
  if (!p.isAbsolute(child) || !p.isAbsolute(parent)) return null;
  const rel = p.relative(p.resolve(parent), p.resolve(child));
  if (rel === '') return '';
  if (p.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${p.sep}`)) return null;
  return rel;
}

/** True when `child` lies strictly inside `parent` (not the folder itself). See `relativeInside`. */
export const isStrictlyInside = (child: string, parent: string, p: InsidePathModule = platformPath): boolean => {
  const rel = relativeInside(child, parent, p);
  return rel !== null && rel !== '';
};
