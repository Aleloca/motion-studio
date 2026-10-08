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
  try { localStorage.setItem(KEY, memory); } catch { /* storage blocked: kept for this page only */ }
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

export function uiToken(): string | null {
  if (memory) return memory;
  try { return localStorage.getItem(KEY); } catch { return null; }
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
