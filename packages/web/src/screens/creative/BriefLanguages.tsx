// The languages of the brief (Phase 12, spec §3.1): the primary language and up to ten extra ones from the curated list. The
// right-to-left languages are listed disabled, each with the reason (not supported yet). With no primary language chosen the
// creative is not localized, and this is a single quiet field: no extra controls for an old brief.
import { SUPPORTED_LOCALES, type Brief, type LocaleTag } from '@motion-studio/shared';
import { useId } from 'react';
import { useLocale, useT } from '../../i18n.tsx';
import { Chip, Select } from '../../ui/index.ts';
import { localeName, RTL_CHOICES } from './languagesModel.ts';

/** At most this many extra languages (the brief schema's limit). */
export const MAX_EXTRA_LOCALES = 10;
type Locales = NonNullable<Brief['locales']>;

export function BriefLanguages({ value, onChange, disabled }: { value: Brief['locales'] | undefined; onChange(next: Locales | undefined): void; disabled?: boolean }) {
  const t = useT();
  const l = t.web.languages;
  const ui = useLocale();
  const hintId = useId();
  const ordered = [...SUPPORTED_LOCALES].sort((a, b) => localeName(a.tag, ui).localeCompare(localeName(b.tag, ui), ui));
  const pick = (v: string) => {
    if (v === '') { onChange(undefined); return; }
    const primary = v as LocaleTag;
    onChange({ primary, extra: (value?.extra ?? []).filter((x) => x !== primary) });
  };
  const toggle = (tag: LocaleTag) => {
    if (!value) return;
    const has = value.extra.includes(tag);
    onChange({ primary: value.primary, extra: has ? value.extra.filter((x) => x !== tag) : [...value.extra, tag] });
  };
  const full = (value?.extra.length ?? 0) >= MAX_EXTRA_LOCALES;
  return (
    <div className="ms-brief-langs">
      <span className="ms-brief-lbl">{l.briefTitle}</span>
      <p className="ms-brief-hint" id={hintId}>{l.briefHint}</p>
      <Select<string> label={l.briefPrimary} value={value?.primary ?? ''} disabled={disabled} onChange={pick}
        options={[{ value: '', label: l.briefNone }, ...ordered.map((x) => ({ value: x.tag, label: localeName(x.tag, ui) }))]} />
      {value ? (
        <>
          <span className="ms-brief-lbl">{l.briefExtra({ count: value.extra.length, max: MAX_EXTRA_LOCALES })}</span>
          <div className="ms-brief-chips" role="group" aria-label={l.briefExtraLabel}>
            {ordered.filter((x) => x.tag !== value.primary).map((x) => {
              const on = value.extra.includes(x.tag);
              return (
                <Chip key={x.tag} on={on} disabled={disabled || (!on && full)} title={!on && full ? l.briefFull({ max: MAX_EXTRA_LOCALES }) : undefined} onClick={() => toggle(x.tag)}>
                  {localeName(x.tag, ui)}
                </Chip>
              );
            })}
            {RTL_CHOICES.map((tag) => (
              <Chip key={tag} disabled title={l.briefRtl} onClick={() => {}}>{localeName(tag, ui)}</Chip>
            ))}
          </div>
          <p className="ms-brief-hint ms-brief-rtl">{l.briefRtl}</p>
        </>
      ) : null}
    </div>
  );
}
