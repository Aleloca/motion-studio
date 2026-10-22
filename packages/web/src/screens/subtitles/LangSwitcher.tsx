// The subtitle languages in the editor's header (Task 26, spec §6.3, §6.5, U8): the creative's subtitle languages (its own
// list, apart from the brief's), "+ Lingua" to add one (the brief's languages first) and the deletion of a language (the
// original speech only once no translation comes from it). Switching goes through the screen (`onSwitch`), which saves a waiting edit first.
import { SUPPORTED_LOCALES, type Brief, type JobSummary, type LocaleTag, type SubtitlesSummary } from '@motion-studio/shared';
import { useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../../api.ts';
import { message } from '../../errors.ts';
import { useLocale, useT } from '../../i18n.tsx';
import { Button, Icon, Popover, Segmented, Tooltip } from '../../ui/index.ts';
import { creativeLocales, localeName } from '../creative/languagesModel.ts';

/** The original video's speech set: made from speech, on the original audio (not a localized voice's, Task 24). */
export const isOriginalSpeech = (s: Pick<SubtitlesSummary, 'origin' | 'timing'>): boolean => s.origin === 'speech' && !s.timing.locale;

/**
 * Whether a set can be deleted: any but the original speech set, and that one too once no translation comes from it
 * (follow-up ruling of the final review).
 */
export const deletable = (s: Pick<SubtitlesSummary, 'lang' | 'origin' | 'timing'>, sets: ReadonlyArray<Pick<SubtitlesSummary, 'origin' | 'sourceLang'>>): boolean =>
  !isOriginalSpeech(s) || !sets.some((x) => x.origin === 'translation' && x.sourceLang === s.lang);

/**
 * The language the editor (and the creative page's "Sottotitoli") opens with no language named: the original speech set, else
 * the set in the brief's primary language, else the first one; null without sets.
 */
export function entrySubtitleLang(sets: readonly SubtitlesSummary[] | undefined, briefPrimary?: LocaleTag): LocaleTag | null {
  if (!sets?.length) return null;
  return (sets.find(isOriginalSpeech) ?? sets.find((s) => s.lang === briefPrimary) ?? sets[0]!).lang;
}

/** Final review T26: when each creative's language was last seen with its set (`slug/creative/lang`), on this client. */
const seenWithSet = new Map<string, number>();
/** Final review T26: the creative's subtitles job "+ Lingua" started for a language (its own voice), by `slug/creative/lang`. */
const startedFor = new Map<string, string>();
const langKey = (slug: string, creative: string, lang: string) => `${slug}/${creative}/${lang}`;

/** The creative's sets as just read: each language is seen with its set now (a job asked before is not making it again). */
export function noteSubtitleLangs(slug: string, creative: string, sets: ReadonlyArray<Pick<SubtitlesSummary, 'lang'>>): void {
  const now = Date.now();
  for (const x of sets) seenWithSet.set(langKey(slug, creative, x.lang), now);
}

/** "+ Lingua" started job `jobId` for `lang`: the creative's subtitles job is then that language's. */
export function noteLanguageJob(slug: string, creative: string, lang: LocaleTag, jobId: string): void {
  startedFor.set(langKey(slug, creative, lang), jobId);
}

/**
 * The job making `lang`'s subtitles, the latest one: its translation (`subtitles-translate:<root>:<project>:<creative>:<lang>`)
 * or the creative's subtitles job (`subtitles:<root>:<project>:<creative>`) when "+ Lingua" started it for this language (its
 * own voice). Final review T26: only a job asked since the language was last seen with its set (an older one made or failed
 * to make a set that is gone since).
 */
export function languageJob(jobs: Record<string, JobSummary>, slug: string, creative: string, lang: LocaleTag): JobSummary | null {
  const key = langKey(slug, creative, lang);
  const since = seenWithSet.get(key) ?? Number.NEGATIVE_INFINITY;
  const own = startedFor.get(key);
  const mine = (j: JobSummary) => ((j.key.startsWith('subtitles-translate:') && j.key.endsWith(`:${slug}:${creative}:${lang}`))
    || (j.id === own && j.key.startsWith('subtitles:') && j.key.endsWith(`:${slug}:${creative}`))) && Date.parse(j.createdAt) > since;
  return Object.values(jobs).filter(mine).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1) ?? null;
}

/** A language's name inside a sentence ("inglese", "English"), as the core writes it; its tag when unknown. */
export function inlineLangName(tag: string, ui: string): string {
  try { return new Intl.DisplayNames([ui], { type: 'language' }).of(tag) ?? tag; } catch { return tag; }
}

export interface LangSwitcherProps {
  slug: string;
  creative: string;
  /** The language shown. */
  lang: LocaleTag;
  sets: readonly SubtitlesSummary[];
  brief: Pick<Brief, 'locales'> | null;
  /** The lines of the shown language the user corrected (the editor's own count: unsaved edits included). */
  edited: number;
  /** Opens another language (the screen saves a waiting edit first). */
  onSwitch(lang: LocaleTag): Promise<void> | void;
  /** Leaves for `lang` without saving (the shown language was deleted). */
  onLeave(lang: LocaleTag | null): void;
}

