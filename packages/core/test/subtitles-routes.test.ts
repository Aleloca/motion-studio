// @vitest-environment node
/**
 * Task 6 of the subtitles plan: the subtitles routes of a creative (overview, start, one set, the .srt/.vtt downloads) and
 * the agent's `start_subtitles` tool. A server on a temp workspace with the controlled runner (no `claude`), the `studio`
 * bridge active (the test calls the bridge routes with a run's token, as the MCP server would), real ffmpeg, no Whisper
 * (none detected) and the transcription set to "ask".
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SUBTITLES_SCHEMA_ID, subtitleCuesHash, subtitleHashesOf, subtitlesCurrent, subtitleSetHash, toSrt, toVtt, type Composition, type ConversationEntry, type CreativeDetail, type JobSummary, type ServerMessage,
  type SubtitleCue, type SubtitleSet, type SubtitlesSummary,
} from '@motion-studio/shared';
import type { Transcriber } from '../src/analysis/video-analysis.ts';
import { AppConfigStore } from '../src/app-config.ts';
import { ApprovalBroker } from '../src/approvals/broker.ts';
import { AgentBridge, type AppScope } from '../src/bridge/bridge.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import type { SubtitlesDeps, SubtitlesService, SubtitlesStart } from '../src/subtitles/subtitles-job.ts';
import { parseStudioBlock } from '../src/creatives/prompt.ts';
import { execCommand } from '../src/exec.ts';
import { Git } from '../src/git.ts';
import { t } from '../src/i18n.ts';
import { MemoryVault } from '../src/secrets/vault.ts';
import { buildServer } from '../src/server/app.ts';
import { audioFingerprint, readSubtitleSet, SubtitleCommits, subtitleSetLocks, writeSubtitleSet } from '../src/subtitles/store.ts';
import { SUBTITLE_WAVEFORM_PEAKS } from '../src/server/subtitles-routes.ts';
import { emptyOverlay, setLocalizationRow, writeOverlay } from '../src/localization/store.ts';
import type { SubtitleTranslateStart } from '../src/subtitles/translate-job.ts';
import { ControlledRunner, type ControlledRun } from './helpers/controlled-runner.ts';

const P = '/api/projects/acme/creatives';
const brief = { goal: 'Lancio app', message: '', formats: ['youtube-16x9'], durationSec: 6, assets: [], notes: '' };

let base: string;
let app: FastifyInstance;
let runner: ControlledRunner;
let bridge: AgentBridge;
/** Each start of a subtitles job: the versions saved at that moment and the options. */
let starts: Array<{ versions: number[]; o: SubtitlesStart }>;
let subtitlesService: SubtitlesService;
/** Each start of a translation job (Task 25): the options. */
let translateStarts: SubtitleTranslateStart[];
let broadcasts: ServerMessage[];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ms-subtitles-routes-'));
  runner = new ControlledRunner();
  bridge = new AgentBridge();
  bridge.setOrigin('http://127.0.0.1:9');
  starts = [];
  translateStarts = [];
  broadcasts = [];
  const config = new AppConfigStore(join(base, 'config'));
  await config.setTranscription({ method: 'ask' });
  app = await buildServer({
    uiToken: null, sandbox: async () => ({ available: false, reason: 'test' }),
    appConfig: config, configDir: join(base, 'config'), git: new Git(), runner,
    doctor: async () => [], claudeVersion: async () => '2.1.0', bridge, approvals: new ApprovalBroker({ broadcast: () => {} }),
    mcpCommand: [process.execPath, join(base, 'never-started-mcp.mjs')], vault: new MemoryVault({}), whisperDetect: async () => [],
    onBroadcast: (m) => { broadcasts.push(m); },
    onSubtitles: (svc) => {
      subtitlesService = svc;
      const start = svc.start.bind(svc);
      svc.start = async (ref, o) => {
        starts.push({ versions: (await new CreativeStore(ref.projectDir).readVersions(ref.creativeSlug)).map((v) => v.n), o });
        return start(ref, o);
      };
    },
    onSubtitleTranslate: (svc) => {
      const start = svc.start.bind(svc);
      svc.start = async (ref, o) => { translateStarts.push(o); return start(ref, o); };
    },
  });
  await app.inject({ method: 'PUT', url: '/api/workspace', payload: { path: join(base, 'ws') } });
  await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const r of runner.runs) r.end();
  await app.close();
  await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const projectDir = () => join(base, 'ws', 'acme');
const jobs = async () => (await app.inject('/api/jobs')).json() as JobSummary[];
const waitIdle = () => vi.waitFor(async () => expect((await jobs()).every((j) => j.state !== 'queued' && j.state !== 'running')).toBe(true), { timeout: 20_000, interval: 20 });
const detail = async (slug: string) => (await app.inject(`${P}/${slug}`)).json() as CreativeDetail;
const runOf = async (slug: string, nth = 0): Promise<ControlledRun> => {
  const mine = () => runner.runs.filter((r) => r.req.prompt.includes(`creatives/${slug}/outputs`));
  await vi.waitFor(() => expect(mine().length).toBeGreaterThan(nth), { timeout: 10_000 });
  return mine()[nth]!;
};
const tool = async (run: ControlledRun, name: string, args: Record<string, unknown>): Promise<LightMyRequestResponse> => {
  const config = JSON.parse(await readFile(run.req.mcpConfigPath!, 'utf8')) as { mcpServers: { studio: { env: Record<string, string> } } };
  const token = (await readFile(config.mcpServers.studio.env.MOTION_STUDIO_BRIDGE_TOKEN_FILE!, 'utf8')).trim();
  return app.inject({ method: 'POST', url: `/api/bridge/${name}`, headers: { 'x-motion-studio-bridge': token }, payload: args });
};
/** A composition without audio. */
const composition = (w: number, h: number, duration: number, background = '#000000'): Composition => ({
  $schema: 'motion-studio/composition@1', width: w, height: h, fps: 30, duration, background, fonts: [], scenes: [], tracks: [],
} as unknown as Composition);
/** A 6 s video (a still for an image format) for every format the run's prompt asks for. */
const writeCompositions = (run: ControlledRun, background?: string) => {
  for (const f of parseStudioBlock(run.req.prompt)!.formats) {
    const dir = join(run.req.cwd, f.compositionDir!);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'composition.json'), JSON.stringify(composition(f.width, f.height, f.kind === 'video' ? 6 : 0, background)));
  }
};
/** A creative whose first turn saved version 1 (a 6 s video, no audio). */
const made = async (): Promise<string> => {
  const slug = ((await app.inject({ method: 'POST', url: P, payload: { title: 'Lancio', brief, generate: true } })).json() as { slug: string }).slug;
  const run = await runOf(slug);
  writeCompositions(run);
  run.finish({ write: false });
  await waitIdle();
  expect((await detail(slug)).versions.map((v) => v.status)).toEqual(['complete']);
  return slug;
};
/**
 * A creative whose version 1 has a 3 s tone as its voice (the subtitles job has something to mix), near full scale; `role`: the
 * clip is marked as a voice (a localization can replace it).
 */
