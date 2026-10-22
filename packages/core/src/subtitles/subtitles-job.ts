import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  alignToScript, buildCues, creativeJobKey, effectiveLinks, mergeKeepingEdited, SILENCE_NO_SPEECH, SUBTITLE_LIMITS, SUBTITLES_DIR, SUBTITLES_SCHEMA_ID, subtitleLangOf, subtitleSetSchema,
  subtitleSetText, subtitlesJobKey,
  type Brief, type ConversationEntry, type FormatPreset, type JobSummary, type LocaleTag, type ServerMessage, type SubtitleCue, type SubtitleSet,
  type JobWaitReason, type TimedWord, type TranscribeMethod, type TranscriptionChoice, type TranscriptionPending, type VersionEntry,
} from '@motion-studio/shared';
import { extractWav, silenceRatio } from '../analysis/audio.ts';
import { copyConfinedFile } from '../brand/agent-guard.ts';
import { precheckLimitMs, untilAborted, type Transcriber } from '../analysis/video-analysis.ts';
import { realDirChain, writeThroughTemp } from '../creatives/core-files.ts';
import { CreativeStore } from '../creatives/creative-store.ts';
import type { CreativeRef, CreativeTurnService } from '../creatives/creative-turns.ts';
import { groupJobKey } from '../creatives/group-turn.ts';
import { execCommand, type CommandExec } from '../exec.ts';
import { findPreset } from '../formats/format-catalog.ts';
import { currentLocale, t } from '../i18n.ts';
import { JobFailedError, type JobQueue } from '../jobs/job-queue.ts';
import { instanceComposition, knownVoiceScripts, localizedComposition, readOverlay, type InstanceComposition } from '../localization/store.ts';
import { filePeaks } from '../library/asset-meta.ts';
import { decodePcmWith, type MediaTools } from '../media/media-tools.ts';
import { mixAudio, mixClips, type MixClip } from '../render/audio-mix.ts';
import type { FfmpegInfo } from '../render/encode.ts';
import { CodedError } from '../workspace-store.ts';
import { audioFingerprint, followSource, listSubtitleSets, readSubtitleSet, speechSourceSet, type SubtitleCommits, subtitlePath, subtitleSetLocks, writeSubtitleSet } from './store.ts';

/** The queue lane of the subtitles jobs (decision 1640): one at a time, never in an agent turn's slot. */
export const SUBTITLES_LANE = 'subtitles';
/**
 * The check before a transcription choice (the plan, then the mix's speech when it would ask) gives up after this long, plus
 * 0.2 s per second of audio: the job then fails saying so.
 */
const PLAN_MAX_MS = 60_000;
/** The peaks of the subtitle timeline's waveform (Task 13), and how long its mix may take. */
export const SUBTITLE_WAVEFORM_PEAKS = 1200;
const WAVE_MAX_MS = 300_000;
/** The waveforms being made, by cache file: a second request waits for the first. */
const waveInFlight = new Map<string, Promise<{ peaks: number[]; durationMs: number }>>();

export interface SubtitlesDeps {
  queue: JobQueue;
  /** The transcription (the analyses' one); absent: a job with speech fails saying the transcription is unavailable. */
  transcriber?: Transcriber;
  /** The ffmpeg of the mix (default: none, every job fails). */
  ffmpeg?: () => Promise<FfmpegInfo | null>;
  media: MediaTools;
  turns: Pick<CreativeTurnService, 'noteFromTurn'>;
  commits: Pick<SubtitleCommits, 'touch'>;
  broadcast(m: ServerMessage): void;
  presets(): Promise<FormatPreset[]>;
  /** The runner of the WAV extraction and the silence check (default: the system's). Test seam. */
  ffExec?: CommandExec;
  /** The base time limit of the check before the choice (default PLAN_MAX_MS). Test seam. */
  planMaxMs?: number;
}

/**
 * `new`: transcribe and cut (the language `lang` when the user picked one, else the one heard); a `lang` whose localized
 * video has its own voices (`localizedVoiceOf`, Task 24) is made from that video's audio. `retime` (Task 14, spec §6.7,
 * "Rifai i tempi"): the same flow on an existing set (`lang`, else the first one timed on other audio, else the first), on
 * the audio it was timed on (the original video, or its language's own), transcribed in the set's language; the merge keeps
 * every edited cue's text and moves it onto the words heard now.
 */
export interface SubtitlesStart { mode: 'new' | 'retime'; lang?: LocaleTag; drawn?: boolean }

/** What the style turn of drawn subtitles needs of the creative turns (Task 19). */
export type StyleTurnHost = Pick<CreativeTurnService, 'start' | 'memberOf' | 'queueWaiting'>;

/** The holds only the user releases (a card to answer): a style turn never waits on them (Task 19, decision 1682). */
const USER_HOLDS: ReadonlySet<JobWaitReason> = new Set(['variant-confirm', 'video-long', 'transcription-choice']);
/** How often a style turn's wait looks again for a user hold on the work it waits for. */
const STYLE_POLL_MS = 2000;

/**
 * The style turn's instruction (Task 19), for the agent's prompt only (agent-facing, English): the user sees the app line
 * `subtitles.styleStarted` and the version's request `subtitles.styleVersionRequest` instead.
 */
export const SUBTITLES_STYLE_INSTRUCTION = 'Motion Studio: the subtitles the user asked to see drawn into the video are ready. Add the subtitles track to every video format, with its style (see "Drawn subtitles are the subtitles track"), as a new version. Change nothing else.';

/** A subtitles job queued or running: one per creative. */
interface Active {
  ref: CreativeRef; jobId: string; o: SubtitlesStart; audioSec: number;
  /** The audio the check before the choice listens to. */
  timing: SubtitleTiming;
  /** A retime's: the language whose own localized video the set was timed on (`timing.locale`); absent: the original. */
  audio?: LocaleTag;
  /** Why the job will not transcribe, found before it runs: the setting is "never", or the check ran out of time. */
  blocked: 'off' | 'timeout' | null;
  /** The user's transcription choice, or what the plan resolved to; null: what the settings resolve to when it runs. */
  method: TranscribeMethod | null;
  /** What the held job asks the user; null: nothing. */
  pending: TranscriptionPending | null;
  /** The plan before the job runs, while it runs: aborted when the job ends. */
  planning: AbortController | null;
}

