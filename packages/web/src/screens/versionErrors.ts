// Errors of the per-format version actions (★ picks, links, targeted turns): the core's stable `code` mapped to a clear
// message in the user's language, and the automatic retry of a pick refused while old versions are still being hashed.
import type { LinkReason } from '@motion-studio/shared';
import type { useT } from '../i18n.tsx';
import { message } from './common.tsx';

type T = ReturnType<typeof useT>;

/** The core's machine-readable reason of an API error (duck-typed: any thrown value may carry one). */
export const errorCode = (e: unknown): string | undefined => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
};

/** Default wait before retrying `hashes-pending` without a usable `Retry-After`. */
export const HASH_RETRY_SEC = 5;
/** Never wait longer than this between two tries, whatever the server says. */
const HASH_RETRY_MAX_SEC = 15;
/** Automatic retries of a `hashes-pending` refusal before giving up with a calm message. */
export const HASH_RETRIES = 2;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A wait for `withHashRetry` that an abort (the page or the dialog going away) cuts short, rejecting with its reason. */
export const abortableWait = (signal: AbortSignal) => (ms: number) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const id = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(id); reject(signal.reason); }, { once: true });
});

/**
 * Runs `fn`, retrying it after the server's `Retry-After` (at most HASH_RETRIES times) while it answers `hashes-pending`
 * (the core is still hashing old versions in the background). The last error is thrown when it never succeeds.
 */
export async function withHashRetry<T>(fn: () => Promise<T>, wait: (ms: number) => Promise<void> = sleep): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (errorCode(e) !== 'hashes-pending' || attempt >= HASH_RETRIES) throw e;
      const after = (e as { retryAfterSec?: unknown }).retryAfterSec;
      const sec = typeof after === 'number' && Number.isFinite(after) && after >= 0 ? Math.min(after, HASH_RETRY_MAX_SEC) : HASH_RETRY_SEC;
      await wait(sec * 1000);
    }
  }
}

export interface VersionErrorContext {
  /** The format acted on (its display label). */
  label: string;
  /** The primary involved (its display label): the one a follower follows, or the one being linked to. */
  primary?: string;
  /** The version involved. */
  n?: number;
  /** Why a link is refused, when the UI knows it (from the format summary). */
  reason?: LinkReason;
}

/** A clear, translated message for a failed version action; unknown errors keep the server's explanation. */
export function versionErrorText(e: unknown, t: T, ctx: VersionErrorContext): string {
  const x = t.web.formatVersions.errors;
  const primary = ctx.primary ?? '';
  switch (errorCode(e)) {
    case 'hashes-pending': return x.hashesPending;
    case 'pick-follower': return x.pickFollower({ label: ctx.label, primary });
    case 'format-not-in-brief': return x.notInBrief({ label: ctx.label });
    case 'pick-no-file': return x.pickNoFile({ label: ctx.label, n: ctx.n ?? 0 });
    case 'pick-file-missing': return x.pickFileMissing({ label: ctx.label, n: ctx.n ?? 0 });
    case 'version-not-found': return ctx.n !== undefined ? x.versionNotFound({ n: ctx.n }) : x.failed({ detail: message(e) });
    case 'link-self': return x.linkSelf;
    case 'link-chain': return x.linkChain({ label: ctx.label, primary });
    case 'link-incompatible':
      // The reason the UI knows, translated; otherwise the server's own sentence (already in the user's language).
      return ctx.reason ? x.linkIncompatible({ label: ctx.label, primary, reason: t.errors.followReason[ctx.reason] }) : message(e);
    case 'job-running': return x.jobRunning;
    case 'formats-not-in-brief': return x.formatsNotInBrief;
    default: return x.failed({ detail: message(e) });
  }
}

/** A clear, translated message for a failed export (the core's `export-*` codes); other errors keep the server's explanation. */
export function exportErrorText(e: unknown, t: T): string {
  const x = t.web.exportUi.errors;
  // The server's own sentence (in the user's language) names the files or names involved: kept, with the hint.
  const detail = message(e);
  switch (errorCode(e)) {
    case 'hashes-pending': return t.web.formatVersions.errors.hashesPending;
    case 'export-invalid-picks': return x.invalidPicks;
    case 'export-pick-follower': return x.pickFollower;
    case 'export-pick-no-file': return x.pickNoFile({ detail });
    case 'export-follow-mismatch': return x.followMismatch({ detail });
    case 'export-file-missing': return x.fileMissing({ detail });
    case 'export-name-collision': return x.nameCollision({ detail });
    case 'export-name-empty': return x.nameEmpty;
    case 'export-invalid-pattern': return x.invalidPattern;
    case 'export-invalid-destination': return x.invalidDestination;
    case 'export-invalid-date': return x.invalidDate;
    default: return detail;
  }
}
