// @vitest-environment node
/**
 * Phase 15, Task 2: the variant group service (sisters, shared brief, ★ across variants, discard and restore, orphans) with
 * the controlled runner (no process) and the fake claude for a composition turn. Also the one shared "real sister" check of
 * ruling R2 and the places that use it (list, sweeps, approvals, brief-asset rename).
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CREATIVE_SOURCE_RE, DEFAULT_FORMATS, type Brief, type CreativeFile, type VersionEntry } from '@motion-studio/shared';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { explainContext } from '../src/approvals/broker.ts';
import { sweepDerivedCaches } from '../src/creatives/cache-sweep.ts';
import { CreativeSideStateStore } from '../src/creatives/creative-side-state.ts';
import { creativeKind, CreativeStore, isAcceptedCreative, isRealSister, isRealSisterSync } from '../src/creatives/creative-store.ts';
import { DirectEditService } from '../src/creatives/direct-edit.ts';
import { CreativeTurnService, type CreativeRef } from '../src/creatives/creative-turns.ts';
import { VariantGroupService } from '../src/creatives/variant-group.ts';
import { Git } from '../src/git.ts';
import { t } from '../src/i18n.ts';
import { CodedError } from '../src/workspace-store.ts';
import { JobQueue } from '../src/jobs/job-queue.ts';
import { renameJournalSchema } from '../src/library/rename-journal.ts';
import { NoMediaTools } from '../src/media/media-tools.ts';
import { sweepProjectRenders } from '../src/render/render-sweep.ts';
import { MemoryVault } from '../src/secrets/vault.ts';
import { WorkspaceStore } from '../src/workspace-store.ts';
import { recoverWorkspace } from '../src/server/creative-routes.ts';
import { parseStudioBlock } from '../src/creatives/prompt.ts';
import { ControlledRunner } from './helpers/controlled-runner.ts';
import { testLauncher } from './helpers/launcher.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const OLD = ['instagram-post-1x1', 'web-banner-300x250'];
const NEW = ['instagram-post-1x1', 'youtube-16x9'];
const brief: Brief = { goal: 'Lancio app', message: '', formats: OLD, durationSec: 10, assets: ['assets/logo.png'], notes: '' };
const HASH = (c: string) => c.repeat(64);

let base: string;
let projectDir: string;
let store: CreativeStore;
let side: CreativeSideStateStore;
let queue: JobQueue;
let runner: ControlledRunner;
let turns: CreativeTurnService;
let svc: VariantGroupService;
let host: CreativeRef;
const refOf = (slug: string): CreativeRef => ({ ...host, creativeSlug: slug });
const sis = (l: string) => `${host.creativeSlug}~${l}`;

const makeTurns = (o: { contract?: 'media' | 'compositions'; claude?: boolean } = {}) => new CreativeTurnService({
  agentContract: o.contract ?? 'media', maxAttempts: 1,
  queue, git: new Git(), media: NoMediaTools, vault: new MemoryVault(),
  launcher: testLauncher(o.claude ? new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }) : runner),
  presets: async () => DEFAULT_FORMATS, model: async () => null, broadcast: () => {}, sideState: side,
});

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ms-vg-'));
  const ws = await WorkspaceStore.open(join(base, 'ws'), new Git());
  const { slug } = await ws.createProject({ name: 'Acme' });
  projectDir = ws.projectDir(slug);
  store = new CreativeStore(projectDir);
  const created = await store.create({ title: 'Lancio', brief });
  host = { root: ws.root, projectSlug: slug, projectDir, creativeSlug: created.slug };
  side = new CreativeSideStateStore(join(base, 'config'));
  queue = new JobQueue({ concurrency: 1 });
  runner = new ControlledRunner();
  turns = makeTurns();
  svc = new VariantGroupService({ store, turns });
  await side.read(projectDir, host.creativeSlug);
});
afterEach(async () => {
  for (const j of queue.list()) if (j.state === 'queued' || j.state === 'running') queue.cancel(j.id);
  await queue.whenIdle();
  delete process.env.FAKE_CLAUDE_SCENARIO;
});

/** A v2 version of `slug` with one composition per format (the identity `hasFormat` and `starOf` read; no files needed). */
async function fakeVersion(slug: string, n: number, formats: string[], c = 'a'): Promise<void> {
  const v: VersionEntry = {
    n, commit: null, sessionId: null, status: 'complete', createdAt: new Date().toISOString(), request: `v${n}`, outputs: [], problems: [], tools: [],
    renderCommand: null, basedOn: null, compositions: formats.map((format) => ({ format, dir: `compositions/${format}`, hash: HASH(c), problems: [] })),
  };
  await store.appendVersion(slug, v);
}
const json = async (slug: string): Promise<CreativeFile> => JSON.parse(await readFile(join(projectDir, 'creatives', slug, 'creative.json'), 'utf8'));
const withoutLinks = (b: Brief) => { const { links: _l, ...rest } = b; return rest; };
const blockFormats = (prompt: string) => parseStudioBlock(prompt)!.formats.map((f) => f.id).sort();
const stateOf = (id: string) => queue.list().find((j) => j.id === id)?.state;