const keyOf = (ref: CreativeRef) => subtitlesJobKey(ref.root, ref.projectSlug, ref.creativeSlug);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const ms = (sec: number) => Math.max(0, Math.round(sec * 1000));

/** The language's name in the app language ("italiano"), its tag when unknown. */
export function languageName(tag: string): string {
  try { return new Intl.DisplayNames([currentLocale()], { type: 'language' }).of(tag) ?? tag; } catch { return tag; }
}

/**
 * The format the subtitles are timed on (spec §6.1): the first format of the brief that is a primary (not a follower), a
 * video (not a still) and has a composition in `version`. Null when there is none.
 */
export function subtitleSourceFormat(version: VersionEntry, brief: Brief, presets: readonly FormatPreset[]): string | null {
  const followers = new Set(Object.keys(effectiveLinks(brief.links, brief.formats)));
  return brief.formats.find((id) => !followers.has(id) && findPreset(presets, id)?.kind === 'video' && version.compositions?.some((c) => c.format === id)) ?? null;
}

/** The audio a subtitle set is timed on (`subtitleTimingOf`). */
export interface SubtitleTiming {
  format: string;
  /** The main format's composition; for a language's own video (`locale`), its localized one (the folder stays the original's). */
  ic: InstanceComposition;
  fingerprint: string;
  /** Task 24: the language whose localized video this is; absent: the original video. */
  locale?: LocaleTag;
  /** The localized voices the mix takes from the project (`voiceRootsOf`): the composition folder does not have them. */
  projectFiles: string[];
}

/**
 * Task 24: the localized video of `locale` for `ic` (the main format of `version`): its composition (`localizedComposition`,
 * the row's voice choice applied) and the voice files it takes from the project. `voiced`: the row translates the voices and
 * at least one is applied. Null when the language has no row on that format, or its overlay is not the row's or no longer applies.
 */
async function localizedAudioOf(creativeDir: string, version: VersionEntry, ic: InstanceComposition, locale: LocaleTag): Promise<{ composition: InstanceComposition['composition']; projectFiles: string[]; voiced: boolean } | null> {
  try {
    const row = version.localizations?.find((r) => r.locale === locale && r.instanceId === ic.entry.format);
    const read = row ? await readOverlay(creativeDir, version.n, locale, row.instanceId) : null;
    if (!row || !read || read.hash !== row.hash) return null;
    const composition = localizedComposition(ic.composition, read.overlay, row);
    if (!composition) return null;
    const applied = row.voice === 'translated' ? Object.entries(read.overlay.voices).filter(([id]) => !row.stale.includes(id)).map(([, v]) => v.src) : [];
    // As the localized render (and the checks): a path the composition folder has wins over the project's.
    const have = new Set(ic.folder.files.map((f) => f.path));
    return { composition, projectFiles: [...new Set(applied.filter((p) => !have.has(p)))], voiced: applied.length > 0 };
  } catch (err) {
    console.warn(`Motion Studio: the ${locale} localized audio of v${version.n} could not be read: ${errText(err)}`);
    return null;
  }
}

/**
 * The audio the subtitles of `version` are timed on: its main format (`subtitleSourceFormat`), that composition and the
 * fingerprint of its audio; null when there is no such format or its composition cannot be read. With `locale` (a set timed
 * on that language's own video, Task 24): that language's localized composition, as the row has it now; the original when
 * the language has no row there. The one derivation of the job, the chat notice and the routes' `timingChanged`, so they
 * never disagree (Task 14, review round 1).
 */
export async function subtitleTimingOf(creativeDir: string, version: VersionEntry, brief: Brief, presets: readonly FormatPreset[], locale?: LocaleTag): Promise<SubtitleTiming | null> {
  const format = subtitleSourceFormat(version, brief, presets);
  const ic = format ? await instanceComposition(creativeDir, version, format, presets).catch(() => null) : null;
  if (!format || !ic) return null;
  const own = locale ? await localizedAudioOf(creativeDir, version, ic, locale) : null;
  if (own) return { format, ic: { ...ic, composition: own.composition }, fingerprint: audioFingerprint(own.composition), locale, projectFiles: own.projectFiles };
  return { format, ic, fingerprint: audioFingerprint(ic.composition), projectFiles: [] };
}

/**
 * Task 24 (spec §6.5): whether `lang`'s localized video of `version`'s main format has its own voices (its row translates them
 * and at least one is applied): its subtitles are then made from that audio, not translated.
 */
export async function localizedVoiceOf(creativeDir: string, version: VersionEntry, brief: Brief, presets: readonly FormatPreset[], lang: LocaleTag): Promise<boolean> {
  const format = subtitleSourceFormat(version, brief, presets);
  const ic = format ? await instanceComposition(creativeDir, version, format, presets).catch(() => null) : null;
  return ic ? (await localizedAudioOf(creativeDir, version, ic, lang))?.voiced === true : false;
}

/**
 * Final review I3 and Minor 4: why a set in `lang` may not be made from speech heard on `audio` (a language's own localized
 * video, or the original: undefined), or null. 409 `subtitles-lang-translated`: the language's set is a translation (the user
 * deletes it first); `subtitles-voice-gone`: its set was made from that language's own voice, which its video no longer has
 * (only a translation fits it now); `subtitles-other-speech`: the original video's speech already has a set in another
 * language (one set from it: the source of the translations).
 */
export function speechSetRefusal(sets: readonly SubtitleSet[], lang: LocaleTag, audio: LocaleTag | undefined): CodedError | null {
  const name = languageName(lang);
  const existing = sets.find((s) => s.lang === lang);
  if (existing?.origin === 'translation') return new CodedError(409, t().errors.subtitlesLangTranslated({ lang: name }), 'subtitles-lang-translated');
  if (audio === undefined && existing?.timing.locale !== undefined) return new CodedError(409, t().errors.subtitlesVoiceGone({ lang: name }), 'subtitles-voice-gone');
  const other = audio === undefined ? sets.find((s) => s.origin === 'speech' && s.timing.locale === undefined && s.lang !== lang) : undefined;
  if (other) return new CodedError(409, t().errors.subtitlesOtherSpeech({ lang: name, other: languageName(other.lang) }), 'subtitles-other-speech');
  return null;
}

