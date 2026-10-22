// @vitest-environment node
/**
 * Task 19 (spec §6.2 U9, §6.4): the agent corrects the subtitle text (`edit_subtitles`, under the PUT's set lock), asks for
 * drawn subtitles (`start_subtitles({ drawn })`, recorded on the creative), and a drawn job's end starts the style turn, or
 * queues it behind a running one. The agent's frames show the drawn subtitles. A real subtitles job (a fake transcriber,
 * ffmpeg on a tone made here), fake turns; no Whisper, no provider, no agent.
 */
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  creativeJobKey, DEFAULT_FORMATS, SUBTITLES_SCHEMA_ID, type Brief, type Composition, type ConversationEntry, type FormatPreset, type JobSummary, type ServerMessage, type SubtitleSet,
} from '@motion-studio/shared';
import type { Transcriber } from '../src/analysis/video-analysis.ts';
import type { BridgeContext } from '../src/bridge/bridge.ts';
import { readCompositionFolder } from '../src/compositions/composition-files.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import type { CreativeRef, TurnSettledHook } from '../src/creatives/creative-turns.ts';
import { PreviewService, storyboardKey } from '../src/creatives/previews.ts';
import { buildAgentPolicy } from '../src/agent/policy.ts';
import { buildCreativePrompt } from '../src/creatives/prompt.ts';
import { execCommand } from '../src/exec.ts';
import { JobQueue } from '../src/jobs/job-queue.ts';
import { NoMediaTools } from '../src/media/media-tools.ts';
import { findFfmpeg } from '../src/render/encode.ts';
import { readSubtitleSet, subtitleSetLocks, writeSubtitleSet } from '../src/subtitles/store.ts';
import { SUBTITLES_LANE, SUBTITLES_STYLE_INSTRUCTION, SubtitlesService } from '../src/subtitles/subtitles-job.ts';
import { groupJobKey } from '../src/creatives/group-turn.ts';
import { t } from '../src/i18n.ts';
import { CodedError } from '../src/workspace-store.ts';
import { subtitlesTools } from '../src/subtitles/subtitles-tools.ts';

const FONT = join(import.meta.dirname, '../../composition-runtime/test/fixtures/fonts/jetbrains-mono-latin-400-normal.woff2');
const PRESETS: FormatPreset[] = [{ id: 'test-wide', channel: 'Test', name: 'Wide', width: 320, height: 180, kind: 'video', extensions: ['mp4'] }];

