import { sourceCueOf, staleCues, type JobSummary, type LocaleTag, type ServerMessage, type SubtitleCue, type SubtitleSet } from '@motion-studio/shared';
import { CreativeStore } from '../creatives/creative-store.ts';
import type { CreativeRef } from '../creatives/creative-turns.ts';
import { t } from '../i18n.ts';
import { CodedError } from '../workspace-store.ts';
import { listSubtitleSets, readSubtitleSet, speechSourceSet, type SubtitleCommits, subtitleSetLocks, writeSubtitleSet } from './store.ts';
import { languageName, type SubtitlesService } from './subtitles-job.ts';
import type { SubtitleTranslateService } from './translate-job.ts';

export interface SubtitleLanguageDeps {
  subtitles: Pick<SubtitlesService, 'start' | 'localizedVoiceLang'>;
  translate: Pick<SubtitleTranslateService, 'start'>;
}

export interface RetranslateDeps {
  translate: Pick<SubtitleTranslateService, 'start'>;
  commits: Pick<SubtitleCommits, 'touch'>;
  broadcast(m: ServerMessage): void;
}

/**
 * Task 25 (spec §6.5, U8): a new subtitle language of `ref`, the route's and the agent's (`add_subtitle_language`). A language
 * whose localized video has its own translated voices (`localizedVoiceLang`, Task 24) is made from that video's speech; any
 * other is translated from the original video's speech set (409 `subtitles-no-source` without one). 409
 * `subtitles-lang-exists` when the language has a set. The brief's languages are not touched: subtitle languages are their own.
 */
export async function addSubtitleLanguage(deps: SubtitleLanguageDeps, ref: CreativeRef, lang: LocaleTag): Promise<{ job: JobSummary; how: 'speech' | 'translation' }> {
  await assertNoSubtitleSet(ref, lang);
  if (await deps.subtitles.localizedVoiceLang(ref, lang)) return { job: await deps.subtitles.start(ref, { mode: 'new', lang }), how: 'speech' };
  return { job: await deps.translate.start(ref, { target: lang }), how: 'translation' };
}

/** 409 `subtitles-lang-exists` when `lang` has a set. */
export async function assertNoSubtitleSet(ref: CreativeRef, lang: LocaleTag): Promise<void> {
  if (await readSubtitleSet(new CreativeStore(ref.projectDir).dir(ref.creativeSlug), lang)) {
    throw new CodedError(409, t().errors.subtitlesLangExists({ lang: languageName(lang) }), 'subtitles-lang-exists');
  }
}

/**
 * Task 25 ("Ritraduci"): translates lines of `lang`'s translation again. With `ids`, those (lines the user corrected included:
 * they asked for them, decision 1686). Without, every stale line (`staleCues`) the user did not correct; first, under the set
 * lock, the uncorrected lines no source line overlaps any more go (as in a full translation, decision 1690), committed and
 * told to the clients (`dropped`). Nothing left to ask: `job: null` when lines went, else 409 `subtitles-nothing-stale`
 * (saying so when the stale lines are all corrected ones). 404 without the set, 409 `subtitles-lang-spoken` for a set made
 * from speech; the translation's own refusals otherwise.
 */
export async function retranslateSubtitles(deps: RetranslateDeps, ref: CreativeRef, lang: LocaleTag, ids?: string[]): Promise<{ job: JobSummary | null; dropped?: number }> {
  const store = new CreativeStore(ref.projectDir);
  const dir = store.dir(ref.creativeSlug);
  const name = languageName(lang);
  const plan = await subtitleSetLocks.run(dir, async () => {
    const sets = await listSubtitleSets(dir);
    const target = sets.find((s) => s.lang === lang);
    if (!target) throw new CodedError(404, t().errors.subtitlesNoLang({ lang: name }), 'subtitles-not-found');
    if (target.origin === 'speech') throw new CodedError(409, t().errors.subtitlesLangSpoken({ lang: name }), 'subtitles-lang-spoken');
    if (ids) return { ids, dropped: 0, corrected: 0 };
    const source = speechSourceSet(sets);
    if (!source) throw new CodedError(409, t().errors.subtitlesNoSource, 'subtitles-no-source');
    const gone = (c: SubtitleCue) => !c.edited && c.source !== undefined && sourceCueOf(c, source.cues) === null;
    const kept: SubtitleSet = { ...target, cues: target.cues.filter((c) => !gone(c)) };
    const dropped = target.cues.length - kept.cues.length;
    if (dropped > 0) await writeSubtitleSet(dir, kept);
    const edited = new Set(kept.cues.filter((c) => c.edited).map((c) => c.id));
    const stale = staleCues(kept, source);
    return { ids: stale.filter((id) => !edited.has(id)), dropped, corrected: stale.filter((id) => edited.has(id)).length };
  });
  if (plan.dropped > 0) {
    deps.commits.touch(ref, t().subtitles.commit({ title: (await store.get(ref.creativeSlug)).title, lang }));
    try { deps.broadcast({ type: 'subtitles', project: ref.projectSlug, creative: ref.creativeSlug, lang }); } catch { /* a faulty listener */ }
  }
  const dropped = plan.dropped > 0 ? { dropped: plan.dropped } : {};
  if (plan.ids.length === 0 && !ids) {
    if (plan.dropped > 0) return { job: null, ...dropped };
    const text = plan.corrected > 0 ? t().errors.subtitlesNothingStaleCorrected({ lang: name }) : t().errors.subtitlesNothingStale({ lang: name });
    throw new CodedError(409, text, 'subtitles-nothing-stale');
  }
  return { job: await deps.translate.start(ref, { target: lang, ids: plan.ids }), ...dropped };
}