describe('group lifecycle', { timeout: 60_000 }, () => {
  it('creates the sisters of a new group: folders, brief, variantOf, directions, side records; no turn starts', async () => {
    const g = await svc.addVariants(host, [{ direction: 'Minimal' }, {}], { hostDirection: 'Bold' });
    expect(g.members.map((m) => [m.slug, m.letter, m.direction, m.directionSource, m.status])).toEqual([
      [host.creativeSlug, 'a', 'Bold', 'user', 'active'], [sis('b'), 'b', 'Minimal', 'user', 'active'], [sis('c'), 'c', null, null, 'active'],
    ]);
    expect(g).toMatchObject({ picks: {}, layout: 'variant' });
    expect((await json(host.creativeSlug)).variantGroup).toEqual(g);
    for (const l of ['b', 'c']) {
      const c = await json(sis(l));
      expect(c).toMatchObject({ title: 'Lancio', status: 'draft', variantOf: host.creativeSlug, brief: withoutLinks(brief) });
      expect(c.variantGroup).toBeUndefined();
      expect(existsSync(join(projectDir, 'creatives', sis(l), 'work', '.gitkeep'))).toBe(true);
      expect(await store.readVersions(sis(l))).toEqual([]);
      expect(await side.fileFor(projectDir, sis(l))).not.toBeNull();
    }
    // Ruling R3: creating sisters starts nothing.
    expect(queue.list()).toEqual([]);
    expect(runner.runs).toHaveLength(0);
    // Committed: the host's group and the sisters' files.
    const paths = [`creatives/${host.creativeSlug}/creative.json`, `creatives/${sis('b')}`, `creatives/${sis('c')}`];
    expect(execFileSync('git', ['status', '--porcelain', '--', ...paths], { cwd: projectDir, encoding: 'utf8' })).toBe('');
    expect(execFileSync('git', ['ls-files', '--', `creatives/${sis('b')}`], { cwd: projectDir, encoding: 'utf8' })).toContain('creative.json');
    // Member slugs are tied to letters (ruling R2).
    expect(await isRealSister(projectDir, sis('b'))).toBe(true);
  });

  it('has no cap on variants (decision 978): ids go on past e to z, then aa, and are never reused (decision 1151)', async () => {
    await svc.addVariants(host, [{}, {}, {}, {}]);
    await svc.addVariants(host, [{}]);
    expect((await json(host.creativeSlug)).variantGroup!.members.map((m) => m.letter)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(await isRealSister(projectDir, sis('f'))).toBe(true);
    await svc.addVariants(host, Array.from({ length: 21 }, () => ({})));
    const g = (await json(host.creativeSlug)).variantGroup!;
    expect(g.members).toHaveLength(27);
    expect(g.members.at(-1)).toMatchObject({ letter: 'aa', slug: sis('aa') });
    expect(existsSync(join(projectDir, 'creatives', sis('aa'), 'creative.json'))).toBe(true);
    expect(await isRealSister(projectDir, sis('aa'))).toBe(true);
    // The commit line names the two-letter id whole.
    expect(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: projectDir, encoding: 'utf8' })).toContain('AA');
  });

  it('decision 1162: an id is never given twice: not after a sister left, not after the group dissolved, not for an old group with no mark', async () => {
    const leave = async (slug: string) => {
      const g = (await json(host.creativeSlug)).variantGroup!;
      await turns.runLocked(host, () => svc.detachLocked(host, g, slug));
      await store.removeSisterFolder(slug);
    };
    await svc.addVariants(host, [{}, {}]);
    await leave(sis('c'));
    await svc.addVariants(host, [{}]);
    expect((await json(host.creativeSlug)).variantGroup!.members.map((m) => m.letter)).toEqual(['a', 'b', 'd']);
    // The group dissolves (A alone), then is made again: the next id still comes after d.
    await leave(sis('d'));
    await leave(sis('b'));
    expect((await json(host.creativeSlug)).variantGroup).toBeUndefined();
    await svc.addVariants(host, [{}]);
    expect((await json(host.creativeSlug)).variantGroup!.members.map((m) => m.letter)).toEqual(['a', 'e']);
    // An older host with no mark: the ids its chat already names are not given again.
    await leave(sis('e'));
    await store.update(host.creativeSlug, { variantNext: undefined });
    await writeFile(join(projectDir, 'creatives', host.creativeSlug, 'conversation.jsonl'), `${JSON.stringify({ type: 'system', at: new Date().toISOString(), level: 'info', text: 'x', variant: 'g' })}\n`);
    await svc.addVariants(host, [{}]);
    expect((await json(host.creativeSlug)).variantGroup!.members.map((m) => m.letter)).toEqual(['a', 'h']);
  });

  it('a folder already on disk with a sister\'s name keeps its id out of use (decision 1162): the next ids go past it', async () => {
    await mkdir(join(projectDir, 'creatives', sis('c')));
    await svc.addVariants(host, [{}, {}]);
    expect((await json(host.creativeSlug)).variantGroup!.members.map((m) => m.letter)).toEqual(['a', 'd', 'e']);
  });

  it('a sister that cannot be made (409, e.g. its folder appeared meanwhile) leaves no group or other sister behind', async () => {
    const real = store.createSister.bind(store);
    let n = 0;
    const spy = vi.spyOn(store, 'createSister').mockImplementation(async (h, l, c) => {
      if (++n === 2) throw new CodedError(409, 'exists', 'variant-folder-exists');
      return real(h, l, c);
    });
    try {
      await expect(svc.addVariants(host, [{}, {}])).rejects.toMatchObject({ status: 409, apiCode: 'variant-folder-exists' });
    } finally { spy.mockRestore(); }
    expect(existsSync(join(projectDir, 'creatives', sis('b')))).toBe(false);
    expect((await json(host.creativeSlug)).variantGroup).toBeUndefined();
  });

  it('setDirection, setLayout and directions over 140 characters', async () => {
    await svc.addVariants(host, [{}]);
    let g = await svc.setDirection(refOf(sis('b')), 'b', '  Più caldo ', 'user');
    expect(g.members[1]).toMatchObject({ direction: 'Più caldo', directionSource: 'user' });
    g = await svc.setDirection(host, 'b', '', 'user');
    expect(g.members[1]).toMatchObject({ direction: null, directionSource: null });
    await expect(svc.setDirection(host, 'b', 'x'.repeat(141), 'user')).rejects.toMatchObject({ status: 400 });
    await expect(svc.setDirection(host, 'd', 'x', 'user')).rejects.toMatchObject({ status: 404, apiCode: 'variant-unknown' });
    expect((await svc.setLayout(host, 'format')).layout).toBe('format');
  });
});