let fixtures: string;
beforeAll(async () => {
  fixtures = await mkdtemp(join(tmpdir(), 'ms-subtitles-tools-fx-'));
  const r = await execCommand('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=3:r=48000', '-c:a', 'pcm_s16le', join(fixtures, 'tone.wav')], { timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(r.stderr);
}, 60_000);
afterAll(async () => { await rm(fixtures, { recursive: true, force: true }); });

const SUBTITLES_TRACK = {
  id: 'subs', kind: 'subtitles', clips: [{
    id: 'subs-clip', type: 'subtitles', start: 0, duration: 3,
    props: { fontFamily: 'Mono', fontSize: 14, color: '#ffffff', position: 'bottom', margin: 12, maxWidth: 0.8, background: '#000000' },
  }],
};
const composition = (o: { track?: boolean } = {}): Composition => ({
  $schema: 'motion-studio/composition@1', width: 320, height: 180, fps: 30, duration: 3, background: '#101010', scenes: [],
  fonts: o.track ? [{ family: 'Mono', src: 'assets/Mono.woff2', weight: 400 }] : [],
  tracks: [
    { id: 'v', kind: 'visual', clips: [] },
    { id: 'a', kind: 'audio', clips: [{ id: 'vo', type: 'audio', src: 'assets/tone.wav', start: 0, duration: 3 }] },
    ...(o.track ? [SUBTITLES_TRACK] : []),
  ],
} as unknown as Composition);

const SET = (cues: SubtitleSet['cues']): SubtitleSet => ({
  $schema: SUBTITLES_SCHEMA_ID, lang: 'en', origin: 'speech', transcript: 'whisper-small', detected: 'en',
  timing: { version: 1, format: 'test-wide', fingerprint: '0'.repeat(64) }, cues,
});
const CUES: SubtitleSet['cues'] = [
  { id: 'c1', start: 0, end: 1000, text: 'Welcome to motion studio', words: [{ start: 0, end: 300, text: 'Welcome' }, { start: 300, end: 500, text: 'to' }, { start: 500, end: 750, text: 'motion' }, { start: 750, end: 1000, text: 'studio' }] },
  { id: 'c2', start: 1000, end: 2000, text: 'Nothing to fix here' },
  { id: 'c3', start: 2000, end: 2900, text: 'MOTION STUDIO makes videos' },
];

let base: string;
let ref: CreativeRef;
let store: CreativeStore;
let queue: JobQueue;
let service: SubtitlesService;
let entries: ConversationEntry[];
let sent: ServerMessage[];
let touch: ReturnType<typeof vi.fn>;
let settle: TurnSettledHook;
let started: Array<{ m?: { text: string; pins: unknown[] }; o?: { app?: { request: string } } }>;
let startCalls: number;
/** Runs before a start is recorded (the n-th call); may throw like `CreativeTurnService.start`. */
let beforeStart: ((n: number) => Promise<void> | void) | null;
let member: { host: string } | null;
let drawnSet: boolean[];
let tools: ReturnType<typeof subtitlesTools>;

const transcriber: Transcriber = {
  plan: async () => ({ run: 'whisper' }),
  settings: async () => ({ method: 'whisper' }),
  prepareChoice: async () => ({}),
  recheck: async () => { throw new Error('not asked'); },
  transcribe: async () => ({ kind: 'whisper-small', segments: [], words: [{ from: 0.2, to: 0.6, text: 'Hello' }, { from: 0.7, to: 1.4, text: 'everyone.' }], language: 'en' }),
} as unknown as Transcriber;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ms-subtitles-tools-'));
  const projectDir = join(base, 'acme');
  await mkdir(projectDir, { recursive: true });
  store = new CreativeStore(projectDir);
  entries = []; sent = []; started = []; startCalls = 0; beforeStart = null; member = null; drawnSet = [];
  touch = vi.fn();
  queue = new JobQueue({ concurrency: 2, lanes: { [SUBTITLES_LANE]: 1 } });
  service = new SubtitlesService({
    queue, transcriber, ffmpeg: () => findFfmpeg(), media: NoMediaTools,
    turns: { noteFromTurn: async (_job, _ref, e) => { entries.push(e); } },
    commits: { touch }, broadcast: (m) => { sent.push(m); }, presets: async () => PRESETS,
  });
  const turns = {
    onTurnSettled: (fn: TurnSettledHook) => { settle = fn; },
    noteFromTurn: async (_job: string, _ref: CreativeRef, e: ConversationEntry) => { entries.push(e); },
    start: async (_ref: CreativeRef, m?: { text: string; pins: unknown[] }, o?: { app?: { request: string } }) => {
      await beforeStart?.(++startCalls);
      started.push({ ...(m ? { m } : {}), ...(o ? { o } : {}) });
      return { id: 'style-turn' } as JobSummary;
    },
    memberOf: async () => member,
    setSubtitlesDrawn: async (_ref: CreativeRef, drawn: boolean) => { drawnSet.push(drawn); },
  };
  tools = subtitlesTools({ subtitles: service, turns: turns as never, commits: { touch }, broadcast: (m) => { sent.push(m); } });
  return async () => { await queue.whenIdle(); await rm(base, { recursive: true, force: true }); };
});

