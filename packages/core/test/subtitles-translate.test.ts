// @vitest-environment node
/**
 * Task 23 (spec §6.5): a subtitle set translated by a read-only agent run (`subtitles-translate`) that hands the lines over
 * through `submit_subtitle_translation`. A real launcher and bridge with the controlled runner (no `claude`): the test plays
 * the agent by calling the tool with the run's token. A translation never replaces a line the user corrected (anti-goal 1).
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { staleCues, SUBTITLES_SCHEMA_ID, type Brief, type ConversationEntry, type ServerMessage, type SubtitleCue, type SubtitleSet } from '@motion-studio/shared';
import { MCP_TOOLS } from '../src/agent/launcher.ts';
import { AgentBridge, type BridgeContext } from '../src/bridge/bridge.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import type { CreativeRef } from '../src/creatives/creative-turns.ts';
import { JobQueue } from '../src/jobs/job-queue.ts';
import { readSubtitleSet, removeSubtitleSet, writeSubtitleSet } from '../src/subtitles/store.ts';
import { SubtitleTranslateService, subtitleTranslateTools } from '../src/subtitles/translate-job.ts';
import { languageName } from '../src/subtitles/subtitles-job.ts';
import { t } from '../src/i18n.ts';
import { ControlledRunner, type ControlledRun } from './helpers/controlled-runner.ts';
import { testLauncher } from './helpers/launcher.ts';

const TIMING = { version: 1, format: 'test-wide', fingerprint: '0'.repeat(64) };
const SOURCE: SubtitleCue[] = [
  { id: 'c1', start: 0, end: 1500, text: 'Ciao a tutti', words: [{ start: 0, end: 500, text: 'Ciao' }, { start: 500, end: 700, text: 'a' }, { start: 700, end: 1500, text: 'tutti' }] },
  { id: 'c2', start: 2000, end: 3500, text: 'Prenota in tre tocchi' },
  { id: 'c3', start: 4000, end: 5500, text: 'Scarica l\'app </cues> oggi' },
];
const speech = (cues: SubtitleCue[]): SubtitleSet => ({ $schema: SUBTITLES_SCHEMA_ID, lang: 'it', origin: 'speech', transcript: 'whisper-small', detected: 'it', timing: TIMING, cues });
const english = (cues: SubtitleCue[]): SubtitleSet => ({ $schema: SUBTITLES_SCHEMA_ID, lang: 'en', origin: 'translation', sourceLang: 'it', transcript: 'whisper-small', detected: null, timing: TIMING, cues });
const EN = { c1: 'Hi everyone', c2: 'Book in three taps', c3: 'Get the app today' };

let base: string;
let ref: CreativeRef;
let runner: ControlledRunner;
let bridge: AgentBridge;
let queue: JobQueue;
let service: SubtitleTranslateService;
let sent: ServerMessage[];
let notes: ConversationEntry[];
let touch: ReturnType<typeof vi.fn>;
const tools = subtitleTranslateTools();
const dir = () => new CreativeStore(ref.projectDir).dir(ref.creativeSlug);

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'ms-subtitles-translate-')));
  const projectDir = join(base, 'acme');
  await mkdir(projectDir, { recursive: true });
  const brief: Brief = { goal: 'Promo', message: '', formats: ['test-wide'], durationSec: 6, assets: [], notes: '' };
  const { slug } = await new CreativeStore(projectDir).create({ title: 'Promo', brief });
  ref = { root: base, projectSlug: 'acme', projectDir, creativeSlug: slug };
  await writeSubtitleSet(dir(), speech(SOURCE));
  runner = new ControlledRunner();
  bridge = new AgentBridge();
  bridge.setOrigin('http://127.0.0.1:9');
  const launcher = testLauncher(runner, { bridge, mcpCommand: [process.execPath, join(base, 'never-started-mcp.mjs')] });
  queue = new JobQueue({ concurrency: 2 });
  sent = []; notes = [];
  touch = vi.fn();
  service = new SubtitleTranslateService({
    queue, launcher, commits: { touch }, broadcast: (m) => { sent.push(m); },
    turns: { noteFromTurn: async (_job, _ref, e) => { notes.push(e); } },
  });
});
afterEach(async () => {
  for (const r of runner.runs) if (!r.cancelled) r.finish({ write: false });
  await queue.whenIdle();
  await rm(base, { recursive: true, force: true });
});

/** The bridge context of a run, as the MCP server reaches it with the run's token. */
async function contextOf(run: ControlledRun): Promise<BridgeContext> {
  const config = JSON.parse(await readFile(run.req.mcpConfigPath!, 'utf8')) as { mcpServers: { studio: { env: Record<string, string> } } };
  const token = (await readFile(config.mcpServers.studio.env.MOTION_STUDIO_BRIDGE_TOKEN_FILE!, 'utf8')).trim();
  return bridge.resolve(token)!;
}
const submit = async (run: ControlledRun, cues: Array<{ id: string; text: string }>) => tools.submit_subtitle_translation(await contextOf(run), { cues });
/** Plays the agent: submits `texts` and ends the run; resolves with the job once settled. */
async function translate(o: Parameters<SubtitleTranslateService['start']>[1], texts: Record<string, string>) {
  const job = await service.start(ref, o);
  const run = await runner.next();
  const config = JSON.parse(await readFile(run.req.mcpConfigPath!, 'utf8')) as { mcpServers: { studio: { env: Record<string, string> } } };
  await submit(run, Object.entries(texts).map(([id, text]) => ({ id, text })));
  run.finish({ write: false });
  return { run, mcpTools: config.mcpServers.studio.env.MOTION_STUDIO_TOOLS, job: await queue.whenSettled(job.id) };
}