describe('Review Focus 1: brief edited while B runs and C is queued', { timeout: 60_000 }, () => {
  it('B finishes on the old brief and takes the new one at its next turn; C starts with it; no variant mixes formats', async () => {
    await svc.addVariants(host, [{}, {}]);
    const [B, C] = [refOf(sis('b')), refOf(sis('c'))];
    const jobB = await turns.start(B);
    const runB = await runner.next(0);
    const jobC = await turns.start(C);
    expect(stateOf(jobC.id)).toBe('queued');
    // A pick of the format the edit removes (Review Focus 2's other half is below).
    await fakeVersion(host.creativeSlug, 1, OLD);
    await svc.setPick(host, 'web-banner-300x250', { slug: host.creativeSlug, version: 1 });

    const next: Brief = { ...brief, goal: 'Nuovo obiettivo', formats: NEW };
    const answered = await turns.updateBrief(host, { brief: next });
    expect(answered.brief).toMatchObject({ goal: 'Nuovo obiettivo', formats: NEW });
    // A (idle) now; B (running) and C (queued) at their next turn, never mid-turn.
    expect((await json(host.creativeSlug)).brief.formats).toEqual(NEW);
    for (const s of [B, C]) {
      expect((await json(s.creativeSlug)).brief.formats).toEqual(OLD);
      expect((await side.pendingBrief(projectDir, s.creativeSlug))?.brief.formats).toEqual(NEW);
    }
    expect((await store.readConversation(B.creativeSlug)).some((e) => e.type === 'system' && e.text === t().jobs.variantBriefDeferred)).toBe(true);
    expect((await json(host.creativeSlug)).variantGroup!.picks).toEqual({});
    expect(blockFormats(runB.req.prompt)).toEqual([...OLD].sort());

    // B finishes on the old brief; C starts and plans on the new one.
    runB.finish();
    const runC = await runner.next(1);
    expect(blockFormats(runC.req.prompt)).toEqual([...NEW].sort());
    expect(runC.req.prompt).toContain('Nuovo obiettivo');
    expect((await json(C.creativeSlug)).brief.formats).toEqual(NEW);
    expect(await side.pendingBrief(projectDir, C.creativeSlug)).toBeNull();
    runC.finish();
    await queue.whenIdle();
    expect(stateOf(jobB.id)).toBe('succeeded');
    // Fix round 1 (Important 1): B's turn is over, so it took the group's brief when its job ended (never mid-turn).
    await vi.waitFor(async () => expect((await json(B.creativeSlug)).brief.formats).toEqual(NEW));

    // B's next turn plans on the new brief.
    await turns.start(B, { text: 'ancora', pins: [] });
    const runB2 = await runner.next(2);
    expect(blockFormats(runB2.req.prompt)).toEqual([...NEW].sort());
    runB2.finish();
    await queue.whenIdle();

    // Converged: the same shared brief everywhere, nothing pending.
    const briefs = await Promise.all([host.creativeSlug, B.creativeSlug, C.creativeSlug].map(async (s) => withoutLinks((await json(s)).brief)));
    expect(briefs[1]).toEqual(briefs[0]);
    expect(briefs[2]).toEqual(briefs[0]);
    for (const s of [B, C]) expect(await side.pendingBrief(projectDir, s.creativeSlug)).toBeNull();
    // No variant ever had a mix: each run's formats are all old or all new.
    for (const r of runner.runs) {
      const f = blockFormats(r.req.prompt);
      expect([JSON.stringify([...OLD].sort()), JSON.stringify([...NEW].sort())]).toContain(JSON.stringify(f));
    }
  });

  it('a brief edit on a sister is the group\'s (the host and the other sister get it)', async () => {
    await svc.addVariants(host, [{}, {}]);
    await turns.updateBrief(refOf(sis('c')), { services: { voice: 'none' } });
    for (const s of [host.creativeSlug, sis('b'), sis('c')]) expect((await json(s)).brief.services).toEqual({ voice: 'none' });
    // A partial save keeps per-variant links: each variant keeps its own.
    await store.update(sis('b'), { brief: { ...(await json(sis('b'))).brief, links: { 'web-banner-300x250': 'instagram-post-1x1' } } });
    await turns.updateBrief(host, { title: 'Lancio 2' });
    expect((await json(sis('b'))).brief.links).toEqual({ 'web-banner-300x250': 'instagram-post-1x1' });
    expect((await json(sis('c'))).title).toBe('Lancio 2');
  });

  it('a discarded variant is not propagated to; restoring it brings it to the group\'s brief', async () => {
    await svc.addVariants(host, [{}, {}]);
    await svc.discard(host, 'c');
    await turns.updateBrief(host, { brief: { ...brief, goal: 'Altro' } });
    expect((await json(sis('c'))).brief.goal).toBe('Lancio app');
    await svc.restore(host, 'c');
    expect((await json(sis('c'))).brief.goal).toBe('Altro');
  });
});

describe('Review Focus 2: a format removed while its ★ points to variant C', { timeout: 60_000 }, () => {
  it('drops the ★; C keeps its versions; the selection no longer lists the format and never throws', async () => {
    await svc.addVariants(host, [{}, {}]);
    await fakeVersion(host.creativeSlug, 1, OLD, 'a');
    await fakeVersion(sis('c'), 1, OLD, 'c');
    await svc.setPick(host, 'web-banner-300x250', { slug: sis('c'), version: 1 });
    expect(await svc.groupSelection(host)).toEqual({
      'instagram-post-1x1': { slug: host.creativeSlug, version: 1, source: 'default' },
      'web-banner-300x250': { slug: sis('c'), version: 1, source: 'pick' },
    });
    // The real path of a brief edit (final wave M5: the test-only propagateBrief is gone).
    await svc.updateGroupBrief(host, { brief: { ...brief, formats: ['instagram-post-1x1'] } }, host);
    for (const s of [host.creativeSlug, sis('b'), sis('c')]) expect((await json(s)).brief.formats).toEqual(['instagram-post-1x1']);
    expect((await json(host.creativeSlug)).variantGroup!.picks).toEqual({});
    expect((await store.readVersions(sis('c')))[0]!.compositions!.map((c) => c.format)).toEqual(OLD);
    expect(await svc.groupSelection(host)).toEqual({ 'instagram-post-1x1': { slug: host.creativeSlug, version: 1, source: 'default' } });
    // From a sister's page the selection is the group's.
    await svc.setPick(host, 'instagram-post-1x1', { slug: sis('c'), version: 1 });
    expect((await svc.groupSelection(refOf(sis('c'))))['instagram-post-1x1']).toEqual({ slug: sis('c'), version: 1, source: 'pick' });
  });
});

