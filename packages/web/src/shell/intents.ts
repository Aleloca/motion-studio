// One-shot navigation intents between the shell and a screen (the prototype's `focusNew`): set before navigating,
// consumed by the screen that owns the target once it is on the page.
import { useEffect, useRef } from 'react';

let newProject = false;
const listeners = new Set<() => void>();

/** "New project" from the project switcher: the Projects page focuses and flashes its name field. */
export function requestNewProject(): void {
  newProject = true;
  for (const l of listeners) l();
}

/** Runs `onIntent` once per request, now if one is pending or when it arrives while mounted. */
export function useNewProjectIntent(onIntent: () => void): void {
  const cb = useRef(onIntent);
  cb.current = onIntent;
  useEffect(() => {
    const take = () => {
      if (!newProject) return;
      newProject = false;
      cb.current();
    };
    take();
    listeners.add(take);
    return () => { listeners.delete(take); };
  }, []);
}

// "Use in a creative" from Assets: the assets wait here, by project, until that project's New creative page takes them.
const newCreativeAssets = new Map<string, string[]>();
const assetListeners = new Set<() => void>();

/**
 * Preselects `paths` (project paths, as stored in the brief: `assets/<file>`) on the next New creative page of `slug`.
 * Set it, then navigate to `href.newCreative(slug)`. A second request before the page takes the first adds to it.
 */
export function requestNewCreativeWithAssets(slug: string, paths: string[]): void {
  const prev = newCreativeAssets.get(slug) ?? [];
  newCreativeAssets.set(slug, [...prev, ...paths.filter((p) => !prev.includes(p))]);
  for (const l of assetListeners) l();
}

/** Runs `onAssets` with the pending paths of `slug`, now if a request is pending or when one arrives while mounted. */
export function useNewCreativeAssetsIntent(slug: string, onAssets: (paths: string[]) => void): void {
  const cb = useRef(onAssets);
  cb.current = onAssets;
  useEffect(() => {
    const take = () => {
      const paths = newCreativeAssets.get(slug);
      if (!paths) return;
      newCreativeAssets.delete(slug);
      if (paths.length > 0) cb.current(paths);
    };
    take();
    assetListeners.add(take);
    return () => { assetListeners.delete(take); };
  }, [slug]);
}

// Shared-element transitions (T3 board → editor, T4 back): the page that leaves stores the rect of the element the
// next page grows from, keyed by the target (`format:<project>/<creative>/<format>` for the format view,
// `canvas:<project>/<creative>/<format>` for the board on the way back). The next page takes it once, on mount.
const frameOrigins = new Map<string, DOMRect>();

export function setFrameOrigin(key: string, rect: DOMRect): void {
  frameOrigins.set(key, rect);
}

/** The stored rect for `key`, removed: a later visit of the same page starts without a shared element. */
export function takeFrameOrigin(key: string): DOMRect | null {
  const rect = frameOrigins.get(key) ?? null;
  frameOrigins.delete(key);
  return rect;
}

// The version on screen travels with T3/T4: a version picked on the canvas is the one the format view opens on, and
// back. Keyed by `<project>/<creative>`; the next page takes it once, on mount.
const shownVersions = new Map<string, number>();

export function setShownVersion(key: string, n: number | null): void {
  if (n === null) shownVersions.delete(key); else shownVersions.set(key, n);
}

/** The version picked on the page left behind, removed (null: follow the newest). */
export function takeShownVersion(key: string): number | null {
  const n = shownVersions.get(key) ?? null;
  shownVersions.delete(key);
  return n;
}
