// @vitest-environment node
/**
 * Phase 15, Task 3 (spec §3, "Direzioni"): the directions turn. Before a start, the variants without a direction get one from
 * a short agent turn that writes no file and hands its directions over through `submit_variant_directions` (the only tool of
 * the job kind `variant-directions`: no editing tool, no Bash). The tool refuses a wrong count, a direction out of 3..140
 * characters, duplicates (case-insensitive) and a copy of a given direction; a run that ends without valid directions gets a
 * bounded repair turn. Directions the user typed always win, and when every target has one the turn is skipped. Controlled
 * runner only (no `claude`), no provider.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCP_TOOLS } from '../src/agent/launcher.ts';
import { buildAgentPolicy } from '../src/agent/policy.ts';
import { variantApp, type VariantApp } from './helpers/variant-app.ts';
import type { ControlledRun } from './helpers/controlled-runner.ts';

vi.setConfig({ testTimeout: 60_000 });

let v: VariantApp;
afterEach(async () => { await v?.close(); });

const TOOL = 'mcp__studio__submit_variant_directions';
const isDirections = (r: ControlledRun) => r.req.allowedTools?.includes(TOOL) === true;
const runFor = (slug: string, body: unknown) => v.app.inject({ method: 'POST', url: `${v.url(slug)}/variants/run`, payload: body as object });

describe('variant directions: the tool set', () => {
  it('the directions job kind has only submit_variant_directions: no write tool, no Bash, with and without the sandbox', () => {
    expect(MCP_TOOLS['variant-directions']).toEqual(['submit_variant_directions']);
    for (const sandbox of [false, true]) {
      const p = buildAgentPolicy({
        kind: 'variant-directions', sandbox, projectDir: '/w/p', home: '/h', configDir: '/c', codebases: [], protectedFiles: [], protectedDirs: [],
        extraDomains: [], projectAllowRules: ['Bash(ls:*)'], mcpTools: [TOOL], autoApproveSandboxed: true,
      });
      for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash']) expect(p.disallowedTools, `${tool} sandbox=${sandbox}`).toContain(tool);
      expect(p.allowedTools.filter((x) => x !== TOOL && x !== 'Bash(ls:*)')).toEqual([]);
      expect(p.allowedTools.some((x) => /^(Edit|Write|MultiEdit|NotebookEdit)\b/.test(x))).toBe(false);
      if (sandbox) expect((p.settings as { sandbox: { autoAllowBashIfSandboxed: boolean } }).sandbox.autoAllowBashIfSandboxed).toBe(false);
    }
    // A creative turn never gets the tool.
    expect(MCP_TOOLS.creative).not.toContain('submit_variant_directions');
  });
});

describe('variant directions: the turn', () => {
  it('fills only the missing directions: wrong count, duplicates and a copy of a given one are refused, then a repair turn delivers', async () => {
    v = await variantApp();
    const slug = await v.group(['Audace e notturna', null, null]);
    const pending = runFor(slug, { targets: 'all-active', request: null });
    const first = await v.runner.next(0);
    expect(isDirections(first)).toBe(true);
    // The turn's tools: the submit tool only, every editing tool and Bash denied; no write is asked of it.
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash']) expect(first.req.disallowedTools).toContain(tool);
    expect(first.req.allowedTools).toEqual([TOOL]);
    expect(first.req.prompt).toContain('submit_variant_directions');
    expect(first.req.prompt).toContain('Audace e notturna');
    expect(first.req.prompt).toMatch(/exactly 2 directions/);
    const job = (await v.jobs()).find((j) => j.kind === 'variant-directions')!;
    expect(job).toMatchObject({ state: 'running' });
    // Wrong count.
    let res = await v.bridge(first, 'submit_variant_directions', { directions: ['Solo una'] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false });
    expect(JSON.stringify(res.json().errors)).toMatch(/exactly 2/);
    // Duplicates, case-insensitive.
    res = await v.bridge(first, 'submit_variant_directions', { directions: ['Minimal pastello', 'MINIMAL pastello '] });
    expect(res.json()).toMatchObject({ ok: false });
    // The same as a given direction.
    res = await v.bridge(first, 'submit_variant_directions', { directions: ['audace e NOTTURNA', 'Minimal pastello'] });
    expect(res.json()).toMatchObject({ ok: false });
    // Too short, too long.
    res = await v.bridge(first, 'submit_variant_directions', { directions: ['ok', 'x'.repeat(141)] });
    expect(res.json()).toMatchObject({ ok: false });
    expect(res.json().errors).toHaveLength(2);
    // The run ends with nothing valid: a repair turn follows, resuming the session, with the errors.
    first.finish({ write: false });
    const repair = await v.runner.next(1);
    expect(isDirections(repair)).toBe(true);
    expect(repair.req.resumeSessionId).toBe(first.sessionId);
    expect(repair.req.prompt).toMatch(/not accepted|refused/i);
    res = await v.bridge(repair, 'submit_variant_directions', { directions: ['  Minimal pastello  ', 'Retro anni 80'] });
    expect(res.json()).toEqual({ ok: true });
    repair.finish({ write: false });
    const answer = await pending;
    expect(answer.statusCode, answer.body).toBe(202);
    const g = (await v.detail(slug)).creative.variantGroup!;
    expect(g.members.map((m) => [m.letter, m.direction, m.directionSource])).toEqual([
      ['a', 'Audace e notturna', 'user'], ['b', 'Minimal pastello', 'agent'], ['c', 'Retro anni 80', 'agent'],
    ]);
    // Then the fan-out: every variant gets a creative turn of its own.
    expect(Object.keys(answer.json().jobs).sort()).toEqual(['a', 'b', 'c']);
    expect((await v.jobs()).find((j) => j.kind === 'variant-directions')).toMatchObject({ state: 'succeeded' });
  });

  it('skips the turn when the user typed every direction of the targets', async () => {
    v = await variantApp();
    const slug = await v.group(['Audace', 'Calma', null]);
    const res = await runFor(slug, { targets: ['a', 'b'], request: null });
    expect(res.statusCode, res.body).toBe(202);
    expect(Object.keys(res.json().jobs).sort()).toEqual(['a', 'b']);
    await vi.waitFor(() => expect(v.runner.runs).toHaveLength(2));
    expect(v.runner.runs.some(isDirections)).toBe(false);
    expect((await v.jobs()).some((j) => j.kind === 'variant-directions')).toBe(false);
    // C's direction stays empty: it was not a target.
    expect((await v.detail(slug)).creative.variantGroup!.members[2]!.direction).toBeNull();
  });

  it('gives up after the bounded repair turns: no variant starts and the route says why', async () => {
    v = await variantApp();
    const slug = await v.group([null, null]);
    const pending = runFor(slug, { targets: 'all-active', request: null });
    for (let i = 0; i < 3; i++) {
      const r = await v.runner.next(i);
      expect(isDirections(r)).toBe(true);
      r.finish({ write: false });
    }
    const res = await pending;
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('variant-directions-failed');
    expect(v.runner.runs).toHaveLength(3);
    expect((await v.jobs()).filter((j) => j.kind === 'creative')).toEqual([]);
    expect((await v.detail(slug)).creative.variantGroup!.members.every((m) => m.direction === null)).toBe(true);
  });

  it('the tool is refused to any other job, and the directions turn gets no card for anything', async () => {
    v = await variantApp();
    const slug = await v.group(['Audace', 'Calma']);
    await runFor(slug, { targets: ['a'], request: null });
    const creative = await v.runner.next(0);
    expect(isDirections(creative)).toBe(false);
    const res = await v.bridge(creative, 'submit_variant_directions', { directions: ['x y z'] });
    expect(res.statusCode).toBe(403);
    creative.finish();
    await v.waitIdle();
    // A directions run asking for Bash or a write is denied at once, without a card.
    const other = await v.group([null, null], 'Altra');
    const pending = runFor(other, { targets: 'all-active', request: null });
    const dir = await v.runner.next(1);
    expect(isDirections(dir)).toBe(true);
    for (const [tool, input] of [['Bash', { command: 'ls' }], ['Write', { file_path: 'x.txt', content: 'x' }]] as const) {
      const a = await v.bridge(dir, 'approve', { tool_name: tool, input });
      expect(a.json()).toMatchObject({ behavior: 'deny' });
    }
    expect(await v.pending()).toEqual([]);
    await v.bridge(dir, 'submit_variant_directions', { directions: ['Minimal pastello', 'Retro anni 80'] });
    dir.finish({ write: false });
    expect((await pending).statusCode).toBe(202);
  });
});