const madeWithVoice = async (o: { role?: boolean } = {}): Promise<string> => {
  const tone = join(base, 'tone.wav');
  const ff = await execCommand('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=3:r=48000', '-af', 'volume=7', '-c:a', 'pcm_s16le', tone], { timeoutMs: 60_000 });
  expect(ff.code, ff.stderr).toBe(0);
  const slug = ((await app.inject({ method: 'POST', url: P, payload: { title: 'Lancio', brief, generate: true } })).json() as { slug: string }).slug;
  const run = await runOf(slug);
  for (const f of parseStudioBlock(run.req.prompt)!.formats) {
    const dir = join(run.req.cwd, f.compositionDir!);
    mkdirSync(join(dir, 'assets'), { recursive: true });
    copyFileSync(tone, join(dir, 'assets', 'tone.wav'));
    const audio = { id: 'a', kind: 'audio', clips: [{ id: 'vo', type: 'audio', src: 'assets/tone.wav', start: 0, duration: 3, ...(o.role ? { role: 'voice' } : {}) }] };
    writeFileSync(join(dir, 'composition.json'), JSON.stringify({ ...composition(f.width, f.height, 6), tracks: [audio] }));
  }
  run.finish({ write: false });
  await waitIdle();
  expect((await detail(slug)).versions.map((v) => v.status)).toEqual(['complete']);
  return slug;
};
const set = (fingerprint: string): SubtitleSet => ({
  $schema: SUBTITLES_SCHEMA_ID, lang: 'en', origin: 'speech', transcript: 'whisper-small', detected: 'en',
  timing: { version: 1, format: 'youtube-16x9', fingerprint },
  cues: [
    { id: 'c1', start: 200, end: 1800, text: 'Hello <everyone>' },
    { id: 'c2', start: 2000, end: 3500, text: 'Book in three taps', edited: true },
    { id: 'c3', start: 5200, end: 7400, text: 'Past the end' },
    { id: 'c4', start: 6100, end: 6900, text: 'Never shown' },
  ],
});