/** A creative whose v1 is a 3 s video with a tone (and the subtitles track when `track`). */
async function creative(o: { track?: boolean } = {}) {
  const brief: Brief = { goal: 'Promo', message: '', formats: ['test-wide'], durationSec: 3, assets: [], notes: '' };
  const { slug } = await store.create({ title: 'Promo', brief });
  ref = { root: base, projectSlug: 'acme', projectDir: join(base, 'acme'), creativeSlug: slug };
  const dir = join(store.outputsDir(slug, 1), 'compositions', 'test-wide');
  await mkdir(join(dir, 'assets'), { recursive: true });
  await copyFile(join(fixtures, 'tone.wav'), join(dir, 'assets', 'tone.wav'));
  if (o.track) await copyFile(FONT, join(dir, 'assets', 'Mono.woff2'));
  await writeFile(join(dir, 'composition.json'), JSON.stringify(composition(o)));
  await store.appendVersion(slug, {
    n: 1, commit: null, sessionId: null, status: 'complete', createdAt: new Date().toISOString(), request: '', outputs: [], problems: [], tools: [],
    renderCommand: null, basedOn: null, compositions: [{ format: 'test-wide', dir: 'compositions/test-wide', hash: (await readCompositionFolder(dir)).hash }],
  });
}
const creativeDir = () => store.dir(ref.creativeSlug);
/** Version 2 of the creative: its composition draws the subtitles (an agent added the track). */
async function version2WithTrack() {
  const dir = join(store.outputsDir(ref.creativeSlug, 2), 'compositions', 'test-wide');
  await mkdir(join(dir, 'assets'), { recursive: true });
  await copyFile(join(fixtures, 'tone.wav'), join(dir, 'assets', 'tone.wav'));
  await copyFile(FONT, join(dir, 'assets', 'Mono.woff2'));
  await writeFile(join(dir, 'composition.json'), JSON.stringify(composition({ track: true })));
  await store.appendVersion(ref.creativeSlug, {
    n: 2, commit: null, sessionId: null, status: 'complete', createdAt: new Date().toISOString(), request: '', outputs: [], problems: [], tools: [],
    renderCommand: null, basedOn: 1, compositions: [{ format: 'test-wide', dir: 'compositions/test-wide', hash: (await readCompositionFolder(dir)).hash }],
  });
}
const ctx = (o: { kind?: string; scope?: 'none' | 'group'; jobId?: string } = {}): BridgeContext => ({
  jobId: o.jobId ?? 'turn-1', kind: o.kind ?? 'creative', projectSlug: 'acme', projectDir: ref.projectDir, creativeSlug: ref.creativeSlug,
  sandboxed: false, autoApproveAtStart: false, emit: () => {}, signal: new AbortController().signal,
  ...(o.scope === 'none' ? {} : { appScope: { root: ref.root, projectSlug: 'acme', projectDir: ref.projectDir, creativeSlug: ref.creativeSlug, version: 1, ...(o.scope === 'group' ? { group: true } : {}) } }),
}) as unknown as BridgeContext;
const edit = (args: Record<string, unknown>, c = ctx()) => tools.edit_subtitles(c, args);

