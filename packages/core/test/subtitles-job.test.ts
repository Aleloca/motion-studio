// @vitest-environment node
/**
 * The subtitles job (decisions 1637-1640): the creative's audio mix, transcribed (a fake transcriber with fixed words), the
 * voice scripts as the truth, the cues cut and merged with the user's edits, the set written, the chat told. Real ffmpeg on
 * tones made here; no Whisper, no provider.
 */
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SUBTITLES_SCHEMA_ID, subtitleCuesHash, type Brief, type Composition, type ConversationEntry, type FormatPreset, type Localization, type ServerMessage, type SubtitleSet, type TranscriptionPending,
  type TranscriptKind, type TranscriptWord,
} from '@motion-studio/shared';
import type { Transcriber } from '../src/analysis/video-analysis.ts';
import { readCompositionFolder } from '../src/compositions/composition-files.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import type { CreativeRef } from '../src/creatives/creative-turns.ts';
import { execCommand } from '../src/exec.ts';
import { t } from '../src/i18n.ts';
import { JobQueue } from '../src/jobs/job-queue.ts';
import { emptyOverlay, localizedComposition, setLocalizationRow, writeOverlay } from '../src/localization/store.ts';
import { NoMediaTools } from '../src/media/media-tools.ts';
import { findFfmpeg } from '../src/render/encode.ts';
import { silenceRatio } from '../src/analysis/audio.ts';
import { subtitleSummaries } from '../src/server/subtitles-routes.ts';
import { audioFingerprint, followSource, readSubtitleSet, subtitleSetLocks, writeSubtitleSet } from '../src/subtitles/store.ts';
import { languageName, splitCjkWords, SUBTITLES_LANE, SubtitlesService } from '../src/subtitles/subtitles-job.ts';

const PRESETS: FormatPreset[] = [
  { id: 'test-wide', channel: 'Test', name: 'Wide', width: 320, height: 180, kind: 'video', extensions: ['mp4'] },
  { id: 'test-still', channel: 'Test', name: 'Still', width: 320, height: 180, kind: 'image', extensions: ['png'] },
];

let fixtures: string;
beforeAll(async () => {
  fixtures = await mkdtemp(join(tmpdir(), 'ms-subtitles-job-fx-'));
  const ff = async (args: string[]) => {
    const r = await execCommand('ffmpeg', ['-y', '-loglevel', 'error', ...args], { timeoutMs: 60_000 });
    if (r.code !== 0) throw new Error(r.stderr);
  };
  await ff(['-f', 'lavfi', '-i', 'sine=f=440:d=3:r=48000', '-c:a', 'pcm_s16le', join(fixtures, 'tone.wav')]);
  await ff(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '3', '-c:a', 'pcm_s16le', join(fixtures, 'silence.wav')]);
  // A localized voice (Task 24): 1.5 s of another tone, so a mix of it is half silent.
  await ff(['-f', 'lavfi', '-i', 'sine=f=880:d=1.5:r=48000', '-c:a', 'pcm_s16le', join(fixtures, 'short.wav')]);
}, 60_000);
afterAll(async () => { await rm(fixtures, { recursive: true, force: true }); });

const audioClip = (o: { src?: string; script?: string } = {}) => ({
  id: 'vo', type: 'audio', src: `assets/${o.src ?? 'tone.wav'}`, start: 0, duration: 3, ...(o.script ? { role: 'voice', script: o.script } : {}),
});
const composition = (clips: object[]): Composition => ({
  $schema: 'motion-studio/composition@1', width: 320, height: 180, fps: 30, duration: 3, background: '#101010', fonts: [], scenes: [],
  tracks: [
    { id: 'v', kind: 'visual', clips: [] },
    ...(clips.length ? [{ id: 'a', kind: 'audio', clips }] : []),
  ],
} as unknown as Composition);

const words = (list: Array<[number, number, string]>): TranscriptWord[] => list.map(([from, to, text]) => ({ from, to, text }));
const HELLO = words([[0.2, 0.6, 'Ciao'], [0.7, 1.2, 'a'], [1.25, 1.8, 'tutti.']]);

interface Fake {
  result: { kind: TranscriptKind; words?: TranscriptWord[]; language: string | null }; gate: Promise<void> | null;
  /** null: the plan never answers. */
  plan: Awaited<ReturnType<Transcriber['plan']>> | null;
  method: 'ask' | 'never' | 'whisper';
  /** Task 24: the transcriber measures the silence of the WAV it gets (into `heard`). */
  listen?: boolean;
}
const PENDING: TranscriptionPending = {
  kind: 'transcription', audioSec: 3, whisper: { available: true, modelPresent: true, model: 'small', sizeBytes: 1, engine: 'whisper.cpp' },
  openai: { keySaved: false, costUsd: 0 }, elevenlabs: { keySaved: false, costUsd: 0 },
} as unknown as TranscriptionPending;

let base: string;
let ref: CreativeRef;
let store: CreativeStore;
let queue: JobQueue;
let fake: Fake;
let transcribed: Array<Parameters<Transcriber['transcribe']>[0]>;
let heard: number[];
let entries: ConversationEntry[];
let sent: ServerMessage[];
let touch: ReturnType<typeof vi.fn>;
let ready: Array<{ lang: string; drawn: boolean }>;
let service: SubtitlesService;

const transcriber: Transcriber = {
  plan: () => (fake.plan ? Promise.resolve(fake.plan) : new Promise(() => {})),
  settings: async () => ({ method: fake.method }),
  prepareChoice: async () => ({}),
  recheck: async () => PENDING,
  transcribe: async (i) => {
    transcribed.push(i);
    if (fake.listen) heard.push(await silenceRatio(execCommand, i.wav, i.durationSec));
    if (fake.gate) {
      const stopped = new Promise<never>((_, reject) => { i.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }); });
      await Promise.race([fake.gate, stopped]);
    }
    return { kind: fake.result.kind, segments: [], ...(fake.result.words ? { words: fake.result.words } : {}), language: fake.result.language };
  },
};

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ms-subtitles-job-'));
  const projectDir = join(base, 'acme');
  await mkdir(projectDir, { recursive: true });
  store = new CreativeStore(projectDir);
  fake = { result: { kind: 'whisper-small', words: HELLO, language: 'it' }, gate: null, plan: { run: 'whisper' }, method: 'whisper' };
  transcribed = []; heard = []; entries = []; sent = []; ready = [];
  touch = vi.fn();
  queue = new JobQueue({ concurrency: 2, lanes: { [SUBTITLES_LANE]: 1 } });
  service = new SubtitlesService({
    queue, transcriber, ffmpeg: () => findFfmpeg(), media: NoMediaTools,
    turns: { noteFromTurn: async (_job, _ref, e) => { entries.push(e); } },
    commits: { touch },
    broadcast: (m) => { sent.push(m); },
    presets: async () => PRESETS,
    planMaxMs: 300,
  });
  service.onReady((_r, r) => { ready.push(r); });
  return async () => { await queue.whenIdle(); await rm(base, { recursive: true, force: true }); };
});

