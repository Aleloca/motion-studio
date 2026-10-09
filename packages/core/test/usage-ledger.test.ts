import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_FORMATS, usageRecordSchema, type AgentEvent, type UsageRecord } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { CreativeTurnService } from '../src/creatives/creative-turns.ts';
import { Git } from '../src/git.ts';
import { JobQueue } from '../src/jobs/job-queue.ts';
import { NoMediaTools } from '../src/media/media-tools.ts';
import { MemoryVault } from '../src/secrets/vault.ts';
import { UsageLedger } from '../src/usage/usage-ledger.ts';
import { UsageTracker } from '../src/usage/usage-tracker.ts';
import { WorkspaceStore } from '../src/workspace-store.ts';
import { testLauncher } from './helpers/launcher.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
let dir: string;
let ledger: UsageLedger;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ms-usage-'));
  ledger = new UsageLedger();
});

const file = () => join(dir, '.studio', 'usage.jsonl');
const lines = async () => (await readFile(file(), 'utf8')).split('\n').filter(Boolean);
const tokens = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({ input, output, cacheRead, cacheWrite });
const record = (over: Partial<UsageRecord> = {}): UsageRecord => usageRecordSchema.parse({
  at: '2026-10-09T10:00:00.000Z', jobId: 'j1', kind: 'console', creativeSlug: null, version: null, attempt: null,
  tokens: tokens(1, 2, 3, 4), costUsd: 0.01, models: [], durationMs: 100, outcome: 'ok', ...over,
});
const tracker = (over: Partial<ConstructorParameters<typeof UsageTracker>[0]> = {}) =>
  new UsageTracker({ projectDir: dir, jobId: 'j1', kind: 'creative', creativeSlug: 'spot', version: 2, attempt: 1, ...over }, ledger);

const live = (t: ReturnType<typeof tokens>): AgentEvent => ({ kind: 'usage', live: true, tokens: t, costUsd: null });
/** The final usage of a run as the parser emits it: per-run tokens, CUMULATIVE cost and models. */
const final = (perRun: ReturnType<typeof tokens>, cumulativeCost: number, cumulative: ReturnType<typeof tokens>): AgentEvent => ({
  kind: 'usage', live: false, tokens: perRun, costUsd: cumulativeCost, models: [{ model: 'claude-haiku-5-5', tokens: cumulative, costUsd: cumulativeCost }],
});