describe('edit_subtitles (spec §6.4)', { timeout: 60_000 }, () => {
  it('a replace across lines changes the matching cues only, marks them edited, commits and broadcasts', async () => {
    await creative();
    await writeSubtitleSet(creativeDir(), SET(CUES));
    expect(await edit({ lang: 'en', replace: [{ find: 'motion studio', with: 'Motion Studio' }] })).toEqual({ changed: 2 });
    const cues = (await readSubtitleSet(creativeDir(), 'en'))!.set.cues;
    expect(cues.map((c) => c.text)).toEqual(['Welcome to Motion Studio', 'Nothing to fix here', 'Motion Studio makes videos']);
    expect(cues.map((c) => c.edited ?? false)).toEqual([true, false, true]);
    // The same words in another case keep their times (the highlight still follows them).
    expect(cues[0]!.words!.map((w) => [w.start, w.text])).toEqual([[0, 'Welcome'], [300, 'to'], [500, 'Motion'], [750, 'Studio']]);
    expect(touch).toHaveBeenCalledTimes(1);
    expect(touch.mock.calls[0]![0]).toMatchObject({ creativeSlug: ref.creativeSlug });
    expect(sent).toEqual([{ type: 'subtitles', project: 'acme', creative: ref.creativeSlug, lang: 'en' }]);
  });

  it('case-sensitive replaces and whole cue texts; a text that no longer says its words loses them', async () => {
    await creative();
    await writeSubtitleSet(creativeDir(), SET(CUES));
    const r = await edit({ lang: 'en', replace: [{ find: 'motion studio', with: 'Motion Studio', caseSensitive: true }], cues: [{ id: 'c1', was: 'Welcome to motion studio', text: 'Hi there' }, { id: 'c2', was: 'Nothing to fix here', text: 'Nothing to fix here' }] });
    // c1 (the explicit text wins over the replace); c2 unchanged; c3 is upper case, so the case-sensitive find misses it.
    expect(r).toEqual({ changed: 1 });
    const cues = (await readSubtitleSet(creativeDir(), 'en'))!.set.cues;
    expect(cues[0]).toEqual({ id: 'c1', start: 0, end: 1000, text: 'Hi there', edited: true });
    expect(cues[2]!.text).toBe('MOTION STUDIO makes videos');
  });

  it('nothing changed: nothing written, committed or broadcast', async () => {
    await creative();
    const hash = await writeSubtitleSet(creativeDir(), SET(CUES));
    expect(await edit({ lang: 'en', replace: [{ find: 'nowhere', with: 'x' }] })).toEqual({ changed: 0 });
    expect((await readSubtitleSet(creativeDir(), 'en'))!.hash).toBe(hash);
    expect(touch).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('refusals: an unknown cue id (400, nothing written), a bad text (400), no set in the language (404)', async () => {
    await creative();
    const hash = await writeSubtitleSet(creativeDir(), SET(CUES));
    await expect(edit({ lang: 'en', replace: [{ find: 'motion', with: 'Motion' }], cues: [{ id: 'nope', was: 'x', text: 'x' }] })).rejects.toMatchObject({ status: 400, apiCode: 'subtitles-unknown-cue' });
    await expect(edit({ lang: 'en', cues: [{ id: 'c2', was: 'Nothing to fix here', text: 'one\ntwo\nthree' }] })).rejects.toMatchObject({ status: 400 });
    await expect(edit({ lang: 'en', replace: [{ find: 'Nothing to fix here', with: '' }] })).rejects.toMatchObject({ status: 400 });
    await expect(edit({ lang: 'en' })).rejects.toMatchObject({ status: 400 });
    await expect(edit({ lang: 'en', replace: Array.from({ length: 21 }, () => ({ find: 'a', with: 'b' })) })).rejects.toMatchObject({ status: 400 });
    await expect(edit({ lang: 'it', cues: [{ id: 'c1', was: 'x', text: 'Ciao' }] })).rejects.toMatchObject({ status: 404 });
    // A cue without the text it was read with is refused (the schema).
    await expect(edit({ lang: 'en', cues: [{ id: 'c1', text: 'Hi' }] })).rejects.toMatchObject({ status: 400 });
    expect((await readSubtitleSet(creativeDir(), 'en'))!.hash).toBe(hash);
    expect(touch).not.toHaveBeenCalled();
  });

  it('outside a creative turn, or for a group\'s coordinator: 403', async () => {
    await creative();
    await writeSubtitleSet(creativeDir(), SET(CUES));
    await expect(edit({ lang: 'en', cues: [{ id: 'c1', was: 'x', text: 'x' }] }, ctx({ kind: 'brief' }))).rejects.toMatchObject({ status: 403 });
    await expect(edit({ lang: 'en', cues: [{ id: 'c1', was: 'x', text: 'x' }] }, ctx({ scope: 'none' }))).rejects.toMatchObject({ status: 403 });
    await expect(edit({ lang: 'en', cues: [{ id: 'c1', was: 'x', text: 'x' }] }, ctx({ scope: 'group' }))).rejects.toMatchObject({ status: 403 });
  });

  it('a line the user corrected since the agent read it: 409, nothing written at all (anti-goal 1)', async () => {
    await creative();
    const hash = await writeSubtitleSet(creativeDir(), SET([CUES[0]!, { ...CUES[1]!, text: 'Fixed by the user', edited: true }, CUES[2]!]));
    const r = edit({ lang: 'en', replace: [{ find: 'motion studio', with: 'Motion Studio' }], cues: [{ id: 'c3', was: 'MOTION STUDIO makes videos', text: 'Motion Studio makes videos' }, { id: 'c2', was: 'Nothing to fix here', text: 'All good here' }] });
    await expect(r).rejects.toMatchObject({ status: 409, apiCode: 'subtitles-cue-changed', message: t().errors.subtitlesCueChanged({ ids: 'c2' }) });
    expect((await readSubtitleSet(creativeDir(), 'en'))!.hash).toBe(hash);
    expect(touch).not.toHaveBeenCalled();
  });

  it('waits for the set lock and edits what the user saved meanwhile (a concurrent save is never lost)', async () => {
    await creative();
    await writeSubtitleSet(creativeDir(), SET(CUES));
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    // A save of the editor holding the lock: its corrections land while the agent's edit waits.
    const save = subtitleSetLocks.run(creativeDir(), async () => {
      await held;
      await writeSubtitleSet(creativeDir(), SET([...CUES.slice(0, 1), { ...CUES[1]!, text: 'Fixed by the user', edited: true }, CUES[2]!]));
    });
    const agent = edit({ lang: 'en', replace: [{ find: 'motion studio', with: 'Motion Studio' }] });
    await new Promise((r) => setTimeout(r, 30));
    expect(touch).not.toHaveBeenCalled();
    release();
    await save;
    expect(await agent).toEqual({ changed: 2 });
    expect((await readSubtitleSet(creativeDir(), 'en'))!.set.cues.map((c) => c.text)).toEqual(['Welcome to Motion Studio', 'Fixed by the user', 'Motion Studio makes videos']);
  });
});

describe('drawn subtitles: start_subtitles({ drawn }) and the style turn (spec §6.2)', { timeout: 60_000 }, () => {
  const ask = async (args: Record<string, unknown>) => {
    expect(await tools.start_subtitles(ctx(), args)).toEqual({ started: true, when: 'after-turn' });
    await settle(ref, 'turn-1', { state: 'succeeded', savedVersion: 1, stopped: false });
  };
  /** A job of `key` (a turn, a group's turn) that runs until released; `fail`: it then fails. */
  const busy = (key: string, fail = false) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const job = queue.enqueue({ key, kind: 'creative', label: 'turn', run: async () => { await gate; if (fail) throw new Error('boom'); } });
    return { job, release };
  };
  const turnKey = () => creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug);
  const lines = () => entries.filter((e): e is Extract<ConversationEntry, { type: 'system' }> => e.type === 'system').map((e) => e.text);
  const subtitlesJobDone = () => vi.waitFor(async () => expect(await readSubtitleSet(creativeDir(), 'en')).not.toBeNull(), { timeout: 20_000 });

  it('drawn: recorded on the creative; the job\'s end starts an app turn (instruction for the agent only) and says so in the chat', async () => {
    await creative();
    await ask({ drawn: true });
    expect(drawnSet).toEqual([true]);
    await vi.waitFor(() => expect(started).toHaveLength(1), { timeout: 20_000 });
    expect(started[0]!.m).toEqual({ text: SUBTITLES_STYLE_INSTRUCTION, pins: [] });
    expect(started[0]!.m!.text).toContain('subtitles track');
    expect(started[0]!.o).toEqual({ app: { request: t().subtitles.styleVersionRequest } });
    await vi.waitFor(() => expect(lines()).toContain(t().subtitles.styleStarted));
    expect(entries.find((e) => e.type === 'system' && e.text === t().subtitles.styleStarted)).toMatchObject({ level: 'info', origin: 'agent' });
    expect(entries.some((e) => e.type === 'user')).toBe(false);
  });

  it('files only: recorded as not drawn, no style turn', async () => {
    await creative();
    await ask({ drawn: false });
    expect(drawnSet).toEqual([false]);
    await subtitlesJobDone();
    await queue.whenIdle();
    await new Promise((r) => setTimeout(r, 50));
    expect(started).toEqual([]);
  });

  it('the latest version already draws them: no style turn', async () => {
    await creative({ track: true });
    await ask({ drawn: true });
    // The job was ready (its set is there): only the track already drawn keeps the turn from starting.
    await subtitlesJobDone();
    await queue.whenIdle();
    await new Promise((r) => setTimeout(r, 100));
    expect(started).toEqual([]);
    expect(lines()).not.toContain(t().subtitles.styleStarted);
  });

  it('a turn of the creative running: the style turn waits for it, says so, then starts', async () => {
    await creative();
    const turn = busy(turnKey());
    await ask({ drawn: true });
    await vi.waitFor(() => expect(lines()).toContain(t().subtitles.styleWaiting), { timeout: 20_000 });
    expect(started).toEqual([]);
    turn.release();
    await vi.waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]!.o).toEqual({ app: { request: t().subtitles.styleVersionRequest } });
    expect(lines()).not.toContain(t().subtitles.styleStarted);
  });

  it('the track is checked again when the wait ends: a version that drew them meanwhile starts nothing', async () => {
    await creative();
    const turn = busy(turnKey());
    await ask({ drawn: true });
    await vi.waitFor(() => expect(lines()).toContain(t().subtitles.styleWaiting), { timeout: 20_000 });
    await version2WithTrack();
    turn.release();
    await queue.whenIdle();
    await new Promise((r) => setTimeout(r, 100));
    expect(started).toEqual([]);
  });

  it('the work it waited for failed or was stopped: dropped, with a chat line', async () => {
    await creative();
    const turn = busy(turnKey(), true);
    await ask({ drawn: true });
    await vi.waitFor(() => expect(lines()).toContain(t().subtitles.styleWaiting), { timeout: 20_000 });
    turn.release();
    await vi.waitFor(() => expect(lines()).toContain(t().subtitles.styleNotStarted({ reason: t().subtitles.styleAfterStop })));
    expect(started).toEqual([]);
  });

  it('a turn that started in between (409): waited for, then the style turn starts', async () => {
    await creative();
    let other: ReturnType<typeof busy> | null = null;
    beforeStart = (n) => {
      if (n !== 1) return;
      other = busy(turnKey());
      throw new CodedError(409, t().errors.generationRunning, 'job-running');
    };
    await ask({ drawn: true });
    await vi.waitFor(() => expect(other).not.toBeNull(), { timeout: 20_000 });
    await vi.waitFor(() => expect(lines()).toContain(t().subtitles.styleWaiting));
    expect(started).toEqual([]);
    other!.release();
    await vi.waitFor(() => expect(started).toHaveLength(1));
    expect(startCalls).toBe(2);
  });

  it('a refusal with nothing running: a chat line, no turn', async () => {
    await creative();
    beforeStart = () => { throw new CodedError(409, t().errors.variantDiscardedTurn, 'variant-discarded'); };
    await ask({ drawn: true });
    await vi.waitFor(() => expect(lines()).toContain(t().subtitles.styleNotStarted({ reason: t().errors.variantDiscardedTurn })), { timeout: 20_000 });
    expect(started).toEqual([]);
  });

  it('a grouped variant waits for its group\'s turn too (decision 1680)', async () => {
    await creative();
    member = { host: 'host-creative' };
    const group = busy(groupJobKey(ref.root, ref.projectSlug, 'host-creative'));
    await ask({ drawn: true });
    await vi.waitFor(() => expect(lines()).toContain(t().subtitles.styleWaiting), { timeout: 20_000 });
    expect(started).toEqual([]);
    group.release();
    await vi.waitFor(() => expect(started).toHaveLength(1));
  });
});