describe('subtitles routes', () => {
  it('a creative without sets: nothing, no job, nothing asked; the detail has no subtitles', async () => {
    const slug = await made();
    const res = await app.inject(`${P}/${slug}/subtitles`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ sets: [], job: null, pending: null });
    expect((await detail(slug)).subtitles).toBeUndefined();
  });

  it('lists a set with its timing state, gives it whole and downloads it as .srt and .vtt clamped to the video', async () => {
    const slug = await made();
    const creativeDir = join(projectDir(), 'creatives', slug);
    const written = set('0'.repeat(64));
    await writeSubtitleSet(creativeDir, written);

    const overview = (await app.inject(`${P}/${slug}/subtitles`)).json() as { sets: SubtitlesSummary[] };
    const summary: SubtitlesSummary = {
      lang: 'en', origin: 'speech', cues: 4, edited: 1, hash: subtitleSetHash(written), cuesHash: subtitleCuesHash(written), timing: written.timing, timingChanged: true, staleCues: 0, missing: 0,
    };
    expect(overview.sets).toEqual([summary]);
    expect((await detail(slug)).subtitles).toEqual([summary]);

    // The same fingerprint as the version's main format: the timing still holds.
    const fresh = set(audioFingerprint(composition(1920, 1080, 6)));
    await writeSubtitleSet(creativeDir, fresh);
    expect(((await app.inject(`${P}/${slug}/subtitles`)).json() as { sets: SubtitlesSummary[] }).sets[0]).toMatchObject({ timingChanged: false, hash: subtitleSetHash(fresh) });

    const one = await app.inject(`${P}/${slug}/subtitles/en`);
    expect(one.json()).toEqual({ set: fresh, hash: subtitleSetHash(fresh) });

    const srt = await app.inject(`${P}/${slug}/subtitles/en/file.srt`);
    expect(srt.statusCode).toBe(200);
    expect(srt.body).toBe(toSrt(fresh.cues, { durationMs: 6000 }));
    expect(srt.body).not.toContain('Never shown');
    expect(srt.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(srt.headers['content-disposition']).toBe(`attachment; filename="${slug}.en.srt"`);
    const vtt = await app.inject(`${P}/${slug}/subtitles/en/file.vtt`);
    expect(vtt.body).toBe(toVtt(fresh.cues, { durationMs: 6000 }));
    expect(vtt.headers['content-type']).toMatch(/^text\/vtt/);
    expect(vtt.headers['content-disposition']).toBe(`attachment; filename="${slug}.en.vtt"`);
  });

  it('a language without a set answers 404, one outside the supported languages 400', async () => {
    const slug = await made();
    for (const url of [`${P}/${slug}/subtitles/fr`, `${P}/${slug}/subtitles/fr/file.srt`, `${P}/${slug}/subtitles/fr/file.vtt`]) {
      expect((await app.inject(url)).statusCode, url).toBe(404);
    }
    for (const url of [`${P}/${slug}/subtitles/xx`, `${P}/${slug}/subtitles/xx/file.srt`, `${P}/${slug}/subtitles/..%2Fcreative/file.vtt`]) {
      expect((await app.inject(url)).statusCode, url).toBe(400);
    }
    expect((await app.inject({ method: 'POST', url: `${P}/${slug}/subtitles`, payload: { lang: 'xx' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `${P}/${slug}/subtitles`, payload: { mode: 'other' } })).statusCode).toBe(400);
  });

  it('starts a job, refuses a second one while it runs, and shows it in the overview', async () => {
    const slug = await made();
    const first = await app.inject({ method: 'POST', url: `${P}/${slug}/subtitles`, payload: {} });
    expect(first.statusCode, first.body).toBe(200);
    const job = (first.json() as { job: JobSummary }).job;
    expect(job).toMatchObject({ kind: 'subtitles' });
    const second = await app.inject({ method: 'POST', url: `${P}/${slug}/subtitles`, payload: { mode: 'new' } });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: 'subtitles-running' });
    await waitIdle();
    expect((await app.inject(`${P}/${slug}/subtitles`)).json()).toMatchObject({ job: null, pending: null });
  });

  it('a transcription answer or recheck with nothing asking answers 409; a bad answer 400', async () => {
    const slug = await made();
    const choice = await app.inject({ method: 'POST', url: `${P}/${slug}/subtitles/transcription-choice`, payload: { choice: 'whisper', remember: false } });
    expect(choice.statusCode).toBe(409);
    expect(choice.json()).toMatchObject({ code: 'transcription-not-asked' });
    expect((await app.inject({ method: 'POST', url: `${P}/${slug}/subtitles/transcription-choice`, payload: { choice: 'whisper', remember: false, file: 'x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `${P}/${slug}/subtitles/transcription-recheck` })).statusCode).toBe(409);
  });

  it('an unknown creative answers 404', async () => {
    expect((await app.inject(`${P}/nope/subtitles`)).statusCode).toBe(404);
  });
});

describe('the waveform of the subtitle timeline (Task 13)', () => {
  it('the main format\'s mix as 1200 peaks over the video\'s duration, cached per audio fingerprint', { timeout: 60_000 }, async () => {
    const slug = await madeWithVoice();
    const mixer = vi.spyOn(subtitlesService, 'mixCreativeAudio');
    const res = await app.inject(`${P}/${slug}/subtitles/waveform?version=1`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { peaks: number[]; durationMs: number };
    expect(body.durationMs).toBe(6000);
    expect(SUBTITLE_WAVEFORM_PEAKS).toBe(1200);
    expect(body.peaks).toHaveLength(SUBTITLE_WAVEFORM_PEAKS);
    // The tone plays for the first 3 s of 6: loud in the first half, silent in the second.
    expect(Math.max(...body.peaks)).toBeGreaterThan(0.5);
    expect(Math.max(...body.peaks.slice(700))).toBeLessThan(0.01);
    expect(mixer).toHaveBeenCalledTimes(1);
    const voiced = { ...composition(1920, 1080, 6), tracks: [{ id: 'a', kind: 'audio', clips: [{ id: 'vo', type: 'audio', src: 'assets/tone.wav', start: 0, duration: 3 }] }] } as unknown as Composition;
    const cached = join(projectDir(), '.studio', 'cache', 'subtitles', slug, `wave-${audioFingerprint(voiced)}.json`);
    expect(JSON.parse(await readFile(cached, 'utf8'))).toEqual(body);

    // The second call reads the cache: no mix.
    const again = await app.inject(`${P}/${slug}/subtitles/waveform?version=1`);
    expect(again.json()).toEqual(body);
    expect(mixer).toHaveBeenCalledTimes(1);
  });

  it('?lang= picks the audio of that language\'s set (Task 24); a language without a set is the original, an unsupported one 400', { timeout: 60_000 }, async () => {
    const slug = await madeWithVoice();
    const plain = await app.inject(`${P}/${slug}/subtitles/waveform?version=1`);
    const de = await app.inject(`${P}/${slug}/subtitles/waveform?version=1&lang=de`);
    expect(de.statusCode, de.body).toBe(200);
    expect(de.json()).toEqual(plain.json());
    expect((await app.inject(`${P}/${slug}/subtitles/waveform?version=1&lang=xx`)).statusCode).toBe(400);
  });

  it('two requests at once make one mix', { timeout: 60_000 }, async () => {
    const slug = await madeWithVoice();
    const mixer = vi.spyOn(subtitlesService, 'mixCreativeAudio');
    const [a, b] = await Promise.all([app.inject(`${P}/${slug}/subtitles/waveform?version=1`), app.inject(`${P}/${slug}/subtitles/waveform?version=1`)]);
    expect(a.statusCode, a.body).toBe(200);
    expect(b.json()).toEqual(a.json());
    expect(mixer).toHaveBeenCalledTimes(1);
  });

  it('a version without audio has no peaks; an unknown version 404, a bad one 400', async () => {
    const slug = await made();
    const res = await app.inject(`${P}/${slug}/subtitles/waveform?version=1`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ peaks: [], durationMs: 6000 });
    expect((await app.inject(`${P}/${slug}/subtitles/waveform?version=9`)).statusCode).toBe(404);
    for (const q of ['', '?version=0', '?version=x']) expect((await app.inject(`${P}/${slug}/subtitles/waveform${q}`)).statusCode, q).toBe(400);
  });
});

describe('saving a subtitle set (PUT, decision 1654)', () => {
  const save = (slug: string, body: unknown, lang = 'en') => app.inject({ method: 'PUT', url: `${P}/${slug}/subtitles/${lang}`, payload: body as object });
  const editedFirst = (cues: SubtitleCue[], text = 'Hello all of you'): SubtitleCue[] => cues.map((c, i) => (i === 0 ? { ...c, text, edited: true } : c));
  const stored = async (slug: string, s: SubtitleSet = set('0'.repeat(64))) => {
    const creativeDir = join(projectDir(), 'creatives', slug);
    return { creativeDir, set: s, hash: await writeSubtitleSet(creativeDir, s) };
  };

  it('with the stored hash: saves the cues, keeps every other field, answers the new hash, touches the commit once and broadcasts', async () => {
    const slug = await made();
    const before = await stored(slug);
    const touch = vi.spyOn(SubtitleCommits.prototype, 'touch');
    broadcasts.length = 0;
    const cues = editedFirst(before.set.cues);
    const res = await save(slug, { baseHash: before.hash, cues });
    expect(res.statusCode, res.body).toBe(200);
    const saved: SubtitleSet = { ...before.set, cues };
    expect(res.json()).toEqual({ hash: subtitleSetHash(saved) });
    expect(await readSubtitleSet(before.creativeDir, 'en')).toEqual({ set: saved, hash: subtitleSetHash(saved), cuesHash: subtitleCuesHash(saved) });
    expect(touch).toHaveBeenCalledTimes(1);
    expect(touch).toHaveBeenCalledWith(expect.objectContaining({ projectSlug: 'acme', creativeSlug: slug }), t().subtitles.commit({ title: 'Lancio', lang: 'en' }));
    expect(broadcasts.filter((m) => m.type === 'subtitles')).toEqual([{ type: 'subtitles', project: 'acme', creative: slug, lang: 'en' }]);
    // The next save starts from the hash it was given.
    const again = await save(slug, { baseHash: subtitleSetHash(saved), cues: editedFirst(cues, 'Hi') });
    expect(again.statusCode, again.body).toBe(200);
  });

  it('a stale baseHash gets 409 subtitles-conflict', async () => {
    const slug = await made();
    const before = await stored(slug);
    const touch = vi.spyOn(SubtitleCommits.prototype, 'touch');
    const res = await save(slug, { baseHash: 'f'.repeat(64), cues: editedFirst(before.set.cues) });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'subtitles-conflict', hash: before.hash });
    expect((await readSubtitleSet(before.creativeDir, 'en'))!.hash).toBe(before.hash);
    expect(touch).not.toHaveBeenCalled();
  });

  it('refuses a cue with end before start, a blank line or a bad body (400); no set 404, a language outside 400', async () => {
    const slug = await made();
    const before = await stored(slug);
    const [first, ...rest] = before.set.cues;
    const bad: unknown[] = [
      { baseHash: before.hash, cues: [{ ...first!, end: first!.start - 1 }, ...rest] },
      { baseHash: before.hash, cues: [{ ...first!, text: 'Hello\n ' }, ...rest] },
      { baseHash: before.hash, cues: [{ ...first!, id: 'c2' }, ...rest] },
      { baseHash: before.hash, cues: before.set.cues, lang: 'it' },
      { baseHash: 'nope', cues: before.set.cues },
      { cues: before.set.cues },
    ];
    for (const body of bad) {
      const res = await save(slug, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json()).toMatchObject({ code: 'invalid-request' });
    }
    expect((await save(slug, { baseHash: before.hash, cues: [] }, 'fr')).statusCode).toBe(404);
    expect((await save(slug, { baseHash: before.hash, cues: [] }, 'xx')).statusCode).toBe(400);
    expect((await readSubtitleSet(before.creativeDir, 'en'))!.hash).toBe(before.hash);
  });

  it('waits for the creative\'s set lock (the one the job\'s final merge holds)', async () => {
    const slug = await made();
    const before = await stored(slug);
    let release!: () => void;
    const held = subtitleSetLocks.run(before.creativeDir, () => new Promise<void>((r) => { release = r; }));
    let answered = false;
    const pending = save(slug, { baseHash: before.hash, cues: editedFirst(before.set.cues) }).then((r) => { answered = true; return r; });
    await new Promise((r) => setTimeout(r, 150));
    expect(answered).toBe(false);
    release();
    await held;
    expect((await pending).statusCode).toBe(200);
  });

  it('a save during a running job is kept, edited, by the job\'s later write', { timeout: 60_000 }, async () => {
    const slug = await madeWithVoice();
    const before = await stored(slug, { ...set('0'.repeat(64)), cues: [{ id: 'c1', start: 200, end: 1800, text: 'Hello everyone' }] });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let transcribing = 0;
    const words: Array<[number, number, string]> = [[0.2, 0.6, 'Hello'], [0.7, 1.8, 'everyone.'], [2.6, 2.9, 'Goodbye.']];
    const transcriber: Transcriber = {
      plan: async () => ({ run: 'whisper' }),
      settings: async () => ({ method: 'whisper' }),
      prepareChoice: async () => ({}),
      recheck: async () => { throw new Error('nothing asks'); },
      transcribe: async () => {
        transcribing += 1;
        await gate;
        return { kind: 'whisper-small', segments: [], words: words.map(([from, to, text]) => ({ from, to, text })), language: 'en' };
      },
    } as Transcriber;
    (subtitlesService as unknown as { deps: SubtitlesDeps }).deps.transcriber = transcriber;

    const started = await app.inject({ method: 'POST', url: `${P}/${slug}/subtitles`, payload: {} });
    expect(started.statusCode, started.body).toBe(200);
    await vi.waitFor(() => expect(transcribing).toBe(1), { timeout: 20_000, interval: 20 });
    expect((await jobs()).some((j) => j.kind === 'subtitles' && j.state === 'running')).toBe(true);
    const cues = editedFirst(before.set.cues);
    const res = await save(slug, { baseHash: before.hash, cues });
    expect(res.statusCode, res.body).toBe(200);
    release();
    await waitIdle();

    const after = (await readSubtitleSet(before.creativeDir, 'en'))!.set;
    expect(after.timing.fingerprint).not.toBe('0'.repeat(64));
    expect(after.cues[0]).toEqual(cues[0]);
    expect(after.cues.slice(1).map((c) => c.text)).toEqual(['Goodbye.']);
  });
});

describe('"Tempi controllati": the timing marked as checked (final review, M3)', () => {
  const checked = (slug: string, body: unknown, lang = 'en') => app.inject({ method: 'POST', url: `${P}/${slug}/subtitles/${lang}/timing-checked`, payload: body as object });

  it('with the stored hash: the timing becomes the latest version\'s audio, the cues stay, the commit is touched and it broadcasts', async () => {
    const slug = await made();
    const creativeDir = join(projectDir(), 'creatives', slug);
    const before = set('0'.repeat(64));
    const hash = await writeSubtitleSet(creativeDir, before);
    const touch = vi.spyOn(SubtitleCommits.prototype, 'touch');
    broadcasts.length = 0;
    const res = await checked(slug, { baseHash: hash });
    expect(res.statusCode, res.body).toBe(200);
    const after: SubtitleSet = { ...before, timing: { version: 1, format: 'youtube-16x9', fingerprint: audioFingerprint(composition(1920, 1080, 6)) } };
    expect(res.json()).toEqual({ hash: subtitleSetHash(after), timing: after.timing });
    expect(await readSubtitleSet(creativeDir, 'en')).toEqual({ set: after, hash: subtitleSetHash(after), cuesHash: subtitleCuesHash(after) });
    expect(((await app.inject(`${P}/${slug}/subtitles`)).json() as { sets: SubtitlesSummary[] }).sets[0]).toMatchObject({ timingChanged: false });
    expect(touch).toHaveBeenCalledTimes(1);
    expect(broadcasts.filter((m) => m.type === 'subtitles')).toEqual([{ type: 'subtitles', project: 'acme', creative: slug, lang: 'en' }]);
  });

  it('a set timed on its language\'s own video keeps saying so (Task 24)', async () => {
    const slug = await made();
    const creativeDir = join(projectDir(), 'creatives', slug);
    // The German video has no row of its own any more: its audio is the original's, and the set stays the German video's.
    const before: SubtitleSet = { ...set('0'.repeat(64)), lang: 'de', timing: { version: 1, format: 'youtube-16x9', fingerprint: '0'.repeat(64), locale: 'de' } };
    const hash = await writeSubtitleSet(creativeDir, before);
    const res = await checked(slug, { baseHash: hash }, 'de');
    expect(res.statusCode, res.body).toBe(200);
    expect((await readSubtitleSet(creativeDir, 'de'))!.set.timing).toEqual({ version: 1, format: 'youtube-16x9', fingerprint: audioFingerprint(composition(1920, 1080, 6)), locale: 'de' });
    expect(((await app.inject(`${P}/${slug}/subtitles`)).json() as { sets: SubtitlesSummary[] }).sets[0]).toMatchObject({ lang: 'de', timingChanged: false });
  });

  it('a stale baseHash gets 409 subtitles-conflict and changes nothing; a bad body 400, no set 404', async () => {
    const slug = await made();
    const creativeDir = join(projectDir(), 'creatives', slug);
    const hash = await writeSubtitleSet(creativeDir, set('0'.repeat(64)));
    const stale = await checked(slug, { baseHash: 'f'.repeat(64) });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'subtitles-conflict', hash });
    expect((await readSubtitleSet(creativeDir, 'en'))!.hash).toBe(hash);
    expect((await checked(slug, { baseHash: 'nope' })).statusCode).toBe(400);
    expect((await checked(slug, {})).statusCode).toBe(400);
    expect((await checked(slug, { baseHash: hash }, 'fr')).statusCode).toBe(404);
  });
});