describe('UsageLedger', () => {
  it('keeps every line whole when two trackers append at the same time', async () => {
    const a = tracker({ jobId: 'a' });
    const b = new UsageTracker({ projectDir: dir, jobId: 'b', kind: 'console' }, new UsageLedger());
    for (const t of [a, b]) {
      t.observe({ kind: 'session', sessionId: `s-${Math.random()}` });
      t.observe(final(tokens(1, 2, 3, 4), 0.5, tokens(1, 2, 3, 4)));
    }
    await Promise.all([a.finish('succeeded'), b.finish('succeeded')]);
    const raw = await lines();
    expect(raw).toHaveLength(2);
    expect(raw.map((l) => usageRecordSchema.parse(JSON.parse(l)).jobId).sort()).toEqual(['a', 'b']);
  });

  it('keeps many concurrent appends from separate ledgers whole (O_APPEND)', async () => {
    const other = new UsageLedger();
    await Promise.all(Array.from({ length: 60 }, (_, i) => (i % 2 ? ledger : other).append(dir, record({ jobId: `j${i}` }))));
    const raw = await lines();
    expect(raw).toHaveLength(60);
    expect(raw.every((l) => usageRecordSchema.safeParse(JSON.parse(l)).success)).toBe(true);
    expect(await ledger.read(dir)).toHaveLength(60);
  });

  it('skips a corrupt line in the middle', async () => {
    await mkdir(join(dir, '.studio'), { recursive: true });
    await writeFile(file(), [JSON.stringify(record({ jobId: 'a' })), '{"at": nope', '[]', JSON.stringify({ ...record(), tokens: { input: -1 } }), JSON.stringify(record({ jobId: 'b' }))].join('\n') + '\n');
    expect((await ledger.read(dir)).map((r) => r.jobId)).toEqual(['a', 'b']);
  });

  it('skips a partially written last line and keeps later appends readable', async () => {
    await mkdir(join(dir, '.studio'), { recursive: true });
    const whole = JSON.stringify(record({ jobId: 'a' }));
    await writeFile(file(), `${whole}\n${whole.slice(0, 40)}`);
    expect((await ledger.read(dir)).map((r) => r.jobId)).toEqual(['a']);
    await ledger.append(dir, record({ jobId: 'b' }));
    expect((await ledger.read(dir)).map((r) => r.jobId)).toEqual(['a', 'b']);
  });

  it('refuses an invalid record before touching the file', async () => {
    await expect(ledger.append(dir, { ...record(), tokens: tokens(-1, 0, 0, 0) })).rejects.toThrow();
    await expect(readFile(file())).rejects.toThrow();
  });

  it('reads nothing (and never throws) without a ledger or when it is not a file', async () => {
    expect(await ledger.read(dir)).toEqual([]);
    await mkdir(file(), { recursive: true });
    expect(await ledger.read(dir)).toEqual([]);
  });

  it('filters by time range', async () => {
    for (const at of ['2026-10-01T00:00:00.000Z', '2026-10-05T00:00:00.000Z', '2026-10-09T00:00:00.000Z']) await ledger.append(dir, record({ at }));
    const got = await ledger.read(dir, { from: new Date('2026-10-02T00:00:00Z'), to: new Date('2026-10-09T00:00:00Z') });
    expect(got.map((r) => r.at)).toEqual(['2026-10-05T00:00:00.000Z']);
  });
});