describe('the agent sees the drawn subtitles in its frames (spec §6.4)', { timeout: 60_000 }, () => {
  it('preview_frames stages the creative\'s set when the composition has the track, nothing without it', async () => {
    const seen: unknown[] = [];
    const engine = {
      info: async () => ({ kind: 'system' }),
      frames: async (o: { times: number[]; subtitles?: unknown }) => { seen.push(o.subtitles); return { frames: o.times.map((t) => ({ t, data: Buffer.from('png'), width: 320, height: 180 })), errors: [] }; },
    };
    const normalizer = { prepare: async () => ({ warnings: [], release() {}, media: { clips: new Map() } }) };
    const previews = new PreviewService({ engine: engine as never, normalizer: normalizer as never, presets: async () => PRESETS, uiOrigins: () => [], distDir: base });
    (previews as unknown as { compositionServer: () => Promise<unknown> }).compositionServer = async () => ({ origin: 'http://127.0.0.1:1' });
    await creative({ track: true });
    await writeSubtitleSet(creativeDir(), SET(CUES));
    const vref = { projectDir: ref.projectDir, creativeDir: creativeDir(), creativeSlug: ref.creativeSlug, n: 1 };
    const out = await previews.agentFrames({ ref: vref, format: 'test-wide', times: [0.5], locale: 'en', signal: new AbortController().signal });
    expect(out).toMatchObject({ ok: true });
    expect(seen[0]).toEqual({ lang: 'en', cues: CUES.map(({ id: _id, ...c }) => c) });
    await creative();
    await writeSubtitleSet(creativeDir(), SET(CUES));
    await previews.agentFrames({ ref: { ...vref, creativeDir: creativeDir(), creativeSlug: ref.creativeSlug }, format: 'test-wide', times: [0.5], locale: 'en', signal: new AbortController().signal });
    expect(seen[1]).toBeUndefined();
    await previews.close();
  });
});