describe('the start_subtitles tool (decision 1703)', () => {
  const create = async (b: Record<string, unknown> = brief) => ((await app.inject({ method: 'POST', url: P, payload: { title: 'Lancio', brief: b, generate: true } })).json() as { slug: string }).slug;
  const say = async (slug: string, n: number, text: string) => {
    const sent = await app.inject({ method: 'POST', url: `${P}/${slug}/messages`, payload: { clientId: `00000000-0000-4000-8000-00000000000${n}`, text, mode: 'queued' } });
    expect(sent.statusCode, sent.body).toBe(200);
  };
  const subtitleJobs = async () => (await jobs()).filter((j) => j.kind === 'subtitles');
  const agentLines = async (slug: string) => ((await app.inject(`${P}/${slug}/conversation`)).json() as ConversationEntry[])
    .filter((e): e is Extract<ConversationEntry, { type: 'system' }> => e.type === 'system' && e.origin === 'agent').map((e) => e.text);

  it('asked in the first turn, starts once the turn saved v1; in the next turn again, on the v2 that turn saved', async () => {
    const slug = await create();
    const first = await runOf(slug);
    // `drawn` left out (an older agent): the job makes files only.
    const res = await tool(first, 'start_subtitles', {});
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ started: true, when: 'after-turn' });
    const again = await tool(first, 'start_subtitles', { drawn: true });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: t().errors.subtitlesOncePerTurn });
    expect((await tool(first, 'start_subtitles', { drawn: 'yes' })).statusCode).toBe(400);
    expect(await subtitleJobs()).toEqual([]);
    writeCompositions(first);
    first.finish({ write: false });
    // The settle hook starts the job asynchronously: the queue can be idle before it is queued.
    await vi.waitFor(() => expect(starts).toEqual([{ versions: [1], o: { mode: 'new', drawn: false } }]), { timeout: 20_000, interval: 20 });
    await vi.waitFor(async () => expect(await subtitleJobs()).toHaveLength(1), { timeout: 20_000, interval: 20 });
    await waitIdle();

    // The next turn may ask again (the guard is per turn); the job is timed on the version this turn saves.
    await say(slug, 1, 'Cambia la musica e rifai i sottotitoli');
    const second = await runOf(slug, 1);
    expect((await tool(second, 'start_subtitles', { drawn: true, lang: 'it' })).json()).toEqual({ started: true, when: 'after-turn' });
    writeCompositions(second, '#202020');
    second.finish({ write: false });
    await vi.waitFor(() => expect(starts).toHaveLength(2), { timeout: 20_000, interval: 20 });
    expect(starts.at(-1)).toEqual({ versions: [1, 2], o: { mode: 'new', drawn: true, lang: 'it' } });
    await vi.waitFor(async () => expect(await subtitleJobs()).toHaveLength(2), { timeout: 20_000, interval: 20 });
    await waitIdle();
    expect((await detail(slug)).versions.map((v) => v.n)).toEqual([1, 2]);
  });

  it('a stopped turn starts nothing and says so', async () => {
    const slug = await create();
    const run = await runOf(slug);
    expect((await tool(run, 'start_subtitles', { drawn: false })).statusCode).toBe(200);
    const turn = (await jobs()).find((j) => j.kind !== 'subtitles' && j.state === 'running')!;
    await app.inject({ method: 'POST', url: `/api/jobs/${turn.id}/stop` });
    await waitIdle();
    // The settle hook has run once its line is written: only then is "nothing started" a fact.
    await vi.waitFor(async () => expect(await agentLines(slug)).toContain(t().subtitles.notStartedTurn));
    expect(starts).toEqual([]);
    expect(await subtitleJobs()).toEqual([]);
  });

  it('a refusal when the turn ends is a chat line', async () => {
    const slug = await create({ ...brief, formats: ['web-banner-300x250'], durationSec: null });
    const run = await runOf(slug);
    expect((await tool(run, 'start_subtitles', { drawn: false })).statusCode).toBe(200);
    writeCompositions(run);
    run.finish({ write: false });
    await waitIdle();
    expect(await subtitleJobs()).toEqual([]);
    await vi.waitFor(async () => expect(await agentLines(slug)).toContain(t().subtitles.notStarted({ reason: t().errors.subtitlesNoVideo })));
  });

  it('the transcription switched off is refused at once', async () => {
    const slug = await create();
    const run = await runOf(slug);
    expect((await app.inject({ method: 'PUT', url: '/api/transcription', payload: { method: 'never' } })).statusCode).toBe(200);
    const res = await tool(run, 'start_subtitles', { drawn: false });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: t().errors.subtitlesTranscriptionOff });
    writeCompositions(run);
    run.finish({ write: false });
    await waitIdle();
    expect(starts).toEqual([]);
  });

  const register = (kind: 'brief' | 'creative', appScope?: AppScope) => bridge.register({
    jobId: `${kind}-1`, kind, projectSlug: 'acme', projectDir: projectDir(), creativeSlug: null, sandboxed: false, autoApproveAtStart: false,
    emit: () => {}, signal: new AbortController().signal, ...(appScope ? { appScope } : {}),
  });
  const call = (token: string) => app.inject({ method: 'POST', url: '/api/bridge/start_subtitles', headers: { 'x-motion-studio-bridge': token }, payload: { drawn: false } });

  it('a job of another kind cannot call it, nor a group\'s coordinator', async () => {
    expect((await call(register('brief'))).statusCode).toBe(403);
    // A creative token scoped to a group's coordinator: the handler's own refusal (the bridge lets a creative job through).
    const coordinator = await call(register('creative', { root: join(base, 'ws'), projectSlug: 'acme', projectDir: projectDir(), creativeSlug: 'x', version: 0, group: true }));
    expect(coordinator.statusCode).toBe(403);
    expect(coordinator.json()).toEqual({ error: t().errors.toolUnavailable });
    expect((await call(register('creative'))).statusCode).toBe(403);
  });
});

