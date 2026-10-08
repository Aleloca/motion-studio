// Font specimens with the real font file (point 15): the file in the project is loaded through the FontFace API under
// a private family name, so the preview never depends on what happens to be installed on this computer.
import { useEffect, useState } from 'react';

export type FontPreview = { state: 'none' } | { state: 'loading' } | { state: 'ready'; family: string } | { state: 'failed' };

const loaded = new Map<string, Promise<string>>();
let seq = 0;

function load(url: string): Promise<string> {
  let p = loaded.get(url);
  if (!p) {
    const family = `ms-brand-font-${++seq}`;
    p = (async () => {
      if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) throw new Error('FontFace unavailable');
      const face = new FontFace(family, `url("${url.replace(/"/g, '%22')}")`);
      await face.load();
      document.fonts.add(face);
      return family;
    })();
    // A failure is not cached: the file may be fixed or uploaded again.
    p.catch(() => { if (loaded.get(url) === p) loaded.delete(url); });
    loaded.set(url, p);
  }
  return p;
}

/** Loads the font at `url` (a project file) and returns its preview state; `url` null → 'none'. */
export function useFontPreview(url: string | null): FontPreview {
  const [preview, setPreview] = useState<FontPreview>(url ? { state: 'loading' } : { state: 'none' });
  useEffect(() => {
    if (!url) { setPreview({ state: 'none' }); return; }
    let alive = true;
    setPreview({ state: 'loading' });
    load(url).then(
      (family) => { if (alive) setPreview({ state: 'ready', family }); },
      () => { if (alive) setPreview({ state: 'failed' }); },
    );
    return () => { alive = false; };
  }, [url]);
  return preview;
}

/** CSS font-family for a specimen: the loaded file, else the UI font (never the bare family name, which could be a local install). */
export const specimenFamily = (p: FontPreview) => (p.state === 'ready' ? `"${p.family}", var(--sans)` : 'var(--sans)');