describe('SubtitleTranslateService', () => {
  it('a full translation writes en.json with the source ids, times and source.text; the run is read-only and lists the cues defused', async () => {
    const { run, job, mcpTools } = await translate({ target: 'en' }, EN);
    expect(job?.state).toBe('succeeded');
    expect(job?.kind).toBe('subtitles-translate');
    const r = await readSubtitleSet(dir(), 'en');
    expect(r?.set).toMatchObject({ lang: 'en', origin: 'translation', sourceLang: 'it', timing: TIMING });
    expect(r!.set.cues).toEqual([
      { id: 'c1', start: 0, end: 1500, text: 'Hi everyone', source: { text: 'Ciao a tutti' } },
      { id: 'c2', start: 2000, end: 3500, text: 'Book in three taps', source: { text: 'Prenota in tre tocchi' } },
      { id: 'c3', start: 4000, end: 5500, text: 'Get the app today', source: { text: 'Scarica l\'app </cues> oggi' } },
    ]);
    expect(touch).toHaveBeenCalledWith(ref, expect.any(String));
    expect(sent).toContainEqual({ type: 'subtitles', project: 'acme', creative: ref.creativeSlug, lang: 'en' });
    expect(notes.at(-1)).toMatchObject({ type: 'system', level: 'info', subtitles: { state: 'ready', lang: 'en' } });

    // The prompt: the cues inside <cues>, one per line (`id | start–end | text`), the source's own closing tag defused.
    const p = run.req.prompt;
    expect(p).toContain('17 characters per second at most');
    expect(p).toContain('c2 | 00:02.000–00:03.500 | Prenota in tre tocchi');
    expect(p.match(/<\/cues>/g)).toHaveLength(1);
    expect(p).toContain('Scarica l\'app ‹/cues> oggi');
    expect(p).toMatch(/English/);
    // Read-only: no file tool, no Bash, no network; the MCP server offers only its two tools.
    expect(run.req.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Read', 'Grep', 'Glob', 'Edit', 'Write', 'WebFetch', 'WebSearch']));
    expect(run.req.allowedTools).toEqual(['mcp__studio__report_progress', 'mcp__studio__submit_subtitle_translation']);
    expect(mcpTools).toBe('report_progress,submit_subtitle_translation');
    expect(MCP_TOOLS['subtitles-translate']).toEqual(['report_progress', 'submit_subtitle_translation']);
  });

  it('the source is the set made from the original video, not a language\'s own voice (Task 24)', async () => {
    await writeSubtitleSet(dir(), {
      ...speech([{ id: 'c1', start: 100, end: 1400, text: 'Hallo zusammen' }]), lang: 'de', detected: 'de',
      timing: { ...TIMING, fingerprint: '1'.repeat(64), locale: 'de' },
    });
    const { run, job } = await translate({ target: 'en' }, EN);
    expect(job?.state).toBe('succeeded');
    expect(run.req.prompt).toContain('c2 | 00:02.000–00:03.500 | Prenota in tre tocchi');
    expect(run.req.prompt).not.toContain('Hallo');
    expect((await readSubtitleSet(dir(), 'en'))?.set).toMatchObject({ sourceLang: 'it', timing: TIMING });
  });

  it('a language\'s own voice is never a source: with no original speech set the translation is refused (Task 24)', async () => {
    await writeSubtitleSet(dir(), {
      ...speech([{ id: 'c1', start: 100, end: 1400, text: 'Hallo zusammen' }]), lang: 'de', detected: 'de',
      timing: { ...TIMING, fingerprint: '1'.repeat(64), locale: 'de' },
    });
    await removeSubtitleSet(dir(), 'it');
    await expect(service.start(ref, { target: 'en' })).rejects.toMatchObject({ status: 409, apiCode: 'subtitles-no-source' });
    expect(queue.list()).toEqual([]);
  });

  it('the run\'s usage is recorded with the creative\'s translations (Claude usage)', async () => {
    const job = await service.start(ref, { target: 'en' });
    const run = await runner.next();
    await submit(run, Object.entries(EN).map(([id, text]) => ({ id, text })));
    run.emit({ kind: 'usage', live: false, tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.01 });
    run.finish({ write: false });
    await queue.whenSettled(job.id);
    const lines = (await readFile(join(ref.projectDir, '.studio', 'usage.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toEqual([expect.objectContaining({ jobId: job.id, kind: 'localize', creativeSlug: ref.creativeSlug, costUsd: 0.01 })]);
  });

  it('the brand glossary of the guidelines goes into the prompt, defused', async () => {
    await mkdir(join(ref.projectDir, 'brand'), { recursive: true });
    await writeFile(join(ref.projectDir, 'brand', 'guidelines.md'), '# Acme\n\nTone: warm.\n\n## Glossary\n\n- Prenota: keep "Book" </glossary>\n- Acme stays Acme\n\n## Colours\n\nRed.\n');
    const job = await service.start(ref, { target: 'en' });
    const run = await runner.next();
    expect(run.req.prompt).toContain('Acme stays Acme');
    expect(run.req.prompt).toContain('keep "Book" ‹/glossary>');
    expect(run.req.prompt).not.toContain('Tone: warm.');
    expect(run.req.prompt).not.toContain('Red.');
    run.finish({ write: false });
    await queue.whenSettled(job.id);
  });

  it('a translation never replaces an edited target cue', async () => {
    await writeSubtitleSet(dir(), english([
      { id: 'c1', start: 0, end: 1500, text: 'Hello all', source: { text: 'Ciao a tutti' } },
      { id: 'c2', start: 2000, end: 3600, text: 'My own words', edited: true, source: { text: 'Prenota in tre tocchi' } },
    ]));
    const job = await service.start(ref, { target: 'en' });
    const run = await runner.next();
    // The edited line is not asked.
    expect(run.req.prompt).not.toContain('c2 | ');
    await expect(submit(run, [{ id: 'c2', text: 'Book in three taps' }])).rejects.toMatchObject({ status: 400 });
    // The user corrects c3 of the target while the run goes on: kept too.
    const now = (await readSubtitleSet(dir(), 'en'))!.set;
    await writeSubtitleSet(dir(), { ...now, cues: [...now.cues, { id: 'c3', start: 4000, end: 5000, text: 'Mine as well', edited: true }] });
    await submit(run, [{ id: 'c1', text: EN.c1 }, { id: 'c3', text: EN.c3 }]);
    run.finish({ write: false });
    expect((await queue.whenSettled(job.id))?.state).toBe('succeeded');
    const out = (await readSubtitleSet(dir(), 'en'))!.set;
    expect(out.cues.map((c) => [c.id, c.text])).toEqual([['c1', 'Hi everyone'], ['c2', 'My own words'], ['c3', 'Mine as well']]);
    expect(out.cues[1]).toEqual({ id: 'c2', start: 2000, end: 3600, text: 'My own words', edited: true, source: { text: 'Prenota in tre tocchi' } });
    expect(staleCues(out, speech(SOURCE))).toEqual([]);
    // Its source line changes: it is reported stale instead of being replaced.
    const changed = speech(SOURCE.map((c) => (c.id === 'c2' ? { ...c, text: 'Prenota in due tocchi' } : c)));
    expect(staleCues(out, changed)).toEqual(['c2']);
  });

  it('when every target line is one the user corrected, nothing runs and nothing is rewritten', async () => {
    const all = english(SOURCE.map((c) => ({ id: c.id, start: c.start, end: c.end, text: `Mine ${c.id}`, edited: true as const, source: { text: c.text } })));
    await writeSubtitleSet(dir(), all);
    await expect(service.start(ref, { target: 'en' })).rejects.toMatchObject({ status: 409, apiCode: 'subtitles-nothing-to-translate' });
    expect(runner.runs).toHaveLength(0);
    expect((await readSubtitleSet(dir(), 'en'))!.set).toEqual(all);
  });

  it('the source is read when the job runs; a source line changed during the run is reported, its cue keeps what was translated', async () => {
    const job = await service.start(ref, { target: 'en' });
    const run = await runner.next();
    await writeSubtitleSet(dir(), speech(SOURCE.map((c) => (c.id === 'c2' ? { ...c, text: 'Prenota in due tocchi', edited: true as const } : c))));
    await submit(run, Object.entries(EN).map(([id, text]) => ({ id, text })));
    run.finish({ write: false });
    expect((await queue.whenSettled(job.id))?.state).toBe('succeeded');
    expect((await readSubtitleSet(dir(), 'en'))!.set.cues[1]).toMatchObject({ id: 'c2', text: EN.c2, source: { text: 'Prenota in tre tocchi' } });
    expect(notes.at(-1)).toMatchObject({ level: 'info', subtitles: { state: 'ready', lang: 'en' } });
    expect(notes.at(-1)).toMatchObject({ text: t().subtitles.translatedStale({ lang: languageName('en'), count: 1 }) });
  });

  it('a source changed between the request and the run is the one translated', async () => {
    // A busy queue: the job waits, the source changes, then it runs.
    const busy = new JobQueue({ concurrency: 1 });
    let release!: () => void;
    busy.enqueue({ key: 'other', kind: 'render', label: 'x', run: () => new Promise<void>((r) => { release = r; }) });
    const queued = new SubtitleTranslateService({ queue: busy, launcher: testLauncher(runner, { bridge, mcpCommand: [process.execPath, join(base, 'never-started-mcp.mjs')] }), commits: { touch }, broadcast: () => {}, turns: { noteFromTurn: async () => {} } });
    const job = await queued.start(ref, { target: 'en' });
    await writeSubtitleSet(dir(), speech(SOURCE.map((c) => (c.id === 'c1' ? { ...c, text: 'Ciao a voi' } : c))));
    release();
    const run = await runner.next();
    expect(run.req.prompt).toContain('c1 | 00:00.000–00:01.500 | Ciao a voi');
    await submit(run, Object.entries(EN).map(([id, text]) => ({ id, text })));
    run.finish({ write: false });
    await busy.whenSettled(job.id);
    expect((await readSubtitleSet(dir(), 'en'))!.set.cues[0]!.source).toEqual({ text: 'Ciao a voi' });
  });

  it('control, bidi and zero-width characters in the agent\'s text are dropped', async () => {
    const job = await service.start(ref, { target: 'en' });
    const run = await runner.next();
    await submit(run, [{ id: 'c1', text: 'Hi\u0007 every\u200bone\u202e' }, { id: 'c2', text: EN.c2 }, { id: 'c3', text: EN.c3 }]);
    run.finish({ write: false });
    await queue.whenSettled(job.id);
    expect((await readSubtitleSet(dir(), 'en'))!.set.cues[0]!.text).toBe('Hi every one');
  });

  it('ids: [\'c3\'] only rewrites c3', async () => {
    await translate({ target: 'en' }, EN);
    const before = (await readSubtitleSet(dir(), 'en'))!.set;
    const { run, job } = await translate({ target: 'en', ids: ['c3'] }, { c3: 'Download the app today' });
    expect(job?.state).toBe('succeeded');
    expect(run.req.prompt).toContain('c3 | ');
    expect(run.req.prompt).not.toContain('c1 | ');
    const after = (await readSubtitleSet(dir(), 'en'))!.set;
    expect(after.cues.slice(0, 2)).toEqual(before.cues.slice(0, 2));
    expect(after.cues[2]).toEqual({ ...before.cues[2]!, text: 'Download the app today' });
  });

  it('a target id follows a retimed source (Task 25): asked by the source line it overlaps most, it replaces that cue, no duplicate', async () => {
    await translate({ target: 'en' }, EN);
    const en = (await readSubtitleSet(dir(), 'en'))!.set;
    // The user corrected c2 in English; then the source was timed again (new ids, 100 ms later) and its c2 changed.
    await writeSubtitleSet(dir(), { ...en, cues: en.cues.map((c) => (c.id === 'c2' ? { ...c, text: 'Book it', edited: true as const } : c)) });
    const renamed = SOURCE.map((c, i) => ({ ...c, id: `f${i + 1}`, start: c.start + 100, end: c.end + 100, ...(i === 1 ? { text: 'Prenota ora' } : {}) }));
    await writeSubtitleSet(dir(), speech(renamed));
    const { run, job } = await translate({ target: 'en', ids: ['c2'] }, { f2: 'Book now' });
    expect(job?.state).toBe('succeeded');
    expect(run.req.prompt).toContain('f2 | ');
    expect(run.req.prompt).not.toContain('f1 | ');
    const after = (await readSubtitleSet(dir(), 'en'))!.set;
    expect(after.cues.map((c) => [c.id, c.start, c.text, c.edited ?? false])).toEqual([
      ['c1', 0, 'Hi everyone', false], ['f2', 2100, 'Book now', false], ['c3', 4000, 'Get the app today', false],
    ]);
    expect(staleCues(after, speech(renamed))).toEqual([]);
    await expect(service.start(ref, { target: 'en', ids: ['nope'] })).rejects.toMatchObject({ status: 400, apiCode: 'subtitles-no-cues' });
  });

  it('recycled ids (final review C1): "Ritraduci" on a stale line never touches another line the user corrected that has its source\'s id', async () => {
    // The source after a second retime: its fresh lines renamed f1…f4; the English f3 is the user's correction of "d" (6–8 s).
    const source = [
      { id: 'f1', start: 0, end: 2000, text: 'a' }, { id: 'f2', start: 2000, end: 4000, text: 'b' },
      { id: 'f3', start: 4000, end: 6000, text: 'c' }, { id: 'f4', start: 6000, end: 8000, text: 'd' },
    ];
    await writeSubtitleSet(dir(), speech(source));
    await writeSubtitleSet(dir(), english([
      { id: 'f1', start: 0, end: 2000, text: 'A', source: { text: 'a' } }, { id: 'f2', start: 2000, end: 4000, text: 'B', source: { text: 'b' } },
      { id: 'c9', start: 4000, end: 6000, text: 'Old C', source: { text: 'old c' } },
      { id: 'f3', start: 6000, end: 8000, text: 'MY CORRECTION', edited: true, source: { text: 'd' } },
    ]));
    const { run, job } = await translate({ target: 'en', ids: ['c9'] }, { f3: 'C' });
    expect(job?.state).toBe('succeeded');
    expect(run.req.prompt).toContain('f3 | 00:04.000–00:06.000 | c');
    const after = (await readSubtitleSet(dir(), 'en'))!.set;
    expect(after.cues.map((c) => [c.id, c.start, c.text, c.edited ?? false])).toEqual([
      ['f1', 0, 'A', false], ['f2', 2000, 'B', false], ['c9', 4000, 'C', false], ['f3', 6000, 'MY CORRECTION', true],
    ]);
    expect(after.cues[2]!.source).toEqual({ text: 'c' });
    // "Ritraduci" on the corrected line itself: the source line it stands for ("d", f4), never the source line named f3.
    const again = await translate({ target: 'en', ids: ['f3'] }, { f4: 'D' });
    expect(again.job?.state).toBe('succeeded');
    expect(again.run.req.prompt).toContain('f4 | 00:06.000–00:08.000 | d');
    expect(again.run.req.prompt).not.toContain('f3 | ');
    expect((await readSubtitleSet(dir(), 'en'))!.set.cues.map((c) => [c.id, c.start, c.text])).toEqual([
      ['f1', 0, 'A'], ['f2', 2000, 'B'], ['c9', 4000, 'C'], ['f4', 6000, 'D'],
    ]);
  });

  it('a tool call with an unknown id or a text over two lines is a 400 naming the id; nothing of that call is kept', async () => {
    const job = await service.start(ref, { target: 'en' });
    const run = await runner.next();
    const unknown = submit(run, [{ id: 'c1', text: EN.c1 }, { id: 'zz9', text: 'Who?' }]);
    await expect(unknown).rejects.toMatchObject({ status: 400 });
    await expect(unknown).rejects.toThrow(/zz9/);
    const long = submit(run, [{ id: 'c2', text: 'word '.repeat(30).trim() }]);
    await expect(long).rejects.toMatchObject({ status: 400 });
    await expect(long).rejects.toThrow(/c2/);
    await expect(submit(run, [{ id: 'c2', text: '' }])).rejects.toMatchObject({ status: 400 });
    // A valid call: the remaining ids are given back.
    await expect(submit(run, [{ id: 'c1', text: EN.c1 }])).resolves.toEqual({ ok: true, remaining: ['c2', 'c3'] });
    await expect(submit(run, [{ id: 'c2', text: EN.c2 }])).resolves.toEqual({ ok: true, remaining: ['c3'] });
    // At most five calls a run.
    await expect(submit(run, [{ id: 'c3', text: EN.c3 }])).rejects.toMatchObject({ status: 429 });
    run.finish({ write: false });
    // Lines missing at the end: the job fails, nothing is written.
    expect((await queue.whenSettled(job.id))?.state).toBe('failed');
    expect(await readSubtitleSet(dir(), 'en')).toBeNull();
    expect(notes.at(-1)).toMatchObject({ level: 'error', subtitles: { state: 'failed', lang: 'en' } });
  });

  it('a line wraps to the target\'s two lines; the tool is only for a translation run', async () => {
    const job = await service.start(ref, { target: 'en' });
    const run = await runner.next();
    await submit(run, [{ id: 'c1', text: 'Hi everyone, and welcome to the new booking app' }, { id: 'c2', text: EN.c2 }, { id: 'c3', text: EN.c3 }]);
    const other = { ...(await contextOf(run)), kind: 'creative' } as BridgeContext;
    await expect(tools.submit_subtitle_translation(other, { cues: [{ id: 'c1', text: 'x' }] })).rejects.toMatchObject({ status: 403 });
    run.finish({ write: false });
    await queue.whenSettled(job.id);
    expect((await readSubtitleSet(dir(), 'en'))!.set.cues[0]!.text).toBe('Hi everyone, and welcome\nto the new booking app');
  });

  it('refuses without a speech set, into the source\'s own language, ids without a translation, no ids, or ids not in the source', async () => {
    await expect(service.start(ref, { target: 'it' })).rejects.toMatchObject({ status: 400 });
    await expect(service.start(ref, { target: 'en', ids: ['c3'] })).rejects.toMatchObject({ status: 409, apiCode: 'subtitles-no-lang' });
    await writeSubtitleSet(dir(), english([{ id: 'c1', start: 0, end: 1500, text: 'Hi everyone', source: { text: 'Ciao a tutti' } }]));
    const none = service.start(ref, { target: 'en', ids: [] });
    await expect(none).rejects.toMatchObject({ status: 400, apiCode: 'subtitles-no-ids' });
    await expect(none).rejects.toThrow(/^[^:]*\.$/);
    await expect(service.start(ref, { target: 'en', ids: ['nope'] })).rejects.toMatchObject({ status: 400, apiCode: 'subtitles-no-cues' });
    await rm(join(dir(), 'subtitles', 'it.json'));
    await expect(service.start(ref, { target: 'en' })).rejects.toMatchObject({ status: 409, apiCode: 'subtitles-no-source' });
  });
});

describe('staleCues', () => {
  const translated = english(SOURCE.map((c) => ({ id: c.id, start: c.start, end: c.end, text: `EN ${c.id}`, source: { text: c.text } })));
  it('after editing source c1 → [\'c1\']', () => {
    expect(staleCues(translated, speech(SOURCE))).toEqual([]);
    const edited = speech(SOURCE.map((c) => (c.id === 'c1' ? { ...c, text: 'Ciao a voi', edited: true as const } : c)));
    expect(staleCues(translated, edited)).toEqual(['c1']);
  });
  it('matches by time, not id: a retimed source with new ids is still current; a source line gone makes its cue stale', () => {
    const renamed = speech(SOURCE.map((c, i) => ({ ...c, id: `f${i + 1}`, start: c.start + 100, end: c.end + 100 })));
    expect(staleCues(translated, renamed)).toEqual([]);
    expect(staleCues(translated, speech(SOURCE.slice(0, 2)))).toEqual(['c3']);
    // A line the user added in the target (no source text) is never stale.
    expect(staleCues(english([{ id: 'u1', start: 9000, end: 9500, text: 'Mine' }]), speech(SOURCE))).toEqual([]);
  });
});
