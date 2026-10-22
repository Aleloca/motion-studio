import {
  isSupportedLocale, issuesText, SUBTITLE_LIMITS, subtitleSetSchema, subtitleSetText, type LocaleTag, type ServerMessage, type SubtitleCue,
} from '@motion-studio/shared';
import { z } from 'zod';
import type { BridgeContext } from '../bridge/bridge.ts';
import type { BridgeHandler } from '../bridge/bridge-routes.ts';
import { CreativeStore } from '../creatives/creative-store.ts';
import type { CreativeRef, CreativeTurnService } from '../creatives/creative-turns.ts';
import { currentLocale, t } from '../i18n.ts';
import { CodedError } from '../workspace-store.ts';
import { addSubtitleLanguage } from './languages.ts';
import { readSubtitleSet, type SubtitleCommits, subtitleSetLocks, writeSubtitleSet } from './store.ts';
import type { StyleTurnHost, SubtitlesService } from './subtitles-job.ts';
import type { SubtitleTranslateService } from './translate-job.ts';

const lang = z.string().refine(isSupportedLocale, { message: 'not a supported language' });
/** `drawn` (U9): drawn into the video, or files/track only; absent (an older agent) means files only. */
const startInput = z.strictObject({ drawn: z.boolean().optional(), lang: lang.optional() });
/** Task 19 (spec §6.4): the agent's corrections of a set's text; at least one replace or cue. */
const editInput = z.strictObject({
  lang,
  replace: z.array(z.strictObject({
    find: z.string().min(1).max(SUBTITLE_LIMITS.text), with: z.string().max(SUBTITLE_LIMITS.text), caseSensitive: z.boolean().optional(),
  })).max(20).optional(),
  // `was`: the line's text as the agent read it; a line changed since (the user corrected it) refuses the whole edit (409).
  cues: z.array(z.strictObject({ id: z.string().min(1).max(32), was: z.string().max(SUBTITLE_LIMITS.text), text: z.string().max(SUBTITLE_LIMITS.text) })).max(200).optional(),
}).refine((x) => (x.replace?.length ?? 0) + (x.cues?.length ?? 0) > 0, { message: 'give replace or cues' });
type EditInput = z.infer<typeof editInput>;
const addLanguageInput = z.strictObject({ lang });

function parse<T>(schema: z.ZodType<T>, args: unknown): T {
  const r = schema.safeParse(args ?? {});
  if (!r.success) throw new CodedError(400, t().errors.invalidRequestDetail({ detail: issuesText(r.error, currentLocale()) }), 'invalid-request');
  return r.data;
}