async function creative(clips: object[], o: { formats?: string[]; files?: string[] } = {}) {
  const brief: Brief = { goal: 'Promo', message: '', formats: o.formats ?? ['test-wide'], durationSec: 3, assets: [], notes: '', locales: { primary: 'it', extra: [] } };
  const { slug } = await store.create({ title: 'Promo', brief });
  ref = { root: base, projectSlug: 'acme', projectDir: join(base, 'acme'), creativeSlug: slug };
  const dir = join(store.outputsDir(slug, 1), 'compositions', 'test-wide');
  await mkdir(join(dir, 'assets'), { recursive: true });
  for (const f of o.files ?? ['tone.wav']) await copyFile(join(fixtures, f), join(dir, 'assets', f));
  const c = composition(clips);
  await writeFile(join(dir, 'composition.json'), JSON.stringify(c));
  await store.appendVersion(slug, {
    n: 1, commit: null, sessionId: null, status: 'complete', createdAt: new Date().toISOString(), request: '', outputs: [], problems: [], tools: [],
    renderCommand: null, basedOn: null, compositions: [{ format: 'test-wide', dir: 'compositions/test-wide', hash: (await readCompositionFolder(dir)).hash }],
  });
  return c;
}

const run = async (o: Parameters<SubtitlesService['start']>[1] = { mode: 'new' }) => {
  const job = await service.start(ref, o);
  const done = await queue.whenSettled(job.id);
  expect(done?.state, done?.error).toBe('succeeded');
  return done;
};
const runFailed = async () => {
  const job = await service.start(ref, { mode: 'new' });
  expect((await queue.whenSettled(job.id))?.state).toBe('failed');
};
const subtitleEntries = () => entries.filter((e) => e.type === 'system' && e.subtitles);
const creativeDir = () => store.dir(ref.creativeSlug);