export function LangSwitcher({ slug, creative, lang, sets, brief, edited, onSwitch, onLeave }: LangSwitcherProps) {
  const s = useT().subtitles;
  const locale = useLocale();
  // The route's language is listed even before its set exists (a translation on its way).
  const shown = sets.some((x) => x.lang === lang) ? sets : [...sets, null];
  // No stale counts here: a language's own editor counts what "Ritraduci tutto" acts on (the server's count also has the
  // lines the user corrected).
  const options = shown.map((x) => ({ value: x?.lang ?? lang, label: localeName(x?.lang ?? lang, locale) }));
  const current = sets.find((x) => x.lang === lang);
  return (
    <span className="ms-subs-langs">
      <Segmented<LocaleTag> label={s.languages} options={options} value={lang} onChange={(v) => void onSwitch(v)} className="ms-subs-lang-seg" />
      <AddLanguage slug={slug} creative={creative} sets={sets} brief={brief} onAdded={onSwitch} />
      {current && deletable(current, sets) ? <DeleteLanguage slug={slug} creative={creative} lang={lang} edited={edited}
        onDeleted={() => onLeave(entrySubtitleLang(sets.filter((x) => x.lang !== lang), creativeLocales(brief ?? {})?.primary))} /> : null}
    </span>
  );
}

/** "+ Lingua": the brief's languages without subtitles first, then every other supported one; picking one starts it. */
function AddLanguage({ slug, creative, sets, brief, onAdded }: { slug: string; creative: string; sets: readonly SubtitlesSummary[]; brief: Pick<Brief, 'locales'> | null; onAdded(lang: LocaleTag): Promise<void> | void }) {
  const s = useT().subtitles;
  const locale = useLocale();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<LocaleTag | null>(null);
  const [error, setError] = useState<string | null>(null);
  const groups = useMemo(() => {
    const have = new Set(sets.map((x) => x.lang));
    const fromBrief = (creativeLocales(brief ?? {})?.all ?? []).filter((l) => !have.has(l));
    const others = SUPPORTED_LOCALES.map((l) => l.tag as LocaleTag).filter((l) => !have.has(l) && !fromBrief.includes(l))
      .sort((a, b) => localeName(a, locale).localeCompare(localeName(b, locale), locale));
    return [{ title: s.addFromBrief, langs: fromBrief }, { title: s.addOthers, langs: others }].filter((g) => g.langs.length > 0);
  }, [sets, brief, locale, s]);
  const add = async (tag: LocaleTag) => {
    setBusy(tag);
    setError(null);
    try {
      const r = await api.addSubtitleLanguage(slug, creative, tag);
      if (r.job?.id) noteLanguageJob(slug, creative, tag, r.job.id);
    } catch (e) {
      // Already there (made meanwhile): it opens all the same.
      if (!(e instanceof ApiError && e.code === 'subtitles-lang-exists')) { setError(s.addFailed({ detail: message(e) })); setBusy(null); return; }
    }
    setBusy(null);
    setOpen(false);
    await onAdded(tag);
  };
  return (
    <>
      <Button ref={anchor} size="sm" variant="ghost" aria-haspopup="dialog" aria-expanded={open} onClick={() => { setError(null); setOpen((v) => !v); }}>{s.addLanguage}</Button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} placement="bottom-start" width={260} label={s.addLanguageTitle}>
        <div className="ms-subs-addlang">
          <b className="ms-subs-redo-title">{s.addLanguageTitle}</b>
          <p className="ms-subs-redo-hint">{s.addHint}</p>
          {error ? <p className="ms-subs-redo-error" role="alert">{error}</p> : null}
          {groups.map((g) => (
            <div key={g.title} className="ms-subs-addlang-group" role="group" aria-label={g.title}>
              <span className="ms-subs-addlang-title">{g.title}</span>
              {g.langs.map((tag) => (
                <Button key={tag} size="sm" variant="ghost" className="ms-subs-addlang-item" disabled={busy !== null} aria-busy={busy === tag || undefined}
                  onClick={() => void add(tag)}>{localeName(tag, locale)}</Button>
              ))}
            </div>
          ))}
        </div>
      </Popover>
    </>
  );
}

/**
 * The deletion of a language that is not the original speech: at once when no line of it was corrected, else after a
 * confirmation that says how many corrected lines go with it.
 */
function DeleteLanguage({ slug, creative, lang, edited, onDeleted }: { slug: string; creative: string; lang: LocaleTag; edited: number; onDeleted(): void }) {
  const s = useT().subtitles;
  const locale = useLocale();
  const anchor = useRef<HTMLButtonElement>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = inlineLangName(lang, locale);
  const label = s.deleteLanguage({ lang: name });
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteSubtitleLanguage(slug, creative, lang);
      setAsking(false);
      onDeleted();
    } catch (e) { setError(s.deleteFailed({ detail: message(e) })); }
    finally { setBusy(false); }
  };
  return (
    <>
      <Tooltip label={label}>
        <Button ref={anchor} size="sm" variant="ghost" icon aria-label={label} disabled={busy} aria-busy={busy || undefined}
          onClick={() => { setError(null); if (edited > 0) setAsking((v) => !v); else void remove(); }}><Icon name="trash" size={13} /></Button>
      </Tooltip>
      <Popover open={asking} onClose={() => setAsking(false)} anchor={anchor} placement="bottom-end" width={280} label={label}>
        <div className="ms-subs-redo">
          <b className="ms-subs-redo-title">{label}</b>
          <p className="ms-subs-redo-hint">{s.deleteConfirm({ lang: name, count: edited })}</p>
          {error ? <p className="ms-subs-redo-error" role="alert">{error}</p> : null}
          <span className="ms-subs-confirm">
            <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>{s.deleteNo}</Button>
            <Button size="sm" variant="danger" loading={busy} onClick={() => void remove()}>{s.deleteYes}</Button>
          </span>
        </div>
      </Popover>
      {error && !asking ? <span className="ms-subs-head-error" role="alert">{error}</span> : null}
    </>
  );
}
