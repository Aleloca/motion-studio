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