describe('SubtitlesService', { timeout: 60_000 }, () => {
  it('ready: writes the set with cues from the words, the timing of v1, one chat entry, one broadcast, one commit', async () => {
    const c = await creative([audioClip()]);
    await run();
    const r = await readSubtitleSet(creativeDir(), 'it');
    expect(r!.set).toMatchObject({ $schema: SUBTITLES_SCHEMA_ID, lang: 'it', origin: 'speech', transcript: 'whisper-small', detected: 'it' });
    expect(r!.set.timing).toEqual({ version: 1, format: 'test-wide', fingerprint: audioFingerprint(c) });
    expect(r!.set.cues.map((x) => [x.start, x.end, x.text])).toEqual([[200, 1800, 'Ciao a tutti.']]);
    expect(transcribed[0]).toMatchObject({ words: true, language: null, durationSec: 3 });
    expect(subtitleEntries()).toEqual([expect.objectContaining({ level: 'info', subtitles: { state: 'ready', lang: 'it', detected: 'it' } })]);
    expect(sent.filter((m) => m.type === 'subtitles')).toEqual([{ type: 'subtitles', project: 'acme', creative: ref.creativeSlug, lang: 'it' }]);
    expect(touch).toHaveBeenCalledTimes(1);
    expect(ready).toEqual([{ lang: 'it', drawn: false }]);
  });

  it('a language the user picks is told to the transcriber and kept', async () => {
    await creative([audioClip()]);
    fake.result = { kind: 'whisper-small', words: HELLO, language: 'it' };
    await run({ mode: 'new', lang: 'it', drawn: true });
    expect(transcribed[0]!.language).toBe('it');
    expect(ready).toEqual([{ lang: 'it', drawn: true }]);
  });

  it('detected language differs from the brief: the set is in the detected one and the entry names the brief\'s', async () => {
    await creative([audioClip()]);
    fake.result = { kind: 'whisper-small', words: words([[0.2, 1.0, 'Hello'], [1.1, 1.8, 'everyone.']]), language: 'en' };
    await run();
    expect(await readSubtitleSet(creativeDir(), 'it')).toBeNull();
    expect((await readSubtitleSet(creativeDir(), 'en'))!.set.cues[0]!.text).toBe('Hello everyone.');
    expect(subtitleEntries()[0]).toMatchObject({ subtitles: { state: 'ready', lang: 'en', detected: 'en', briefLang: 'it' } });
  });

  it('a voice script is the truth: the heard words are replaced, their times kept', async () => {
    await creative([audioClip({ script: 'Motion Studio is great' })]);
    fake.result = { kind: 'whisper-small', words: words([[0.2, 0.6, 'motion'], [0.7, 1.1, 'studia'], [1.2, 1.4, 'is'], [1.5, 2.0, 'grate']]), language: 'en' };
    await run();
    const cues = (await readSubtitleSet(creativeDir(), 'en'))!.set.cues;
    expect(cues.map((x) => x.text)).toEqual(['Motion Studio is great']);
    expect(cues[0]!.words!.map((w) => [w.start, w.text])).toEqual([[200, 'Motion'], [700, 'Studio'], [1200, 'is'], [1500, 'great']]);
  });

  it('no audio track, silence, or an engine that heard nothing: no-speech and no file', async () => {
    await creative([]);
    await run();
    await creative([audioClip({ src: 'silence.wav' })], { files: ['silence.wav'] });
    await run();
    await creative([audioClip()]);
    fake.result = { kind: 'whisper-small', words: [], language: 'it' };
    await run();
    await creative([audioClip()]);
    fake.result = { kind: 'none-no-speech', language: null };
    await run();
    expect(subtitleEntries().map((e) => e.type === 'system' && e.subtitles)).toEqual([{ state: 'no-speech' }, { state: 'no-speech' }, { state: 'no-speech' }, { state: 'no-speech' }]);
    expect(subtitleEntries().every((e) => e.type === 'system' && e.text === t().subtitles.noSpeech)).toBe(true);
    expect(transcribed).toHaveLength(2);
    expect(sent.filter((m) => m.type === 'subtitles')).toEqual([]);
    expect(touch).not.toHaveBeenCalled();
  });

  it('a transcription that was not made is a failure that says why, never "no speech"', async () => {
    // Skipped by the transcriber (method unavailable, no key, engine error).
    await creative([audioClip()]);
    fake.result = { kind: 'none-skipped', language: null };
    await runFailed();
    // The setting turned to "never" after the job started.
    await creative([audioClip()]);
    fake.plan = { skip: true };
    await runFailed();
    // The plan never answered.
    await creative([audioClip()]);
    fake.plan = null;
    await runFailed();
    const texts = subtitleEntries().map((e) => (e.type === 'system' ? [e.level, e.subtitles, e.text] : null));
    expect(texts).toEqual([
      ['error', { state: 'failed' }, t().subtitles.failed({ reason: t().subtitles.transcriptionUnavailable })],
      ['error', { state: 'failed' }, t().subtitles.failed({ reason: t().subtitles.transcriptionOff })],
      ['error', { state: 'failed' }, t().subtitles.failed({ reason: t().subtitles.transcriptionTimeout })],
    ]);
    expect(transcribed).toHaveLength(1);
    expect(touch).not.toHaveBeenCalled();
  });

  it('without a transcriber the job fails saying so', async () => {
    service = new SubtitlesService({
      queue, ffmpeg: () => findFfmpeg(), media: NoMediaTools, turns: { noteFromTurn: async (_job, _ref, e) => { entries.push(e); } },
      commits: { touch }, broadcast: () => {}, presets: async () => PRESETS,
    });
    await creative([audioClip()]);
    await runFailed();
    expect(subtitleEntries()).toEqual([expect.objectContaining({ subtitles: { state: 'failed' }, text: t().subtitles.failed({ reason: t().subtitles.transcriptionUnavailable }) })]);
  });

  it('transcription set to "never": refused at start, so the agent can say so at once', async () => {
    await creative([audioClip()]);
    fake.method = 'never';
    await expect(service.start(ref, { mode: 'new' })).rejects.toMatchObject({ status: 409, apiCode: 'subtitles-transcription-off' });
    expect(queue.list()).toEqual([]);
  });

  it('a creative with no audio clips or a silent mix never asks about the transcription', async () => {
    fake.plan = { ask: PENDING };
    for (const [clips, files] of [[[], ['tone.wav']], [[audioClip({ src: 'silence.wav' })], ['silence.wav']]] as const) {
      await creative([...clips], { files: [...files] });
      const job = await service.start(ref, { mode: 'new' });
      expect((await queue.whenSettled(job.id))?.state).toBe('succeeded');
      expect(service.pending(ref)).toBeNull();
    }
    expect(subtitleEntries().map((e) => e.type === 'system' && e.subtitles)).toEqual([{ state: 'no-speech' }, { state: 'no-speech' }]);
    expect(transcribed).toEqual([]);
  });

  it('the cue limit never drops a cue the user edited', async () => {
    await creative([audioClip()]);
    fake.result = { kind: 'whisper-small', words: Array.from({ length: 2100 }, (_, i) => ({ from: i, to: i + 0.4, text: `w${i}.` })), language: 'it' };
    await writeSubtitleSet(creativeDir(), {
      $schema: SUBTITLES_SCHEMA_ID, lang: 'it', origin: 'speech', transcript: 'whisper-small', detected: 'it',
      timing: { version: 1, format: 'test-wide', fingerprint: 'a'.repeat(64) },
      cues: [{ id: 'mine', start: 2_099_500, end: 2_099_900, text: 'La mia riga', edited: true }],
    });
    await run();
    const cues = (await readSubtitleSet(creativeDir(), 'it'))!.set.cues;
    expect(cues).toHaveLength(2000);
    expect(cues.at(-1)).toMatchObject({ id: 'mine', text: 'La mia riga', edited: true });
  });

  it('an unsupported language: an entry naming it, no file; with no language at all, no name', async () => {
    await creative([audioClip()]);
    fake.result = { kind: 'whisper-small', words: HELLO, language: 'ar' };
    await run();
    expect(subtitleEntries()).toEqual([expect.objectContaining({ subtitles: { state: 'unsupported-language', detected: 'ar' } })]);
    await creative([audioClip()]);
    fake.result = { kind: 'whisper-small', words: HELLO, language: null };
    await run();
    expect(subtitleEntries()[1]).toMatchObject({ subtitles: { state: 'unsupported-language' }, text: t().subtitles.unsupportedUnknown });
    expect(await readSubtitleSet(creativeDir(), 'it')).toBeNull();
    expect(touch).not.toHaveBeenCalled();
  });

  it('a job finishing after a save keeps the saved edits', async () => {
    await creative([audioClip()]);
    let release!: () => void;
    fake.gate = new Promise((r) => { release = r; });
    const job = await service.start(ref, { mode: 'new' });
    await vi.waitFor(() => expect(transcribed).toHaveLength(1));
    // The user saves an edited cue while the transcription runs.
    await writeSubtitleSet(creativeDir(), {
      $schema: SUBTITLES_SCHEMA_ID, lang: 'it', origin: 'speech', transcript: 'whisper-small', detected: 'it',
      timing: { version: 1, format: 'test-wide', fingerprint: 'a'.repeat(64) },
      cues: [{ id: 'c1', start: 100, end: 1700, text: 'Ciao a tutti voi!', edited: true }],
    });
    release();
    expect((await queue.whenSettled(job.id))?.state).toBe('succeeded');
    const cues = (await readSubtitleSet(creativeDir(), 'it'))!.set.cues;
    expect(cues).toEqual([expect.objectContaining({ id: 'c1', text: 'Ciao a tutti voi!', edited: true, start: 200 })]);
  });

  it('a set file that cannot be read fails the job saying so, and is never overwritten', async () => {
    await creative([audioClip()]);
    await mkdir(join(creativeDir(), 'subtitles'), { recursive: true });
    await writeFile(join(creativeDir(), 'subtitles', 'it.json'), '{"not": "a set"');
    await runFailed();
    expect(await readFile(join(creativeDir(), 'subtitles', 'it.json'), 'utf8')).toBe('{"not": "a set"');
    const reason = t().subtitles.setUnreadable({ file: 'subtitles/it.json' });
    expect(subtitleEntries().map((e) => e.type === 'system' ? e.text : '')).toContain(t().subtitles.failed({ reason }));
  });

  it('the final re-read, merge and write wait for the creative\'s set lock (decision 1654)', async () => {
    await creative([audioClip()]);
    let release!: () => void;
    fake.gate = new Promise((r) => { release = r; });
    const job = await service.start(ref, { mode: 'new' });
    await vi.waitFor(() => expect(transcribed).toHaveLength(1));
    // A save of the editor holds the lock while the transcription ends: the job writes only after it, and keeps its edit.
    let unlock!: () => void;
    const held = subtitleSetLocks.run(creativeDir(), async () => {
      await new Promise<void>((r) => { unlock = r; });
      await writeSubtitleSet(creativeDir(), {
        $schema: SUBTITLES_SCHEMA_ID, lang: 'it', origin: 'speech', transcript: 'whisper-small', detected: 'it',
        timing: { version: 1, format: 'test-wide', fingerprint: 'a'.repeat(64) },
        cues: [{ id: 'c1', start: 100, end: 1700, text: 'Ciao a tutti voi!', edited: true }],
      });
    });
    release();
    await new Promise((r) => setTimeout(r, 1500));
    expect(queue.list().find((j) => j.id === job.id)?.state).toBe('running');
    expect(await readSubtitleSet(creativeDir(), 'it')).toBeNull();
    unlock();
    await held;
    expect((await queue.whenSettled(job.id))?.state).toBe('succeeded');
    const cues = (await readSubtitleSet(creativeDir(), 'it'))!.set.cues;
    expect(cues).toEqual([expect.objectContaining({ id: 'c1', text: 'Ciao a tutti voi!', edited: true })]);
  });

  it('a held choice: the job waits for the user\'s transcription choice, then runs', async () => {
    await creative([audioClip()]);
    fake.plan = { ask: PENDING };
    const job = await service.start(ref, { mode: 'new' });
    await vi.waitFor(() => expect(queue.list().find((j) => j.id === job.id)?.waitReason).toBe('transcription-choice'));
    expect(service.pending(ref)).toEqual(PENDING);
    expect(await service.recheck(ref)).toEqual(PENDING);
    expect(transcribed).toHaveLength(0);
    await service.choose(ref, { choice: 'whisper', remember: false });
    expect((await queue.whenSettled(job.id))?.state).toBe('succeeded');
    expect(transcribed[0]!.method).toBe('whisper');
    expect(service.pending(ref)).toBeNull();
    expect(await readSubtitleSet(creativeDir(), 'it')).not.toBeNull();
  });

  it('"without transcription" stops the job: no set, and the chat says why', async () => {
    await creative([audioClip()]);
    fake.plan = { ask: PENDING };
    const job = await service.start(ref, { mode: 'new' });
    await vi.waitFor(() => expect(service.pending(ref)).not.toBeNull());
    await service.choose(ref, { choice: 'none', remember: false });
    expect((await queue.whenSettled(job.id))?.state).toBe('cancelled');
    expect(transcribed).toHaveLength(0);
    expect(await readSubtitleSet(creativeDir(), 'it')).toBeNull();
    expect(subtitleEntries()).toEqual([expect.objectContaining({ level: 'warning', text: t().subtitles.cancelledNoTranscription, subtitles: { state: 'failed' } })]);
  });

  it('"without transcription, remember": the other jobs still asking stop too, each with its chat line', async () => {
    await creative([audioClip()]);
    const first = ref;
    fake.plan = { ask: PENDING };
    const a = await service.start(first, { mode: 'new' });
    await creative([audioClip()]);
    const second = ref;
    const b = await service.start(second, { mode: 'new' });
    await vi.waitFor(() => { expect(service.pending(first)).not.toBeNull(); expect(service.pending(second)).not.toBeNull(); });
    fake.plan = { skip: true };
    await service.choose(first, { choice: 'none', remember: true });
    expect((await queue.whenSettled(a.id))?.state).toBe('cancelled');
    expect((await queue.whenSettled(b.id))?.state).toBe('cancelled');
    expect(subtitleEntries()).toEqual([
      expect.objectContaining({ text: t().subtitles.cancelledNoTranscription, subtitles: { state: 'failed' } }),
      expect.objectContaining({ text: t().subtitles.cancelledNoTranscription, subtitles: { state: 'failed' } }),
    ]);
  });

  it('one set from the original video\'s speech (final review I3): a new transcription refuses a language that is a translation, or a second one', async () => {
    await creative([audioClip()]);
    await run();
    const en: SubtitleSet = {
      $schema: SUBTITLES_SCHEMA_ID, lang: 'en', origin: 'translation', sourceLang: 'it', transcript: 'whisper-small', detected: null,
      timing: (await readSubtitleSet(creativeDir(), 'it'))!.set.timing, cues: [{ id: 'c1', start: 200, end: 1800, text: 'Hi all', edited: true, source: { text: 'Ciao a tutti.' } }],
    };
    await writeSubtitleSet(creativeDir(), en);
    await expect(service.start(ref, { mode: 'new', lang: 'en' })).rejects.toMatchObject({
      status: 409, apiCode: 'subtitles-lang-translated', message: t().errors.subtitlesLangTranslated({ lang: languageName('en') }),
    });
    await expect(service.start(ref, { mode: 'new', lang: 'fr' })).rejects.toMatchObject({
      status: 409, apiCode: 'subtitles-other-speech', message: t().errors.subtitlesOtherSpeech({ lang: languageName('fr'), other: languageName('it') }),
    });
    // The language recognised by the transcription: refused once it is known, nothing written.
    for (const language of ['en', 'fr']) {
      fake.result = { kind: 'whisper-small', words: words([[0.2, 1.0, 'Hello'], [1.1, 1.8, 'everyone.']]), language };
      const job = await service.start(ref, { mode: 'new' });
      const done = await queue.whenSettled(job.id);
      expect(done?.state).toBe('failed');
      expect(subtitleEntries().at(-1)).toMatchObject({ level: 'error', subtitles: { state: 'failed' } });
    }
    expect((await readSubtitleSet(creativeDir(), 'en'))!.set).toEqual(en);
    expect(await readSubtitleSet(creativeDir(), 'fr')).toBeNull();
    // The original video's language again: as before.
    fake.result = { kind: 'whisper-small', words: HELLO, language: 'it' };
    await run({ mode: 'new', lang: 'it' });
  });

  it('refuses a second job for the creative, and a creative whose latest version has no video format', async () => {
    await creative([audioClip()]);
    fake.gate = new Promise(() => {});
    const first = await service.start(ref, { mode: 'new' });
    await expect(service.start(ref, { mode: 'new' })).rejects.toMatchObject({ status: 409, apiCode: 'subtitles-running' });
    queue.cancel(first.id);
    await creative([audioClip()], { formats: ['test-still'] });
    await expect(service.start(ref, { mode: 'new' })).rejects.toMatchObject({ status: 409, apiCode: 'subtitles-no-video' });
  });
});