describe('Review Focus 3: discarding a variant that holds ★s or is running', { timeout: 60_000 }, () => {
  it('★s fall back to the default rule; running refused with a translated reason; last active refused; restore without old ★s', async () => {
    await svc.addVariants(host, [{}, {}]);
    await fakeVersion(host.creativeSlug, 1, OLD, 'a');
    await fakeVersion(sis('b'), 1, OLD, 'b');
    await svc.useVariantForAll(host, 'b');
    expect(await svc.groupSelection(host)).toEqual({
      'instagram-post-1x1': { slug: sis('b'), version: 1, source: 'pick' }, 'web-banner-300x250': { slug: sis('b'), version: 1, source: 'pick' },
    });
    let g = await svc.discard(host, 'b');
    expect(g.picks).toEqual({});
    expect(g.members[1]!.status).toBe('discarded');
    expect(Object.values(await svc.groupSelection(host)).every((s) => s.slug === host.creativeSlug && s.source === 'default')).toBe(true);
    // A discarded member takes no ★ and is never selected.
    await expect(svc.setPick(host, 'instagram-post-1x1', { slug: sis('b'), version: 1 })).rejects.toMatchObject({ status: 422, apiCode: 'variant-pick-invalid' });
    expect(await svc.discard(host, 'b')).toEqual(g); // idempotent

    // Running: refused until stopped, with the translated reason.
    const job = await turns.start(refOf(sis('c')));
    await runner.next(0);
    await expect(svc.discard(host, 'c')).rejects.toMatchObject({ status: 409, apiCode: 'variant-running', message: t().errors.variantRunning({ letter: 'C' }) });
    queue.cancel(job.id);
    await queue.whenIdle();
    // Last active: A goes, C stays.
    g = await svc.discard(host, 'a');
    await expect(svc.discard(host, 'c')).rejects.toMatchObject({ status: 409, apiCode: 'variant-last-active', message: t().errors.variantLastActive({ letter: 'C' }) });
    // With A discarded the default rule is the first active variant's (C has no version: nothing to export).
    expect(await svc.groupSelection(host)).toEqual({});
    // Restore: active again, without its old ★s.
    g = await svc.restore(host, 'b');
    expect(g.members[1]!.status).toBe('active');
    expect(g.picks).toEqual({});
    await expect(svc.discard(host, 'e')).rejects.toMatchObject({ status: 404, apiCode: 'variant-unknown' });
  });

  it('invalid picks are 422: a format not in the brief, an unknown slug, a version without the format', async () => {
    await svc.addVariants(host, [{}]);
    await fakeVersion(sis('b'), 1, ['instagram-post-1x1'], 'b');
    const bad = [
      ['youtube-16x9', { slug: sis('b'), version: 1 }], ['instagram-post-1x1', { slug: 'altro', version: 1 }],
      ['web-banner-300x250', { slug: sis('b'), version: 1 }], ['instagram-post-1x1', { slug: sis('b'), version: 9 }],
    ] as const;
    for (const [f, p] of bad) await expect(svc.setPick(host, f, p)).rejects.toMatchObject({ status: 422, apiCode: 'variant-pick-invalid' });
    expect((await svc.setPick(host, 'instagram-post-1x1', { slug: sis('b'), version: 1 })).picks).toEqual({ 'instagram-post-1x1': { slug: sis('b'), version: 1 } });
    expect((await svc.setPick(host, 'instagram-post-1x1', null)).picks).toEqual({});
  });
});

describe('Review Focus 5: the host deleted by hand, or a sister folder missing', { timeout: 60_000 }, () => {
  it('a missing sister is "missing" for the host: list, propagation and selection never throw', async () => {
    await svc.addVariants(host, [{}, {}]);
    await fakeVersion(host.creativeSlug, 1, OLD, 'a');
    await svc.setPick(host, 'instagram-post-1x1', { slug: host.creativeSlug, version: 1 });
    await rm(join(projectDir, 'creatives', sis('c')), { recursive: true });
    expect((await svc.resolve(host)).missing).toEqual([sis('c')]);
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ slug: host.creativeSlug, variants: { count: 3, active: 3, missing: ['c'] } });
    await svc.updateGroupBrief(host, { brief: { ...brief, goal: 'X' } }, host);
    for (const s of [host.creativeSlug, sis('b')]) expect((await json(s)).brief.goal).toBe('X');
    expect(Object.keys(await svc.groupSelection(host))).toEqual(OLD);
    expect(existsSync(join(projectDir, 'creatives', sis('c')))).toBe(false);
  });

  it('the host deleted by hand: each sister opens as a single creative (orphan) and is listed alone', async () => {
    await svc.addVariants(host, [{}, {}]);
    await rm(join(projectDir, 'creatives', host.creativeSlug), { recursive: true });
    const r = await svc.resolve(refOf(sis('b')));
    expect(r).toMatchObject({ orphan: true, group: null, missing: [] });
    expect(r.host.creativeSlug).toBe(sis('b'));
    expect((await store.list()).map((i) => [i.slug, i.ok && i.orphan]).sort()).toEqual([[sis('b'), true], [sis('c'), true]]);
    await expect(store.assertOpenable(sis('b'))).resolves.toBeUndefined();
    expect(await creativeKind(projectDir, sis('b'))).toBe('orphan');
    await expect(svc.groupSelection(refOf(sis('b')))).rejects.toMatchObject({ status: 409, apiCode: 'variant-orphan' });
    await expect(svc.discard(refOf(sis('b')), 'b')).rejects.toMatchObject({ apiCode: 'variant-orphan' });
    // As a single creative: a brief edit changes it alone.
    const edited = await turns.updateBrief(refOf(sis('b')), { title: 'Solo' });
    expect(edited.title).toBe('Solo');
    expect((await json(sis('c'))).title).toBe('Lancio');
  });
});

describe('lock ordering', { timeout: 60_000 }, () => {
  it('concurrent propagations and discards on a slow store never deadlock and end consistent', async () => {
    await svc.addVariants(host, [{}, {}, {}]);
    class SlowStore extends CreativeStore {
      override async get(slug: string) { await new Promise((r) => setTimeout(r, 15)); return super.get(slug); }
      override async update(slug: string, patch: Parameters<CreativeStore['update']>[1]) { await new Promise((r) => setTimeout(r, 15)); return super.update(slug, patch); }
    }
    const slow = new VariantGroupService({ store: new SlowStore(projectDir), turns });
    const running = await turns.start(refOf(sis('c')));
    await runner.next(0);
    const all = Promise.allSettled([
      slow.updateGroupBrief(host, { brief: { ...brief, goal: 'Uno' } }, host),
      slow.discard(host, 'b'),
      slow.updateGroupBrief(refOf(sis('d')), { brief: { ...brief, goal: 'Due' } }, refOf(sis('d'))),
      slow.discard(refOf(sis('d')), 'c'), // running: refused
      turns.updateBrief(refOf(sis('b')), { services: { music: 'none' } }),
      slow.setPick(host, 'instagram-post-1x1', null),
      slow.restore(host, 'b'),
    ]);
    const settled = await Promise.race([all, new Promise<'deadlock'>((r) => setTimeout(() => r('deadlock'), 15_000))]);
    expect(settled).not.toBe('deadlock');
    const results = settled as PromiseSettledResult<unknown>[];
    expect(results[3]).toMatchObject({ status: 'rejected', reason: { apiCode: 'variant-running' } });
    // Final wave I2: B's own brief save may land while B is discarded (it races B's discard and restore): then it is refused.
    if (results[4]!.status === 'rejected') expect(results[4]).toMatchObject({ reason: { apiCode: 'variant-discarded' } });
    expect(results.filter((r, i) => r.status === 'rejected' && i !== 4)).toHaveLength(1);
    queue.cancel(running.id);
    await queue.whenIdle();
    // Every idle active member has the group's brief; the running one has it pending.
    const goal = (await json(host.creativeSlug)).brief.goal;
    // Restore and discard of B race: whichever ran last decides; a discarded variant is not propagated to.
    const g = (await json(host.creativeSlug)).variantGroup!;
    for (const m of g.members.filter((x) => x.status === 'active' && x.letter !== 'c')) expect((await json(m.slug)).brief.goal).toBe(goal);
    // Minor (Task 2): not only the goal. B's discard and restore race (whichever ran last decides), but nothing else changed: only B
    // can be discarded, no ★ was set, and the last writer's goal is one of the two that were saved.
    expect(['Uno', 'Due']).toContain(goal);
    expect(['active', 'discarded']).toContain(g.members.find((x) => x.letter === 'b')!.status);
    expect(g.members.filter((x) => x.status === 'discarded').every((x) => x.letter === 'b')).toBe(true);
    expect(g.picks).toEqual({});
    // The stopped one took it when its job ended (Important 1 of fix round 1).
    await vi.waitFor(async () => expect((await json(sis('c'))).brief.goal).toBe(goal));
    expect(await side.pendingBrief(projectDir, sis('c'))).toBeNull();
  });
});