describe('UsageTracker', () => {
  it('writes the live estimate, marked estimated, when the run is cancelled before result', async () => {
    const t = tracker();
    t.observe({ kind: 'session', sessionId: 's1' });
    t.observe(live(tokens(2, 8, 100, 50)));
    t.observe(live(tokens(4, 20, 300, 70)));
    const { record: r, event } = await t.finish('cancelled');
    expect(event).toBeNull(); // the live events already told the UI
    const [saved] = await ledger.read(dir);
    expect(saved).toEqual(r);
    expect(saved).toMatchObject({
      jobId: 'j1', kind: 'creative', creativeSlug: 'spot', version: 2, attempt: 1, outcome: 'cancelled', estimated: true,
      tokens: tokens(4, 20, 300, 70), costUsd: null, models: [], durationMs: null, sessionId: 's1', cumulativeCostUsd: null,
    });
  });

  it('writes nothing when claude crashed before reporting any usage', async () => {
    const t = tracker();
    t.observe({ kind: 'stderr', text: 'boom' });
    expect(await t.finish('failed')).toEqual({ record: null, event: null });
    await expect(readFile(file())).rejects.toThrow();
  });

  it('records a failed run that did report its final usage as an error, not estimated', async () => {
    const t = tracker();
    t.observe({ kind: 'session', sessionId: 's1' });
    t.observe(final(tokens(1, 1, 1, 1), 0.002, tokens(1, 1, 1, 1)));
    t.observe({ kind: 'result', ok: false, sessionId: 's1', error: 'x', durationMs: 900 });
    const { record: r } = await t.finish('failed');
    expect(r).toMatchObject({ outcome: 'error', costUsd: 0.002, durationMs: 900 });
    expect(r!.estimated).toBeUndefined();
  });

  it('holds the final usage back and re-emits it with per-run cost', async () => {
    const t = tracker();
    expect(t.observe(live(tokens(1, 1, 1, 1)))).toEqual(live(tokens(1, 1, 1, 1)));
    expect(t.observe(final(tokens(1, 2, 3, 4), 0.01, tokens(1, 2, 3, 4)))).toBeNull();
    const { event } = await t.finish('succeeded');
    expect(event).toEqual({ kind: 'usage', live: false, tokens: tokens(1, 2, 3, 4), costUsd: 0.01, models: [{ model: 'claude-haiku-5-5', tokens: tokens(1, 2, 3, 4), costUsd: 0.01 }] });
  });

  it('two resumed turns of one session: the per-run costs add up to the final cumulative cost', async () => {
    // Numbers measured live in Task 1 (docs/superpowers/notes/2026-10-09-phase8-live-checks.md, "resumed sessions").
    const first = tracker({ attempt: 1 });
    first.observe({ kind: 'session', sessionId: 'sess' });
    first.observe(final(tokens(4, 1664, 45349, 16601), 0.00460609, tokens(4, 1664, 45349, 16601)));
    await first.finish('succeeded');
    const second = tracker({ attempt: 2, resumeSessionId: 'sess' });
    second.observe({ kind: 'session', sessionId: 'sess' });
    second.observe(final(tokens(4, 721, 64200, 1405), 0.00588999, tokens(8, 2385, 109549, 18006)));
    await second.finish('succeeded');
    const [a, b] = await ledger.read(dir);
    expect(a!.costUsd! + b!.costUsd!).toBeCloseTo(0.00588999, 12);
    expect(b).toMatchObject({ tokens: tokens(4, 721, 64200, 1405), sessionId: 'sess', cumulativeCostUsd: 0.00588999 });
    expect(b!.costUsd).toBeCloseTo(0.0012839, 12);
    // Per-model values are deltas too: they match this run's own tokens.
    expect(b!.models).toEqual([{ model: 'claude-haiku-5-5', tokens: tokens(4, 721, 64200, 1405), costUsd: expect.closeTo(0.0012839, 12) }]);
    expect(b!.estimated).toBeUndefined();
  });

  it('gives up on the cost (null, estimated) when the cumulative value went down', async () => {
    await ledger.append(dir, record({ sessionId: 'sess', costUsd: 0.5, cumulativeCostUsd: 0.5, cumulativeModels: [{ model: 'm', tokens: tokens(9, 9, 9, 9), costUsd: 0.5 }] }));
    const t = tracker({ resumeSessionId: 'sess' });
    t.observe({ kind: 'session', sessionId: 'sess' });
    t.observe({ kind: 'usage', live: false, tokens: tokens(1, 1, 1, 1), costUsd: 0.1, models: [{ model: 'm', tokens: tokens(1, 1, 1, 1), costUsd: 0.1 }] });
    const { record: r } = await t.finish('succeeded');
    expect(r).toMatchObject({ costUsd: null, estimated: true, models: [], tokens: tokens(1, 1, 1, 1), cumulativeCostUsd: 0.1 });
  });

  it('skips estimated records without cumulative values when looking for the previous run', async () => {
    const first = tracker();
    first.observe({ kind: 'session', sessionId: 'sess' });
    first.observe(final(tokens(1, 1, 1, 1), 0.1, tokens(1, 1, 1, 1)));
    await first.finish('succeeded');
    const cancelled = tracker();
    cancelled.observe({ kind: 'session', sessionId: 'sess' });
    cancelled.observe(live(tokens(5, 5, 5, 5)));
    await cancelled.finish('cancelled');
    const third = tracker();
    third.observe({ kind: 'session', sessionId: 'sess' });
    third.observe(final(tokens(2, 2, 2, 2), 0.4, tokens(8, 8, 8, 8)));
    const { record: r } = await third.finish('succeeded');
    expect(r!.costUsd).toBeCloseTo(0.3, 12);
  });

  it('a forked session starts from the parent run when its cumulative values carried over', async () => {
    const first = tracker();
    first.observe({ kind: 'session', sessionId: 'parent' });
    first.observe(final(tokens(1, 10, 100, 20), 0.1, tokens(1, 10, 100, 20)));
    await first.finish('succeeded');
    const fork = tracker({ resumeSessionId: 'parent' });
    fork.observe({ kind: 'session', sessionId: 'parent-fork' });
    fork.observe(final(tokens(1, 5, 50, 5), 0.15, tokens(2, 15, 150, 25)));
    const { record: r } = await fork.finish('succeeded');
    expect(r!.costUsd).toBeCloseTo(0.05, 12);
    // A fork whose values start from zero keeps the whole value.
    const fresh = tracker({ resumeSessionId: 'parent' });
    fresh.observe({ kind: 'session', sessionId: 'other-fork' });
    fresh.observe(final(tokens(1, 5, 50, 5), 0.03, tokens(1, 5, 50, 5)));
    expect((await fresh.finish('succeeded')).record!.costUsd).toBe(0.03);
  });

  it('never fails the run when the ledger cannot be written', async () => {
    await writeFile(join(dir, '.studio'), 'not a folder');
    const t = tracker();
    t.observe(final(tokens(1, 1, 1, 1), 0.1, tokens(1, 1, 1, 1)));
    const { record: r } = await t.finish('succeeded');
    expect(r).toMatchObject({ costUsd: 0.1 }); // still known to the caller (version usage)
  });
});