describe('the video changed under the subtitles (Task 14, spec §6.7)', { timeout: 60_000 }, () => {
  /** Version `n` of the creative: the same tone, with `clips` (a voice moved, a text changed…). */
  async function version(n: number, clips: object[]) {
    const dir = join(store.outputsDir(ref.creativeSlug, n), 'compositions', 'test-wide');
    await mkdir(join(dir, 'assets'), { recursive: true });
    await copyFile(join(fixtures, 'tone.wav'), join(dir, 'assets', 'tone.wav'));
    const c = composition(clips);
    await writeFile(join(dir, 'composition.json'), JSON.stringify(c));
    await store.appendVersion(ref.creativeSlug, {
      n, commit: null, sessionId: null, status: 'complete', createdAt: new Date().toISOString(), request: '', outputs: [], problems: [], tools: [],
      renderCommand: null, basedOn: n - 1, compositions: [{ format: 'test-wide', dir: 'compositions/test-wide', hash: (await readCompositionFolder(dir)).hash }],
    });
    return c;
  }
  const timingEntries = () => entries.filter((e) => e.type === 'system' && e.subtitles?.state === 'timing-changed');
  const setText = () => readFile(join(creativeDir(), 'subtitles', 'it.json'), 'utf8');

  it('fingerprint mismatch shows the notice and changes nothing; "Rifai i tempi" moves the cues and keeps the edited text', async () => {
    const c1 = await creative([audioClip()]);
    await writeSubtitleSet(creativeDir(), {
      $schema: SUBTITLES_SCHEMA_ID, lang: 'it', origin: 'speech', transcript: 'whisper-small', detected: 'it',
      timing: { version: 1, format: 'test-wide', fingerprint: audioFingerprint(c1) },
      cues: [
        // The user corrected the first word ("Ciao").
        { id: 'c1', start: 200, end: 1800, text: 'Benvenuti a tutti.', edited: true },
        { id: 'c2', start: 2000, end: 2600, text: 'Prenota ora.' },
      ],
    });
    const before = await setText();
    // v2: the voice starts 1 s later.
    const c2 = await version(2, [{ ...audioClip(), start: 1, duration: 2 }]);
    await service.versionSaved(ref, 2, null);
    expect(timingEntries()).toEqual([expect.objectContaining({
      type: 'system', level: 'warning', text: t().subtitles.timingChanged, subtitles: { state: 'timing-changed', lang: 'it' },
    })]);
    expect(await setText()).toBe(before);
    expect(transcribed).toEqual([]);
    // v3 changes no audio: nothing new to tell (once per version that moved the audio, never on every turn).
    await version(3, [{ ...audioClip(), start: 1, duration: 2 }]);
    await service.versionSaved(ref, 3, null);
    expect(timingEntries()).toHaveLength(1);

    // "Rifai i tempi": the speech heard 1 s later; the set's own language is the transcription's.
    fake.result = { kind: 'whisper-small', language: 'it', words: words([[1.2, 1.6, 'Ciao'], [1.7, 2.2, 'a'], [2.25, 2.8, 'tutti.'], [3.0, 3.3, 'Prenota'], [3.35, 3.6, 'ora.']]) };
    await run({ mode: 'retime' });
    expect(transcribed[0]!.language).toBe('it');
    const set = (await readSubtitleSet(creativeDir(), 'it'))!.set;
    expect(set.timing).toEqual({ version: 3, format: 'test-wide', fingerprint: audioFingerprint(c2) });
    expect(set.cues.map((x) => [x.text, x.start, x.end, x.edited ?? false])).toEqual([['Benvenuti a tutti.', 1200, 2800, true], ['Prenota ora.', 3000, 4000, false]]);
    expect(subtitleEntries().at(-1)).toMatchObject({ level: 'info', text: t().subtitles.retimed({ lang: 'italiano' }), subtitles: { state: 'ready', lang: 'it' } });
  });

  it('no notice for a creative without sets, nor when the new version keeps the set\'s audio', async () => {
    await creative([audioClip()]);
    await version(2, [{ ...audioClip(), start: 1, duration: 2 }]);
    await service.versionSaved(ref, 2, null);
    const c3 = await version(3, [audioClip()]);
    await writeSubtitleSet(creativeDir(), {
      $schema: SUBTITLES_SCHEMA_ID, lang: 'it', origin: 'speech', transcript: 'whisper-small', detected: 'it',
      timing: { version: 1, format: 'test-wide', fingerprint: audioFingerprint(c3) }, cues: [{ id: 'c1', start: 200, end: 1800, text: 'Ciao a tutti.' }],
    });
    await service.versionSaved(ref, 3, null);
    expect(timingEntries()).toEqual([]);
  });

  it('"Rifai i tempi" of the source moves its translations\' uncorrected lines with it; a corrected line keeps its times (Task 25)', async () => {
    const c1 = await creative([audioClip()]);
    const timing = { version: 1, format: 'test-wide', fingerprint: audioFingerprint(c1) };
    await writeSubtitleSet(creativeDir(), {
      $schema: SUBTITLES_SCHEMA_ID, lang: 'it', origin: 'speech', transcript: 'whisper-small', detected: 'it', timing,
      cues: [{ id: 'c1', start: 200, end: 1800, text: 'Ciao a tutti.' }, { id: 'c2', start: 2000, end: 2600, text: 'Prenota ora.' }],
    });
    await writeSubtitleSet(creativeDir(), {
      $schema: SUBTITLES_SCHEMA_ID, lang: 'en', origin: 'translation', sourceLang: 'it', transcript: 'whisper-small', detected: null, timing,
      cues: [
        { id: 'c1', start: 200, end: 1800, text: 'Hi everyone.', source: { text: 'Ciao a tutti.' } },
        // The user corrected this line (and its times).
        { id: 'c2', start: 3050, end: 3650, text: 'Book it now.', source: { text: 'Prenota ora.' }, edited: true },
      ],
    });
    const before = (await readSubtitleSet(creativeDir(), 'en'))!;
    // v2: the voice starts 1 s later.
    const c2 = await version(2, [{ ...audioClip(), start: 1, duration: 2 }]);
    fake.result = { kind: 'whisper-small', language: 'it', words: words([[1.2, 1.6, 'Ciao'], [1.7, 2.2, 'a'], [2.25, 2.8, 'tutti.'], [3.0, 3.3, 'Prenota'], [3.35, 3.6, 'ora.']]) };
    sent.length = 0;
    await run({ mode: 'retime', lang: 'it' });
    const it = (await readSubtitleSet(creativeDir(), 'it'))!.set;
    expect(it.cues.map((x) => [x.start, x.end])).toEqual([[1200, 2800], [3000, 4000]]);
    const after = (await readSubtitleSet(creativeDir(), 'en'))!;
    expect(after.set.cues.map((x) => [x.id, x.start, x.end, x.text, x.edited ?? false])).toEqual([
      ['c1', 1200, 2800, 'Hi everyone.', false], ['c2', 3050, 3650, 'Book it now.', true],
    ]);
    expect(after.set.timing).toEqual({ version: 2, format: 'test-wide', fingerprint: audioFingerprint(c2) });
    // What a render draws changed: a render of the old lines turns stale.
    expect(after.cuesHash).not.toBe(before.cuesHash);
    expect(after.cuesHash).toBe(subtitleCuesHash(after.set));
    expect(sent.filter((m) => m.type === 'subtitles').map((m) => m.type === 'subtitles' && m.lang).sort()).toEqual(['en', 'it']);
  });

  it('followSource: a +2 s retime moves every uncorrected line to its source line; a line with no pair keeps the old timing (review round 2)', async () => {
    await creative([audioClip()]);
    const timing = (fingerprint: string) => ({ version: 1, format: 'test-wide', fingerprint });
    const source = (cues: Array<[string, number, number, string]>, fingerprint: string): SubtitleSet => ({
      $schema: SUBTITLES_SCHEMA_ID, lang: 'it' as const, origin: 'speech' as const, transcript: 'whisper-small' as const, detected: 'it', timing: timing(fingerprint),
      cues: cues.map(([id, start, end, text]) => ({ id, start, end, text })),
    });
    const before = source([['c1', 200, 1800, 'Ciao a tutti.'], ['c2', 2000, 3600, 'Prenota ora.']], 'a'.repeat(64));
    await writeSubtitleSet(creativeDir(), before);
    const translation: SubtitleSet = {
      $schema: SUBTITLES_SCHEMA_ID, lang: 'en' as const, origin: 'translation' as const, sourceLang: 'it' as const, transcript: 'whisper-small' as const, detected: null, timing: before.timing,
      cues: [{ id: 'c1', start: 200, end: 1800, text: 'Hi all.', source: { text: 'Ciao a tutti.' } }, { id: 'c2', start: 2000, end: 3600, text: 'Book now.', source: { text: 'Prenota ora.' } }],
    };
    await writeSubtitleSet(creativeDir(), translation);
    const after = source([['f1', 2200, 3800, 'ciao a tutti'], ['f2', 4000, 5600, 'Prenota ora!']], 'b'.repeat(64));
    await writeSubtitleSet(creativeDir(), after);
    expect(await followSource(creativeDir(), before, after)).toEqual(['en']);
    const en = (await readSubtitleSet(creativeDir(), 'en'))!.set;
    expect(en.cues.map((c) => [c.id, c.start, c.end])).toEqual([['c1', 2200, 3800], ['c2', 4000, 5600]]);
    expect(en.timing).toEqual(after.timing);

    // Again, the second line unheard and two others in its place: it cannot be paired, so the timing is not claimed.
    const third = source([['g1', 2200, 3800, 'Ciao a tutti.'], ['g2', 4000, 4500, 'Altro.'], ['g3', 4600, 5600, 'Ancora.']], 'c'.repeat(64));
    await writeSubtitleSet(creativeDir(), third);
    expect(await followSource(creativeDir(), after, third)).toEqual([]);
    expect((await readSubtitleSet(creativeDir(), 'en'))!.set.timing).toEqual(after.timing);
  });

  it('a translation never gets the notice: it follows its source, which "Rifai i tempi" redoes (Task 25)', async () => {
    await creative([audioClip()]);
    const c2 = await version(2, [{ ...audioClip(), start: 1, duration: 2 }]);
    // The speech set is already timed on v2's audio; the translation still has v1's times.
    await writeSubtitleSet(creativeDir(), {
      $schema: SUBTITLES_SCHEMA_ID, lang: 'it', origin: 'speech', transcript: 'whisper-small', detected: 'it',
      timing: { version: 2, format: 'test-wide', fingerprint: audioFingerprint(c2) }, cues: [{ id: 'c1', start: 1200, end: 2800, text: 'Ciao a tutti.' }],
    });
    await writeSubtitleSet(creativeDir(), {
      $schema: SUBTITLES_SCHEMA_ID, lang: 'en', origin: 'translation', sourceLang: 'it', transcript: 'whisper-small', detected: null,
      timing: { version: 1, format: 'test-wide', fingerprint: '0'.repeat(64) }, cues: [{ id: 'c1', start: 200, end: 1800, text: 'Hi all.', source: { text: 'Ciao a tutti.' } }],
    });
    await service.versionSaved(ref, 2, null);
    expect(timingEntries()).toEqual([]);
  });

  it('"Rifai i tempi" needs a set: refused without one, or for a language that has none', async () => {
    await creative([audioClip()]);
    await expect(service.start(ref, { mode: 'retime' })).rejects.toMatchObject({ status: 409, apiCode: 'subtitles-no-set' });
    await expect(service.start(ref, { mode: 'retime', lang: 'de' })).rejects.toMatchObject({ status: 409, apiCode: 'subtitles-no-set' });
    expect(queue.list()).toEqual([]);
  });
});

