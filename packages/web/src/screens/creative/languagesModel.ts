// The model of the Languages UI (Phase 12, Task 5): names of languages, the status of a translation, why a voice cannot be
// translated, which problems belong to which clip. Pure functions, no React.
import {
  effectiveServices, isRtlLocale, missingCapability, RTL_LOCALES, SUPPORTED_LOCALES,
  type Brief, type KeyCheckResult, type Locale, type LocaleTag, type LocalizationRow, type Messages, type ProviderId,
} from '@motion-studio/shared';

/** The languages a creative has (`brief.locales`), or null for a creative that is not localized (old briefs). */
export function creativeLocales(brief: Pick<Brief, 'locales'>): { primary: LocaleTag; extra: LocaleTag[]; all: LocaleTag[] } | null {
  const l = brief.locales;
  if (!l) return null;
  return { primary: l.primary, extra: l.extra, all: [l.primary, ...l.extra] };
}

/** The name of a language in the UI language (Intl); the English name of the curated list when Intl does not know the tag. */
export function localeName(tag: string, ui: Locale): string {
  try {
    const name = new Intl.DisplayNames([ui], { type: 'language' }).of(tag);
    if (name && name !== tag) return name.charAt(0).toLocaleUpperCase(ui) + name.slice(1);
  } catch { /* an unknown tag: the list's name below */ }
  return SUPPORTED_LOCALES.find((x) => x.tag === tag)?.name ?? tag;
}

/** The right-to-left languages the picker shows disabled (name, tag): not supported in this phase. */
export const RTL_CHOICES: readonly string[] = RTL_LOCALES;
export { isRtlLocale };

export type RowStatus = { kind: 'none' } | { kind: 'ok' } | { kind: 'stale'; count: number } | { kind: 'problems'; count: number } | { kind: 'both'; stale: number; problems: number };

/** The state of one translation (a row of a version): not translated, up to date, n outdated, n problems. */
export function rowStatus(row: Pick<LocalizationRow, 'stale' | 'problems'> | undefined): RowStatus {
  if (!row) return { kind: 'none' };
  const stale = row.stale.length;
  const problems = row.problems?.length ?? 0;
  if (stale && problems) return { kind: 'both', stale, problems };
  if (stale) return { kind: 'stale', count: stale };
  if (problems) return { kind: 'problems', count: problems };
  return { kind: 'ok' };
}

export function statusText(s: RowStatus, t: Messages): string {
  const l = t.web.languages;
  switch (s.kind) {
    case 'none': return l.statusNone;
    case 'ok': return l.statusOk;
    case 'stale': return l.statusStale({ count: s.count });
    case 'problems': return l.statusProblems({ count: s.count });
    case 'both': return `${l.statusStale({ count: s.stale })} · ${l.statusProblems({ count: s.problems })}`;
  }
}

export type VoiceReason = 'off' | 'noKey' | 'missingPermission' | 'declined' | 'failed';

const VOICE_PROVIDERS: Record<'auto' | 'openai' | 'elevenlabs', ProviderId[]> = { auto: ['openai', 'elevenlabs'], openai: ['openai'], elevenlabs: ['elevenlabs'] };

/**
 * Why the voices of a language cannot be translated right now, or null when they can (as far as the UI knows): the brief's
 * voice service is `none`; no key for the providers the choice allows; or the keys are checked and lack text-to-speech (F5).
 * `configured` / `checks` null (still loading, or unreadable): nothing is claimed. The core decides in the end.
 */
export function voiceUnavailable(brief: Pick<Brief, 'services'>, configured: ReadonlySet<ProviderId> | null, checks: Partial<Record<ProviderId, KeyCheckResult | null>> | null): VoiceReason | null {
  const choice = effectiveServices(brief).voice;
  if (choice === 'none') return 'off';
  const providers = VOICE_PROVIDERS[choice];
  const withKey = configured ? providers.filter((p) => configured.has(p)) : providers;
  if (withKey.length === 0) return 'noKey';
  if (checks && withKey.every((p) => missingCapability(checks[p], 'tts') !== null)) return 'missingPermission';
  return null;
}

/** The reason a language fell back last time (`voiceFallback` of its rows), when no reason holds now. */
export function fallbackReason(rows: ReadonlyArray<Pick<LocalizationRow, 'voiceFallback'>>): VoiceReason | null {
  return rows.find((r) => r.voiceFallback !== undefined)?.voiceFallback ?? null;
}

export function reasonText(r: VoiceReason, t: Messages): string {
  return t.web.languages.voiceReason[r];
}

/**
 * The problems that mention the clip `label` (a stored problem is a sentence naming the clip in quotes); the clip's checks:
 * overflow and not translated. Matches both catalogs' wording through the quotes alone.
 */
export function problemsOfClip(problems: readonly string[], label: string): string[] {
  const quoted = `"${label}"`;
  return problems.filter((p) => p.includes(quoted));
}

/** What the clip is called in the problems (the core names a clip by its name, else its id). */
export const clipDisplay = (e: { clipId: string; name?: string }): string => (e.name ?? e.clipId).slice(0, 100);

/** Whether `id` (a clip id or `clip.key` param) is outdated in `stale`. */
export const isStaleId = (stale: readonly string[], id: string): boolean => stale.includes(id);

/** The clips of a localized preview flagged as outdated or overflowing, by clip id and label. */
export interface FlaggedClip { clipId: string; label: string; kind: 'stale' | 'overflow' }
export function flaggedClips(o: { stale: readonly string[]; problems: readonly string[]; clips: ReadonlyArray<{ clipId: string; name?: string }> }): FlaggedClip[] {
  const out: FlaggedClip[] = [];
  for (const c of o.clips) {
    const label = clipDisplay(c);
    if (o.stale.includes(c.clipId) || o.stale.some((s) => s.startsWith(`${c.clipId}.`))) out.push({ clipId: c.clipId, label, kind: 'stale' });
    else if (problemsOfClip(o.problems, label).length) out.push({ clipId: c.clipId, label, kind: 'overflow' });
  }
  return out;
}
