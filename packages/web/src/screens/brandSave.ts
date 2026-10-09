// Autosave of the brand kit and guidelines (point 14, T12): every edit is saved through saveBrandKit / saveGuidelines
// with visible feedback (Saving… → Saved, or the error with Retry). Text edits are debounced; discrete edits (a role,
// a removal) save at once. One kit save is in flight at a time and the latest kit always wins.
import type { BrandKit } from '@motion-studio/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { message } from './common.tsx';

/** How long "Saved" stays before the pill leaves. */
export const SAVED_MS = 1800;
/** Debounce of typed edits (names, hex, family, texts). */
export const TYPING_MS = 600;

export type SaveTarget = 'kit' | 'guidelines';
export interface SaveStatus {
  saving: boolean;
  /** "Saved" is showing (it leaves after SAVED_MS). */
  saved: boolean;
  error: { target: SaveTarget; message: string } | null;
}

type KitUpdate = BrandKit | ((k: BrandKit) => BrandKit);

export interface BrandSaver {
  kit: BrandKit | null;
  status: SaveStatus;
  /** Applies an edit locally and saves it (after `wait` ms of quiet when given). */
  edit(next: KitUpdate, wait?: number): void;
  /** Saves a pending debounced edit now (a popover closed, a field lost focus). */
  flush(): void;
  saveGuidelines(text: string): Promise<boolean>;
  retry(): void;
  /**
   * The server changed the kit on its own (a proposal applied): with nothing local pending, `server` becomes the kit;
   * otherwise `rebase` is applied to the local kit so the pending save carries both.
   */
  rebase(server: BrandKit, rebase: (k: BrandKit) => BrandKit): void;
  /** A local edit is waiting or a save is in flight. */
  pending(): boolean;
}

/**
 * `onStale` is called after a save when a newer server kit arrived while edits were pending (and so was not taken):
 * the caller refetches, and the fresh kit reseeds once nothing is pending.
 */
export function useBrandSaver(slug: string, serverKit: BrandKit | null, onStale: () => void): BrandSaver {
  const [kit, setKit] = useState<BrandKit | null>(serverKit);
  const [status, setStatus] = useState<SaveStatus>({ saving: false, saved: false, error: null });
  const latest = useRef<BrandKit | null>(serverKit);
  const dirty = useRef(false);
  const kitInFlight = useRef(false);
  const inFlight = useRef(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorRetry = useRef<(() => void) | null>(null);
  /** A server kit was skipped because local edits were pending: reconcile after the next successful save. */
  const skipped = useRef(false);
  const onStaleRef = useRef(onStale);
  onStaleRef.current = onStale;

  // The server's kit replaces the local one only when nothing local is pending or in flight (no edit is ever lost).
  useEffect(() => {
    if (!serverKit) return;
    if (dirty.current || kitInFlight.current) { skipped.current = true; return; }
    latest.current = serverKit;
    setKit(serverKit);
  }, [serverKit]);

  const begin = () => {
    inFlight.current++;
    if (savedTimer.current) clearTimeout(savedTimer.current);
    setStatus((s) => ({ ...s, saving: true, saved: false }));
  };
  const finish = (target: SaveTarget, error: string | null, retry: () => void) => {
    inFlight.current--;
    if (error !== null) {
      errorRetry.current = retry;
      setStatus({ saving: inFlight.current > 0, saved: false, error: { target, message: error } });
      return;
    }
    const idle = inFlight.current === 0 && !dirty.current;
    setStatus((s) => ({ saving: !idle, saved: idle, error: s.error?.target === target ? null : s.error }));
    if (idle) {
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setStatus((s) => ({ ...s, saved: false })), SAVED_MS);
      if (target === 'kit' && skipped.current) { skipped.current = false; onStaleRef.current(); }
    }
  };

  const flushKit = useCallback(async (): Promise<void> => {
    if (debounce.current) { clearTimeout(debounce.current); debounce.current = null; }
    if (kitInFlight.current || !dirty.current || !latest.current) return;
    const sent = latest.current;
    dirty.current = false;
    kitInFlight.current = true;
    begin();
    let ok = true;
    try {
      await api.saveBrandKit(slug, sent);
      finish('kit', null, () => {});
    } catch (e) {
      ok = false;
      dirty.current = true;
      finish('kit', message(e), () => { void flushKit(); });
    } finally {
      kitInFlight.current = false;
    }
    // Edits made while this save was in flight go out now.
    if (ok && dirty.current) await flushKit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const edit = useCallback((next: KitUpdate, wait = 0) => {
    const base = latest.current;
    if (!base) return;
    const value = typeof next === 'function' ? next(base) : next;
    latest.current = value;
    setKit(value);
    dirty.current = true;
    if (debounce.current) clearTimeout(debounce.current);
    if (wait > 0) debounce.current = setTimeout(() => { void flushKit(); }, wait);
    else void flushKit();
  }, [flushKit]);

  const flush = useCallback(() => { if (debounce.current) void flushKit(); }, [flushKit]);

  const saveGuidelines = useCallback(async (text: string): Promise<boolean> => {
    begin();
    try {
      await api.saveGuidelines(slug, text);
      finish('guidelines', null, () => {});
      return true;
    } catch (e) {
      finish('guidelines', message(e), () => { void saveGuidelines(text); });
      return false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const retry = useCallback(() => { errorRetry.current?.(); }, []);

  const pending = useCallback(() => dirty.current || kitInFlight.current || debounce.current !== null, []);

  const rebase = useCallback((server: BrandKit, apply: (k: BrandKit) => BrandKit) => {
    if (!dirty.current && !kitInFlight.current) {
      latest.current = server;
      setKit(server);
      return;
    }
    // Local edits not on the server yet: put the server's change under them and let the pending save carry both.
    const value = apply(latest.current ?? server);
    latest.current = value;
    setKit(value);
    dirty.current = true;
    if (!kitInFlight.current && !debounce.current) void flushKit();
  }, [flushKit]);

  // Leaving the page: a pending typed edit is saved, not dropped.
  useEffect(() => () => {
    if (savedTimer.current) clearTimeout(savedTimer.current);
    if (debounce.current) void flushKit();
  }, [flushKit]);

  return { kit, status, edit, flush, saveGuidelines, retry, rebase, pending };
}