/**
 * The folder the mix reads `t`'s audio from: the composition folder, or, when localized voices live in the project, a private
 * copy in `workDir` of every file the mix plays, each from where the localized render takes it.
 */
async function mixFolder(projectDir: string, t: SubtitleTiming, clips: readonly MixClip[], workDir: string): Promise<string> {
  if (t.projectFiles.length === 0) return t.ic.compDir;
  const root = join(workDir, 'sources');
  const fromProject = new Set(t.projectFiles);
  for (const src of new Set(clips.map((c) => c.src))) {
    const to = join(root, ...src.split('/'));
    await mkdir(dirname(to), { recursive: true });
    await copyConfinedFile(fromProject.has(src) ? projectDir : t.ic.compDir, src, to);
  }
  return root;
}

/** The scripts written without spaces between words (Korean has spaces: its words stay whole, decision 1701). */
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

/**
 * whisper.cpp's Chinese, Japanese and Thai tokens have no leading space, so a whole segment may arrive as one long "word": every word holding a
 * CJK or Thai character is cut into its characters (a run of other characters stays one piece), the word's time shared
 * evenly. Graphemes, so a Thai vowel mark stays on its consonant.
 */
export function splitCjkWords(words: readonly TimedWord[]): TimedWord[] {
  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const out: TimedWord[] = [];
  for (const w of words) {
    if (!CJK_CHAR.test(w.text)) { out.push(w); continue; }
    const pieces: string[] = [];
    let run = '';
    for (const { segment } of graphemes.segment(w.text.trim())) {
      if (CJK_CHAR.test(segment) || /\s/.test(segment)) {
        if (run) { pieces.push(run); run = ''; }
        if (!/\s/.test(segment)) pieces.push(segment);
      } else run += segment;
    }
    if (run) pieces.push(run);
    pieces.forEach((text, i) => {
      out.push({ start: w.start + Math.round(((w.end - w.start) * i) / pieces.length), end: w.start + Math.round(((w.end - w.start) * (i + 1)) / pieces.length), text });
    });
  }
  return out;
}

/** At most SUBTITLE_LIMITS.cues cues: the fresh ones are dropped from the end, an edited cue never (anti-goal 1). */
function capCues(cues: SubtitleCue[]): SubtitleCue[] {
  if (cues.length <= SUBTITLE_LIMITS.cues) return cues;
  let room = SUBTITLE_LIMITS.cues - cues.filter((c) => c.edited).length;
  return cues.filter((c) => c.edited || room-- > 0);
}

/** The heard words of each voice clip with a known script replaced by the script's (decision 1639), the heard times kept. */
function alignVoices(words: TimedWord[], ic: InstanceComposition, scripts: ReadonlyMap<string, string>): TimedWord[] {
  const c = ic.composition;
  let out = words;
  for (const track of c.tracks) {
    if (track.muted || track.hidden) continue;
    for (const clip of track.clips) {
      if (clip.type !== 'audio' || clip.hidden || !((clip.volume ?? 1) > 0) || clip.start >= c.duration) continue;
      const script = scripts.get(clip.id);
      if (!script) continue;
      const span = { start: ms(clip.start), end: ms(Math.min(clip.start + clip.duration, c.duration)) };
      const inSpan = (w: TimedWord) => w.start >= span.start && w.start < span.end;
      const aligned = alignToScript(out, script, span);
      out = [...out.filter((w) => !inSpan(w)), ...aligned].sort((a, b) => a.start - b.start || a.end - b.end);
    }
  }
  return out;
}

/**
 * Decisions 1637-1640 (spec §6.2): the subtitles of a creative, made from its own audio mix. A job per creative in the
 * `subtitles` lane, without an agent: the latest version's main format is mixed, its speech transcribed (the analyses'
 * transcriber and its choice, held for the user's answer like an analysis), voices aligned to their scripts, cues cut and
 * merged with the user's edited cues, the set written and the chat told.
 */
export class SubtitlesService {
  private readonly active = new Map<string, Active>();
  /** The creatives whose style turn is being started or waits (Task 19). */
  private readonly styling = new Set<string>();
  private readonly readyHooks: Array<(ref: CreativeRef, r: { lang: LocaleTag; drawn: boolean }, jobId: string) => void> = [];
  private readonly ff: CommandExec;

  constructor(private readonly deps: SubtitlesDeps) {
    this.ff = deps.ffExec ?? execCommand;
  }

  /** `fn` runs when a job wrote a set (Phase 3: the style turn of drawn subtitles, `styleTurn`). */
  onReady(fn: (ref: CreativeRef, r: { lang: LocaleTag; drawn: boolean }, jobId: string) => void): void { this.readyHooks.push(fn); }

