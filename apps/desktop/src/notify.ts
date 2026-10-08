// Attention signals for approvals (spec §6.3): native notification, Dock badge and bounce. The renderer asks through
// ms:notify / ms:badge; arguments are validated here, and only the app's own main frame may ask (same guard as the
// other IPC handlers).
import type { IpcMainInvokeEvent } from 'electron';

export interface NotifyArgs { title: string; body: string }
/** Longest title or body accepted from the renderer. */
export const MAX_TEXT = 200;
export const MAX_BADGE = 99;

const text = (v: unknown, min: number): v is string => typeof v === 'string' && v.length >= min && v.length <= MAX_TEXT;

/** `{ title, body }` with a 1–200 character title and a body of at most 200 characters, else null. */
export function notifyArgs(arg: unknown): NotifyArgs | null {
  if (!arg || typeof arg !== 'object' || Array.isArray(arg)) return null;
  const { title, body } = arg as Record<string, unknown>;
  return text(title, 1) && text(body, 0) ? { title, body } : null;
}

/** An integer from 0 to 99, else null. */
export function badgeArg(arg: unknown): number | null {
  return typeof arg === 'number' && Number.isInteger(arg) && arg >= 0 && arg <= MAX_BADGE ? arg : null;
}

export interface DockLike { setBadge(text: string): void; bounce(type: 'informational' | 'critical'): number }
export interface AttentionDeps {
  /** The IPC origin guard shared with the other handlers. */
  trusted(e: IpcMainInvokeEvent): boolean;
  showNotification(args: NotifyArgs): void;
  /** macOS only (app.dock). */
  dock: DockLike | undefined;
  invalid(): Error;
}

export function attentionHandlers(d: AttentionDeps) {
  let last = 0;
  return {
    notify(e: IpcMainInvokeEvent, arg: unknown): void {
      const args = d.trusted(e) ? notifyArgs(arg) : null;
      if (!args) throw d.invalid();
      d.showNotification(args);
    },
    badge(e: IpcMainInvokeEvent, arg: unknown): void {
      const n = d.trusted(e) ? badgeArg(arg) : null;
      if (n === null) throw d.invalid();
      d.dock?.setBadge(n ? String(n) : '');
      // One bounce when something new needs the user, not on every refresh of the same count.
      if (n > last) d.dock?.bounce('informational');
      last = n;
    },
  };
}

export function registerAttention(ipc: { handle(channel: string, fn: (e: IpcMainInvokeEvent, arg: unknown) => unknown): void }, d: AttentionDeps): void {
  const h = attentionHandlers(d);
  ipc.handle('ms:notify', h.notify);
  ipc.handle('ms:badge', h.badge);
}
