import type { useT } from '../i18n.tsx';
import { message } from '../errors.ts';

type T = ReturnType<typeof useT>;

/** The core's machine-readable reason of an API error (duck-typed: any thrown value may carry one). */
const codeOf = (e: unknown): string | undefined => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
};

/**
 * Why a live message, a queue change or a redirect was refused, in the user's language. The core already answers in the
 * app's language, and says the limits itself (`limit`: too long, too many messages in a turn, queue full: the numbers
 * come from the core); the codes that have a fixed meaning are read from this catalog.
 */
export function liveErrorText(e: unknown, t: T): string {
  switch (codeOf(e)) {
    case 'not-queued': return t.live.notQueued;
    case 'queue-changed': return t.live.queueChanged;
    case 'queue-empty': return t.live.queueEmpty;
    case 'redirect-unsupported': return t.live.redirectUnsupported;
    case 'live-off': return t.live.consoleLiveOff;
    default: return message(e);
  }
}

/** A fresh client message id (the core de-duplicates on it, so a double click or a retry is one message). */
export function newClientId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (typeof c?.getRandomValues === 'function') c.getRandomValues(b); else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
