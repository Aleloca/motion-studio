import { useSyncExternalStore } from 'react';

const KEY = 'motion-studio-ui-token';
const FRAGMENT = /^#t=([0-9a-f]{64})/;
let memory: string | null = null;
let pairing = false;
const listeners = new Set<() => void>();

/** Reads the token the terminal link carries (`#t=…`), keeps it and removes it from the address bar. Call before routing. */
export function captureUiToken(): void {
  const m = FRAGMENT.exec(location.hash);
  if (!m) return;
  memory = m[1]!;
  try { localStorage.setItem(KEY, memory); } catch { /* storage blocked: kept for this page only */ }
  history.replaceState(null, '', '#/');
}

export function uiToken(): string | null {
  if (memory) return memory;
  try { return localStorage.getItem(KEY); } catch { return null; }
}

/** The server refused the token: the UI can only be reopened from the link shown in the terminal. */
export function markPairingNeeded(): void {
  if (pairing) return;
  pairing = true;
  for (const l of listeners) l();
}
export const pairingNeeded = () => pairing;

export function usePairingNeeded(): boolean {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, pairingNeeded);
}

export function resetUiTokenForTests(): void { memory = null; pairing = false; for (const l of listeners) l(); }
