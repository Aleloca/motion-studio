import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  alignToScript, buildCues, effectiveLinks, mergeKeepingEdited, SILENCE_NO_SPEECH, SUBTITLE_LIMITS, SUBTITLES_SCHEMA_ID, subtitleLangOf, subtitleSetSchema,
  subtitleSetText, subtitlesJobKey,
  type Brief, type ConversationEntry, type FormatPreset, type JobSummary, type LocaleTag, type ServerMessage, type SubtitleCue, type SubtitleSet,
  type TimedWord, type TranscribeMethod, type TranscriptionChoice, type TranscriptionPending, type TranscriptKind, type VersionEntry,
} from '@motion-studio/shared';
import { extractWav, silenceRatio } from '../analysis/audio.ts';
import type { Transcriber } from '../analysis/video-analysis.ts';
import { realDirChain } from '../creatives/core-files.ts';
import { CreativeStore } from '../creatives/creative-store.ts';
import type { CreativeRef, CreativeTurnService } from '../creatives/creative-turns.ts';
import { execCommand, type CommandExec } from '../exec.ts';
import { findPreset } from '../formats/format-catalog.ts';
import { currentLocale, t } from '../i18n.ts';
import { JobFailedError, type JobQueue } from '../jobs/job-queue.ts';
import { instanceComposition, knownVoiceScripts, type InstanceComposition } from '../localization/store.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { mixAudio, mixClips } from '../render/audio-mix.ts';
import type { FfmpegInfo } from '../render/encode.ts';
import { CodedError } from '../workspace-store.ts';
import { audioFingerprint, readSubtitleSet, type SubtitleCommits, writeSubtitleSet } from './store.ts';

/** The queue lane of the subtitles jobs (decision 1640): one at a time, never in an agent turn's slot. */
export const SUBTITLES_LANE = 'subtitles';
/** The plan before a transcription choice gives up after this long: the job then goes ahead with what the settings give. */
const PLAN_MAX_MS = 60_000;

export interface SubtitlesDeps {
  queue: JobQueue;
  /** The transcription (the analyses' one); absent: every job ends with no speech. */
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
}

export interface SubtitlesStart { mode: 'new' | 'retime'; lang?: LocaleTag; drawn?: boolean }

/** A subtitles job queued or running: one per creative. */
interface Active {
  ref: CreativeRef; jobId: string; o: SubtitlesStart; audioSec: number;
  /** The user's transcription choice, or what the plan resolved to; null: what the settings resolve to when it runs. */
  method: TranscribeMethod | null;
  /** What the held job asks the user; null: nothing. */
  pending: TranscriptionPending | null;
  /** The plan before the job runs, while it runs: aborted when the job ends. */
  planning: AbortController | null;
}

const keyOf = (ref: CreativeRef) => subtitlesJobKey(ref.root, ref.projectSlug, ref.creativeSlug);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const abortedError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
const ms = (sec: number) => Math.max(0, Math.round(sec * 1000));