describe('storyboards are keyed on the drawn set too (decision 1678)', { timeout: 60_000 }, () => {
  it('a corrected set makes the storyboard again, under another image key; a composition without the track keeps the old key', async () => {
    const engine = { info: async () => ({ kind: 'system' }), frames: async (o: { times: number[] }) => ({ frames: o.times.map((t) => ({ t, data: Buffer.from('jpg'), width: 320, height: 180 })), errors: [] }) };
    const normalizer = { prepare: async () => ({ warnings: [], release() {}, media: { clips: new Map() } }) };
    const previews = new PreviewService({ engine: engine as never, normalizer: normalizer as never, presets: async () => PRESETS, uiOrigins: () => [], distDir: base });
    (previews as unknown as { compositionServer: () => Promise<unknown> }).compositionServer = async () => ({ origin: 'http://127.0.0.1:1' });
    await creative({ track: true });
    await mkdir(join(ref.projectDir, '.studio', 'cache'), { recursive: true });
    const setHash = await writeSubtitleSet(creativeDir(), SET(CUES));
    const vref = { projectDir: ref.projectDir, creativeDir: creativeDir(), creativeSlug: ref.creativeSlug, n: 1 };
    const hash = (await store.readVersions(ref.creativeSlug))[0]!.compositions![0]!.hash;
    const sb = (await previews.makeStoryboard(vref, 'test-wide', hash))!;
    expect(sb.subtitles).toBe(setHash);
    expect(storyboardKey(sb)).not.toBe(hash.slice(0, 16));
    expect(await previews.readStoryboard(vref, 'test-wide', hash)).toEqual(sb);
    await edit({ lang: 'en', replace: [{ find: 'motion studio', with: 'Motion Studio' }] });
    expect(await previews.readStoryboard(vref, 'test-wide', hash)).toBeNull();
    const again = (await previews.makeStoryboard(vref, 'test-wide', hash))!;
    expect(again.subtitles).toBe((await readSubtitleSet(creativeDir(), 'en'))!.hash);
    expect(storyboardKey(again)).not.toBe(storyboardKey(sb));
    // No track: no subtitles key, the image key is the composition hash's as before.
    expect(storyboardKey({ hash, subtitles: undefined })).toBe(hash.slice(0, 16));
    await previews.close();
  });
});