  /**
   * Task 19 (spec §6.2): a drawn job (`jobId`) is ready: Motion Studio asks the agent for the `subtitles` track with its style
   * in a turn of its own (`start`'s `app` option: the instruction goes to the agent's prompt only, never as a user message;
   * the chat says it with an app line). Nothing when the latest version already has the track (drawn, or switched off by
   * hiding it). While a job of the creative runs or waits (a turn, a translation) or, for a grouped variant, its group's turn
   * (decision 1680), the turn waits for them all to end, then the track is checked again; a job among them that failed or
   * was stopped drops it (said in the chat: no spending the user did not see coming). A turn that started in between (409)
   * is waited for too. A queue the user paused or left waiting ("Run next"), or work held for the user's answer, drops it
   * with a line asking the user to request it when they carry on (decision 1682). Any other refusal is a chat line. One at a
   * time per creative. Never throws.
   */
  async styleTurn(turns: StyleTurnHost, ref: CreativeRef, jobId: string): Promise<'started' | 'skipped'> {
    const key = keyOf(ref);
    if (this.styling.has(key)) return 'skipped';
    this.styling.add(key);
    const say = (level: 'info' | 'warning', text: string) =>
      this.deps.turns.noteFromTurn(jobId, ref, { type: 'system', at: new Date().toISOString(), level, text, origin: 'agent' }).catch(() => {});
    try {
      const member = await turns.memberOf(ref).catch(() => null);
      const keys = new Set([creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug), ...(member ? [groupJobKey(ref.root, ref.projectSlug, member.host)] : [])]);
      let waited = false;
      let idleQueueSeen = false;
      // Every job waited on, across the polls: one waiter each, and the end of each one is checked, also of a job that ended
      // while another still ran (a group's turn that failed under a running turn of the variant).
      const seen = new Map<string, Promise<JobSummary | null>>();
      for (;;) {
        if (await this.latestHasSubtitlesTrack(ref)) return 'skipped';
        const busy = this.deps.queue.list().filter((j) => keys.has(j.key) && (j.state === 'queued' || j.state === 'running'));
        const ended = await Promise.all([...seen].filter(([id]) => !busy.some((j) => j.id === id)).map(([, end]) => end));
        if (ended.some((e) => e && e.state !== 'succeeded')) { await say('warning', t().subtitles.styleNotStarted({ reason: t().subtitles.styleAfterStop })); return 'skipped'; }
        // Work held for the user's answer (a card) may wait for ever: the user asks for the drawing later (decision 1682).
        if (busy.some((j) => j.state === 'queued' && j.waitReason && USER_HOLDS.has(j.waitReason))) { await say('info', t().subtitles.styleAskLater); return 'skipped'; }
        if (busy.length > 0) {
          if (!waited) await say('info', t().subtitles.styleWaiting);
          waited = true;
          idleQueueSeen = false;
          for (const j of busy) if (!seen.has(j.id)) seen.set(j.id, this.deps.queue.whenSettled(j.id));
          let timer: ReturnType<typeof setTimeout> | undefined;
          const tick = new Promise<'tick'>((r) => { timer = setTimeout(() => r('tick'), STYLE_POLL_MS); timer.unref?.(); });
          await Promise.race([Promise.all(busy.map((j) => seen.get(j.id))), tick]).finally(() => clearTimeout(timer));
          continue;
        }
        // A queue the user paused (a Stop, a failure) or requests waiting for "Run next": the app never starts work before
        // theirs nor resumes their queue (Ruling U); the user asks for the drawing when they carry on (decision 1682).
        const queue = await turns.queueWaiting(ref);
        // Requests left in the queue with nothing running may be about to start by themselves (a turn just ended): one more
        // look after a pause; still there and nothing running, they wait for the user.
        if (queue === 'queued' && !idleQueueSeen) { idleQueueSeen = true; await new Promise((r) => setTimeout(r, STYLE_POLL_MS).unref?.()); continue; }
        if (queue) { await say('info', t().subtitles.styleAskLater); return 'skipped'; }
        try {
          await turns.start(ref, { text: SUBTITLES_STYLE_INSTRUCTION, pins: [] }, { app: { request: t().subtitles.styleVersionRequest } });
        } catch (err) {
          // Something of the creative started in between: wait for it.
          if (this.deps.queue.list().some((j) => keys.has(j.key) && (j.state === 'queued' || j.state === 'running'))) continue;
          throw err;
        }
        if (!waited) await say('info', t().subtitles.styleStarted);
        return 'started';
      }
    } catch (err) {
      await say('warning', t().subtitles.styleNotStarted({ reason: errText(err) }));
      return 'skipped';
    } finally {
      this.styling.delete(key);
    }
  }

  /** Whether a composition of the latest version has a `subtitles` track (hidden or not). */
  private async latestHasSubtitlesTrack(ref: CreativeRef): Promise<boolean> {
    const store = new CreativeStore(ref.projectDir);
    const latest = (await store.readVersions(ref.creativeSlug)).at(-1);
    if (!latest) return false;
    const presets = await this.deps.presets();
    for (const c of latest.compositions ?? []) {
      const ic = await instanceComposition(store.dir(ref.creativeSlug), latest, c.format, presets).catch(() => null);
      if (ic?.composition.tracks.some((k) => k.kind === 'subtitles')) return true;
    }
    return false;
  }

  private jobActive(key: string): boolean {
    return this.deps.queue.list().some((j) => j.key === key && (j.state === 'queued' || j.state === 'running'));
  }

  /**
   * 409 `subtitles-transcription-off` when the transcription is switched off in the settings: said at once (the agent tells
   * the user), no job that could only fail.
   */
  async assertTranscriptionOn(): Promise<void> {
    if ((await this.deps.transcriber?.settings?.().catch(() => null))?.method === 'never') throw new CodedError(409, t().errors.subtitlesTranscriptionOff, 'subtitles-transcription-off');
  }

  /**
   * Queues the subtitles of `ref`'s latest version. 409 `subtitles-running` while one is queued or running for the creative,
   * `subtitles-no-video` when the version has no video format to time them on, `subtitles-no-ffmpeg` without ffmpeg.
   */
  async start(ref: CreativeRef, o: SubtitlesStart): Promise<JobSummary> {
    const key = keyOf(ref);
    const running = () => new CodedError(409, t().errors.subtitlesRunning, 'subtitles-running');
    if (this.active.has(key) || this.jobActive(key)) throw running();
    const store = new CreativeStore(ref.projectDir);
    const dir = store.dir(ref.creativeSlug);
    const creative = await store.get(ref.creativeSlug);
    const latest = (await store.readVersions(ref.creativeSlug)).at(-1);
    const presets = await this.deps.presets();
    const timingOf = async (locale?: LocaleTag) => (latest ? subtitleTimingOf(dir, latest, creative.brief, presets, locale) : null);
    let timing = await timingOf();
    if (!timing) throw new CodedError(409, t().errors.subtitlesNoVideo, 'subtitles-no-video');
    let audio: LocaleTag | undefined;
    if (o.mode === 'retime') {
      // Decision 1714: a retime redoes one set in its own language (the transcriber is told it, so the heard words land in
      // that set): the one asked for, else the first one timed on other audio than the latest version's (each set against
      // the video it was timed on, Task 24), else the first.
      const sets = (await listSubtitleSets(dir)).filter((s) => s.origin === 'speech');
      let set: SubtitleSet | undefined;
      if (o.lang) set = sets.find((s) => s.lang === o.lang);
      else {
        for (const s of sets) if ((await timingOf(s.timing.locale))?.fingerprint !== s.timing.fingerprint) { set = s; break; }
        set ??= sets[0];
      }
      if (!set) throw new CodedError(409, t().errors.subtitlesNoSet, 'subtitles-no-set');
      o = { ...o, lang: set.lang };
      audio = set.timing.locale;
      // A language's own voice its video no longer has (Minor 4): never its original audio under its name.
      if (audio && !(latest && await localizedVoiceOf(dir, latest, creative.brief, presets, audio))) {
        throw new CodedError(409, t().errors.subtitlesVoiceGone({ lang: languageName(audio) }), 'subtitles-voice-gone');
      }
    } else {
      if (o.lang && latest && await localizedVoiceOf(dir, latest, creative.brief, presets, o.lang)) audio = o.lang;
      // One set from the original video's speech (final review I3); a language picked is checked now, one recognised when the
      // job knows it (`run`).
      const refusal = o.lang ? speechSetRefusal(await listSubtitleSets(dir), o.lang, audio) : null;
      if (refusal) throw refusal;
    }
    // The audio the check before the choice listens to (the job itself looks again when it runs).
    if (audio) timing = (await timingOf(audio)) ?? timing;
    const { ic } = timing;
    if (!(await this.deps.ffmpeg?.().catch(() => null))) throw new CodedError(409, t().errors.noFfmpegSubtitles, 'subtitles-no-ffmpeg');
    const tr = this.deps.transcriber;
    await this.assertTranscriptionOn();
    if (this.active.has(key) || this.jobActive(key)) throw running();
    const entry: Active = { ref, jobId: '', o, audioSec: ic.composition.duration, timing, ...(audio ? { audio } : {}), blocked: null, method: null, pending: null, planning: tr ? new AbortController() : null };
    const job = this.deps.queue.enqueue({
      key, kind: 'subtitles', label: t().jobs.subtitlesLabel({ title: creative.title }), lane: SUBTITLES_LANE,
      // Held while the transcription is planned (decision 1547's flow): with no method to run, the hold becomes the user's choice.
      ...(tr ? { hold: 'transcription-check' as const } : {}),
      run: (signal, jobId) => this.run(entry, signal, jobId),
      onCancelledBeforeStart: () => { this.forget(entry); },
    });
    entry.jobId = job.id;
    this.active.set(key, entry);
    void this.deps.queue.whenSettled(job.id).then(() => this.forget(entry));
    if (tr) void this.plan(entry);
    return job;
  }

  private forget(entry: Active): void {
    entry.planning?.abort();
    const key = keyOf(entry.ref);
    if (this.active.get(key) === entry) this.active.delete(key);
  }

  /**
   * The check before the job runs, in the background (the analysis's precheck, decision 1547): `run` releases the job with
   * that method; `ask` holds it for the user's choice, unless the mix has no speech (no audio clip, or silent: the job then
   * ends with "no speech", nothing asked); `skip` (the setting is "never") or a check out of time releases it to fail saying
   * so. Bounded, and stopped with the job.
   */
  private async plan(entry: Active): Promise<void> {
    const own = entry.planning;
    const tr = this.deps.transcriber;
    if (!own || !tr) return;
    let plan: Awaited<ReturnType<Transcriber['plan']>> | null = null;
    let speech = true;
    let timedOut = false;
    try {
      const signal = AbortSignal.any([own.signal, AbortSignal.timeout(precheckLimitMs(this.deps.planMaxMs ?? PLAN_MAX_MS, entry.audioSec))]);
      plan = await untilAborted(tr.plan(entry.audioSec), signal);
      if ('ask' in plan) speech = await untilAborted(this.hasSpeech(entry.ref, entry.timing, signal), signal);
    } catch { timedOut = true; }
    if (own.signal.aborted || entry.planning !== own || this.active.get(keyOf(entry.ref)) !== entry) return;
    entry.planning = null;
    if (timedOut) entry.blocked = 'timeout';
    else if (plan && 'skip' in plan) entry.blocked = 'off';
    else if (plan && 'ask' in plan && speech) {
      entry.pending = plan.ask;
      this.deps.queue.setHold(entry.jobId, 'transcription-choice');
      return;
    } else if (plan && 'run' in plan) entry.method = plan.run;
    this.deps.queue.setHold(entry.jobId, null);
  }

  /** Whether the mix of `timing` has speech (less than 95 % silence); false when it has no audio or cannot be read. */
  private async hasSpeech(ref: CreativeRef, timing: SubtitleTiming, signal: AbortSignal): Promise<boolean> {
    if (mixClips(timing.ic.composition).length === 0) return false;
    if (!(await this.deps.ffmpeg?.().catch(() => null))) return false;
    const tmp = await mkdtemp(join(tmpdir(), 'ms-subtitles-pre-'));
    try {
      const duration = timing.ic.composition.duration;
      const mix = await this.mixCreativeAudio(ref, timing, tmp, signal);
      const wav = join(tmp, 'audio.wav');
      if (!mix) return false;
      if (!await extractWav(this.ff, mix, wav, signal, duration)) return false;
      return (await silenceRatio(this.ff, wav, duration, signal)) < SILENCE_NO_SPEECH;
    } catch {
      return false;
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * The audio mix of `timing` (its composition's audio clips, as the render mixes them; a language's own video with its
   * localized voices, Task 24) as `mix.wav` in `workDir`, its path; null without ffmpeg or when nothing could be mixed (no
   * audio clip).
   */
  async mixCreativeAudio(ref: CreativeRef, timing: SubtitleTiming, workDir: string, signal: AbortSignal): Promise<string | null> {
    const ff = await this.deps.ffmpeg?.().catch(() => null);
    if (!ff) return null;
    const clips = mixClips(timing.ic.composition);
    if (clips.length === 0) return null;
    const compDir = await mixFolder(ref.projectDir, timing, clips, workDir);
    const outWav = join(workDir, 'mix.wav');
    const mixed = await mixAudio({ ff, compDir, clips, durationSec: timing.ic.composition.duration, outWav, workDir, signal });
    return mixed ? outWav : null;
  }

  /**
   * Task 24 (spec §6.5): whether `lang`'s localized video of `ref`'s latest version has its own voices (`localizedVoiceOf`):
   * a new set in `lang` is then made from that audio (`start` with `lang`), not translated. False without a version.
   */
  async localizedVoiceLang(ref: CreativeRef, lang: LocaleTag): Promise<boolean> {
    const store = new CreativeStore(ref.projectDir);
    const latest = (await store.readVersions(ref.creativeSlug)).at(-1);
    if (!latest) return false;
    return localizedVoiceOf(store.dir(ref.creativeSlug), latest, (await store.get(ref.creativeSlug)).brief, await this.deps.presets(), lang);
  }

  /**
   * Task 13: the waveform of the subtitle timeline: `version`'s main format mixed, decoded at 4 kHz and cut into
   * SUBTITLE_WAVEFORM_PEAKS peaks over the composition's duration (no audio: no peaks). With `lang`, the audio that language's
   * set is timed on (its own localized video, Task 24). Cached as `.studio/cache/subtitles/<creative>/wave-<audio
   * fingerprint>.json`. 404 for an unknown version, 409 `subtitles-no-video` when it has no video format.
   */
  async waveform(ref: CreativeRef, n: number, lang?: LocaleTag): Promise<{ peaks: number[]; durationMs: number }> {
    const store = new CreativeStore(ref.projectDir);
    const version = (await store.readVersions(ref.creativeSlug)).find((v) => v.n === n);
    if (!version) throw new CodedError(404, t().errors.notFound, 'version-not-found');
    const presets = await this.deps.presets();
    const creativeDir = store.dir(ref.creativeSlug);
    const locale = lang ? (await readSubtitleSet(creativeDir, lang))?.set.timing.locale : undefined;
    const timing = await subtitleTimingOf(creativeDir, version, (await store.get(ref.creativeSlug)).brief, presets, locale);
    if (!timing) throw new CodedError(409, t().errors.subtitlesNoVideo, 'subtitles-no-video');
    const { ic } = timing;
    const durationMs = ms(ic.composition.duration);
    const dir = await realDirChain(ref.projectDir, ['.studio', 'cache', 'subtitles', ref.creativeSlug]);
    if (!dir) throw new CodedError(422, t().errors.waveformUnavailable, 'waveform-unavailable');
    const cache = join(dir, `wave-${timing.fingerprint}.json`);
    const pending = waveInFlight.get(cache);
    if (pending) return pending;
    const job = (async () => {
      const hit = !(await lstat(cache).catch(() => null))?.isFile() ? null : await readFile(cache, 'utf8').then((s) => JSON.parse(s) as { peaks?: unknown; durationMs?: unknown }).catch(() => null);
      if (hit && hit.durationMs === durationMs && Array.isArray(hit.peaks) && hit.peaks.length <= SUBTITLE_WAVEFORM_PEAKS && hit.peaks.every((p) => typeof p === 'number')) {
        return { peaks: hit.peaks as number[], durationMs };
      }
      if (!(await this.deps.ffmpeg?.().catch(() => null))) throw new CodedError(409, t().errors.noFfmpegSubtitles, 'subtitles-no-ffmpeg');
      const work = await mkdtemp(join(tmpdir(), 'ms-subtitles-wave-'));
      try {
        const mix = await this.mixCreativeAudio(ref, timing, work, AbortSignal.timeout(WAVE_MAX_MS));
        // No audio clip (or a mix that failed): no peaks, and nothing cached.
        if (!mix) return { peaks: [], durationMs };
        const got = await filePeaks(decodePcmWith(this.ff), mix, work, { buckets: SUBTITLE_WAVEFORM_PEAKS, maxSec: Math.ceil(ic.composition.duration) + 1 });
        if (!got) throw new CodedError(422, t().errors.waveformUnavailable, 'waveform-unavailable');
        // A very short mix has fewer samples than peaks: spread to the full count, so each peak is the same slice of time.
        const peaks = got.length === SUBTITLE_WAVEFORM_PEAKS ? got : Array.from({ length: SUBTITLE_WAVEFORM_PEAKS }, (_, i) => got[Math.floor((i * got.length) / SUBTITLE_WAVEFORM_PEAKS)] ?? 0);
        const out = { peaks, durationMs };
        await writeThroughTemp(dir, basename(cache), async (temp) => { await writeFile(temp, JSON.stringify(out), { flag: 'wx' }); return true; }).catch(() => {});
        return out;
      } finally {
        await rm(work, { recursive: true, force: true }).catch(() => {});
      }
    })();
    waveInFlight.set(cache, job);
    try { return await job; } finally { waveInFlight.delete(cache); }
  }

  private asking(ref: CreativeRef): Active | null {
    const a = this.active.get(keyOf(ref));
    return a?.pending ? a : null;
  }

  /** What the held job of `ref` asks about its transcription; null when it asks nothing. */
  pending(ref: CreativeRef): TranscriptionPending | null { return this.asking(ref)?.pending ?? null; }

  /**
   * The user's answer to the transcription dialog of `ref`'s job (the analysis's semantics): a refusal throws the
   * transcriber's CodedError and the dialog stays; a model download keeps the job held until it ends (failed: the dialog
   * stays with the error). `none` stops the job, with a chat line: there are no subtitles without a transcription. `remember`: the other
   * subtitles jobs still asking are planned again.
   */
  async choose(ref: CreativeRef, c: Omit<TranscriptionChoice, 'file'>): Promise<void> {
    const a = this.asking(ref);
    const tr = this.deps.transcriber;
    if (!a?.pending || !tr) return;
    const { wait } = await tr.prepareChoice({ ...c, file: `creatives/${ref.creativeSlug}` });
    // A job stopped for "continue without a transcription" says so in the chat first (a cancelled job writes nothing else).
    const stop = async (entry: Active) => {
      entry.pending = null;
      await this.note(entry.jobId, entry.ref, 'warning', t().subtitles.cancelledNoTranscription, { state: 'failed' });
      this.deps.queue.cancel(entry.jobId);
    };
    const release = (entry: Active, how: TranscribeMethod) => {
      entry.method = how;
      entry.pending = null;
      this.deps.queue.setHold(entry.jobId, null);
    };
    const replanOthers = async () => {
      if (!c.remember) return;
      for (const other of [...this.active.values()]) {
        if (other === a || !other.pending) continue;
        const plan = await tr.plan(other.audioSec).catch(() => null);
        if (!plan || 'ask' in plan || !other.pending) continue;
        if ('run' in plan) release(other, plan.run);
        else await stop(other);
      }
    };
    if (c.choice === 'none') {
      await stop(a);
      await replanOthers();
      return;
    }
    if (wait) {
      const { error: _old, ...rest } = a.pending;
      a.pending = rest;
      void wait.then(async () => {
        if (this.active.get(keyOf(a.ref)) === a && a.pending) release(a, 'whisper');
        await replanOthers();
      }, (err: Error) => {
        if (a.pending) a.pending = { ...a.pending, error: err.message };
      });
      return;
    }
    release(a, c.choice);
    await replanOthers();
  }

  /** "Ricontrolla" in the dialog of `ref`'s job: the Whispers are looked for again and the question asked anew. */
  async recheck(ref: CreativeRef): Promise<TranscriptionPending | null> {
    const a = this.asking(ref);
    const tr = this.deps.transcriber;
    if (!a?.pending || !tr) return null;
    const asked = a.pending;
    const offer = await tr.recheck(asked.audioSec);
    // Answered meanwhile, or a download started or failed: the question stands as it is now.
    if (a.pending === asked) a.pending = offer;
    return a.pending;
  }

  /**
   * Task 14 (spec §6.7): version `n` of `ref` was just saved (an agent turn, `jobId`, or a direct edit, null). When its main
   * format's audio differs from what a subtitle set was timed on, the chat says "Il video è cambiato: ricontrolla i tempi"
   * (with "Rifai i tempi"): once, on the version that moved the audio (decision 1715): a version whose audio is the previous
   * version's tells nothing new. Nothing is changed: the sets keep their cues until the user retimes them. Only the sets made
   * from speech (Task 25): a translation follows its source (its lines are translated again from it, with its times) and
   * "Rifai i tempi" would refuse it. Never throws.
   */
  async versionSaved(ref: CreativeRef, n: number, jobId: string | null): Promise<void> {
    try {
      const store = new CreativeStore(ref.projectDir);
      const dir = store.dir(ref.creativeSlug);
      const sets = (await listSubtitleSets(dir)).filter((s) => s.origin === 'speech');
      if (sets.length === 0) return;
      const versions = await store.readVersions(ref.creativeSlug);
      const i = versions.findIndex((v) => v.n === n);
      if (i < 0) return;
      const brief = (await store.get(ref.creativeSlug)).brief;
      const presets = await this.deps.presets();
      // Each set against the video it was timed on: the original, or its language's own (Task 24).
      const known = new Map<string, Promise<string | null>>();
      const fingerprint = (v: VersionEntry, locale?: LocaleTag) => {
        const key = `${v.n}:${locale ?? ''}`;
        if (!known.has(key)) known.set(key, subtitleTimingOf(dir, v, brief, presets, locale).then((x) => x?.fingerprint ?? null));
        return known.get(key)!;
      };
      const off: SubtitleSet[] = [];
      for (const s of sets) {
        const now = await fingerprint(versions[i]!, s.timing.locale);
        if (!now || s.timing.fingerprint === now) continue;
        // Only on the version that moved that audio.
        if (i > 0 && (await fingerprint(versions[i - 1]!, s.timing.locale)) === now) continue;
        off.push(s);
      }
      if (off.length === 0) return;
      const set = speechSourceSet(off) ?? off[0]!;
      await this.note(jobId ?? '', ref, 'warning', t().subtitles.timingChanged, { state: 'timing-changed', lang: set.lang });
    } catch (err) {
      console.warn(`Motion Studio: the subtitles' timing check of ${ref.creativeSlug} v${n} failed: ${errText(err)}`);
    }
  }

  private async note(jobId: string, ref: CreativeRef, level: 'info' | 'warning' | 'error', text: string, subtitles: NonNullable<Extract<ConversationEntry, { type: 'system' }>['subtitles']>): Promise<void> {
    await this.deps.turns.noteFromTurn(jobId, ref, { type: 'system', at: new Date().toISOString(), level, text, subtitles }).catch(() => {});
  }

  private async run(entry: Active, signal: AbortSignal, jobId: string): Promise<void | 'cancelled'> {
    const { ref, o } = entry;
    const store = new CreativeStore(ref.projectDir);
    const creativeDir = store.dir(ref.creativeSlug);
    let work: string | null = null;
    try {
      const creative = await store.get(ref.creativeSlug);
      const version = (await store.readVersions(ref.creativeSlug)).at(-1);
      const presets = await this.deps.presets();
      // The language whose own localized video is heard (Task 24): a retime's set's, or a new set's language when its video
      // has its own voices now; else the original video.
      const audio = o.mode === 'retime' ? entry.audio
        : o.lang && version && await localizedVoiceOf(creativeDir, version, creative.brief, presets, o.lang) ? o.lang : undefined;
      // A language's own voice its video no longer has since the job was asked for (Minor 4).
      if (audio && !(version && await localizedVoiceOf(creativeDir, version, creative.brief, presets, audio))) throw new Error(t().errors.subtitlesVoiceGone({ lang: languageName(audio) }));
      const timing = version ? await subtitleTimingOf(creativeDir, version, creative.brief, presets, audio) : null;
      if (!version || !timing) throw new Error(t().errors.subtitlesNoVideo);
      const { format, ic } = timing;
      const ff = await this.deps.ffmpeg?.().catch(() => null);
      if (!ff) throw new Error(t().errors.noFfmpegSubtitles);
      const duration = ic.composition.duration;

      // The mix and its 16 kHz copy in the project's cache, removed after (a leftover of an earlier job is cleared first). Their
      // own `job` folder: the creative's cache folder also keeps the timeline's waveforms.
      const cache = await realDirChain(ref.projectDir, ['.studio', 'cache', 'subtitles', ref.creativeSlug]);
      if (!cache) throw new Error(`.studio/cache/subtitles/${ref.creativeSlug} is not a folder`);
      work = join(cache, 'job');
      await rm(work, { recursive: true, force: true });
      await mkdir(work);
      const wav = join(work, 'audio.wav');
      const mix = await this.mixCreativeAudio(ref, timing, work, signal);
      if (signal.aborted) return 'cancelled';
      let speech = mix !== null && await extractWav(this.ff, mix, wav, signal, duration);
      if (speech && (await silenceRatio(this.ff, wav, duration, signal)) >= SILENCE_NO_SPEECH) speech = false;
      if (signal.aborted) return 'cancelled';
      // "No speech" only when it is true: no audio, a silent mix, or an engine that heard nothing. A transcription that was not
      // made (switched off, unavailable, failed, a check out of time) is a failure that says why.
      const noSpeech = () => this.note(jobId, ref, 'info', t().subtitles.noSpeech, { state: 'no-speech' });
      if (!speech) { await noSpeech(); return; }
      const transcriber = this.deps.transcriber;
      if (!transcriber) throw new Error(t().subtitles.transcriptionUnavailable);
      if (entry.blocked) throw new Error(entry.blocked === 'off' ? t().subtitles.transcriptionOff : t().subtitles.transcriptionTimeout);
      const tr = await transcriber.transcribe({
        ref, file: `creatives/${ref.creativeSlug}`, jobId, wav, durationSec: duration, signal,
        ...(entry.method ? { method: entry.method } : {}), words: true, language: o.lang ?? null,
      });
      if (signal.aborted) return 'cancelled';
      if (tr.kind === 'none-skipped') {
        const off = (await transcriber.settings?.().catch(() => null))?.method === 'never';
        throw new Error(off ? t().subtitles.transcriptionOff : t().subtitles.transcriptionUnavailable);
      }
      if (tr.kind === 'none-no-speech' || (tr.segments.length === 0 && !tr.words?.length)) { await noSpeech(); return; }
      const lang = subtitleLangOf(o.lang ?? tr.language);
      if (!lang) {
        const text = tr.language ? t().subtitles.unsupported({ detected: languageName(tr.language) }) : t().subtitles.unsupportedUnknown;
        await this.note(jobId, ref, 'warning', text, { state: 'unsupported-language', ...(tr.language ? { detected: tr.language } : {}) });
        return;
      }

      let fresh: SubtitleCue[];
      if (tr.words?.length) {
        let words: TimedWord[] = tr.words.map((w) => ({ start: ms(w.from), end: Math.max(ms(w.from), ms(w.to)), text: w.text }));
        const scripts = await knownVoiceScripts(ic, ref.projectDir, this.deps.media).catch(() => new Map<string, string>());
        if (scripts.size > 0) words = alignVoices(words, ic, scripts);
        fresh = buildCues({ words: splitCjkWords(words) }, lang);
      } else {
        fresh = buildCues({ segments: tr.segments.map((s) => ({ start: ms(s.from), end: Math.max(ms(s.from), ms(s.to)), text: s.text })) }, lang);
      }
      if (signal.aborted) return 'cancelled';

      // Re-read just before writing, under the sets' lock (decision 1654): a save of the editor during the transcription keeps
      // its edited cues (anti-goal 1), and one arriving now waits for this write and then meets its new hash (409). The
      // translations of the original speech set follow its new times (Task 25, `followSource`), under the same lock.
      let followed: LocaleTag[] = [];
      await subtitleSetLocks.run(creativeDir, async () => {
        // One set from the original video's speech, never over a translation (final review I3): the language is known now.
        const refusal = speechSetRefusal(await listSubtitleSets(creativeDir), lang, audio);
        if (refusal) throw new Error(refusal.message);
        const existing = await readSubtitleSet(creativeDir, lang);
        // A file there that is not a valid set may hold the user's corrections: never overwritten (anti-goal 1).
        if (!existing && await lstat(subtitlePath(creativeDir, lang)).then(() => true, () => false)) {
          throw new Error(t().subtitles.setUnreadable({ file: `${SUBTITLES_DIR}/${lang}.json` }));
        }
        const cues = capCues(existing ? mergeKeepingEdited(existing.set.cues, fresh) : fresh);
        let set: SubtitleSet = {
          $schema: SUBTITLES_SCHEMA_ID, lang, origin: 'speech', transcript: tr.kind, detected: tr.language,
          timing: { version: version.n, format, fingerprint: timing.fingerprint, ...(audio ? { locale: audio } : {}) }, cues,
        };
        // A set over the file limit loses its word timings (word highlighting then falls back to whole cues).
        if (Buffer.byteLength(subtitleSetText(set)) > SUBTITLE_LIMITS.fileBytes) set = { ...set, cues: set.cues.map(({ words: _w, ...c }) => c) };
        const valid = subtitleSetSchema.safeParse(set);
        if (!valid.success || Buffer.byteLength(subtitleSetText(set)) > SUBTITLE_LIMITS.fileBytes) throw new Error(valid.success ? 'the subtitles are too large' : valid.error.message);
        await writeSubtitleSet(creativeDir, set);
        if (!audio) followed = await followSource(creativeDir, existing?.set ?? null, set);
      });
      this.deps.commits.touch(ref, t().subtitles.commit({ title: creative.title, lang }));
      for (const l of [lang, ...followed]) {
        try { this.deps.broadcast({ type: 'subtitles', project: ref.projectSlug, creative: ref.creativeSlug, lang: l }); } catch { /* a faulty listener */ }
      }
      const briefLang = creative.brief.locales?.primary;
      // A language's own voice was known, not heard: never "a language other than the brief's".
      const other = !audio && briefLang !== undefined && briefLang !== lang;
      const text = o.mode === 'retime' ? t().subtitles.retimed({ lang: languageName(lang) })
        : other ? t().subtitles.readyOtherLang({ lang: languageName(lang), brief: languageName(briefLang) }) : t().subtitles.ready({ lang: languageName(lang) });
      await this.note(jobId, ref, 'info', text, {
        state: 'ready', lang, ...(tr.language ? { detected: tr.language } : {}), ...(other ? { briefLang } : {}),
      });
      for (const fn of this.readyHooks) { try { fn(ref, { lang, drawn: o.drawn === true }, jobId); } catch { /* a hook never fails the job */ } }
    } catch (err) {
      if (signal.aborted || (err as Error).name === 'AbortError') return 'cancelled';
      const reason = errText(err);
      await this.note(jobId, ref, 'error', t().subtitles.failed({ reason }), { state: 'failed' });
      throw new JobFailedError(t().subtitles.failed({ reason }));
    } finally {
      if (work) await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }
}
