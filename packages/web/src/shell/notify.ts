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

/** The window is in the background: hidden, or visible without the focus. */
export function appInBackground(): boolean {
  try { return document.visibilityState === 'hidden' || !document.hasFocus(); } catch { return false; }
}

/** A failing bridge call must never break the page: errors are swallowed (sync throw or rejected promise). */
function quietly(call: () => unknown): void {
  try { void Promise.resolve(call()).catch(() => {}); } catch { /* ignored */ }
}

/**
 * Desktop: native notification from the main process, also with the window visible (the main process bounces the Dock
 * with it). Web: the Notification API when the user granted it and the page is hidden or not focused (on a focused page
 * the toast is enough). Texts are clipped to what the main process accepts.
 */
export function showNotification(raw: { title: string; body: string }): void {
  const p = { title: clip(raw.title), body: clip(raw.body) };
  const d = desktop();
  if (typeof d?.notify === 'function') { quietly(() => d.notify!(p)); return; }
  try {
    const away = document.visibilityState === 'hidden' || !document.hasFocus();
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && away) {
      new Notification(p.title, { body: p.body });
    }
  } catch { /* some browsers only allow notifications from a service worker */ }
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