describe('the agent reads the subtitle sets (protected for writing only)', () => {
  // The turn runs in the project folder, where Claude Code reads without asking; creative turns protect `subtitles/` with
  // `protectedDirs` (creative-turns.ts), which deny only the edit tools and the sandbox's writes.
  it('a creative turn\'s policy denies the edit tools in subtitles/, never a read', () => {
    const dir = '/w/acme/creatives/promo/subtitles';
    for (const sandbox of [false, true]) {
      const p = buildAgentPolicy({
        kind: 'creative', sandbox, codebases: [], protectedFiles: [], protectedDirs: [dir], extraDomains: [], autoApproveSandboxed: false,
        configDir: '/cfg', home: '/home/u', projectAllowRules: [], mcpTools: [], projectDir: '/w/acme',
      });
      const rules = p.disallowedTools.filter((r) => r.includes('/creatives/promo/subtitles'));
      expect(rules.some((r) => r.startsWith('Edit('))).toBe(true);
      expect(rules.some((r) => r.startsWith('Write('))).toBe(true);
      expect(rules.filter((r) => /^(Read|Grep|Glob)\(/.test(r))).toEqual([]);
      const fs = (p.settings as { sandbox: { filesystem: { denyRead: string[]; denyWrite: string[] } } } | null)?.sandbox.filesystem;
      if (fs) {
        expect(fs.denyRead.some((d) => d.includes('/creatives/promo'))).toBe(false);
        expect(fs.denyWrite.some((d) => d.includes('/creatives/promo/subtitles'))).toBe(true);
      }
    }
  });
});

describe('the prompt rules of drawn subtitles (spec §6.4)', () => {
  it('the creative prompt asks drawn or files, and gives the default look with the plan\'s values', () => {
    const creative = {
      schemaVersion: 1, title: 'Promo', status: 'draft', error: null, resumeFrom: null, linkedCodebases: [], createdAt: '2026-10-22T10:00:00.000Z', updatedAt: '2026-10-22T10:00:00.000Z',
      brief: { goal: 'Promo', message: '', formats: ['instagram-reel-9x16'], durationSec: 15, assets: [], notes: '' },
    } as const;
    const p = buildCreativePrompt({ slug: '2026-10-22-promo', creative: creative as never, presets: DEFAULT_FORMATS, version: 2, locale: 'it', kind: 'iteration', userText: 'Aggiungi i sottotitoli', pins: [], appActions: true });
    const line = (prefix: string) => p.split('\n').find((l) => l.startsWith(prefix)) ?? '';
    expect(line('- start_subtitles:')).toContain('first ask with AskUserQuestion whether they want them drawn into the video or only as a track/file');
    expect(line('- start_subtitles:')).toContain('Never write subtitle text in text clips');
    expect(line('- edit_subtitles:')).toContain('each with was, the text you read');
    const look = line('- Drawn subtitles are the subtitles track:');
    for (const x of [
      'a legible style in the brand fonts and colours', 'fontSize at least 4.5 % of the frame height', 'a contrast box (background) or an outline',
      'in 9:16 formats position "bottom" with the line at least 18 % of the frame height above the bottom edge', 'a subtle entrance',
      'highlight only when the user asks', 'reads window.msSubtitles and window.msActiveCue(ms) and writes the line with textContent only',
      'To turn drawing off, remove the track',
    ]) expect(look).toContain(x);
    // Without the app actions (a repair attempt), none of it.
    expect(buildCreativePrompt({ slug: '2026-10-22-promo', creative: creative as never, presets: DEFAULT_FORMATS, version: 2, locale: 'it', kind: 'fix', problems: ['x'], appActions: true })).not.toContain('Drawn subtitles are the subtitles track');
  });
});
