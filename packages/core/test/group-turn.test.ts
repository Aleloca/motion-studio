// @vitest-environment node
/**
 * Phase 3 of the single agent (decisions 977–983, spec §3–§7): the group turn. A message to a variant group with one agent
 * runs its coordinator (a `creative-group` job in its own lane: read-only, no Bash), which answers, asks, or records one
 * instruction per variant; the core then runs each variant's own turn as a helper (two at a time), resumes the coordinator
 * for the closing message and writes the `group-turn` entry. The ask rule is enforced by the core too. Controlled runner
 * only (no `claude`), no provider.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { messages, type ConversationEntry, type JobSummary } from '@motion-studio/shared';
import { MCP_TOOLS } from '../src/agent/launcher.ts';
import { buildAgentPolicy } from '../src/agent/policy.ts';
import { GROUP_BLOCK } from '../src/creatives/coordinator-prompt.ts';
import { CreativeSideStateStore } from '../src/creatives/creative-side-state.ts';
import { recoverGroupTurns } from '../src/creatives/group-turn.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { cid } from './helpers/live-app.ts';
import type { ControlledRun } from './helpers/controlled-runner.ts';
import { variantApp, type VariantApp } from './helpers/variant-app.ts';

vi.setConfig({ testTimeout: 60_000 });

let v: VariantApp;
afterEach(async () => { await v?.close(); });

const isCoordinator = (r: ControlledRun) => r.req.prompt.includes(`\`\`\`${GROUP_BLOCK}`);
const coordinatorRuns = () => v.runner.runs.filter(isCoordinator);
async function coordinator(nth = 0): Promise<ControlledRun> {
  await vi.waitFor(() => expect(coordinatorRuns().length).toBeGreaterThan(nth), { timeout: 10_000 });
  return coordinatorRuns()[nth]!;
}
const send = (slug: string, text: string, pins: unknown[] = []) => v.app.inject({ method: 'POST', url: `${v.url(slug)}/turns`, payload: { text, pins } as object });
const conversation = async (slug: string) => (await v.app.inject(`${v.url(slug)}/conversation`)).json() as ConversationEntry[];
const groupJob = async () => (await v.jobs()).find((j) => j.kind === 'creative-group');
const pin = (variant: string, note: string) => ({ format: 'instagram-post-1x1', x: 0.5, y: 0.5, timeSec: null, note, variant });

async function setup(directions: Array<string | null> = ['Audace', 'Calma', 'Retro'], settings: Record<string, unknown> = {}) {
  v = await variantApp({ settings: { singleAgent: true, confirmPaidProviders: false, ...settings } });
  const slug = await v.group(directions);
  return slug;
}

describe('the coordinator\'s tools and permissions', () => {
  it('reads and asks only: no edit tool, no Bash, no paid tool, no project "Always" rules, with and without the sandbox', () => {
    expect(MCP_TOOLS['creative-group']).toEqual(expect.arrayContaining(['list_variants', 'work_on_variants', 'add_variants', 'set_pick', 'update_brief']));
    for (const paid of ['generate_image', 'tts', 'music', 'sound_effect', 'add_variant', 'add_format']) expect(MCP_TOOLS['creative-group']).not.toContain(paid);
    expect(MCP_TOOLS.creative).not.toContain('work_on_variants');
    for (const sandbox of [false, true]) {
      const p = buildAgentPolicy({
        kind: 'creative-group', sandbox, projectDir: '/w/p', home: '/h', configDir: '/c', codebases: [], protectedFiles: [], protectedDirs: [],
        extraDomains: [], projectAllowRules: ['Bash(ls:*)'], mcpTools: ['mcp__studio__work_on_variants'], autoApproveSandboxed: true,
      });
      for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash']) expect(p.disallowedTools, `${tool} sandbox=${sandbox}`).toContain(tool);
      expect(p.allowedTools).not.toContain('Bash(ls:*)');
      // Review minor 1: the reads it gets without asking are the project's only (anything else reaches the prompt, refused).
      expect(p.allowedTools.filter((x) => !x.startsWith('mcp__'))).toEqual(['Read(//w/p/**)', 'Glob(//w/p/**)', 'Grep(//w/p/**)']);
      expect(p.allowedTools).not.toContain('Read');
      if (sandbox) expect((p.settings as { sandbox: { autoAllowBashIfSandboxed: boolean; network?: unknown } }).sandbox).toMatchObject({ autoAllowBashIfSandboxed: false });
      if (sandbox) expect((p.settings as { sandbox: { network?: unknown } }).sandbox.network).toBeUndefined();
    }
  });
});

describe('the group turn', () => {
  it('a message with no target: the core refuses to guess, the coordinator asks, then B\'s helper works and the coordinator closes', async () => {
    const slug = await setup();
    const res = await send(`${slug}~c`, 'Rendi il titolo più grande');
    expect(res.statusCode, res.body).toBe(202);
    const job = res.json() as JobSummary;
    expect(job).toMatchObject({ kind: 'creative-group', label: messages('it').jobs.groupLabel({ title: 'Lancio' }) });
    const c = await coordinator();
    // The coordinator runs on the host, read-only; it is told the ask rule, never which page the message came from.
    expect(c.req.disallowedTools).toEqual(expect.arrayContaining(['Edit', 'Write', 'Bash']));
    expect(c.req.prompt).toContain('Rendi il titolo più grande');
    expect(c.req.prompt).toContain('The message has no pinned comment.');
    expect(c.req.prompt).not.toMatch(/~c|variant C is open|on screen/);
    // The user's message is the group's: one entry, with no variant.
    const user = (await conversation(slug)).filter((e) => e.type === 'user');
    expect(user).toEqual([expect.objectContaining({ text: 'Rendi il titolo più grande', group: true, jobId: job.id })]);
    expect(user[0]!.variant).toBeUndefined();
    // Decision 979, the core's guard: no target, no answer yet.
    const refused = await v.bridge(c, 'work_on_variants', { items: [{ variant: 'b', instruction: 'Titolo più grande' }] });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatch(/ask the user which variant \(AskUserQuestion/);
    // The question goes to the user (a card of the group turn), the answer opens B.
    const asked = v.bridge(c, 'approve', { tool_name: 'AskUserQuestion', tool_use_id: 'toolu_q', input: { questions: [{ question: 'Su quale variante?', header: 'Variante', multiSelect: true, options: [{ label: 'A · Audace', description: '' }, { label: 'B · Calma', description: '' }, { label: 'Tutte', description: '' }] }] } });
    await vi.waitFor(async () => expect(await v.pending()).toHaveLength(1));
    const card = (await v.pending())[0]!;
    expect(card).toMatchObject({ kind: 'question', jobId: job.id, creativeSlug: slug });
    expect((await v.app.inject({ method: 'POST', url: `/api/approvals/${card.id}/answer`, payload: { answers: [{ selected: [1] }] } })).statusCode).toBe(200);
    expect((await asked).json()).toMatchObject({ behavior: 'allow' });
    const ok = await v.bridge(c, 'work_on_variants', { items: [{ variant: 'b', instruction: 'Ingrandisci il titolo del 20%' }] });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, plan: [{ variant: 'b', firstGeneration: false }] });
    // Only A is refused still: one answer opens what it named.
    expect((await v.bridge(c, 'work_on_variants', { items: [{ variant: 'a', instruction: 'x' }] })).statusCode).toBe(409);
    c.emit({ kind: 'text', text: 'Lavoro su B.' });
    c.emit({ kind: 'usage', live: false, tokens: { input: 10, output: 100, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.01 });
    c.finish({ write: false });
    // B's helper: today's creative turn of B, linked to the group turn, with the instruction and the user's words quoted.
    const b = await v.runOf(`${slug}~b`);
    expect(b.req.prompt).toContain('Ingrandisci il titolo del 20%');
    expect(b.req.prompt).toContain('## Working for the agent the user talks to');
    expect(b.req.prompt).toContain('Rendi il titolo più grande');
    const helper = (await v.jobs()).find((j) => j.kind === 'creative' && j.key.endsWith(`${slug}~b`))!;
    expect(helper).toMatchObject({ parentJobId: job.id, variant: 'b' });
    expect(await groupJob()).toMatchObject({ state: 'running', groupPhase: 'helpers' });
    // A helper may not do the coordinator's group actions.
    const add = await v.bridge(b, 'add_variant', { direction: 'Notturna' });
    expect(add.statusCode).toBe(409);
    expect(add.json().error).toBe(messages('it').agentActions.helperGroupAction);
    b.emit({ kind: 'usage', live: false, tokens: { input: 10, output: 100, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.01 });
    b.finish();
    // The report run: the same session, resumed, with B's outcome.
    const report = await coordinator(1);
    expect(report.req.resumeSessionId).toBe(c.sessionId);
    expect(report.req.forkSession).toBe(false);
    expect(report.req.prompt).toMatch(/- B: saved v1 \(complete\)/);
    report.emit({ kind: 'text', text: 'Fatto: B ora ha il titolo più grande (v1).' });
    report.emit({ kind: 'usage', live: false, tokens: { input: 10, output: 100, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.01 });
    report.finish({ write: false });
    await v.waitIdle();
    expect(await groupJob()).toMatchObject({ state: 'succeeded' });
    const conv = await conversation(slug);
    const end = conv.find((e) => e.type === 'group-turn');
    expect(end).toMatchObject({ jobId: job.id, group: true, outcome: [{ variant: 'b', jobId: helper.id, version: 1, kept: false, status: 'complete', instruction: 'Ingrandisci il titolo del 20%' }] });
    // The turn's usage sums its runs': the coordinator's two and the helper's (one ledger line each).
    const ledger = (await import('node:fs/promises')).readFile(`${v.projectDir}/.studio/usage.jsonl`, 'utf8');
    const lines = (await ledger).trim().split('\n').map((l) => JSON.parse(l) as { jobId: string; costUsd: number | null });
    const mine = lines.filter((l) => l.jobId === job.id || l.jobId === helper.id);
    expect(mine.filter((l) => l.jobId === job.id)).toHaveLength(2);
    expect(mine.filter((l) => l.jobId === helper.id)).toHaveLength(1);
    expect(end && end.type === 'group-turn' ? end.usage?.costUsd : null).toBeCloseTo(mine.reduce((n, l) => n + (l.costUsd ?? 0), 0), 6);
    // B's steps carry the group turn (folded under it in the chat); the helper wrote no user entry of its own.
    expect(conv.filter((e) => e.groupJobId === job.id && e.variant === 'b').length).toBeGreaterThan(2);
    expect(conv.filter((e) => e.type === 'user')).toHaveLength(1);
    // The coordinator's entries are the group's.
    expect(conv.filter((e) => e.type === 'agent' && e.jobId === job.id).every((e) => e.group && e.variant === undefined)).toBe(true);
  });

  it('pinned comments and named variants are targets; others are refused', async () => {
    const slug = await setup();
    await send(slug, 'Sistema questi', [pin('c', 'logo più piccolo')]);
    const c = await coordinator();
    expect(c.req.prompt).toContain('[C] instagram-post-1x1');
    expect(c.req.prompt).toContain('The comments point to the variants C.');
    expect((await v.bridge(c, 'work_on_variants', { items: [{ variant: 'c', instruction: 'Logo più piccolo' }, { variant: 'b', instruction: 'x' }] })).statusCode).toBe(409);
    expect((await v.bridge(c, 'work_on_variants', { items: [{ variant: 'c', instruction: 'Logo più piccolo' }] })).statusCode).toBe(200);
    c.finish({ write: false });
    const helper = await v.runOf(`${slug}~c`);
    // The helper gets its own variant's comments.
    expect(helper.req.prompt).toContain('logo più piccolo');
    helper.finish();
    (await coordinator(1)).finish({ write: false });
    await v.waitIdle();

    await send(slug, 'Nella variante B e in A più contrasto');
    const c2 = await coordinator(2);
    expect((await v.bridge(c2, 'work_on_variants', { items: [{ variant: 'a', instruction: 'Contrasto' }, { variant: 'b', instruction: 'Contrasto' }] })).statusCode).toBe(200);
    expect((await v.bridge(c2, 'work_on_variants', { items: [{ variant: 'c', instruction: 'x' }] })).statusCode).toBe(409);
    c2.finish({ write: false });
    // Two helpers at once at most (the group's slot); here two.
    const [ha, hb] = [await v.runOf(slug), await v.runOf(`${slug}~b`)];
    ha.finish(); hb.finish();
    const r2 = await coordinator(3);
    expect(r2.req.prompt).toMatch(/- A: saved v1 \(complete\)/);
    expect(r2.req.prompt).toMatch(/- B: saved v1 \(complete\)/);
    r2.finish({ write: false });
    await v.waitIdle();
  });

  it('a question that needs no work: the coordinator answers, no helper runs, no group-turn entry', async () => {
    const slug = await setup();
    await send(slug, 'Quanti formati ha la C?');
    const c = await coordinator();
    c.emit({ kind: 'text', text: 'La C ha due formati.' });
    c.finish({ write: false });
    await v.waitIdle();
    expect(v.runner.runs.filter((r) => !isCoordinator(r))).toEqual([]);
    expect(await groupJob()).toMatchObject({ state: 'succeeded' });
    const conv = await conversation(slug);
    expect(conv.some((e) => e.type === 'group-turn')).toBe(false);
    expect(conv.find((e) => e.type === 'agent' && e.event.kind === 'text')).toMatchObject({ group: true, event: { text: 'La C ha due formati.' } });
  });

  it('a new variant runs once: add_variants makes it and its first generation; a second add is refused', async () => {
    const slug = await setup(['Audace', 'Calma']);
    await send(slug, 'Crea una nuova variante notturna');
    const c = await coordinator();
    // A refused add (a copy of an existing direction, a base that does not exist) adds nothing and may be tried again.
    expect((await v.bridge(c, 'add_variants', { items: [{ direction: 'audace' }] })).statusCode).toBe(409);
    expect((await v.bridge(c, 'add_variants', { items: [{ direction: 'Notturna', baseFrom: { variant: 'b', version: 7 } }] })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await v.detail(slug)).creative.variantGroup!.members.map((m) => m.letter)).toEqual(['a', 'b']);
    const added = await v.bridge(c, 'add_variants', { items: [{ direction: 'Notturna e al neon' }] });
    expect(added.statusCode, added.body).toBe(200);
    expect(added.json()).toMatchObject({ ok: true, variants: ['c'] });
    const again = await v.bridge(c, 'add_variants', { items: [{ direction: 'Un\'altra ancora' }] });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatch(/already added C/);
    expect((await v.detail(slug)).creative.variantGroup!.members.map((m) => m.letter)).toEqual(['a', 'b', 'c']);
    c.finish({ write: false });
    const first = await v.runOf(`${slug}~c`);
    expect(first.req.prompt).toContain('Notturna e al neon');
    expect(first.req.prompt).toContain('Crea una nuova variante notturna');
    first.finish();
    (await coordinator(1)).finish({ write: false });
    await v.waitIdle();
    expect((await v.detail(slug)).creative.variantGroup!.members.map((m) => m.letter)).toEqual(['a', 'b', 'c']);
    expect((await conversation(slug)).find((e) => e.type === 'group-turn')).toMatchObject({ outcome: [{ variant: 'c', status: 'complete', version: 1 }] });
  });

  it('Stop on the group turn stops the coordinator\'s helpers; Stop on one helper stops that variant only', async () => {
    const slug = await setup(['Audace', 'Calma', 'Retro']);
    await send(slug, 'Tutte le varianti più luminose');
    const c = await coordinator();
    expect((await v.bridge(c, 'work_on_variants', { items: ['a', 'b', 'c'].map((x) => ({ variant: x, instruction: 'Più luce' })) })).statusCode).toBe(200);
    c.finish({ write: false });
    const [ha, hb] = [await v.runOf(slug), await v.runOf(`${slug}~b`)];
    // Two at a time: C waits for a slot.
    const helperC = async () => (await v.jobs()).find((j) => j.kind === 'creative' && j.key.endsWith(`${slug}~c`));
    await vi.waitFor(async () => expect(await helperC()).toMatchObject({ state: 'queued', waitReason: 'variant-slot' }));
    // Stop on B's own row: B only.
    const bJob = (await v.jobs()).find((j) => j.kind === 'creative' && j.key.endsWith(`${slug}~b`))!;
    await v.app.inject({ method: 'POST', url: `/api/jobs/${bJob.id}/stop` });
    await vi.waitFor(() => expect(hb.cancelled).toBe(true));
    const hc = await v.runOf(`${slug}~c`);
    // Stop on the group: A and C stop too; no report run.
    const g = (await groupJob())!;
    await v.app.inject({ method: 'POST', url: `/api/jobs/${g.id}/stop` });
    await v.waitIdle();
    expect([ha.cancelled, hc.cancelled]).toEqual([true, true]);
    expect(coordinatorRuns()).toHaveLength(1);
    expect(await groupJob()).toMatchObject({ state: 'cancelled' });
    const conv = await conversation(slug);
    expect(conv.find((e) => e.type === 'group-turn')).toMatchObject({ stopped: true, outcome: ['a', 'b', 'c'].map((x) => ({ variant: x, status: 'stopped' })) });
    expect(conv.at(-1)).toMatchObject({ type: 'system', group: true, text: messages('it').jobs.cancelledNote });
  });

  it('the next group turn resumes the coordinator\'s session and reads what happened since; a lost session starts over once', async () => {
    const slug = await setup();
    await send(slug, 'Ciao');
    const c1 = await coordinator();
    c1.finish({ write: false });
    await v.waitIdle();
    // A UI action that names its variant is not a group turn: B's own turn (decision 1145).
    const direct = await v.app.inject({ method: 'POST', url: `${v.url(`${slug}~b`)}/turns`, payload: {} });
    expect(direct.json()).toMatchObject({ kind: 'creative' });
    (await v.runOf(`${slug}~b`)).finish();
    await v.waitIdle();
    await send(slug, 'Com\'è venuta la B?');
    const c2 = await coordinator(1);
    expect(c2.req.resumeSessionId).toBe(c1.sessionId);
    expect(c2.req.prompt).toContain('## What happened since you last spoke');
    expect(c2.req.prompt).toContain('B: saved v1 (complete)');
    c2.finish({ write: false });
    await v.waitIdle();
    // The session is gone from Claude Code: one fresh run with the whole chat.
    v.runner.missingSessions.add(c1.sessionId);
    await send(slug, 'E la A?');
    const lost = await coordinator(2);
    expect(lost.req.resumeSessionId).toBe(c1.sessionId);
    const fresh = await coordinator(3);
    expect(fresh.req.resumeSessionId).toBeUndefined();
    expect(fresh.req.prompt).toContain('## The conversation so far');
    expect(fresh.req.prompt).toContain('User (to the group): Ciao');
    fresh.finish({ write: false });
    await v.waitIdle();
    expect(await groupJob()).toMatchObject({ state: 'succeeded' });
  });

  it('a message while the group turn works joins the group\'s queue and starts after it; the queue is the group\'s on every member', async () => {
    const slug = await setup();
    await send(slug, 'Primo');
    const c = await coordinator();
    const m = await v.app.inject({ method: 'POST', url: `${v.url(`${slug}~b`)}/messages`, payload: { clientId: cid(), text: 'Secondo', mode: 'live' } });
    expect(m.statusCode, m.body).toBe(200);
    expect(m.json().outcome).toMatch(/^queued/);
    for (const s of [slug, `${slug}~b`, `${slug}~c`]) expect((await v.detail(s)).creative.queued?.map((q) => q.text), s).toEqual(['Secondo']);
    c.finish({ write: false });
    const c2 = await coordinator(1);
    expect(c2.req.prompt).toContain('Secondo');
    c2.finish({ write: false });
    await v.waitIdle();
    expect((await v.detail(slug)).creative.queued ?? []).toEqual([]);
  });

  it('with live input, a message goes to the running coordinator (and opens what it names); while helpers work, to the helpers its comments target', async () => {
    v = await variantApp({ settings: { singleAgent: true, confirmPaidProviders: false }, claudeVersion: '2.1.301' });
    const slug = await v.group(['Audace', 'Calma', 'Retro']);
    await send(slug, 'Più contrasto');
    const c = await coordinator();
    await vi.waitFor(() => expect(c.req.capabilities?.liveInput).toBe(true));
    const live = await v.app.inject({ method: 'POST', url: `${v.url(slug)}/messages`, payload: { clientId: cid(), text: 'nella variante C', mode: 'live' } });
    expect(live.json().outcome, live.body).toBe('delivered-pending');
    expect(c.sent.map((m) => m.text)).toEqual(['nella variante C']);
    // Its words are a target now.
    expect((await v.bridge(c, 'work_on_variants', { items: [{ variant: 'c', instruction: 'Più contrasto' }] })).statusCode).toBe(200);
    c.finish({ write: false });
    const hc = await v.runOf(`${slug}~c`);
    await vi.waitFor(() => expect(hc.req.capabilities?.liveInput).toBe(true));
    // A comment on the working variant goes to its helper; one on another variant waits for the next group turn.
    const toC = await v.app.inject({ method: 'POST', url: `${v.url(`${slug}~c`)}/messages`, payload: { clientId: cid(), text: 'anche il logo', pins: [pin('c', 'qui')], mode: 'live' } });
    expect(toC.json().outcome, toC.body).toBe('delivered-pending');
    expect(hc.sent).toHaveLength(1);
    const toB = await v.app.inject({ method: 'POST', url: `${v.url(slug)}/messages`, payload: { clientId: cid(), text: 'e la B', pins: [pin('b', 'qui')], mode: 'live' } });
    expect(toB.json().outcome).toMatch(/^queued/);
    expect((await v.detail(slug)).creative.queued?.map((q) => q.text)).toEqual(['e la B']);
    hc.finish();
    (await coordinator(1)).finish({ write: false });
    // The queued request is the next group turn, with B's comment.
    const next = await coordinator(2);
    expect(next.req.prompt).toContain('The comments point to the variants B.');
    next.finish({ write: false });
    await v.waitIdle();
  });

  it('review M1: a message whose comments target two working helpers that cannot take it live is queued once, with both variants\' comments', async () => {
    const slug = await setup();
    await send(slug, 'Varianti B e C più luminose');
    const c = await coordinator();
    expect((await v.bridge(c, 'work_on_variants', { items: [{ variant: 'b', instruction: 'luce' }, { variant: 'c', instruction: 'luce' }] })).statusCode).toBe(200);
    c.finish({ write: false });
    const [hb, hc] = [await v.runOf(`${slug}~b`), await v.runOf(`${slug}~c`)];
    const m = await v.app.inject({ method: 'POST', url: `${v.url(slug)}/messages`, payload: { clientId: cid(), text: 'anche qui', pins: [pin('b', 'nota B'), pin('c', 'nota C')], mode: 'live' } });
    expect(m.json().outcome).toMatch(/^queued/);
    const q = (await v.detail(slug)).creative.queued ?? [];
    expect(q).toHaveLength(1);
    expect(q[0]!.pins.map((p) => p.note).sort()).toEqual(['nota B', 'nota C']);
    expect([...(q[0]!.variants ?? [])].sort()).toEqual(['b', 'c']);
    hb.finish(); hc.finish();
    (await coordinator(1)).finish({ write: false });
    const next = await coordinator(2);
    expect(next.req.prompt).toContain('The comments point to the variants B, C.');
    next.finish({ write: false });
    await v.waitIdle();
  });

  it('review M2: a redirect after add_variants keeps the new variant\'s first generation and tells the coordinator what this turn already added', async () => {
    const slug = await setup(['Audace', 'Calma']);
    const job = (await send(slug, 'Crea una nuova variante notturna')).json() as JobSummary;
    const c = await coordinator();
    expect((await v.bridge(c, 'add_variants', { items: [{ direction: 'Notturna al neon' }] })).statusCode).toBe(200);
    expect((await v.bridge(c, 'work_on_variants', { items: [{ variant: 'c', instruction: 'Più neon' }] })).statusCode).toBe(200);
    const r = await v.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/redirect`, payload: { clientId: cid(), text: 'anzi, falla al tramonto' } });
    expect(r.json().outcome).toBe('restarted');
    const c2 = await coordinator(1);
    expect(c2.req.resumeSessionId).toBe(c.sessionId);
    // The redirect prompt has the variants (C among them), says C was added in this turn, and is a coordinator prompt.
    expect(c2.req.prompt).toContain('- C · "Notturna al neon"');
    expect(c2.req.prompt).toMatch(/This turn already added the variants C/);
    expect(c2.req.prompt).toContain('anzi, falla al tramonto');
    // A second add is still refused ("runs once"): the variant made before the redirect is the one.
    expect((await v.bridge(c2, 'add_variants', { items: [{ direction: 'Tramonto caldo' }] })).statusCode).toBe(409);
    c2.finish({ write: false });
    // C's first generation still runs (its instruction given before the redirect is dropped: it was the old words).
    const first = await v.runOf(`${slug}~c`);
    expect(first.req.prompt).not.toContain('Più neon');
    first.finish();
    (await coordinator(2)).finish({ write: false });
    await v.waitIdle();
    expect((await v.detail(`${slug}~c`)).versions).toHaveLength(1);
  });

  it('review M3: variants are added only when the user asked for new ones, and no more than they asked; a discard needs the user to point to the variant', async () => {
    const slug = await setup(['Audace', 'Calma']);
    await send(slug, 'Ciao, come va?');
    const c = await coordinator();
    const added = await v.bridge(c, 'add_variants', { items: ['Uno al neon', 'Due pastello', 'Tre vintage'].map((direction) => ({ direction })) });
    expect(added.statusCode).toBe(409);
    expect(added.json().error).toMatch(/did not ask for new variants/);
    const discard = await v.bridge(c, 'discard_variant', { variant: 'b' });
    expect(discard.statusCode).toBe(409);
    c.finish({ write: false });
    await v.waitIdle();
    expect((await v.detail(slug)).creative.variantGroup!.members.map((m) => [m.letter, m.status])).toEqual([['a', 'active'], ['b', 'active']]);
    expect(v.runner.runs.filter((r) => !isCoordinator(r))).toEqual([]);

    await send(slug, 'Crea due nuove varianti e scarta la B');
    const c2 = await coordinator(1);
    const tooMany = await v.bridge(c2, 'add_variants', { items: ['Uno al neon', 'Due pastello', 'Tre vintage'].map((direction) => ({ direction })) });
    expect(tooMany.statusCode).toBe(409);
    expect(tooMany.json().error).toMatch(/at most 2/);
    expect((await v.bridge(c2, 'add_variants', { items: ['Uno al neon', 'Due pastello'].map((direction) => ({ direction })) })).statusCode).toBe(200);
    expect((await v.bridge(c2, 'discard_variant', { variant: 'b' })).statusCode).toBe(200);
    c2.finish({ write: false });
    for (const s2 of [`${slug}~c`, `${slug}~d`]) (await v.runOf(s2)).finish();
    (await coordinator(2)).finish({ write: false });
    await v.waitIdle();
  });

  it('review M3: a request for a new variant can come in the answer to the agent\'s question', async () => {
    const slug = await setup(['Audace', 'Calma']);
    await send(slug, 'Proviamo qualcosa di diverso');
    const c = await coordinator();
    const asked = v.bridge(c, 'approve', { tool_name: 'AskUserQuestion', tool_use_id: 'toolu_q', input: { questions: [{ question: 'Cosa preferisci?', header: 'Scelta', multiSelect: false, options: [{ label: 'Una nuova variante', description: '' }, { label: 'Cambiare la A', description: '' }] }] } });
    await vi.waitFor(async () => expect(await v.pending()).toHaveLength(1));
    await v.app.inject({ method: 'POST', url: `/api/approvals/${(await v.pending())[0]!.id}/answer`, payload: { answers: [{ selected: [0] }] } });
    await asked;
    expect((await v.bridge(c, 'add_variants', { items: [{ direction: 'Notturna' }] })).statusCode).toBe(200);
    c.finish({ write: false });
    (await v.runOf(`${slug}~c`)).finish();
    (await coordinator(1)).finish({ write: false });
    await v.waitIdle();
  });

  it('a request sent with "Tutte" is one group turn with every active variant as its target', async () => {
    const slug = await setup();
    const res = await v.app.inject({ method: 'POST', url: `${v.url(slug)}/variants/run`, payload: { targets: 'all-active', request: { text: 'Più luce' } } });
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json().groupJobId).toBeTruthy();
    const c = await coordinator();
    expect(c.req.prompt).toContain('The comments point to the variants A, B, C.');
    expect((await v.bridge(c, 'work_on_variants', { items: ['a', 'b', 'c'].map((x) => ({ variant: x, instruction: 'Più luce' })) })).statusCode).toBe(200);
    c.finish({ write: false });
    for (const s of [slug, `${slug}~b`]) (await v.runOf(s)).finish();
    (await v.runOf(`${slug}~c`)).finish();
    (await coordinator(1)).finish({ write: false });
    await v.waitIdle();
    expect(v.runner.runs.filter((r) => !isCoordinator(r))).toHaveLength(3);
  });

  it('a UI action that names its variant (`direct`, e.g. Retry) is the variant\'s own turn, not a group turn (decision 1145)', async () => {
    const slug = await setup();
    const res = await send(`${slug}~b`, 'Riprova questo');
    expect(res.json()).toMatchObject({ kind: 'creative-group' });
    (await coordinator()).finish({ write: false });
    await v.waitIdle();
    const direct = await v.app.inject({ method: 'POST', url: `${v.url(`${slug}~b`)}/turns`, payload: { text: 'Riprova questo', direct: true } });
    expect(direct.json()).toMatchObject({ kind: 'creative' });
    (await v.runOf(`${slug}~b`)).finish();
    await v.waitIdle();
    const run = await v.app.inject({ method: 'POST', url: `${v.url(slug)}/variants/run`, payload: { targets: ['c'], request: { text: 'Riprova', direct: true } } });
    expect(run.json().jobs.c).toBeTruthy();
    (await v.runOf(`${slug}~c`)).finish();
    await v.waitIdle();
    expect(coordinatorRuns()).toHaveLength(1);
  });

  it('with the setting off, a message goes to the variant\'s own turn as in phase 15', async () => {
    v = await variantApp({ settings: { singleAgent: false } });
    const slug = await v.group(['Audace', 'Calma']);
    const res = await send(`${slug}~b`, 'Ciao');
    expect(res.json()).toMatchObject({ kind: 'creative' });
    (await v.runOf(`${slug}~b`)).finish();
    await v.waitIdle();
    expect(coordinatorRuns()).toEqual([]);
  });
});

describe('the paid-services card on the plan (phase 4, decisions 1125, 1126, 1144)', () => {
  const KEYS = { OPENAI_API_KEY: 'sk-test-0123456789' };
  it('a plan of two variants shows ONE card for those variants before any helper starts; Decline runs them without paid services', async () => {
    v = await variantApp({ keys: KEYS, settings: { singleAgent: true, confirmPaidProviders: true } });
    const slug = await v.group(['Audace', 'Calma', 'Retro']);
    await send(slug, 'Varianti A e B con una nuova immagine di sfondo');
    const c = await coordinator();
    // A's work is on the banner only (an image format): its voice is not on the card (decision 1125); B's video post keeps it.
    expect((await v.bridge(c, 'work_on_variants', { items: [{ variant: 'a', instruction: 'Nuovo sfondo', formats: ['web-banner-300x250'] }, { variant: 'b', instruction: 'Nuovo sfondo' }] })).statusCode).toBe(200);
    c.finish({ write: false });
    await vi.waitFor(async () => expect(await v.pending()).toHaveLength(1));
    const card = (await v.pending())[0]!;
    const g = (await groupJob())!;
    // One card, the group turn's (its Stop takes it away), for the plan's variants only.
    expect(card).toMatchObject({ kind: 'paid-batch', jobId: g.id, creativeSlug: slug });
    expect([...new Set(card.paidBatch!.items!.map((i) => i.variant))].sort()).toEqual(['a', 'b']);
    expect(card.paidBatch!.items!.filter((i) => i.variant === 'a').map((i) => i.capability)).toEqual(['images']);
    expect(card.paidBatch!.items!.filter((i) => i.variant === 'b').map((i) => i.capability).sort()).toEqual(['images', 'voice']);
    expect(g.groupPhase).toBe('confirm');
    expect(v.runner.runs.filter((r) => !isCoordinator(r))).toEqual([]);
    expect((await v.app.inject({ method: 'POST', url: `/api/approvals/${card.id}`, payload: { decision: 'deny' } })).statusCode).toBe(200);
    const [ha, hb] = [await v.runOf(slug), await v.runOf(`${slug}~b`)];
    for (const h of [ha, hb]) expect(h.req.prompt).toMatch(/off for this run: the user declined paid services/);
    ha.finish(); hb.finish();
    (await coordinator(1)).finish({ write: false });
    await v.waitIdle();
    expect(await groupJob()).toMatchObject({ state: 'succeeded' });
  });

  it('approved: the helpers run under its cover; one work item: no card; Stop while it waits stops the turn', async () => {
    v = await variantApp({ keys: KEYS, settings: { singleAgent: true, confirmPaidProviders: true } });
    const slug = await v.group(['Audace', 'Calma']);
    await send(slug, 'Tutte le varianti con un\'immagine nuova');
    const c = await coordinator();
    expect((await v.bridge(c, 'work_on_variants', { items: [{ variant: 'a', instruction: 'x' }, { variant: 'b', instruction: 'x' }] })).statusCode).toBe(200);
    c.finish({ write: false });
    await vi.waitFor(async () => expect(await v.pending()).toHaveLength(1));
    await v.app.inject({ method: 'POST', url: `/api/approvals/${(await v.pending())[0]!.id}`, payload: { decision: 'once' } });
    const ha = await v.runOf(slug);
    expect(ha.req.prompt).not.toMatch(/off for this run/);
    // Its paid call asks nothing more (covered by the card).
    const call = v.bridge(ha, 'generate_image', { prompt: 'sfondo', width: 1024, height: 1024 });
    const settled = await Promise.race([call.then(() => 'answered'), new Promise((r) => setTimeout(() => r('waiting'), 1500))]);
    expect(settled).toBe('answered');
    expect(await v.pending()).toEqual([]);
    ha.finish(); (await v.runOf(`${slug}~b`)).finish();
    (await coordinator(1)).finish({ write: false });
    await v.waitIdle();
    // One work item: no card.
    await send(slug, 'Variante B più luce');
    const c2 = await coordinator(2);
    expect((await v.bridge(c2, 'work_on_variants', { items: [{ variant: 'b', instruction: 'luce' }] })).statusCode).toBe(200);
    c2.finish({ write: false });
    (await v.runOf(`${slug}~b`, 1)).finish();
    (await coordinator(3)).finish({ write: false });
    await v.waitIdle();
    // Stop while the card waits: the turn ends, nothing ran.
    await send(slug, 'Tutte le varianti più luce');
    const c3 = await coordinator(4);
    expect((await v.bridge(c3, 'work_on_variants', { items: [{ variant: 'a', instruction: 'x' }, { variant: 'b', instruction: 'x' }] })).statusCode).toBe(200);
    c3.finish({ write: false });
    await vi.waitFor(async () => expect(await v.pending()).toHaveLength(1));
    const before = v.runner.runs.length;
    await v.app.inject({ method: 'POST', url: `/api/jobs/${(await groupJob())!.id}/stop` });
    await v.waitIdle();
    expect(v.runner.runs.length).toBe(before);
    expect(await v.pending()).toEqual([]);
    expect(await groupJob()).toMatchObject({ state: 'cancelled' });
  });
});

describe('restart recovery', () => {
  it('review minor 2: a group request that had not started (taken from the queue, or waiting for its lane) goes back to the front of the queue, written once', async () => {
    const slug = await setup();
    const side = new CreativeSideStateStore(null);
    await side.read(v.projectDir, slug);
    const store = new CreativeStore(v.projectDir);
    await store.appendConversation(slug, { type: 'user', at: new Date().toISOString(), text: 'Più luce in B', pins: [], attachments: [], jobId: 'cut', clientId: 'c-1', group: true });
    await side.updateGroup(v.projectDir, slug, () => ({
      turn: { jobId: 'cut', at: new Date().toISOString(), request: { clientId: 'c-1', text: 'Più luce in B', pins: [], at: new Date().toISOString() } },
      queued: [{ clientId: 'c-2', text: 'Dopo', pins: [], at: new Date().toISOString() }],
    }));
    expect(await recoverGroupTurns(v.projectDir, [slug], side, () => false)).toEqual([slug]);
    expect((await side.group(v.projectDir, slug)).queued?.map((q) => q.clientId)).toEqual(['c-1', 'c-2']);
    expect((await side.group(v.projectDir, slug)).turn).toBeUndefined();
    const conv = await store.readConversation(slug);
    expect(conv.at(-1)).toMatchObject({ type: 'system', group: true, text: messages('it').jobs.groupInterruptedQueued });
  });

  it('review minor 2: a request put back in the queue after a restart is not written twice when it starts', async () => {
    const slug = await setup();
    await send(slug, 'Primo');
    const c = await coordinator();
    const id = cid();
    const q = await v.app.inject({ method: 'POST', url: `${v.url(slug)}/messages`, payload: { clientId: id, text: 'Più luce in B', mode: 'queued' } });
    expect(q.json().outcome, q.body).toBe('queued');
    // As a turn cut by a restart had written it before it was put back in the queue.
    await new CreativeStore(v.projectDir).appendConversation(slug, { type: 'user', at: new Date().toISOString(), text: 'Più luce in B', pins: [], attachments: [], jobId: 'cut', clientId: id, group: true });
    c.finish({ write: false });
    (await coordinator(1)).finish({ write: false });
    await v.waitIdle();
    expect((await conversation(slug)).filter((e) => e.type === 'user' && e.clientId === id)).toHaveLength(1);
  });

  it('a group turn cut by a restart is said in the group\'s chat and its marker cleared; the coordinator\'s session stays', async () => {
    const slug = await setup();
    const side = new CreativeSideStateStore(null);
    await side.read(v.projectDir, slug);
    await side.updateGroup(v.projectDir, slug, () => ({ turn: { jobId: 'gone', at: new Date().toISOString() }, session: { sessionId: 'sess-1', at: new Date().toISOString() } }));
    expect(await recoverGroupTurns(v.projectDir, [slug, `${slug}~b`], side, () => false)).toEqual([slug]);
    expect((await side.group(v.projectDir, slug))).toEqual({ session: { sessionId: 'sess-1', at: expect.any(String) } });
    const conv = await new CreativeStore(v.projectDir).readConversation(slug);
    expect(conv.at(-1)).toMatchObject({ type: 'system', level: 'error', group: true, text: messages('it').jobs.groupInterrupted });
    // Once: nothing more the second time.
    expect(await recoverGroupTurns(v.projectDir, [slug], side, () => false)).toEqual([]);
  });
});