describe('a language with its own voice (Task 24, spec §6.5)', { timeout: 60_000 }, () => {
  const GERMAN = words([[0.2, 0.6, 'halo'], [0.7, 1.3, 'zusamen']]);
  /**
   * v1 with a voice clip (its Italian script) and a `de` row of the main format whose overlay replaces it with a German voice
   * (1.5 s of another tone, a project asset as a localize turn writes it). The localized composition is returned with v1's.
   */
  async function localized(voice: 'translated' | 'original' | 'muted' = 'translated', o: { voices?: boolean } = {}) {
    const c = await creative([audioClip({ script: 'Ciao a tutti' })]);
    await mkdir(join(ref.projectDir, 'assets', 'audio'), { recursive: true });
    await copyFile(join(fixtures, 'short.wav'), join(ref.projectDir, 'assets', 'audio', 'vo-de.wav'));
    const overlay: Localization = {
      ...emptyOverlay('de', 'test-wide'),
      voices: o.voices === false ? {} : { vo: { src: 'assets/audio/vo-de.wav', sourceScript: 'Ciao a tutti', script: 'Hallo zusammen' } },
    };
    const hash = await writeOverlay(creativeDir(), 1, overlay);
    await setLocalizationRow(store, ref.creativeSlug, 1, { locale: 'de', instanceId: 'test-wide', hash, origin: 'agent', stale: [], voice });
    return { c, de: localizedComposition(c, overlay, { stale: [], voice })!, overlay, hash };
  }
  const timingEntries = () => entries.filter((e) => e.type === 'system' && e.subtitles?.state === 'timing-changed');

  it('the job mixes the language\'s own voice, tells the transcriber the language and aligns the words to its script', async () => {
    const { c, de } = await localized();
    fake.listen = true;
    // The original video first: its Italian voice, heard over the whole 3 s.
    await run();
    expect(heard[0]).toBeLessThan(0.1);
    expect(transcribed[0]!.language).toBeNull();
    expect((await readSubtitleSet(creativeDir(), 'it'))!.set.timing).toEqual({ version: 1, format: 'test-wide', fingerprint: audioFingerprint(c) });

    fake.result = { kind: 'whisper-small', words: GERMAN, language: 'de' };
    await run({ mode: 'new', lang: 'de' });
    // The German voice is 1.5 s of the 3: the mix the transcriber heard is the localized one.
    expect(heard[1]).toBeGreaterThan(0.3);
    expect(transcribed[1]!.language).toBe('de');
    const set = (await readSubtitleSet(creativeDir(), 'de'))!.set;
    expect(set).toMatchObject({ lang: 'de', origin: 'speech' });
    expect(set.timing).toEqual({ version: 1, format: 'test-wide', fingerprint: audioFingerprint(de), locale: 'de' });
    expect(audioFingerprint(de)).not.toBe(audioFingerprint(c));
    expect(set.cues.map((x) => x.text)).toEqual(['Hallo zusammen']);
    expect(set.cues[0]!.words!.map((w) => [w.start, w.text])).toEqual([[200, 'Hallo'], [700, 'zusammen']]);
    // Not "a language other than the brief's": the language was known.
    expect(subtitleEntries().at(-1)).toMatchObject({ level: 'info', text: t().subtitles.ready({ lang: languageName('de') }), subtitles: { state: 'ready', lang: 'de' } });
  });

  it('localizedVoiceLang: only a row of the main format whose voices are translated and applied', async () => {
    await localized();
    expect(await service.localizedVoiceLang(ref, 'de')).toBe(true);
    expect(await service.localizedVoiceLang(ref, 'fr')).toBe(false);
    await localized('original');
    expect(await service.localizedVoiceLang(ref, 'de')).toBe(false);
    await localized('muted');
    expect(await service.localizedVoiceLang(ref, 'de')).toBe(false);
    await localized('translated', { voices: false });
    expect(await service.localizedVoiceLang(ref, 'de')).toBe(false);
    // An overlay whose file no longer has the row's hash is not applied.
    const { overlay } = await localized();
    await writeOverlay(creativeDir(), 1, { ...overlay, voices: { vo: { ...overlay.voices.vo!, script: 'Guten Tag' } } });
    expect(await service.localizedVoiceLang(ref, 'de')).toBe(false);
    // A language without a row's voices is transcribed from the original video, as before.
    await localized('original');
    fake.listen = true;
    fake.result = { kind: 'whisper-small', words: GERMAN, language: 'de' };
    await run({ mode: 'new', lang: 'de' });
    expect(heard[0]).toBeLessThan(0.1);
    expect((await readSubtitleSet(creativeDir(), 'de'))!.set.timing.locale).toBeUndefined();
  });

  it('"Il video è cambiato" compares a localized set with its own language\'s video, and "Rifai i tempi" keeps that audio', async () => {
    const { hash } = await localized();
    await run();
    fake.result = { kind: 'whisper-small', words: GERMAN, language: 'de' };
    await run({ mode: 'new', lang: 'de' });
    // Each set matches the audio it was timed on: nothing to tell.
    await service.versionSaved(ref, 1, null);
    expect(timingEntries()).toEqual([]);
    const summary = async () => Object.fromEntries((await subtitleSummaries(ref.projectDir, ref.creativeSlug, async () => PRESETS)).map((s) => [s.lang, s.timingChanged]));
    expect(await summary()).toEqual({ de: false, it: false });
    // The German video goes back to the original voice: only the German set's audio changed.
    await setLocalizationRow(store, ref.creativeSlug, 1, { locale: 'de', instanceId: 'test-wide', hash, origin: 'agent', stale: [], voice: 'original' });
    expect(await summary()).toEqual({ de: true, it: false });
    await setLocalizationRow(store, ref.creativeSlug, 1, { locale: 'de', instanceId: 'test-wide', hash, origin: 'agent', stale: [], voice: 'translated' });
    expect(await summary()).toEqual({ de: false, it: false });

    // "Rifai i tempi" of the German set: its own voice again, its language told.
    fake.listen = true;
    await run({ mode: 'retime', lang: 'de' });
    expect(heard.at(-1)).toBeGreaterThan(0.3);
    expect(transcribed.at(-1)!.language).toBe('de');
    expect((await readSubtitleSet(creativeDir(), 'de'))!.set.timing.locale).toBe('de');
  });

  it('a language whose own voice went back to the original: its set is not made again from speech (final review Minor 4)', async () => {
    const { hash } = await localized();
    await run();
    fake.result = { kind: 'whisper-small', words: GERMAN, language: 'de' };
    await run({ mode: 'new', lang: 'de' });
    await setLocalizationRow(store, ref.creativeSlug, 1, { locale: 'de', instanceId: 'test-wide', hash, origin: 'agent', stale: [], voice: 'original' });
    const gone = { status: 409, apiCode: 'subtitles-voice-gone', message: t().errors.subtitlesVoiceGone({ lang: languageName('de') }) };
    await expect(service.start(ref, { mode: 'retime', lang: 'de' })).rejects.toMatchObject(gone);
    await expect(service.start(ref, { mode: 'new', lang: 'de' })).rejects.toMatchObject(gone);
    // "Rifai i tempi" with no language picks the set whose audio changed: the German one, refused too.
    await expect(service.start(ref, { mode: 'retime' })).rejects.toMatchObject(gone);
    expect(transcribed).toHaveLength(2);
  });

  it('the waveform with a language is the audio that language\'s set is timed on', async () => {
    await localized();
    fake.result = { kind: 'whisper-small', words: GERMAN, language: 'de' };
    await run({ mode: 'new', lang: 'de' });
    const loudLate = (peaks: number[]) => Math.max(...peaks.slice(700));
    // The original voice (a quiet sine) plays the whole 3 s; the German one stops at 1.5 s.
    const original = loudLate((await service.waveform(ref, 1)).peaks);
    expect(original).toBeGreaterThan(0.05);
    expect(loudLate((await service.waveform(ref, 1, 'de')).peaks)).toBeLessThan(0.01);
    // A language without a set: the original video.
    expect(loudLate((await service.waveform(ref, 1, 'fr')).peaks)).toBe(original);
  });

  it('the check before the choice listens to the language\'s own voice', async () => {
    // A silent German voice under an Italian tone: the original would ask, the German video has no speech.
    await creative([audioClip({ script: 'Ciao a tutti' })], { files: ['tone.wav', 'silence.wav'] });
    const overlay: Localization = { ...emptyOverlay('de', 'test-wide'), voices: { vo: { src: 'assets/silence.wav', sourceScript: 'Ciao a tutti', script: 'Hallo zusammen' } } };
    const hash = await writeOverlay(creativeDir(), 1, overlay);
    await setLocalizationRow(store, ref.creativeSlug, 1, { locale: 'de', instanceId: 'test-wide', hash, origin: 'agent', stale: [], voice: 'translated' });
    fake.plan = { ask: PENDING };
    const job = await service.start(ref, { mode: 'new', lang: 'de' });
    expect((await queue.whenSettled(job.id))?.state).toBe('succeeded');
    expect(service.pending(ref)).toBeNull();
    expect(transcribed).toEqual([]);
    expect(subtitleEntries().map((e) => e.type === 'system' && e.subtitles)).toEqual([{ state: 'no-speech' }]);
  });

  it('a version that moves the original audio names the original speech set in its notice', async () => {
    await localized();
    await run();
    fake.result = { kind: 'whisper-small', words: GERMAN, language: 'de' };
    await run({ mode: 'new', lang: 'de' });
    // v2: the original voice moves 1 s later.
    const dir = join(store.outputsDir(ref.creativeSlug, 2), 'compositions', 'test-wide');
    await mkdir(join(dir, 'assets'), { recursive: true });
    await copyFile(join(fixtures, 'tone.wav'), join(dir, 'assets', 'tone.wav'));
    await writeFile(join(dir, 'composition.json'), JSON.stringify(composition([{ ...audioClip({ script: 'Ciao a tutti' }), start: 1, duration: 2 }])));
    await store.appendVersion(ref.creativeSlug, {
      n: 2, commit: null, sessionId: null, status: 'complete', createdAt: new Date().toISOString(), request: '', outputs: [], problems: [], tools: [],
      renderCommand: null, basedOn: 1, compositions: [{ format: 'test-wide', dir: 'compositions/test-wide', hash: (await readCompositionFolder(dir)).hash }],
    });
    await service.versionSaved(ref, 2, null);
    expect(timingEntries()).toEqual([expect.objectContaining({ subtitles: { state: 'timing-changed', lang: 'it' } })]);
  });
});

describe('splitCjkWords', () => {
  it('cuts a CJK or Thai "word" into characters, times spread over its span; other words are left alone', () => {
    expect(splitCjkWords([{ start: 0, end: 400, text: '你好世界' }, { start: 500, end: 900, text: 'ok' }])).toEqual([
      { start: 0, end: 100, text: '你' }, { start: 100, end: 200, text: '好' }, { start: 200, end: 300, text: '世' }, { start: 300, end: 400, text: '界' },
      { start: 500, end: 900, text: 'ok' },
    ]);
    expect(splitCjkWords([{ start: 0, end: 300, text: 'สวัส' }]).map((w) => w.text)).toEqual(['ส', 'วั', 'ส']);
    // Korean has spaces between its words: a Hangul word stays whole.
    expect(splitCjkWords([{ start: 0, end: 500, text: '안녕하세요' }])).toEqual([{ start: 0, end: 500, text: '안녕하세요' }]);
    // A Latin run inside stays one word.
    expect(splitCjkWords([{ start: 0, end: 600, text: 'AI模型' }]).map((w) => [w.start, w.end, w.text])).toEqual([[0, 200, 'AI'], [200, 400, '模'], [400, 600, '型']]);
  });
});