describe('baseFrom (decisions log 263)', { timeout: 90_000 }, () => {
  it('the new sister\'s v1 is the base version\'s compositions, and its next agent turn builds on it', async () => {
    turns = makeTurns({ contract: 'compositions', claude: true });
    svc = new VariantGroupService({ store, turns });
    process.env.FAKE_CLAUDE_SCENARIO = 'composition';
    const promptFile = join(base, 'prompts.jsonl');
    process.env.FAKE_CLAUDE_PROMPT_FILE = promptFile;
    try {
      const job = await turns.start(host);
      await queue.whenIdle();
      expect(stateOf(job.id)).toBe('succeeded');
      const [a1] = await store.readVersions(host.creativeSlug);
      expect(a1!.compositions!.length).toBeGreaterThan(0);
      await svc.addVariants(host, [{ direction: 'Notturna', baseFrom: { slug: host.creativeSlug, version: 1 } }]);
      const [b1] = await store.readVersions(sis('b'));
      expect(b1).toMatchObject({ n: 1, origin: 'editor', basedOn: null, request: t().jobs.variantSeedRequest({ letter: 'A', n: 1 }) });
      expect(b1!.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(b1!.compositions!.map((c) => [c.format, c.hash])).toEqual(a1!.compositions!.map((c) => [c.format, c.hash]));
      // The agent's workspace holds the copies, as after an editor save.
      for (const c of b1!.compositions!.filter((x) => x.followsFormat === undefined)) {
        expect(existsSync(join(projectDir, 'creatives', sis('b'), 'work', 'editor', c.format, 'composition.json'))).toBe(true);
      }
      // The sister's next turn: "v1 contains direct edits by the user … Build on v1".
      await turns.start(refOf(sis('b')), { text: 'più notturna', pins: [] });
      await queue.whenIdle();
      const prompts = (await readFile(promptFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { prompt: string });
      expect(prompts.at(-1)!.prompt).toContain('v1 contains direct edits by the user');
      expect(prompts.at(-1)!.prompt).toContain('Build on v1');
      // A base that is not an active member, or a version that does not exist, is refused with nothing left behind.
      await expect(svc.addVariants(host, [{ baseFrom: { slug: 'altro', version: 1 } }])).rejects.toMatchObject({ status: 422, apiCode: 'variant-base-invalid' });
      await expect(svc.addVariants(host, [{ baseFrom: { slug: host.creativeSlug, version: 7 } }])).rejects.toMatchObject({ status: 422, apiCode: 'variant-base-invalid' });
      expect(existsSync(join(projectDir, 'creatives', sis('c')))).toBe(false);
      expect((await json(host.creativeSlug)).variantGroup!.members).toHaveLength(2);
    } finally { delete process.env.FAKE_CLAUDE_PROMPT_FILE; }
  });
});

describe('minors (Task 2): a failed add leaves nothing behind, in git too', { timeout: 90_000 }, () => {
  it('the group write failing after a seeded sister was committed: the deletion is committed, the tree is clean', async () => {
    turns = makeTurns({ contract: 'compositions', claude: true });
    svc = new VariantGroupService({ store, turns });
    process.env.FAKE_CLAUDE_SCENARIO = 'composition';
    await turns.start(host);
    await queue.whenIdle();
    const real = store.update.bind(store);
    vi.spyOn(store, 'update').mockImplementation(async (slug, patch) => {
      if ('variantGroup' in patch) throw new Error('disk full');
      return real(slug, patch);
    });
    await expect(svc.addVariants(host, [{ baseFrom: { slug: host.creativeSlug, version: 1 } }])).rejects.toThrow('disk full');
    vi.restoreAllMocks();
    expect(existsSync(join(projectDir, 'creatives', sis('b')))).toBe(false);
    // Neither an uncommitted deletion nor the sister's files left in HEAD.
    expect(execFileSync('git', ['status', '--porcelain', '--', `creatives/${sis('b')}`], { cwd: projectDir, encoding: 'utf8' })).toBe('');
    expect(execFileSync('git', ['ls-files', '--', `creatives/${sis('b')}`], { cwd: projectDir, encoding: 'utf8' })).toBe('');
  });

  it('the seed failing after it committed the sister (appendVersion throws): the removal is committed, the tree is clean', async () => {
    turns = makeTurns({ contract: 'compositions', claude: true });
    svc = new VariantGroupService({ store, turns });
    process.env.FAKE_CLAUDE_SCENARIO = 'composition';
    await turns.start(host);
    await queue.whenIdle();
    vi.spyOn(store, 'appendVersion').mockRejectedValueOnce(new Error('disk full'));
    await expect(svc.addVariants(host, [{ baseFrom: { slug: host.creativeSlug, version: 1 } }])).rejects.toThrow('disk full');
    vi.restoreAllMocks();
    expect(existsSync(join(projectDir, 'creatives', sis('b')))).toBe(false);
    expect(execFileSync('git', ['status', '--porcelain', '--', `creatives/${sis('b')}`], { cwd: projectDir, encoding: 'utf8' })).toBe('');
    expect(execFileSync('git', ['ls-files', '--', `creatives/${sis('b')}`], { cwd: projectDir, encoding: 'utf8' })).toBe('');
  });

  it('a sister added while the host\'s brief is pending starts from the pending brief: its links match its formats', async () => {
    await svc.addVariants(host, [{}]);
    // The host works (its next brief is pending): a link B->A exists for the format the pending brief removes.
    const links = { 'web-banner-300x250': 'instagram-post-1x1' };
    await store.update(host.creativeSlug, { brief: { ...brief, links } });
    await turns.start(host);
    await runner.next(0);
    await turns.updateBrief(host, { brief: { ...brief, goal: 'Nuovo', formats: ['instagram-post-1x1'] } });
    expect((await side.pendingBrief(projectDir, host.creativeSlug))?.brief.formats).toEqual(['instagram-post-1x1']);
    await svc.addVariants(host, [{}]);
    const c = await json(sis('c'));
    expect(c.brief.formats).toEqual(['instagram-post-1x1']);
    expect(c.brief.goal).toBe('Nuovo');
    expect(c.brief.links ?? {}).toEqual({});
  });
});

describe('minor (Task 2): the requested formats are checked again once the pending brief is applied', { timeout: 60_000 }, () => {
  it('a queued request for a format the group\'s newer brief removes fails; it does not widen to every format', async () => {
    await svc.addVariants(host, [{}]);
    const B = refOf(sis('b'));
    await fakeVersion(sis('b'), 1, OLD);
    // A runs (the only slot); B's request for the banner waits behind it.
    await turns.start(host);
    const runA = await runner.next(0);
    const jobB = await turns.start(B, { text: 'solo il banner', pins: [] }, { formats: ['web-banner-300x250'] });
    expect(stateOf(jobB.id)).toBe('queued');
    // The group's brief drops the banner meanwhile: B is waiting, so it keeps it pending until its turn.
    await turns.updateBrief(host, { brief: { ...brief, formats: NEW } });
    expect((await side.pendingBrief(projectDir, B.creativeSlug))?.brief.formats).toEqual(NEW);
    runA.finish();
    await vi.waitFor(() => expect(stateOf(jobB.id)).toBe('failed'), { timeout: 10_000 });
    expect(runner.runs).toHaveLength(1);
  });
});

describe('ruling R2: the one "real sister" check and its users', { timeout: 60_000 }, () => {
  it('isRealSister: host present, listing the slug tied to its letter; never a plain x~b, a link or a hand-edited group', async () => {
    await svc.addVariants(host, [{}]);
    expect(await isRealSister(projectDir, sis('b'))).toBe(true);
    expect(isRealSisterSync(projectDir, sis('b'))).toBe(true);
    expect(await isRealSister(projectDir, sis('c'))).toBe(false); // not a member
    // A hand-made x~b with no group: not a creative anywhere.
    const plain = (await store.create({ title: 'Solo', brief })).slug;
    await mkdir(join(projectDir, 'creatives', `${plain}~b`, 'work'), { recursive: true });
    await writeFile(join(projectDir, 'creatives', `${plain}~b`, 'creative.json'), JSON.stringify({ ...(await json(plain)) }));
    expect(await isRealSister(projectDir, `${plain}~b`)).toBe(false);
    expect(await creativeKind(projectDir, `${plain}~b`)).toBe('none');
    await expect(store.assertOpenable(`${plain}~b`)).rejects.toMatchObject({ status: 404 });
    expect((await store.list()).some((i) => i.slug === `${plain}~b`)).toBe(false);
    // A group whose member slug is not its letter's makes no sister real.
    const g = (await json(host.creativeSlug)).variantGroup!;
    await store.update(host.creativeSlug, { variantGroup: { ...g, members: [g.members[0]!, { ...g.members[1]!, letter: 'c' }] } });
    expect(await isRealSister(projectDir, sis('b'))).toBe(false);
    expect(isRealSisterSync(projectDir, sis('b'))).toBe(false);
    await store.update(host.creativeSlug, { variantGroup: g });
    // A host reached through a link is not one.
    const linked = `${host.creativeSlug}-link`;
    await symlink(join(projectDir, 'creatives', host.creativeSlug), join(projectDir, 'creatives', linked));
    expect(await isRealSister(projectDir, `${linked}~b`)).toBe(false);
    // Approvals: the work folder of a real sister only.
    expect(explainContext({ projectDir, creativeSlug: sis('b') }).workDir).toBe(join(projectDir, 'creatives', sis('b'), 'work'));
    expect(explainContext({ projectDir, creativeSlug: `${plain}~b` }).workDir).toBeUndefined();
    // The brand source of "Use as brand logo" from a sister.
    expect(CREATIVE_SOURCE_RE.test(`creative:${sis('b')}/v2`)).toBe(true);
    expect(CREATIVE_SOURCE_RE.test(`creative:${host.creativeSlug}~aa/v2`)).toBe(true); // any id (decision 978)
    expect(CREATIVE_SOURCE_RE.test(`creative:${host.creativeSlug}~a/v2`)).toBe(false);
    expect(CREATIVE_SOURCE_RE.test(`creative:${host.creativeSlug}~abcd/v2`)).toBe(false);
  });

  it('list collapses real sisters into the host row; sweeps clean real sisters only; the rename journal and brief assets include them', async () => {
    await svc.addVariants(host, [{}, {}]);
    await svc.discard(host, 'c');
    const list = await store.list();
    expect(list.map((i) => i.slug)).toEqual([host.creativeSlug]);
    expect(list[0]).toMatchObject({ variants: { count: 3, active: 2, missing: [] } });
    expect((await store.listAll()).map((i) => i.slug).sort()).toEqual([host.creativeSlug, sis('b'), sis('c')].sort());
    // A plain x~b with old temp files and caches: never swept; the real sister's are.
    const fake = 'nessuno~b';
    const old = new Date(Date.now() - 3600_000 * 24 * 60);
    for (const slug of [sis('b'), fake]) {
      await mkdir(join(projectDir, 'creatives', slug), { recursive: true });
      const tmp = join(projectDir, 'creatives', slug, 'creative.json.0123456789ab.tmp');
      await writeFile(tmp, '{}');
      await utimes(tmp, old, old);
      const cache = join(projectDir, '.studio', 'cache', 'pin-frames', slug, 'v1');
      await mkdir(cache, { recursive: true });
      await writeFile(join(cache, 'f.jpg'), 'x');
      await utimes(join(cache, 'f.jpg'), old, old);
      await utimes(cache, old, old);
    }
    const swept = await sweepProjectRenders(projectDir, { minAgeMs: 1000 });
    expect(swept.some((p) => p.includes(`${sis('b')}/creative.json.`))).toBe(true);
    expect(swept.some((p) => p.includes(fake))).toBe(false);
    const cleared = await sweepDerivedCaches(projectDir, { caches: [{ name: 'pin-frames', maxBytes: 1e12 }], maxAgeMs: 1000, graceMs: 1000 });
    expect(cleared.some((p) => p.includes(sis('b')))).toBe(true);
    expect(cleared.some((p) => p.includes(fake))).toBe(false);
    // Asset rename: the sisters' briefs follow, a fake x~b's does not.
    await writeFile(join(projectDir, 'creatives', fake, 'creative.json'), JSON.stringify(await json(sis('b'))));
    expect((await store.briefSlugsUsing('assets/logo.png')).sort()).toEqual([host.creativeSlug, sis('b'), sis('c')].sort());
    await store.renameBriefAsset('assets/logo.png', 'assets/marchio.png');
    expect((await json(sis('c'))).brief.assets).toEqual(['assets/marchio.png']);
    expect((await json(fake)).brief.assets).toEqual(['assets/logo.png']);
    expect(renameJournalSchema.safeParse({ schemaVersion: 1, from: 'assets/a.png', to: 'assets/b.png', startedAt: new Date().toISOString(), brandRefs: false, briefSlugs: [sis('b')] }).success).toBe(true);
    expect(renameJournalSchema.safeParse({ schemaVersion: 1, from: 'assets/a.png', to: 'assets/b.png', startedAt: new Date().toISOString(), brandRefs: false, briefSlugs: ['x~a'] }).success).toBe(false);
  });

  it('recovery at startup reaches the sisters (listAll): a sister left working is marked interrupted', async () => {
    await svc.addVariants(host, [{}]);
    await store.update(sis('b'), { status: 'working' });
    expect(await store.recoverInterrupted()).toEqual([sis('b')]);
    expect((await json(sis('b'))).status).toBe('interrupted');
  });
});

describe('fix round 1', { timeout: 120_000 }, () => {
  it('Critical 1: with A discarded the host still carries the group\'s brief; edits never undo each other; restoring A matches', async () => {
    await svc.addVariants(host, [{}, {}]);
    await fakeVersion(host.creativeSlug, 1, OLD, 'a');
    await fakeVersion(sis('b'), 1, OLD, 'b');
    await svc.setPick(host, 'web-banner-300x250', { slug: sis('b'), version: 1 });
    await svc.discard(host, 'a');
    await turns.updateBrief(refOf(sis('b')), { brief: { ...brief, goal: 'Due' } });
    await turns.updateBrief(refOf(sis('c')), { services: { voice: 'none' } });
    await turns.updateBrief(host, { formats: ['instagram-post-1x1'] });
    const want = { ...withoutLinks(brief), goal: 'Due', services: { voice: 'none' }, formats: ['instagram-post-1x1'] };
    for (const s of [host.creativeSlug, sis('b'), sis('c')]) expect(withoutLinks((await json(s)).brief)).toEqual(want);
    expect((await json(host.creativeSlug)).variantGroup!.picks).toEqual({});
    expect(Object.keys(await svc.groupSelection(host))).toEqual(['instagram-post-1x1']);
    await expect(svc.setPick(host, 'web-banner-300x250', { slug: sis('b'), version: 1 })).rejects.toMatchObject({ status: 422 });
    await svc.restore(host, 'a');
    expect(withoutLinks((await json(host.creativeSlug)).brief)).toEqual(withoutLinks((await json(sis('b'))).brief));
  });

  it('Important 1: a variant\'s pending brief applies when any job of its key ends (not only a turn)', async () => {
    await svc.addVariants(host, [{}]);
    const B = refOf(sis('b'));
    // A job of B's key that is not a creative turn (a translation uses the same key).
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const job = queue.enqueue({ id: 'loc-1', key: `creative:${B.root}:${B.projectSlug}:${B.creativeSlug}`, kind: 'localize', label: 'x', run: async () => { await gate; } });
    await turns.updateBrief(host, { brief: { ...brief, locales: { primary: 'it', extra: ['en'] } } });
    expect((await json(B.creativeSlug)).brief.locales).toBeUndefined();
    release();
    const settled = await queue.whenSettled(job.id);
    await turns.otherJobEndedByKey(job.key, settled!.state); // what the server's job hook calls for a translation
    expect((await json(B.creativeSlug)).brief.locales).toEqual({ primary: 'it', extra: ['en'] });
    expect(await side.pendingBrief(projectDir, B.creativeSlug)).toBeNull();
  });

  it('Important 2: "Duplica formato" in a group adds the same instance to every active variant, from A and from a sister', async () => {
    turns = makeTurns({ contract: 'compositions', claude: true });
    svc = new VariantGroupService({ store, turns });
    const edits = new DirectEditService({ turns, queue, git: new Git(), presets: async () => DEFAULT_FORMATS });
    process.env.FAKE_CLAUDE_SCENARIO = 'composition';
    await turns.start(host);
    await queue.whenIdle();
    await svc.addVariants(host, [{ baseFrom: { slug: host.creativeSlug, version: 1 } }, {}]);
    await svc.discard(host, 'c');
    const fromA = await edits.duplicate(host, 1, { instanceId: 'instagram-post-1x1', label: 'Promo' }, 'it');
    expect(fromA.instanceId).toBe('instagram-post-1x1@2');
    for (const s of [host.creativeSlug, sis('b')]) {
      expect((await json(s)).brief).toMatchObject({ formats: ['instagram-post-1x1', 'instagram-post-1x1@2', 'web-banner-300x250'], formatLabels: { 'instagram-post-1x1@2': 'Promo' } });
    }
    expect((await json(sis('c'))).brief.formats).toEqual(OLD); // discarded: at its restore
    // From the sister: the id is allocated over every member's ids (@3, never a second @2).
    const fromB = await edits.duplicate(refOf(sis('b')), 1, { instanceId: 'instagram-post-1x1' }, 'it');
    expect(fromB.instanceId).toBe('instagram-post-1x1@3');
    for (const s of [host.creativeSlug, sis('b')]) expect((await json(s)).brief.formats).toEqual(['instagram-post-1x1', 'instagram-post-1x1@3', 'instagram-post-1x1@2', 'web-banner-300x250']);
    expect((await store.readVersions(sis('b'))).at(-1)!.compositions!.some((c) => c.format === 'instagram-post-1x1@3')).toBe(true);
    await svc.restore(host, 'c');
    expect((await json(sis('c'))).brief.formats).toEqual((await json(host.creativeSlug)).brief.formats);
  });

  it('orphan sisters are accepted creatives (approvals, sweeps); a plain x~b without variantOf is not', async () => {
    await svc.addVariants(host, [{}]);
    await rm(join(projectDir, 'creatives', host.creativeSlug), { recursive: true });
    expect(await isAcceptedCreative(projectDir, sis('b'))).toBe(true);
    expect(explainContext({ projectDir, creativeSlug: sis('b') }).workDir).toBe(join(projectDir, 'creatives', sis('b'), 'work'));
    const fake = 'nessuno~b';
    await mkdir(join(projectDir, 'creatives', fake), { recursive: true });
    await writeFile(join(projectDir, 'creatives', fake, 'creative.json'), JSON.stringify({ ...(await json(sis('b'))), variantOf: undefined }));
    expect(await isAcceptedCreative(projectDir, fake)).toBe(false);
    expect(explainContext({ projectDir, creativeSlug: fake }).workDir).toBeUndefined();
    const old = new Date(Date.now() - 3600_000);
    for (const slug of [sis('b'), fake]) {
      const tmp = join(projectDir, 'creatives', slug, 'versions.json.0123456789ab.tmp');
      await writeFile(tmp, '{}');
      await utimes(tmp, old, old);
    }
    const swept = await sweepProjectRenders(projectDir, { minAgeMs: 1000 });
    expect(swept.some((p) => p.includes(`${sis('b')}/versions.json.`))).toBe(true);
    expect(swept.some((p) => p.includes(fake))).toBe(false);
  });
});

describe('final wave I2: a discarded variant is read-only for every write', { timeout: 120_000 }, () => {
  it('a brief save from a discarded B is refused (409 variant-discarded) and the group\'s brief is unchanged', async () => {
    await svc.addVariants(host, [{}, {}]);
    await svc.discard(host, 'b');
    await turns.updateBrief(host, { brief: { ...brief, goal: 'Nuovo' } });
    // B kept the old brief (not propagated to); its full-brief save would roll the group back.
    const stale = (await json(sis('b'))).brief;
    expect(stale.goal).toBe('Lancio app');
    await expect(turns.updateBrief(refOf(sis('b')), { brief: stale })).rejects.toMatchObject({ status: 409, apiCode: 'variant-discarded', message: t().errors.variantDiscardedTurn });
    await expect(turns.updateBrief(refOf(sis('b')), { title: 'Altro titolo' })).rejects.toMatchObject({ apiCode: 'variant-discarded' });
    for (const s of [host.creativeSlug, sis('c')]) {
      expect((await json(s)).brief.goal).toBe('Nuovo');
      expect((await json(s)).title).toBe('Lancio');
    }
    // Restored, it can be edited again (and it is at the group's brief first).
    await svc.restore(host, 'b');
    await turns.updateBrief(refOf(sis('b')), { title: 'Lancio 3' });
    expect((await json(host.creativeSlug)).title).toBe('Lancio 3');
  });

  it('a discarded A (the host) still edits the group\'s brief: it always carries it (decisions log 830), so nothing rolls back', async () => {
    await svc.addVariants(host, [{}]);
    await svc.discard(host, 'a');
    await turns.updateBrief(refOf(sis('b')), { brief: { ...brief, goal: 'Da B' } });
    expect((await json(host.creativeSlug)).brief.goal).toBe('Da B');
    await turns.updateBrief(host, { title: 'Da A' });
    expect((await json(sis('b'))).title).toBe('Da A');
    expect((await json(sis('b'))).brief.goal).toBe('Da B');
  });

  it('editor save, duplicate, links and "resume from" on a discarded variant are refused with the same reason', async () => {
    await svc.addVariants(host, [{}]);
    await svc.discard(host, 'b');
    const B = refOf(sis('b'));
    const edits = new DirectEditService({ turns, queue, git: new Git(), presets: async () => DEFAULT_FORMATS });
    const body = { baseVersion: 1, format: 'instagram-post-1x1', baseHash: 'a'.repeat(64), composition: {}, staged: [], ops: [], token: 'A'.repeat(43) };
    const refused = { status: 409, apiCode: 'variant-discarded' };
    await expect(edits.save(B, body, 'it')).rejects.toMatchObject(refused);
    await expect(edits.duplicate(B, 1, { instanceId: 'instagram-post-1x1' }, 'it')).rejects.toMatchObject(refused);
    await expect(turns.setLink(B, 'web-banner-300x250', 'instagram-post-1x1')).rejects.toMatchObject(refused);
    await expect(turns.restore(B, 1)).rejects.toMatchObject(refused);
    // Nothing reached the group: no instance was added anywhere.
    for (const s of [host.creativeSlug, sis('b')]) expect((await json(s)).brief.formats).toEqual(OLD);
  });

  it('deferred 51: a pending brief left by a crash is applied at startup recovery, under the member\'s lock', async () => {
    await svc.addVariants(host, [{}]);
    const target = { brief: { ...brief, goal: 'Lasciato in sospeso' }, title: 'Lancio', linkedCodebases: [], at: new Date().toISOString() };
    await side.setPendingBrief(projectDir, sis('b'), target);
    const ws = await WorkspaceStore.open(host.root, new Git());
    const applied: string[] = [];
    await recoverWorkspace(ws, () => false, { sideState: side, applyPendingBrief: async (ref) => { applied.push(ref.creativeSlug); await turns.briefAfterJob(ref); } });
    expect(applied).toEqual([sis('b')]);
    expect((await json(sis('b'))).brief.goal).toBe('Lasciato in sospeso');
    expect(await side.pendingBrief(projectDir, sis('b'))).toBeNull();
  });
});

describe('final wave M3: discard and start of the same variant never both win', { timeout: 60_000 }, () => {
  it('started and discarded at once: either the turn runs and the discard is refused (variant-running), or the discard wins and the start is refused', async () => {
    await svc.addVariants(host, [{}, {}]);
    for (const letter of ['b', 'c'] as const) {
      const ref = refOf(sis(letter));
      const [start, discard] = await Promise.allSettled([turns.start(ref), svc.discard(host, letter)]);
      const discarded = (await json(host.creativeSlug)).variantGroup!.members.find((m) => m.letter === letter)!.status === 'discarded';
      const running = turns.turnActive(ref);
      // Never a discarded variant with a turn of it queued or running.
      expect(discarded && running).toBe(false);
      if (start.status === 'fulfilled') expect(discard).toMatchObject({ status: 'rejected', reason: { apiCode: 'variant-running' } });
      else expect(start.reason).toMatchObject({ apiCode: 'variant-discarded' });
      for (const j of queue.list()) if (j.state === 'queued' || j.state === 'running') queue.cancel(j.id);
      await queue.whenIdle();
    }
  });
});

describe('final wave M7: one "mancante" rule for the list and the detail', { timeout: 60_000 }, () => {
  it('a sister whose creative.json is readable but names another host is missing in both', async () => {
    await svc.addVariants(host, [{}, {}]);
    const file = join(projectDir, 'creatives', sis('c'), 'creative.json');
    await writeFile(file, JSON.stringify({ ...(await json(sis('c'))), variantOf: 'someone-else' }));
    expect((await svc.resolve(host)).missing).toEqual([sis('c')]);
    const [row] = await store.list();
    expect(row).toMatchObject({ slug: host.creativeSlug, variants: { missing: ['c'] } });
  });
});
