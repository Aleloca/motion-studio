// The language shown by a preview (Phase 12, spec §3.3): the localized composition (the overlay applied by the core, outdated
// entries keep the source text) is sent to the live player with `setComposition`, after the core is told to serve the
// translation's fallback fonts and voices under the session (hash-checked there). The overlay's stored problems and outdated
// entries come back with it, to flag the clips. Back to the original: the base composition is sent again.
import type { Composition, LocaleTag, LocalizationRow } from '@motion-studio/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type LocalizedCompositionView } from '../../api.ts';
import type { CompositionMedia } from '../../components/CompositionPlayer.tsx';
import { message } from '../../errors.ts';
import { flaggedClips, type FlaggedClip } from './languagesModel.ts';

export interface LocalePreviewOptions {
  slug: string; creative: string;
  /** The version and the format instance shown; null: nothing to show (the preview is off). */
  n: number | null; format: string;
  /** The version's translations: the languages with a row for `format` can be shown. */
  rows: readonly LocalizationRow[];
  player: CompositionMedia | null;
  /** The token of the live preview session the player shows. */
  token: string | null;
  /** The composition to show again for the original language (the editor's draft, else fetched). */
  original?(): Composition | null;
}

export interface LocalePreview {
  /** The language shown; null: the original. */
  locale: LocaleTag | null;
  select(tag: LocaleTag | null): void;
  state: 'idle' | 'loading' | 'ready' | 'failed';
  error: string | null;
  /** Languages that can be shown for this format (a translation exists). */
  available: LocaleTag[];
  /** The clips of the language shown that are outdated or overflowing. */
  flagged: FlaggedClip[];
  /** The flagged clip whose box is outlined. */
  focus: string | null;
  setFocus(clipId: string | null): void;
}

export function useLocalePreview(o: LocalePreviewOptions): LocalePreview {
  const { slug, creative, n, format, rows, player, token } = o;
  const [locale, setLocale] = useState<LocaleTag | null>(null);
  const [state, setState] = useState<LocalePreview['state']>('idle');
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<LocalizedCompositionView | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const original = useRef(o.original);
  original.current = o.original;
  const available = useMemo(() => [...new Set(rows.filter((r) => r.instanceId === format).map((r) => r.locale))], [rows, format]);
  const rowHash = rows.find((r) => r.locale === locale && r.instanceId === format)?.hash ?? null;

  // Another version or format: back to the original.
  useEffect(() => { setLocale(null); setView(null); setError(null); setState('idle'); setFocus(null); }, [slug, creative, n, format]);

  useEffect(() => {
    if (locale === null || n === null || !player || !token) return;
    let alive = true;
    setState('loading'); setError(null);
    Promise.resolve()
      .then(() => api.getLocalizedComposition(slug, creative, n, format, locale))
      // The fonts and voices first: the frame asks for them as soon as it shows the composition.
      .then(async (v) => { await api.attachLocalePreview(slug, creative, n, locale, format, token); return v; })
      .then((v) => { if (!alive) return; player.setComposition(v.composition); setView(v); setState('ready'); })
      .catch((e: unknown) => { if (alive) { setState('failed'); setError(message(e)); } });
    return () => { alive = false; };
  }, [locale, slug, creative, n, format, player, token, rowHash]);

  const select = useCallback((tag: LocaleTag | null) => {
    setLocale(tag);
    setFocus(null);
    if (tag !== null) return;
    setView(null); setState('idle'); setError(null);
    player?.select(null);
    const base = original.current?.() ?? null;
    if (base && player) { player.setComposition(base); return; }
    if (player && n !== null) {
      void Promise.resolve().then(() => api.getEditorComposition(slug, creative, n, format)).then((v) => { player.setComposition(v.composition); }).catch((e: unknown) => setError(message(e)));
    }
  }, [player, slug, creative, n, format]);

  const flagged = useMemo(() => {
    if (!view) return [];
    const clips = view.composition.tracks.flatMap((t) => t.clips.map((c) => ({ clipId: c.id, ...(c.name !== undefined ? { name: c.name } : {}) })));
    return flaggedClips({ stale: view.localization.stale, problems: view.localization.problems, ...(view.localization.issues ? { issues: view.localization.issues } : {}), clips });
  }, [view]);

  // The first flagged clip is outlined by default; the person moves on to the others from the list.
  const first = flagged[0]?.clipId ?? null;
  const shownFocus = focus !== null && flagged.some((f) => f.clipId === focus) ? focus : first;
  useEffect(() => { if (player && locale !== null) player.select(shownFocus); }, [player, locale, shownFocus]);
  useEffect(() => () => { player?.select(null); }, [player]);

  return { locale, select, state, error, available, flagged, focus: shownFocus, setFocus };
}
