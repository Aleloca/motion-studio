// The language switcher of the player and the editor preview (Phase 12): "Original" and the languages that have a translation of
// the format. A translation with outdated entries or problems flags those clips: a label per clip ("outdated", "outside the
// box") and the outline of the clip's drawn box over the frame.
import { useEffect, useState } from 'react';
import { useLocale, useT } from '../../i18n.tsx';
import type { CompositionMedia } from '../../components/CompositionPlayer.tsx';
import { Pill, Segmented, cx } from '../../ui/index.ts';
import { creativeLocales, localeName, type FlagKind } from './languagesModel.ts';
import type { LocalePreview } from './useLocalePreview.ts';
import type { Brief, LocaleTag, Messages } from '@motion-studio/shared';
import './languages.css';

const flagText = (k: FlagKind, l: Messages['web']['languages']): string =>
  k === 'stale' ? l.flagStale : k === 'overflow' ? l.flagOverflow : k === 'notTranslated' ? l.flagNotTranslated : k === 'voice' ? l.flagVoice : l.flagAsset;

export interface LocaleSwitcherProps { brief: Pick<Brief, 'locales'>; preview: LocalePreview; className?: string }

/** Nothing for a creative whose brief has no languages (old briefs): no control, no noise. */
export function LocaleSwitcher({ brief, preview, className }: LocaleSwitcherProps) {
  const t = useT();
  const l = t.web.languages;
  const ui = useLocale();
  const langs = creativeLocales(brief);
  if (!langs || langs.extra.length === 0) return null;
  const value = preview.locale ?? 'source';
  return (
    <div className={cx('ms-loc', className)}>
      <Segmented<LocaleTag | 'source'> label={l.previewLanguage} value={value} onChange={(v) => preview.select(v === 'source' ? null : v)}
        options={[
          { value: 'source', label: l.previewOriginal({ language: localeName(langs.primary, ui) }) },
          ...langs.extra.map((tag) => {
            const has = preview.available.includes(tag);
            return { value: tag, label: localeName(tag, ui), disabled: !has, ...(has ? {} : { title: l.statusNone }) };
          }),
        ]} />
      {preview.state === 'loading' ? <span className="ms-loc-state" role="status">{l.previewLoading}</span> : null}
      {preview.error ? <span className="ms-loc-error" role="alert">{l.previewFailed({ detail: preview.error })}</span> : null}
      {preview.flagged.length ? (
        <ul className="ms-loc-flags" aria-label={l.flaggedLabel}>
          {preview.flagged.map((f) => (
            <li key={f.clipId}>
              <button type="button" className={cx('ms-loc-flag', preview.focus === f.clipId && 'ms-on')} aria-pressed={preview.focus === f.clipId} title={f.messages.join(' · ') || undefined}
                onClick={() => preview.setFocus(f.clipId)} onMouseEnter={() => preview.setFocus(f.clipId)} onFocus={() => preview.setFocus(f.clipId)}>
                <span className="ms-loc-flag-name">{f.label}</span>
                <Pill tone="warn">{flagText(f.kind, l)}</Pill>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The outline of the flagged clip over the frame: the box the runtime reports for the selected clip (CSS pixels of the frame,
 * animations included), with the "outdated" or "outside the box" label on it. Put inside the frame's box.
 */
export function LocaleOutline({ player, preview }: { player: CompositionMedia | null; preview: LocalePreview }) {
  const l = useT().web.languages;
  const [reported, setReported] = useState(() => player?.clipBounds ?? null);
  useEffect(() => {
    if (!player) { setReported(null); return; }
    const on = () => setReported(player.clipBounds ? { ...player.clipBounds } : null);
    player.addEventListener('clipbounds', on);
    on();
    return () => player.removeEventListener('clipbounds', on);
  }, [player]);
  const flag = preview.flagged.find((f) => f.clipId === preview.focus);
  const box = flag && reported && reported.clipId === flag.clipId ? reported.bounds : null;
  if (!flag || !box) return null;
  return (
    <div className="ms-loc-outline-layer" aria-hidden="true">
      <span className={cx('ms-loc-outline', `ms-${flag.kind}`)} data-clip={flag.clipId} style={{ left: box.x, top: box.y, width: box.width, height: box.height }}>
        <span className="ms-loc-outline-label">{flagText(flag.kind, l)}</span>
      </span>
    </div>
  );
}
