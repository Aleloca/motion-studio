// @vitest-environment node
/**
 * The subtitles job (decisions 1637-1640): the creative's audio mix, transcribed (a fake transcriber with fixed words), the
 * voice scripts as the truth, the cues cut and merged with the user's edits, the set written, the chat told. Real ffmpeg on
 * tones made here; no Whisper, no provider.
 */
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SUBTITLES_SCHEMA_ID, type Brief, type Composition, type ConversationEntry, type FormatPreset, type ServerMessage, type TranscriptionPending,
  type TranscriptKind, type TranscriptWord,
} from '@motion-studio/shared';
import type { Transcriber } from '../src/analysis/video-analysis.ts';
import { readCompositionFolder } from '../src/compositions/composition-files.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import type { CreativeRef } from '../src/creatives/creative-turns.ts';
import { execCommand } from '../src/exec.ts';
import { t } from '../src/i18n.ts';
import { JobQueue } from '../src/jobs/job-queue.ts';
import { NoMediaTools } from '../src/media/media-tools.ts';
import { findFfmpeg } from '../src/render/encode.ts';
import { audioFingerprint, readSubtitleSet, writeSubtitleSet } from '../src/subtitles/store.ts';
import { splitCjkWords, SUBTITLES_LANE, SubtitlesService } from '../src/subtitles/subtitles-job.ts';

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
  transcribed = []; entries = []; sent = []; ready = [];
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
