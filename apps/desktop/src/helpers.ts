import { isAbsolute } from 'node:path';

/** The UI token travels only in the URL fragment (`#t=<token>`). */
export function tokenFromAppUrl(appUrl: string): string | null {
  try { return new URLSearchParams(new URL(appUrl).hash.slice(1)).get('t'); } catch { return null; }
}

/** Validated payload of `ms:pick-folder`, or null when it is malformed. */
export function pickFolderArgs(arg: unknown): { title: string; defaultPath?: string } | null {
  if (typeof arg !== 'object' || arg === null) return null;
  const { title, defaultPath } = arg as Record<string, unknown>;
  if (typeof title !== 'string') return null;
  if (defaultPath === undefined) return { title };
  return typeof defaultPath === 'string' ? { title, defaultPath } : null;
}

/** Validated payload of `ms:reveal`: an absolute path, nothing else. */
export function absolutePathArg(arg: unknown): string | null {
  return typeof arg === 'string' && arg !== '' && !arg.includes('\0') && isAbsolute(arg) ? arg : null;
}
