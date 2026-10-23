import { z } from 'zod';
import { CodedError } from '../workspace-store.ts';
import { probeConfinedFile } from '../brand/agent-guard.ts';
import { t } from '../i18n.ts';

/** Report 79: at most this many library files go with one message. */
export const MAX_ATTACHMENTS = 20;

/** A message's attached files as the request carries them: project paths (`assets/…`), no control characters. */
export const attachmentsSchema = z.array(z.string().min(1).max(1024).refine((s) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(s))).max(MAX_ATTACHMENTS);

/** Whether `p` is a regular file of the project library (see `checkAttachments`). */
async function isLibraryFile(projectDir: string, p: string): Promise<boolean> {
  const parts = p.split('/');
  return parts.length >= 2 && parts[0] === 'assets' && p !== 'assets/assets.json'
    && parts.every((s) => s !== '' && s !== '.' && s !== '..' && !s.startsWith('.') && !s.includes('\\'))
    && (await probeConfinedFile(projectDir, p).catch(() => null)) === true;
}

/**
 * Report 79: the files attached to a creative message, checked: each is a regular file of the project library (`assets/…`,
 * no `.`, `..`, empty or hidden segment, not the library's own `assets.json`), read through the confined-read checks (no
 * link out of the project, no hard link). Anything else is refused (400 `attachment-invalid`, its `problems` the refused
 * paths, so the composer drops exactly those). Duplicates are dropped.
 */
export async function checkAttachments(projectDir: string, paths: readonly string[]): Promise<string[]> {
  const unique = [...new Set(paths)];
  const bad: string[] = [];
  for (const p of unique) if (!(await isLibraryFile(projectDir, p))) bad.push(p);
  if (bad.length) {
    const err = new CodedError(400, bad.map((path) => t().errors.briefAssetNotFound({ path })).join(' '), 'attachment-invalid');
    err.problems = bad;
    throw err;
  }
  return unique;
}

/** Round 1 (finding 6): the attached files still in the library when a request put back in the queue starts (the others drop). */
export async function keptAttachments(projectDir: string, paths: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const p of new Set(paths)) if (await isLibraryFile(projectDir, p)) out.push(p);
  return out;
}
