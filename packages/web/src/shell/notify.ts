// Attention signals outside the page (spec §6.3): desktop notification and Dock badge through the preload bridge,
// with the web Notification API as the fallback.
import { desktop } from '../desktop.ts';

/** localStorage key of the "Notify me about approvals" setting (Settings → Notifications, Task 15). Default on. */
export const NOTIFY_APPROVALS_KEY = 'motion-studio.notifyApprovals';
export const APP_TITLE = 'Motion Studio';
/** The Dock badge (and the IPC validation in the main process) stop at 99. */
export const MAX_BADGE = 99;
/** The main process refuses longer notification texts (apps/desktop/src/notify.ts). */
export const MAX_TEXT = 200;

/** At most `max` UTF-16 units, ending with "…" when cut; never splits a surrogate pair. */
export function clip(text: string, max = MAX_TEXT): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

export function notifyApprovalsEnabled(): boolean {
  try { return localStorage.getItem(NOTIFY_APPROVALS_KEY) !== 'false'; } catch { return true; }
}
export function setNotifyApprovals(on: boolean): void {
  try { localStorage.setItem(NOTIFY_APPROVALS_KEY, String(on)); } catch { /* storage unavailable: keep the default */ }
}

/** localStorage key of the "Notify when a creative is ready" setting (Settings → Notifications). Default on. */
export const NOTIFY_READY_KEY = 'motion-studio.notifyReady';
export function notifyReadyEnabled(): boolean {
  try { return localStorage.getItem(NOTIFY_READY_KEY) !== 'false'; } catch { return true; }
}
export function setNotifyReady(on: boolean): void {
  try { localStorage.setItem(NOTIFY_READY_KEY, String(on)); } catch { /* storage unavailable: keep the default */ }
}

/** localStorage key of the "Play a sound" setting (Settings → Notifications). Default on. */
export const NOTIFY_SOUND_KEY = 'motion-studio.notifySound';
export function notifySoundEnabled(): boolean {
  try { return localStorage.getItem(NOTIFY_SOUND_KEY) !== 'false'; } catch { return true; }
}
export function setNotifySound(on: boolean): void {
  try { localStorage.setItem(NOTIFY_SOUND_KEY, String(on)); } catch { /* storage unavailable: keep the default */ }
}

/** The window is in the background: hidden, or visible without the focus. */
export function appInBackground(): boolean {
  try { return document.visibilityState === 'hidden' || !document.hasFocus(); } catch { return false; }
}

/** A failing bridge call must never break the page: errors are swallowed (sync throw or rejected promise). */
function quietly(call: () => unknown): void {
  try { void Promise.resolve(call()).catch(() => {}); } catch { /* ignored */ }
}

/**
 * What happened to a notification: `sent` (the system showed it: Electron's / the browser's 'show' event), `blocked` (the
 * system refused it, cannot show notifications, or did not confirm it in time; `detail` is the system's own message when
 * there is one), `unconfirmed` (a desktop app older than this check answers nothing), `skipped` (web: a focused page
 * already has the toast).
 */
export type NotificationResult = { state: 'sent' } | { state: 'blocked'; detail?: string } | { state: 'unconfirmed' } | { state: 'skipped' };
/** How long the web Notification may take to report 'show' (the desktop main process has its own, shorter wait). */
export const WEB_SHOW_TIMEOUT_MS = 5000;

function desktopResult(o: unknown): NotificationResult {
  if (!o || typeof o !== 'object' || !('shown' in o)) return { state: 'unconfirmed' };
  if ((o as { shown: unknown }).shown === true) return { state: 'sent' };
  const detail = (o as { detail?: unknown }).detail;
  return typeof detail === 'string' && detail ? { state: 'blocked', detail } : { state: 'blocked' };
}

/** A web Notification's outcome: 'show' → sent; 'error' or nothing within the timeout → blocked. */
function webResult(n: Notification): Promise<NotificationResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ state: 'blocked' }), WEB_SHOW_TIMEOUT_MS);
    n.onshow = () => { clearTimeout(timer); resolve({ state: 'sent' }); };
    n.onerror = () => { clearTimeout(timer); resolve({ state: 'blocked' }); };
  });
}

/**
 * Shows a notification and answers what the system did with it (used by the Settings test button; the automatic path
 * ignores it). Rejects only for a real error: a refused request, or (web) a missing permission or API, with the reason.
 * Desktop: the main process validates the arguments, plays the sound per `sound` and reports whether the system showed
 * it. Web: the Notification API needs the user's permission; the browser has no sound control, so `silent: !sound`.
 * `onlyAway` keeps the web rule "a focused page already has the toast".
 */
export async function sendNotification(raw: { title: string; body: string }, onlyAway = false): Promise<NotificationResult> {
  const p = { title: clip(raw.title), body: clip(raw.body), sound: notifySoundEnabled() };
  const d = desktop();
  if (typeof d?.notify === 'function') return desktopResult(await d.notify(p));
  if (typeof Notification === 'undefined') throw new Error('unsupported');
  if (Notification.permission !== 'granted') throw new Error(Notification.permission);
  const away = document.visibilityState === 'hidden' || !document.hasFocus();
  if (onlyAway && !away) return { state: 'skipped' };
  return webResult(new Notification(p.title, { body: p.body, silent: !p.sound }));
}

/**
 * Desktop: native notification from the main process, also with the window visible (the main process bounces the Dock
 * with it). Web: the Notification API when the user granted it and the page is hidden or not focused (on a focused page
 * the toast is enough). Texts are clipped to what the main process accepts. Failures are swallowed.
 */
export function showNotification(raw: { title: string; body: string }): void {
  quietly(() => sendNotification(raw, true));
}

export type NotificationStatus = 'ok' | 'unsupported' | 'default' | 'denied';
/** Whether notifications can be seen: the main process answers on desktop, `Notification.permission` on the web. */
export async function notificationStatus(): Promise<NotificationStatus> {
  const d = desktop();
  if (d) {
    if (typeof d.notifyStatus !== 'function') return 'ok';
    try { return (await d.notifyStatus()).supported ? 'ok' : 'unsupported'; } catch { return 'unsupported'; }
  }
  if (typeof Notification === 'undefined') return 'unsupported';
  const perm = Notification.permission;
  return perm === 'granted' ? 'ok' : perm === 'denied' ? 'denied' : 'default';
}

/** Subscribes to clicks on the desktop app's notifications (nothing on the web); returns the unsubscribe. */
export function onNotificationClick(cb: () => void): () => void {
  const d = desktop();
  if (typeof d?.onAttentionClick !== 'function') return () => {};
  try { return d.onAttentionClick(cb); } catch { return () => {}; }
}

/** Dock badge on desktop (0 clears it); nothing on the web, where the window title carries the count. */
export function setBadge(n: number): void {
  const d = desktop();
  if (typeof d?.setBadge === 'function') quietly(() => d.setBadge!(Math.max(0, Math.min(MAX_BADGE, Math.trunc(n)))));
}

/** Whether to offer "Turn on notifications" (web only: the desktop app notifies from the main process). */
export function canAskNotifications(): boolean {
  return !desktop() && typeof Notification !== 'undefined' && Notification.permission === 'default';
}