/** The creative of a creative turn (`appScope`); 403 `tool-unavailable` for any other job and for a group's coordinator. */
function creativeOf(c: BridgeContext): CreativeRef {
  const a = c.appScope;
  if (c.kind !== 'creative' || !a || a.group) throw new CodedError(403, t().errors.toolUnavailable, 'tool-unavailable');
  if (c.signal.aborted) throw new CodedError(409, t().errors.jobCancelled, 'tool-aborted');
  return plain(a);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const compact = (s: string) => s.replace(/\s+/g, '');

/**
 * The cue with the agent's text, marked edited. Its word times stay when the text still says its words, or says as many
 * words (a case or spelling fix: the times move onto the new words); otherwise they go (the highlight falls back to the line).
 */
function withText(c: SubtitleCue, text: string): SubtitleCue {
  const { words, ...rest } = c;
  const out: SubtitleCue = { ...rest, text, edited: true };
  if (!words) return out;
  if (compact(words.map((w) => w.text).join('')) === compact(text)) return { ...out, words };
  const tokens = text.split(/\s+/).filter(Boolean);
  return tokens.length === words.length && tokens.every((x) => x.length <= 100) ? { ...out, words: words.map((w, i) => ({ ...w, text: tokens[i]! })) } : out;
}

/** `edit.replace` (literal, case-insensitive unless asked) on every cue, then `edit.cues`' texts; the cues that changed. */
export function editCues(cues: readonly SubtitleCue[], edit: Pick<EditInput, 'replace' | 'cues'>): { cues: SubtitleCue[]; changed: number } {
  const texts = new Map((edit.cues ?? []).map((x) => [x.id, x.text]));
  const finds = (edit.replace ?? []).map((r) => ({ re: new RegExp(escapeRe(r.find), r.caseSensitive ? 'gu' : 'giu'), with: r.with }));
  let changed = 0;
  const out = cues.map((c) => {
    let text = c.text;
    // A function replacement: `$&` and the like in the agent's text stay literal.
    for (const f of finds) text = text.replace(f.re, () => f.with);
    text = texts.get(c.id) ?? text;
    if (text === c.text) return c;
    changed++;
    return withText(c, text);
  });
  return { cues: out, changed };
}

/**
 * Decision 1703 (U9, spec §6.2) and Task 19: the agent's subtitle tools, creative turns only (the turn's creative from its
 * `appScope`; 403 `tool-unavailable` for any other job).
 * - `start_subtitles`: like `render_version "current"`, the job starts when the turn settles, on the version it saved (none
 *   saved: the latest), so subtitles asked in the brief's first turn, or with an audio change in the same turn, are timed on
 *   that turn's work. Once per turn (409 after that). `drawn` is recorded on the creative (`subtitlesDrawn`) once the job
 *   started; a drawn job's end starts the style turn (`SubtitlesService.styleTurn`). The transcription switched off is
 *   refused at once; any other refusal when the turn settles, or a turn that failed or was stopped, is a chat line.
 * - `edit_subtitles` (spec §6.4): corrects the text of a set now: re-read, changed and written under the creative's set lock
 *   (the editor's save holds it too, so neither loses the other's change; the editor then meets the new hash and rebases),
 *   every changed cue marked edited, committed in the subtitle commits' batch and told to the clients. All or nothing: an
 *   unknown cue id or a text the set refuses changes nothing (400), nor does a line whose text is no longer the `was` the
 *   agent read (409 `subtitles-cue-changed`: the user corrected it since, anti-goal 1).
 * - `add_subtitle_language` (Task 25, spec §6.5, U8): a new subtitle language now, as the route (`addSubtitleLanguage`: from
 *   the language's own voices, or translated from the speech set); a refusal is the tool's error. The brief is not touched.
 */
export function subtitlesTools(deps: {
  subtitles: Pick<SubtitlesService, 'start' | 'assertTranscriptionOn' | 'onReady' | 'styleTurn' | 'localizedVoiceLang'>;
  translate: Pick<SubtitleTranslateService, 'start'>;
  turns: Pick<CreativeTurnService, 'onTurnSettled' | 'noteFromTurn' | 'setSubtitlesDrawn'> & StyleTurnHost;
  commits: Pick<SubtitleCommits, 'touch'>;
  broadcast: (m: ServerMessage) => void;
}): Record<'start_subtitles' | 'edit_subtitles' | 'add_subtitle_language', BridgeHandler> {
  /** What each turn asked for, by job id, until it settles. */
  const asked = new Map<string, { drawn?: boolean; lang?: LocaleTag }>();
  deps.turns.onTurnSettled(async (ref, jobId, o) => {
    const a = asked.get(jobId);
    asked.delete(jobId);
    if (!a) return;
    const say = (text: string) => deps.turns.noteFromTurn(jobId, ref, { type: 'system', at: new Date().toISOString(), level: 'warning', text, origin: 'agent' });
    if (o.state !== 'succeeded' || o.stopped) { await say(t().subtitles.notStartedTurn); return; }
    try {
      await deps.subtitles.start(plain(ref), { mode: 'new', drawn: a.drawn === true, ...(a.lang ? { lang: a.lang } : {}) });
    } catch (err) {
      await say(t().subtitles.notStarted({ reason: err instanceof Error ? err.message : String(err) }));
      return;
    }
    if (a.drawn !== undefined) {
      await deps.turns.setSubtitlesDrawn(plain(ref), a.drawn).catch((err: Error) => console.warn(`Motion Studio: the subtitles choice of ${ref.creativeSlug} was not recorded: ${err.message}`));
    }
  });
  deps.subtitles.onReady((ref, r, jobId) => { if (r.drawn) void deps.subtitles.styleTurn(deps.turns, plain(ref), jobId); });
  return {
    start_subtitles: async (c, args) => {
      creativeOf(c);
      const r = parse(startInput, args);
      if (asked.has(c.jobId)) throw new CodedError(409, t().errors.subtitlesOncePerTurn, 'subtitles-once');
      await deps.subtitles.assertTranscriptionOn();
      asked.set(c.jobId, { ...(r.drawn !== undefined ? { drawn: r.drawn } : {}), ...(r.lang ? { lang: r.lang as LocaleTag } : {}) });
      return { started: true, when: 'after-turn' };
    },
    edit_subtitles: async (c, args) => {
      const ref = creativeOf(c);
      const e = parse(editInput, args);
      const tag = e.lang as LocaleTag;
      const store = new CreativeStore(ref.projectDir);
      const dir = store.dir(ref.creativeSlug);
      const changed = await subtitleSetLocks.run(dir, async () => {
        const stored = await readSubtitleSet(dir, tag);
        if (!stored) throw new CodedError(404, t().errors.subtitlesNoLang({ lang: tag }), 'subtitles-not-found');
        const ids = new Set(stored.set.cues.map((x) => x.id));
        const unknown = [...new Set((e.cues ?? []).map((x) => x.id).filter((id) => !ids.has(id)))];
        if (unknown.length > 0) throw new CodedError(400, t().errors.subtitlesUnknownCue({ ids: unknown.slice(0, 10).join(', ') }), 'subtitles-unknown-cue');
        // Anti-goal 1: a whole-line text never overwrites a correction the agent did not see.
        const texts = new Map(stored.set.cues.map((x) => [x.id, x.text]));
        const moved = [...new Set((e.cues ?? []).filter((x) => texts.get(x.id) !== x.was).map((x) => x.id))];
        if (moved.length > 0) throw new CodedError(409, t().errors.subtitlesCueChanged({ ids: moved.slice(0, 10).join(', ') }), 'subtitles-cue-changed');
        const next = editCues(stored.set.cues, e);
        if (next.changed === 0) return 0;
        const set = parse(subtitleSetSchema, { ...stored.set, cues: next.cues });
        if (Buffer.byteLength(subtitleSetText(set)) > SUBTITLE_LIMITS.fileBytes) {
          throw new CodedError(413, t().errors.subtitlesTooLarge({ maxMB: SUBTITLE_LIMITS.fileBytes / 1_048_576 }), 'subtitles-too-large');
        }
        await writeSubtitleSet(dir, set);
        return next.changed;
      });
      if (changed > 0) {
        const title = await store.get(ref.creativeSlug).then((x) => x.title, () => ref.creativeSlug);
        deps.commits.touch(ref, t().subtitles.commit({ title, lang: tag }));
        try { deps.broadcast({ type: 'subtitles', project: ref.projectSlug, creative: ref.creativeSlug, lang: tag }); } catch { /* a faulty listener */ }
      }
      return { changed };
    },
    add_subtitle_language: async (c, args) => {
      const ref = creativeOf(c);
      const r = parse(addLanguageInput, args);
      const { how } = await addSubtitleLanguage({ subtitles: deps.subtitles, translate: deps.translate }, ref, r.lang as LocaleTag);
      return { started: true, how };
    },
  };
}

const plain = (ref: CreativeRef): CreativeRef => ({ root: ref.root, projectSlug: ref.projectSlug, projectDir: ref.projectDir, creativeSlug: ref.creativeSlug });
