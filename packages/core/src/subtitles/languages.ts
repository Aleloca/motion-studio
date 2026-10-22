import { sourceCueOf, staleCues, type JobSummary, type LocaleTag } from '@motion-studio/shared';
import { CreativeStore } from '../creatives/creative-store.ts';
import type { CreativeRef } from '../creatives/creative-turns.ts';
import { t } from '../i18n.ts';
import { CodedError } from '../workspace-store.ts';
import { listSubtitleSets, readSubtitleSet, speechSourceSet } from './store.ts';
import { languageName, type SubtitlesService } from './subtitles-job.ts';
import type { SubtitleTranslateService } from './translate-job.ts';

export interface SubtitleLanguageDeps {
  subtitles: Pick<SubtitlesService, 'start' | 'localizedVoiceLang'>;
  translate: Pick<SubtitleTranslateService, 'start'>;
}

/**
 * Task 25 (spec §6.5, U8): a new subtitle language of `ref`, the route's and the agent's (`add_subtitle_language`). A language
 * whose localized video has its own translated voices (`localizedVoiceLang`, Task 24) is made from that video's speech; any
 * other is translated from the original video's speech set (409 `subtitles-no-source` without one). 409
 * `subtitles-lang-exists` when the language has a set. The brief's languages are not touched: subtitle languages are their own.
 */
export async function addSubtitleLanguage(deps: SubtitleLanguageDeps, ref: CreativeRef, lang: LocaleTag): Promise<{ job: JobSummary; how: 'speech' | 'translation' }> {
  const dir = new CreativeStore(ref.projectDir).dir(ref.creativeSlug);
  if (await readSubtitleSet(dir, lang)) throw new CodedError(409, t().errors.subtitlesLangExists({ lang: languageName(lang) }), 'subtitles-lang-exists');
  if (await deps.subtitles.localizedVoiceLang(ref, lang)) return { job: await deps.subtitles.start(ref, { mode: 'new', lang }), how: 'speech' };
  return { job: await deps.translate.start(ref, { target: lang }), how: 'translation' };
}

/**
 * Task 25 ("Ritraduci"): translates lines of `lang`'s translation again. With `ids`, those (lines the user corrected included:
 * they asked for them, decision 1686); without, every stale line (`staleCues`) but those the user corrected and those no
 * source line overlaps any more (nothing to translate them from: the user deletes them in the editor), 409
 * `subtitles-nothing-stale` when there is none. 404 without the set, 409 `subtitles-lang-spoken` for a set made from speech;
 * the translation's own refusals otherwise.
 */
export async function retranslateSubtitles(deps: Pick<SubtitleLanguageDeps, 'translate'>, ref: CreativeRef, lang: LocaleTag, ids?: string[]): Promise<JobSummary> {
  const sets = await listSubtitleSets(new CreativeStore(ref.projectDir).dir(ref.creativeSlug));
  const target = sets.find((s) => s.lang === lang);
  const name = languageName(lang);
  if (!target) throw new CodedError(404, t().errors.subtitlesNoLang({ lang: name }), 'subtitles-not-found');
  if (target.origin === 'speech') throw new CodedError(409, t().errors.subtitlesLangSpoken({ lang: name }), 'subtitles-lang-spoken');
  if (ids) return deps.translate.start(ref, { target: lang, ids });
  const source = speechSourceSet(sets);
  if (!source) throw new CodedError(409, t().errors.subtitlesNoSource, 'subtitles-no-source');
  const asked = new Set(target.cues.filter((c) => !c.edited && sourceCueOf(c, source.cues) !== null).map((c) => c.id));
  const stale = staleCues(target, source).filter((id) => asked.has(id));
  if (stale.length === 0) throw new CodedError(409, t().errors.subtitlesNothingStale({ lang: name }), 'subtitles-nothing-stale');
  return deps.translate.start(ref, { target: lang, ids: stale });
}