/** The language's name in the app language ("italiano"), its tag when unknown. */
function languageName(tag: string): string {
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

const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;

/**
 * whisper.cpp's CJK tokens have no leading space, so a whole segment may arrive as one long "word": every word holding a
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
  private readonly readyHooks: Array<(ref: CreativeRef, r: { lang: LocaleTag; drawn: boolean }) => void> = [];
  private readonly ff: CommandExec;

  constructor(private readonly deps: SubtitlesDeps) {
    this.ff = deps.ffExec ?? execCommand;
  }

  /** `fn` runs when a job wrote a set (Phase 3: the style turn of drawn subtitles). */
  onReady(fn: (ref: CreativeRef, r: { lang: LocaleTag; drawn: boolean }) => void): void { this.readyHooks.push(fn); }

  private jobActive(key: string): boolean {
    return this.deps.queue.list().some((j) => j.key === key && (j.state === 'queued' || j.state === 'running'));
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
    const creative = await store.get(ref.creativeSlug);
    const latest = (await store.readVersions(ref.creativeSlug)).at(-1);
    const presets = await this.deps.presets();
    const format = latest ? subtitleSourceFormat(latest, creative.brief, presets) : null;
    const ic = latest && format ? await instanceComposition(store.dir(ref.creativeSlug), latest, format, presets) : null;
    if (!ic) throw new CodedError(409, t().errors.subtitlesNoVideo, 'subtitles-no-video');
    if (!(await this.deps.ffmpeg?.().catch(() => null))) throw new CodedError(409, t().errors.noFfmpegSubtitles, 'subtitles-no-ffmpeg');
    if (this.active.has(key) || this.jobActive(key)) throw running();
    const tr = this.deps.transcriber;
    const entry: Active = { ref, jobId: '', o, audioSec: ic.composition.duration, method: null, pending: null, planning: tr ? new AbortController() : null };
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

  /** The transcription plan, in the background: run → released with that method; ask → held for the user; else released. */
  private async plan(entry: Active): Promise<void> {
    const own = entry.planning;
    const tr = this.deps.transcriber;
    if (!own || !tr) return;
    type Plan = Awaited<ReturnType<Transcriber['plan']>>;
    let plan: Plan | null = null;
    try {
      const signal = AbortSignal.any([own.signal, AbortSignal.timeout(PLAN_MAX_MS)]);
      plan = await new Promise<Plan>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(abortedError()), { once: true });
        tr.plan(entry.audioSec).then(resolve, reject);
      });
    } catch { /* the settings decide when the job runs */ }
    if (own.signal.aborted || entry.planning !== own || this.active.get(keyOf(entry.ref)) !== entry) return;
    entry.planning = null;
    if (plan && 'ask' in plan) {
      entry.pending = plan.ask;
      this.deps.queue.setHold(entry.jobId, 'transcription-choice');
      return;
    }
    if (plan && 'run' in plan) entry.method = plan.run;
    this.deps.queue.setHold(entry.jobId, null);
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
   * stays with the error). `none` stops the job: there are no subtitles without a transcription. `remember`: the other
   * subtitles jobs still asking are planned again.
   */
  async choose(ref: CreativeRef, c: Omit<TranscriptionChoice, 'file'>): Promise<void> {
    const a = this.asking(ref);
    const tr = this.deps.transcriber;
    if (!a?.pending || !tr) return;
    const { wait } = await tr.prepareChoice({ ...c, file: `creatives/${ref.creativeSlug}` });
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
        else { other.pending = null; this.deps.queue.cancel(other.jobId); }
      }
    };
    if (c.choice === 'none') {
      a.pending = null;
      this.deps.queue.cancel(a.jobId);
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
      const format = version ? subtitleSourceFormat(version, creative.brief, presets) : null;
      const ic = version && format ? await instanceComposition(creativeDir, version, format, presets) : null;
      if (!version || !format || !ic) throw new Error(t().errors.subtitlesNoVideo);
      const ff = await this.deps.ffmpeg?.().catch(() => null);
      if (!ff) throw new Error(t().errors.noFfmpegSubtitles);
      const duration = ic.composition.duration;

      // The mix and its 16 kHz copy in the project's cache, removed after (a leftover of an earlier job is cleared first).
      const cache = await realDirChain(ref.projectDir, ['.studio', 'cache', 'subtitles']);
      if (!cache) throw new Error('.studio/cache/subtitles is not a folder');
      work = join(cache, ref.creativeSlug);
      await rm(work, { recursive: true, force: true });
      await mkdir(work);
      const mix = join(work, 'mix.wav');
      const wav = join(work, 'audio.wav');
      const mixed = await mixAudio({ ff, compDir: ic.compDir, clips: mixClips(ic.composition), durationSec: duration, outWav: mix, workDir: work, signal });
      if (signal.aborted) return 'cancelled';
      let speech = mixed && await extractWav(this.ff, mix, wav, signal, duration);
      if (speech && (await silenceRatio(this.ff, wav, duration, signal)) >= SILENCE_NO_SPEECH) speech = false;
      if (signal.aborted) return 'cancelled';
      let tr: { kind: TranscriptKind; segments: Array<{ from: number; to: number; text: string }>; words?: Array<{ from: number; to: number; text: string }>; language: string | null } | null = null;
      if (speech && this.deps.transcriber) {
        tr = await this.deps.transcriber.transcribe({
          ref, file: `creatives/${ref.creativeSlug}`, jobId, wav, durationSec: duration, signal,
          ...(entry.method ? { method: entry.method } : {}), words: true, language: o.lang ?? null,
        });
      }
      if (signal.aborted) return 'cancelled';
      if (!tr || tr.kind === 'none-skipped' || tr.kind === 'none-no-speech' || (tr.segments.length === 0 && !tr.words?.length)) {
        await this.note(jobId, ref, 'info', t().subtitles.noSpeech, { state: 'no-speech' });
        return;
      }
      const lang = subtitleLangOf(o.lang ?? tr.language);
      if (!lang) {
        const detected = tr.language ?? '?';
        await this.note(jobId, ref, 'warning', t().subtitles.unsupported({ detected: languageName(detected) }), { state: 'unsupported-language', ...(tr.language ? { detected: tr.language } : {}) });
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

      // Re-read just before writing: a save of the editor during the transcription keeps its edited cues (anti-goal 1).
      const existing = await readSubtitleSet(creativeDir, lang);
      const cues = (existing ? mergeKeepingEdited(existing.set.cues, fresh) : fresh).slice(0, SUBTITLE_LIMITS.cues);
      let set: SubtitleSet = {
        $schema: SUBTITLES_SCHEMA_ID, lang, origin: 'speech', transcript: tr.kind, detected: tr.language,
        timing: { version: version.n, format, fingerprint: audioFingerprint(ic.composition) }, cues,
      };
      // A set over the file limit loses its word timings (word highlighting then falls back to whole cues).
      if (Buffer.byteLength(subtitleSetText(set)) > SUBTITLE_LIMITS.fileBytes) set = { ...set, cues: set.cues.map(({ words: _w, ...c }) => c) };
      const valid = subtitleSetSchema.safeParse(set);
      if (!valid.success || Buffer.byteLength(subtitleSetText(set)) > SUBTITLE_LIMITS.fileBytes) throw new Error(valid.success ? 'the subtitles are too large' : valid.error.message);
      await writeSubtitleSet(creativeDir, set);
      this.deps.commits.touch(ref, t().subtitles.commit({ title: creative.title, lang }));
      try { this.deps.broadcast({ type: 'subtitles', project: ref.projectSlug, creative: ref.creativeSlug, lang }); } catch { /* a faulty listener */ }
      const briefLang = creative.brief.locales?.primary;
      const other = briefLang !== undefined && briefLang !== lang;
      await this.note(jobId, ref, 'info', other ? t().subtitles.readyOtherLang({ lang: languageName(lang), brief: languageName(briefLang) }) : t().subtitles.ready({ lang: languageName(lang) }), {
        state: 'ready', lang, ...(tr.language ? { detected: tr.language } : {}), ...(other ? { briefLang } : {}),
      });
      for (const fn of this.readyHooks) { try { fn(ref, { lang, drawn: o.drawn === true }); } catch { /* a hook never fails the job */ } }
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
