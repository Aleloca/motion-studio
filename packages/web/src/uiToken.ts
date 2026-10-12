import { useSyncExternalStore } from 'react';

const KEY = 'motion-studio-ui-token';
const FRAGMENT = /^#t=([0-9a-f]{64})/;
let memory: string | null = null;
let pairing = false;
const listeners = new Set<() => void>();
const tokenListeners = new Set<() => void>();
const notify = (set: Set<() => void>) => { for (const l of [...set]) l(); };

/**
 * Reads the token the terminal link carries (`#t=…`), keeps it and removes it from the address bar. Call before routing.
 * A new token also ends a pairing request and tells the listeners (e.g. the events socket reconnects). True when found.
 */
export function captureUiToken(): boolean {
  const m = FRAGMENT.exec(location.hash);
  if (!m) return false;
  memory = m[1]!;
  store(memory);
  history.replaceState(null, '', '#/');
  notify(tokenListeners);
  if (pairing) { pairing = false; notify(listeners); }
  return true;
}

/** A link pasted into an already open tab: registered before the router's own hashchange listener. */
export function listenForUiToken(): () => void {
  const on = () => { captureUiToken(); };
  addEventListener('hashchange', on);
  return () => removeEventListener('hashchange', on);
}

const TOKEN_RE = /^[0-9a-f]{64}$/;
const stored = (): string | null => { try { return localStorage.getItem(KEY); } catch { return null; } };
const store = (token: string) => { try { localStorage.setItem(KEY, token); } catch { /* storage blocked: kept for this page only */ } };

/**
 * Desktop: the token of the core this window was opened for, from the main process (final wave B3); null in a plain browser
 * or an older desktop build. It is the launch link's token, so it always wins over one left in localStorage.
 */
function desktopToken(): string | null {
  const b = (window as unknown as { motionStudio?: { isDesktop?: unknown; uiToken?: unknown } }).motionStudio;
  if (b?.isDesktop !== true || typeof b.uiToken !== 'function') return null;
  try { const v: unknown = (b.uiToken as () => unknown)(); return typeof v === 'string' && TOKEN_RE.test(v) ? v : null; } catch { return null; }
}

/** The token API calls carry: the captured link's, else the desktop's (a reload), else the stored one. */
export function uiToken(): string | null {
  if (memory) return memory;
  const d = desktopToken();
  if (d) { memory = d; store(d); return d; }
  return stored();
}

/**
 * The server refused `failed` (401 ui-token): takes a newer token when there is one (final wave B3: never a lockout while
 * the app knows a valid one), i.e. the desktop's current one, or one another tab stored from a new link. True when the
 * caller can retry with `uiToken()`; false: nothing newer, the user must reopen the app from its link.
 */
export function renewUiToken(failed: string | null): boolean {
  const fresh = desktopToken() ?? stored();
  if (!fresh || fresh === failed) return false;
  if (fresh !== memory) {
    memory = fresh;
    store(fresh);
    notify(tokenListeners);
  }
  if (pairing) { pairing = false; notify(listeners); }
  return true;
}

/** Called whenever a new token is captured. */
export function onUiTokenChange(l: () => void): () => void {
  tokenListeners.add(l);
  return () => { tokenListeners.delete(l); };
}

/** The server refused the token: the UI can only be reopened from the link shown in the terminal. */
export function markPairingNeeded(): void {
  if (pairing) return;
  pairing = true;
  notify(listeners);
}
export const pairingNeeded = () => pairing;

export function usePairingNeeded(): boolean {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, pairingNeeded);
}

export function resetUiTokenForTests(): void { memory = null; pairing = false; notify(listeners); }
