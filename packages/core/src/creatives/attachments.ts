import { z } from 'zod';
import { CodedError } from '../workspace-store.ts';
import { probeConfinedFile } from '../brand/agent-guard.ts';
import { t } from '../i18n.ts';

/** Report 79: at most this many library files go with one message. */
export const MAX_ATTACHMENTS = 20;

/** A message's attached files as the request carries them: project paths (`assets/…`), no control characters. */
export const attachmentsSchema = z.array(z.string().min(1).max(1024).refine((s) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(s))).max(MAX_ATTACHMENTS);

/**
 * Report 79: the files attached to a creative message, checked: each is a regular file of the project library (`assets/…`,
 * no `.`, `..`, empty or hidden segment, not the library's own `assets.json`), read through the confined-read checks (no
 * link out of the project). Anything else is refused (400 `attachment-invalid`). Duplicates are dropped.
 */
export async function checkAttachments(projectDir: string, paths: readonly string[]): Promise<string[]> {
  const unique = [...new Set(paths)];
  for (const p of unique) {
    const parts = p.split('/');
    const ok = parts.length >= 2 && parts[0] === 'assets' && p !== 'assets/assets.json'
      && parts.every((s) => s !== '' && s !== '.' && s !== '..' && !s.startsWith('.') && !s.includes('\\'))
      && (await probeConfinedFile(projectDir, p).catch(() => null)) === true;
    if (!ok) throw new CodedError(400, t().errors.briefAssetNotFound({ path: p }), 'attachment-invalid');
  }
  return unique;
}