describe('subtitle languages (Task 25, spec §6.5, U8)', () => {
  const ORIGINAL: SubtitleCue[] = [
    { id: 'c1', start: 200, end: 1800, text: 'Ciao a tutti' },
    { id: 'c2', start: 2000, end: 3500, text: 'Prenota in tre tocchi' },
    { id: 'c3', start: 4000, end: 5500, text: 'Scarica l\'app' },
  ];
  const speech = (cues: SubtitleCue[] = ORIGINAL, fingerprint = '0'.repeat(64)): SubtitleSet => ({
    $schema: SUBTITLES_SCHEMA_ID, lang: 'it', origin: 'speech', transcript: 'whisper-small', detected: 'it', timing: { version: 1, format: 'youtube-16x9', fingerprint }, cues,
  });
  const english = (cues: SubtitleCue[], fingerprint = '0'.repeat(64)): SubtitleSet => ({
    $schema: SUBTITLES_SCHEMA_ID, lang: 'en', origin: 'translation', sourceLang: 'it', transcript: 'whisper-small', detected: null,
    timing: { version: 1, format: 'youtube-16x9', fingerprint }, cues,
  });
  const translated = (texts: string[]) => english(ORIGINAL.map((c, i) => ({ id: c.id, start: c.start, end: c.end, text: texts[i]!, source: { text: c.text } })));
  const add = (slug: string, body: unknown) => app.inject({ method: 'POST', url: `${P}/${slug}/subtitles/languages`, payload: body as object });
  const retranslate = (slug: string, lang: string, body: unknown = {}) => app.inject({ method: 'POST', url: `${P}/${slug}/subtitles/${lang}/retranslate`, payload: body as object });
  const remove = (slug: string, lang: string) => app.inject({ method: 'DELETE', url: `${P}/${slug}/subtitles/${lang}` });
  const sets = async (slug: string) => ((await app.inject(`${P}/${slug}/subtitles`)).json() as { sets: SubtitlesSummary[] }).sets;
  const dirOf = (slug: string) => join(projectDir(), 'creatives', slug);
  /** A `de` row of v1's main format: its voice `voice`, with a German voice for the clip `vo`. */
  const germanRow = async (slug: string, voice: 'translated' | 'original') => {
    const store = new CreativeStore(projectDir());
    const overlay = { ...emptyOverlay('de', 'youtube-16x9'), voices: { vo: { src: 'assets/audio/vo-de.wav', sourceScript: '', script: 'Hallo zusammen' } } };
    const hash = await writeOverlay(store.dir(slug), 1, overlay);
    await setLocalizationRow(store, slug, 1, { locale: 'de', instanceId: 'youtube-16x9', hash, origin: 'agent', stale: [], voice });
  };

  it('adding a language translates the original speech set; the brief is not touched (U8)', async () => {
    const slug = await made();
    await writeSubtitleSet(dirOf(slug), speech());
    const before = (await detail(slug)).creative.brief;
    const res = await add(slug, { lang: 'en' });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { job: JobSummary }).job).toMatchObject({ kind: 'subtitles-translate' });
    expect(translateStarts).toEqual([{ target: 'en' }]);
    expect(starts).toEqual([]);
    expect((await detail(slug)).creative.brief).toEqual(before);
  });

  it('a language that has a set answers 409 subtitles-lang-exists; without a speech set 409 subtitles-no-source; a bad language 400', async () => {
    const slug = await made();
    const none = await add(slug, { lang: 'en' });
    expect(none.statusCode).toBe(409);
    expect(none.json()).toMatchObject({ code: 'subtitles-no-source' });
    await writeSubtitleSet(dirOf(slug), speech());
    await writeSubtitleSet(dirOf(slug), translated(['Hi everyone', 'Book in three taps', 'Get the app']));
    for (const lang of ['it', 'en']) {
      const res = await add(slug, { lang });
      expect(res.statusCode, lang).toBe(409);
      expect(res.json()).toMatchObject({ code: 'subtitles-lang-exists' });
    }
    expect((await add(slug, { lang: 'xx' })).statusCode).toBe(400);
    expect((await add(slug, {})).statusCode).toBe(400);
    // The one asked before the sets existed, refused by the translation.
    expect(translateStarts).toEqual([{ target: 'en' }]);
  });

  it('a language whose own translated voices are applied is made from its video\'s speech; with the original voice it is translated (Task 24)', { timeout: 60_000 }, async () => {
    const slug = await madeWithVoice({ role: true });
    await writeSubtitleSet(dirOf(slug), speech());
    await germanRow(slug, 'translated');
    const voiced = await add(slug, { lang: 'de' });
    expect(voiced.statusCode, voiced.body).toBe(200);
    expect((voiced.json() as { job: JobSummary }).job).toMatchObject({ kind: 'subtitles' });
    expect(starts.map((s) => s.o)).toEqual([{ mode: 'new', lang: 'de' }]);
    expect(translateStarts).toEqual([]);
    await app.inject({ method: 'POST', url: `/api/jobs/${(voiced.json() as { job: JobSummary }).job.id}/stop` });
    await waitIdle();

    await germanRow(slug, 'original');
    const original = await add(slug, { lang: 'de' });
    expect(original.statusCode, original.body).toBe(200);
    expect((original.json() as { job: JobSummary }).job).toMatchObject({ kind: 'subtitles-translate' });
    expect(translateStarts).toEqual([{ target: 'de' }]);
    expect(starts).toHaveLength(1);
  });

  it('the summary counts a translation\'s stale lines; a translation\'s timing is its source\'s, not the video\'s', async () => {
    const slug = await made();
    await writeSubtitleSet(dirOf(slug), speech());
    await writeSubtitleSet(dirOf(slug), translated(['Hi everyone', 'Book in three taps', 'Get the app']));
    // The video moved under both: only the source says so (the translation follows it).
    expect((await sets(slug)).map((s) => [s.lang, s.staleCues, s.timingChanged])).toEqual([['en', 0, false], ['it', 0, true]]);
    await writeSubtitleSet(dirOf(slug), speech(ORIGINAL.map((c) => (c.id === 'c1' ? { ...c, text: 'Ciao a voi', edited: true } : c))));
    expect((await sets(slug)).find((s) => s.lang === 'en')).toMatchObject({ staleCues: 1, timingChanged: false });
    // A translation not timed as its source is now (a safety signal).
    await writeSubtitleSet(dirOf(slug), { ...translated(['Hi everyone', 'Book in three taps', 'Get the app']), timing: { version: 1, format: 'youtube-16x9', fingerprint: '1'.repeat(64) } });
    expect((await sets(slug)).find((s) => s.lang === 'en')).toMatchObject({ timingChanged: true });
  });

  it('"Tempi controllati" of the source carries its timing to the translations (Task 25)', async () => {
    const slug = await made();
    const hash = await writeSubtitleSet(dirOf(slug), speech());
    await writeSubtitleSet(dirOf(slug), translated(['Hi everyone', 'Book in three taps', 'Get the app']));
    const res = await app.inject({ method: 'POST', url: `${P}/${slug}/subtitles/it/timing-checked`, payload: { baseHash: hash } });
    expect(res.statusCode, res.body).toBe(200);
    expect((await readSubtitleSet(dirOf(slug), 'en'))!.set.timing).toEqual((await readSubtitleSet(dirOf(slug), 'it'))!.set.timing);
    expect((await sets(slug)).map((s) => [s.lang, s.timingChanged])).toEqual([['en', false], ['it', false]]);
  });

  it('retranslate without ids asks for the stale lines the user did not correct; with ids, those (corrected ones included)', async () => {
    const slug = await made();
    await writeSubtitleSet(dirOf(slug), speech(ORIGINAL.map((c) => (c.id === 'c3' ? c : { ...c, text: `${c.text}!`, edited: true }))));
    const en = translated(['Hi everyone', 'Book in three taps', 'Get the app']);
    // c2 was corrected by the user: stale too, but only translated again when asked for.
    await writeSubtitleSet(dirOf(slug), { ...en, cues: en.cues.map((c) => (c.id === 'c2' ? { ...c, text: 'Book now', edited: true } : c)) });
    const all = await retranslate(slug, 'en');
    expect(all.statusCode, all.body).toBe(200);
    expect((all.json() as { job: JobSummary }).job).toMatchObject({ kind: 'subtitles-translate' });
    expect(translateStarts).toEqual([{ target: 'en', ids: ['c1'] }]);
    await app.inject({ method: 'POST', url: `/api/jobs/${(all.json() as { job: JobSummary }).job.id}/stop` });
    await waitIdle();

    const listed = await retranslate(slug, 'en', { ids: ['c2'] });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(translateStarts.at(-1)).toEqual({ target: 'en', ids: ['c2'] });
  });

  it('retranslate without ids also asks for the source lines no line stands for ("Manca la traduzione", final review I2)', async () => {
    const slug = await made();
    await writeSubtitleSet(dirOf(slug), speech());
    await writeSubtitleSet(dirOf(slug), translated(['Hi everyone', 'Book in three taps', 'Get the app']));
    await writeSubtitleSet(dirOf(slug), speech([...ORIGINAL, { id: 'c4', start: 6000, end: 7000, text: 'Nuova riga' }]));
    expect((await sets(slug)).find((s) => s.lang === 'en')).toMatchObject({ staleCues: 0, missing: 1 });
    const res = await retranslate(slug, 'en');
    expect(res.statusCode, res.body).toBe(200);
    expect(translateStarts).toEqual([{ target: 'en', ids: [], sourceIds: ['c4'] }]);
    await app.inject({ method: 'POST', url: `/api/jobs/${(res.json() as { job: JobSummary }).job.id}/stop` });
    await waitIdle();
  });

  it('retranslate without ids drops the uncorrected lines whose source line is gone (decision 1690), corrected ones stay', async () => {
    const slug = await made();
    await writeSubtitleSet(dirOf(slug), speech());
    const en = translated(['Hi everyone', 'Book in three taps', 'Get the app']);
    await writeSubtitleSet(dirOf(slug), { ...en, cues: [...en.cues, { id: 'c4', start: 6000, end: 6500, text: 'Mine', source: { text: 'Mio' }, edited: true }] });
    // c3's source line is gone, c2's changed.
    await writeSubtitleSet(dirOf(slug), speech([ORIGINAL[0]!, { ...ORIGINAL[1]!, text: 'Prenota ora' }]));
    vi.spyOn(SubtitleCommits.prototype, 'touch');
    broadcasts.length = 0;
    const res = await retranslate(slug, 'en');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ job: { kind: 'subtitles-translate' }, dropped: 1 });
    expect(translateStarts).toEqual([{ target: 'en', ids: ['c2'] }]);
    expect((await readSubtitleSet(dirOf(slug), 'en'))!.set.cues.map((c) => c.id)).toEqual(['c1', 'c2', 'c4']);
    expect(broadcasts.filter((m) => m.type === 'subtitles')).toEqual([{ type: 'subtitles', project: 'acme', creative: slug, lang: 'en' }]);
    await app.inject({ method: 'POST', url: `/api/jobs/${(res.json() as { job: JobSummary }).job.id}/stop` });
    await waitIdle();

    // Only gone lines: dropped, no job.
    await writeSubtitleSet(dirOf(slug), speech([ORIGINAL[1]!]));
    const only = await retranslate(slug, 'en');
    expect(only.statusCode, only.body).toBe(200);
    expect(only.json()).toEqual({ job: null, dropped: 1 });
    expect((await readSubtitleSet(dirOf(slug), 'en'))!.set.cues.map((c) => c.id)).toEqual(['c2', 'c4']);
  });

  it('a translation not timed as its source loses nothing to Ritraduci; lines dropped before a refusal are still reported (review round 2)', async () => {
    const slug = await made();
    await writeSubtitleSet(dirOf(slug), speech());
    // Timed on other audio than the source now (its lines could not follow a retime): c3 overlaps no source line, yet is kept.
    const en = translated(['Hi everyone', 'Book in three taps', 'Get the app']);
    await writeSubtitleSet(dirOf(slug), { ...en, timing: { ...en.timing, fingerprint: '1'.repeat(64) }, cues: en.cues.map((c) => (c.id === 'c3' ? { ...c, start: 8000, end: 9000 } : c)) });
    const kept = await retranslate(slug, 'en');
    expect(kept.statusCode, kept.body).toBe(200);
    expect(kept.json()).not.toHaveProperty('dropped');
    expect((await readSubtitleSet(dirOf(slug), 'en'))!.set.cues.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    // Translated again whole from the source now (final review I2): the job, not this request, replaces its lines.
    expect(translateStarts).toEqual([{ target: 'en' }]);

    // Timed as its source, with a line gone and the translation of 'en' already running: dropped, then refused, said both.
    await writeSubtitleSet(dirOf(slug), { ...translated(['Hi everyone', 'Book in three taps', 'Get the app']), cues: [...en.cues.slice(0, 2), { id: 'c9', start: 8000, end: 9000, text: 'Gone', source: { text: 'Sparita' } }] });
    await writeSubtitleSet(dirOf(slug), speech(ORIGINAL.map((c) => (c.id === 'c1' ? { ...c, text: 'Ciao a voi' } : c)).slice(0, 2)));
    const refused = await retranslate(slug, 'en');
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'subtitles-translating', dropped: 1 });
    expect((await readSubtitleSet(dirOf(slug), 'en'))!.set.cues.map((c) => c.id)).toEqual(['c1', 'c2']);
    await app.inject({ method: 'POST', url: `/api/jobs/${(kept.json() as { job: JobSummary }).job.id}/stop` });
    await waitIdle();
  });

  it('"Ritraduci tutto" on a translation a shifted retime left behind translates every source line now, corrections kept (final review I2)', async () => {
    const slug = await made();
    // The source after a retime with a 3 s intro: its fresh lines renamed (f1…), the line the user corrected kept (c1).
    const shifted: SubtitleCue[] = [
      { id: 'f1', start: 0, end: 2500, text: 'Benvenuti' },
      { id: 'c1', start: 3200, end: 4800, text: 'Ciao a voi', edited: true },
      { id: 'f2', start: 5000, end: 6500, text: 'Prenota in tre tocchi' },
      { id: 'f3', start: 7000, end: 8500, text: 'Scarica l\'app' },
    ];
    await writeSubtitleSet(dirOf(slug), speech(shifted, '2'.repeat(64)));
    // The English could not follow: its old times and timing; its c2 corrected by the user.
    const en = translated(['Hi everyone', 'Book in three taps', 'Get the app']);
    await writeSubtitleSet(dirOf(slug), { ...en, cues: en.cues.map((c) => (c.id === 'c2' ? { ...c, text: 'Book now', edited: true as const } : c)) });
    // "Ciao a voi" has no line standing for it.
    expect((await sets(slug)).find((s) => s.lang === 'en')).toMatchObject({ timingChanged: true, missing: 1 });
    const res = await retranslate(slug, 'en');
    expect(res.statusCode, res.body).toBe(200);
    expect(translateStarts).toEqual([{ target: 'en' }]);
    await vi.waitFor(() => expect(runner.runs.some((r) => r.req.prompt.startsWith('Motion Studio: translate'))).toBe(true), { timeout: 10_000 });
    const run = runner.runs.find((r) => r.req.prompt.startsWith('Motion Studio: translate'))!;
    // From the source as it is now; the corrected line's source line is left to it.
    expect(run.req.prompt).toContain('f1 | 00:00.000–00:02.500 | Benvenuti');
    expect(run.req.prompt).toContain('c1 | 00:03.200–00:04.800 | Ciao a voi');
    expect(run.req.prompt).toContain('f3 | 00:07.000–00:08.500 | Scarica l\'app');
    expect(run.req.prompt).not.toContain('f2 | ');
    const submitted = await tool(run, 'submit_subtitle_translation', { cues: [{ id: 'f1', text: 'Welcome' }, { id: 'c1', text: 'Hi you all' }, { id: 'f3', text: 'Get the app' }] });
    expect(submitted.statusCode, submitted.body).toBe(200);
    run.finish({ write: false });
    await waitIdle();
    const after = (await readSubtitleSet(dirOf(slug), 'en'))!.set;
    expect(after.cues.map((c) => [c.id, c.start, c.end, c.text, c.edited ?? false])).toEqual([
      ['f1', 0, 2500, 'Welcome', false], ['c1', 3200, 4800, 'Hi you all', false], ['c2', 5000, 6500, 'Book now', true], ['f3', 7000, 8500, 'Get the app', false],
    ]);
    expect(after.timing).toEqual((await readSubtitleSet(dirOf(slug), 'it'))!.set.timing);
    expect((await sets(slug)).find((s) => s.lang === 'en')).toMatchObject({ timingChanged: false, staleCues: 0, missing: 0 });
  });

  it('"Tempi controllati" refuses a translation: it follows its source (review round 2)', async () => {
    const slug = await made();
    await writeSubtitleSet(dirOf(slug), speech());
    const hash = await writeSubtitleSet(dirOf(slug), translated(['Hi everyone', 'Book in three taps', 'Get the app']));
    const res = await app.inject({ method: 'POST', url: `${P}/${slug}/subtitles/en/timing-checked`, payload: { baseHash: hash } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'subtitles-follows-source' });
    expect((await readSubtitleSet(dirOf(slug), 'en'))!.hash).toBe(hash);
  });

  it('retranslate with nothing stale 409; of a speech set 409; no set 404; a bad body 400', async () => {
    const slug = await made();
    await writeSubtitleSet(dirOf(slug), speech());
    expect((await retranslate(slug, 'en')).statusCode).toBe(404);
    await writeSubtitleSet(dirOf(slug), translated(['Hi everyone', 'Book in three taps', 'Get the app']));
    const fresh = await retranslate(slug, 'en');
    expect(fresh.statusCode).toBe(409);
    expect(fresh.json()).toEqual({ error: t().errors.subtitlesNothingStale({ lang: 'inglese' }), code: 'subtitles-nothing-stale' });
    // The only stale line is one the user corrected: the message says so (they pick it to translate it again).
    const en = (await readSubtitleSet(dirOf(slug), 'en'))!.set;
    await writeSubtitleSet(dirOf(slug), { ...en, cues: en.cues.map((c) => (c.id === 'c1' ? { ...c, text: 'Hi all', edited: true } : c)) });
    await writeSubtitleSet(dirOf(slug), speech(ORIGINAL.map((c) => (c.id === 'c1' ? { ...c, text: 'Ciao a voi' } : c))));
    expect((await retranslate(slug, 'en')).json()).toEqual({ error: t().errors.subtitlesNothingStaleCorrected({ lang: 'inglese' }), code: 'subtitles-nothing-stale' });
    const spoken = await retranslate(slug, 'it', { ids: ['c1'] });
    expect(spoken.statusCode).toBe(409);
    expect(spoken.json()).toMatchObject({ code: 'subtitles-lang-spoken' });
    expect((await retranslate(slug, 'en', { ids: 'c1' })).statusCode).toBe(400);
    expect((await retranslate(slug, 'en', { ids: [], other: 1 })).statusCode).toBe(400);
    expect(translateStarts).toEqual([]);
  });

  it('deleting a translation or a localized voice\'s set removes it, commits, broadcasts and turns its renders stale; the original speech set 409', async () => {
    const slug = await made();
    await writeSubtitleSet(dirOf(slug), speech());
    await writeSubtitleSet(dirOf(slug), translated(['Hi everyone', 'Book in three taps', 'Get the app']));
    await writeSubtitleSet(dirOf(slug), { ...speech(), lang: 'de', detected: 'de', timing: { version: 1, format: 'youtube-16x9', fingerprint: '0'.repeat(64), locale: 'de' } });
    const drawn = { lang: 'en', hash: (await readSubtitleSet(dirOf(slug), 'en'))!.cuesHash };
    expect(subtitlesCurrent(drawn, subtitleHashesOf((await detail(slug)).subtitles))).toBe(true);
    const touch = vi.spyOn(SubtitleCommits.prototype, 'touch');
    broadcasts.length = 0;

    const source = await remove(slug, 'it');
    expect(source.statusCode).toBe(409);
    expect(source.json()).toMatchObject({ code: 'subtitles-source-set' });
    expect(await readSubtitleSet(dirOf(slug), 'it')).not.toBeNull();

    for (const lang of ['en', 'de'] as const) {
      const res = await remove(slug, lang);
      expect(res.statusCode, res.body).toBe(200);
      expect(await readSubtitleSet(dirOf(slug), lang)).toBeNull();
    }
    expect(touch).toHaveBeenCalledWith(expect.objectContaining({ creativeSlug: slug }), t().subtitles.commitDeleted({ title: 'Lancio', lang: 'en' }));
    expect(broadcasts.filter((m) => m.type === 'subtitles')).toEqual([
      { type: 'subtitles', project: 'acme', creative: slug, lang: 'en' }, { type: 'subtitles', project: 'acme', creative: slug, lang: 'de' },
    ]);
    expect((await sets(slug)).map((s) => s.lang)).toEqual(['it']);
    expect(subtitlesCurrent(drawn, subtitleHashesOf((await detail(slug)).subtitles))).toBe(false);
    expect((await remove(slug, 'en')).statusCode).toBe(404);
    expect((await remove(slug, 'xx')).statusCode).toBe(400);
  });

  it('the add_subtitle_language tool adds a language from a creative turn; the brief stays as it is (U8); other jobs 403', async () => {
    const slug = ((await app.inject({ method: 'POST', url: P, payload: { title: 'Lancio', brief, generate: true } })).json() as { slug: string }).slug;
    const run = await runOf(slug);
    await writeSubtitleSet(dirOf(slug), speech());
    const before = (await detail(slug)).creative.brief;
    const res = await tool(run, 'add_subtitle_language', { lang: 'en' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ started: true, how: 'translation', when: 'now' });
    expect(translateStarts).toEqual([{ target: 'en' }]);
    expect((await detail(slug)).creative.brief).toEqual(before);
    const again = await tool(run, 'add_subtitle_language', { lang: 'it' });
    expect(again.statusCode).toBe(409);
    expect((await tool(run, 'add_subtitle_language', { lang: 'xx' })).statusCode).toBe(400);
    const token = bridge.register({
      jobId: 'brief-1', kind: 'brief', projectSlug: 'acme', projectDir: projectDir(), creativeSlug: null, sandboxed: false, autoApproveAtStart: false,
      emit: () => {}, signal: new AbortController().signal,
    });
    expect((await app.inject({ method: 'POST', url: '/api/bridge/add_subtitle_language', headers: { 'x-motion-studio-bridge': token }, payload: { lang: 'en' } })).statusCode).toBe(403);
  });

  it('the tool on a language with its own voices starts when the turn ends, on the version it saved; a refusal then is a chat line', async () => {
    const slug = ((await app.inject({ method: 'POST', url: P, payload: { title: 'Lancio', brief, generate: true } })).json() as { slug: string }).slug;
    const run = await runOf(slug);
    const voiced = vi.spyOn(subtitlesService, 'localizedVoiceLang').mockImplementation(async (_ref, lang) => lang === 'de' || lang === 'fr');
    const res = await tool(run, 'add_subtitle_language', { lang: 'de' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ started: true, how: 'speech', when: 'after-turn' });
    expect((await tool(run, 'add_subtitle_language', { lang: 'fr' })).json()).toEqual({ started: true, how: 'speech', when: 'after-turn' });
    expect(starts).toEqual([]);
    writeCompositions(run);
    run.finish({ write: false });
    // de starts on v1; fr then meets the running subtitles job: a chat line says why.
    await vi.waitFor(() => expect(starts.map((x) => x.o)).toEqual([{ mode: 'new', lang: 'de' }, { mode: 'new', lang: 'fr' }]), { timeout: 20_000, interval: 20 });
    expect(starts[0]!.versions).toEqual([1]);
    const lines = async () => ((await app.inject(`${P}/${slug}/conversation`)).json() as ConversationEntry[])
      .filter((e): e is Extract<ConversationEntry, { type: 'system' }> => e.type === 'system' && e.origin === 'agent').map((e) => e.text);
    await vi.waitFor(async () => expect(await lines()).toContain(t().subtitles.notStarted({ reason: t().errors.subtitlesRunning })), { timeout: 20_000, interval: 20 });
    expect(translateStarts).toEqual([]);
    voiced.mockRestore();
    await waitIdle();
  });
});
