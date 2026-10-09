// Attention signals for approvals (spec §6.3): native notification with one Dock bounce, Dock badge. The renderer asks through
// ms:notify / ms:badge; arguments are validated here, and only the app's own main frame may ask (same guard as the
// other IPC handlers).
import type { IpcMainInvokeEvent } from 'electron';

/** `sound` is optional; absent means the system default sound (on). */
export interface NotifyArgs { title: string; body: string; sound?: boolean }
/** Longest title or body accepted from the renderer. */
export const MAX_TEXT = 200;
export const MAX_BADGE = 99;

const text = (v: unknown, min: number): v is string => typeof v === 'string' && v.length >= min && v.length <= MAX_TEXT;

/** `{ title, body }` with a 1–200 character title and a body of at most 200 characters, else null. */
export function notifyArgs(arg: unknown): NotifyArgs | null {
  if (!arg || typeof arg !== 'object' || Array.isArray(arg)) return null;
  const { title, body, sound } = arg as Record<string, unknown>;
  if (!text(title, 1) || !text(body, 0)) return null;
  if (sound === undefined) return { title, body };
  return typeof sound === 'boolean' ? { title, body, sound } : null; // strict boolean: "false", 0, null are refused
}

/** The macOS sound name; `sound` is a darwin-only Electron option (Windows and Linux ignore it). */
export const MAC_SOUND = 'Glass';

export interface NotificationOptions { title: string; body: string; silent: boolean; sound?: string }
/**
 * Electron options for a validated request. Sound on: `silent: false` (the system default sound where the platform
 * supports it: Windows toast sound, Linux notification daemon) plus the named sound on macOS. Sound off: `silent: true`.
 */
export function notificationOptions(a: NotifyArgs, platform: string): NotificationOptions {
  const on = a.sound !== false;
  return { title: a.title, body: a.body, silent: !on, ...(on && platform === 'darwin' ? { sound: MAC_SOUND } : {}) };
}

/** An integer from 0 to 99, else null. */
export function badgeArg(arg: unknown): number | null {
  return typeof arg === 'number' && Number.isInteger(arg) && arg >= 0 && arg <= MAX_BADGE ? arg : null;
}

/**
 * What the system did with a notification. `shown`: the OS accepted it (Electron's 'show' event). Otherwise `failed` (the
 * 'failed' event, with the system's reason: on macOS a development build of Electron is refused with "UNErrorDomain
 * error 1"), `timeout` (no 'show' within SHOW_TIMEOUT_MS, e.g. a permission prompt left unanswered) or `unsupported`.
 */
export type NotifyOutcome = { shown: true } | { shown: false; reason: 'failed' | 'timeout' | 'unsupported'; detail?: string };
/** How long to wait for the system to confirm a notification. */
export const SHOW_TIMEOUT_MS = 5000;

export interface DockLike { setBadge(text: string): void; bounce(type: 'informational' | 'critical'): number }
export interface AttentionDeps {
  /** The IPC origin guard shared with the other handlers. */
  trusted(e: IpcMainInvokeEvent): boolean;
  /** Notification.isSupported() of the main process. */
  isSupported(): boolean;
  /** Shows the notification and answers what the system did with it. */
  showNotification(args: NotifyArgs): Promise<NotifyOutcome>;
  /** macOS only (app.dock). */
  dock: DockLike | undefined;
  invalid(): Error;
}

/**
 * The renderer decides what is an arrival: it calls ms:notify once per new request (never for the requests already
 * waiting at startup), and the Dock bounces with that notification. ms:badge only mirrors the count, so restoring the
 * badge at startup or after a reconnect never bounces.
 */
export function attentionHandlers(d: AttentionDeps) {
  return {
    /** Throws on an untrusted sender or invalid arguments; otherwise answers the outcome (never an error for it). */
    notify(e: IpcMainInvokeEvent, arg: unknown): Promise<NotifyOutcome> {
      const args = d.trusted(e) ? notifyArgs(arg) : null;
      if (!args) throw d.invalid();
      if (!d.isSupported()) return Promise.resolve({ shown: false, reason: 'unsupported' });
      const outcome = d.showNotification(args);
      d.dock?.bounce('informational');
      return outcome;
    },
    /** Whether the main process can show notifications at all (origin-checked, no argument). */
    status(e: IpcMainInvokeEvent): { supported: boolean } {
      if (!d.trusted(e)) throw d.invalid();
      return { supported: d.isSupported() };
    },
    badge(e: IpcMainInvokeEvent, arg: unknown): void {
      const n = d.trusted(e) ? badgeArg(arg) : null;
      if (n === null) throw d.invalid();
      d.dock?.setBadge(n ? String(n) : '');
    },
  };
}

export function registerAttention(ipc: { handle(channel: string, fn: (e: IpcMainInvokeEvent, arg: unknown) => unknown): void }, d: AttentionDeps): void {
  const h = attentionHandlers(d);
  ipc.handle('ms:notify', h.notify);
  ipc.handle('ms:notify-status', h.status);
  ipc.handle('ms:badge', h.badge);
}

/** Main → page: a notification of the app was clicked (the page runs its "Review", as on the toast). */
export const ATTENTION_CLICK = 'ms:attention-click';

export interface NativeNotification {
  /** 'failed' passes (event, error string); the others pass nothing we use. */
  on(event: 'click' | 'close' | 'show' | 'failed', fn: (...args: unknown[]) => void): unknown;
  show(): void;
}

/**
 * Shows `n` and keeps a reference to it until it is clicked, closed or fails: a Notification object that is garbage
 * collected loses its click handler (Electron), so a click on an older banner would do nothing. Resolves with what the
 * system did: 'show' → shown, 'failed' → failed with the system's reason, nothing within `timeoutMs` → timeout.
 */
export function showKept<N extends NativeNotification>(live: Set<N>, n: N, onClick: () => void, timeoutMs = SHOW_TIMEOUT_MS): Promise<NotifyOutcome> {
  live.add(n);
  const drop = () => { live.delete(n); };
  return new Promise<NotifyOutcome>((resolve) => {
    let done = false;
    const settle = (o: NotifyOutcome) => { if (done) return; done = true; clearTimeout(timer); resolve(o); };
    const timer = setTimeout(() => settle({ shown: false, reason: 'timeout' }), timeoutMs);
    n.on('click', () => { drop(); onClick(); });
    n.on('close', drop);
    n.on('show', () => settle({ shown: true }));
    n.on('failed', (_e: unknown, error: unknown) => {
      drop();
      const detail = typeof error === 'string' ? error.slice(0, MAX_TEXT) : '';
      settle(detail ? { shown: false, reason: 'failed', detail } : { shown: false, reason: 'failed' });
    });
    n.show();
  });
}

export interface ClickTarget { isDestroyed(): boolean; getURL(): string; send(channel: string): void }

/**
 * Tells the page about a notification click, only while the window shows the app itself (the origin guard of the
 * invoke handlers, the other way round). No data goes with it. Returns whether it was sent.
 */
export function sendAttentionClick(wc: ClickTarget, isApp: (url: string) => boolean): boolean {
  if (wc.isDestroyed() || !isApp(wc.getURL())) return false;
  wc.send(ATTENTION_CLICK);
  return true;
}