describe('version usage', { timeout: 30_000 }, () => {
  afterEach(() => { delete process.env.FAKE_CLAUDE_SCENARIO; delete process.env.FAKE_CLAUDE_USAGE_FILE; });

  it('is the sum of the three fix-loop attempts', async () => {
    const base = await mkdtemp(join(tmpdir(), 'ms-usage-ver-'));
    const git = new Git();
    const ws = await WorkspaceStore.open(join(base, 'ws'), git);
    const { slug } = await ws.createProject({ name: 'Acme' });
    const projectDir = ws.projectDir(slug);
    const store = new CreativeStore(projectDir);
    const created = await store.create({ title: 'Spot', brief: { goal: 'g', message: '', formats: ['instagram-post-1x1'], durationSec: 5, assets: [], notes: '' } });
    const queue = new JobQueue({ concurrency: 1 });
    const service = new CreativeTurnService({
      queue, git, media: NoMediaTools, vault: new MemoryVault(),
      launcher: testLauncher(new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 })),
      presets: async () => DEFAULT_FORMATS, model: async () => null, broadcast: () => {},
    });
    process.env.FAKE_CLAUDE_SCENARIO = 'render_never';
    // The fake keeps a run counter here: its cost and model tokens grow like a real resumed session.
    process.env.FAKE_CLAUDE_USAGE_FILE = join(base, 'fake-usage.json');
    await service.start({ root: ws.root, projectSlug: slug, projectDir, creativeSlug: created.slug });
    await queue.whenIdle();
    const [v1] = await store.readVersions(created.slug);
    const records = await new UsageLedger().read(projectDir);
    expect(records.map((r) => [r.kind, r.creativeSlug, r.version, r.attempt, r.outcome])).toEqual([1, 2, 3].map((a) => ['creative', created.slug, 1, a, 'ok']));
    // Fake numbers per run: in 10 / out 100 / cache read 1000 / cache write 200, cumulative cost 0.01 per run.
    expect(v1!.usage).toEqual({ tokens: tokens(30, 300, 3000, 600), costUsd: expect.closeTo(0.03, 12) });
    expect(records.reduce((s, r) => s + r.costUsd!, 0)).toBeCloseTo(0.03, 12);
    // Live usage events are not stored in the conversation; the final one is.
    const conv = await store.readConversation(created.slug);
    const stored = conv.flatMap((e) => (e.type === 'agent' && e.event.kind === 'usage' ? [e.event] : []));
    expect(stored.every((e) => e.kind === 'usage' && !e.live)).toBe(true);
    expect(stored).toHaveLength(3);
  });
});
