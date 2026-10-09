import { appendFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UsageReport } from '@motion-studio/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AppConfigStore } from '../src/app-config.ts';
import { Git } from '../src/git.ts';
import { buildServer } from '../src/server/app.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const TOKEN = 'ab'.repeat(32); // hex, like a real UI token
const headers = { 'x-motion-studio-ui': TOKEN };
let app: FastifyInstance;
let base: string;
let billingCalls: number;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ms-usr-'));
  billingCalls = 0;
  app = await buildServer({
    uiToken: TOKEN, sandbox: async () => ({ available: false, reason: 'test' }),
    appConfig: new AppConfigStore(join(base, 'config')), git: new Git(),
    runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }),
    doctor: async () => [],
    billing: async () => { billingCalls++; return 'subscription'; },
  });
});
afterEach(async () => { await app.close(); delete process.env.FAKE_CLAUDE_SCENARIO; });

const setup = async () => {
  await app.inject({ method: 'PUT', url: '/api/workspace', payload: { path: join(base, 'ws') }, headers });
  await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' }, headers });
};
const waitJobs = async () => {
  for (let i = 0; i < 500; i++) {
    const jobs = (await app.inject({ url: '/api/jobs', headers })).json() as Array<{ state: string }>;
    if (jobs.every((j) => j.state !== 'queued' && j.state !== 'running')) return jobs;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout');
};

describe('GET /api/usage', { timeout: 20_000 }, () => {
  it('requires the UI token', async () => {
    const res = await app.inject({ url: '/api/usage' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'ui-token' });
  });

  it('answers with an empty report before a workspace exists', async () => {
    const r = (await app.inject({ url: '/api/usage', headers })).json() as UsageReport;
    expect(r).toMatchObject({ byProject: [], trackedSince: null, billing: 'subscription' });
    expect(r.byDay).toHaveLength(7);
  });

  it('reports a console turn from the ledger, and never throws on a corrupt ledger', async () => {
    await setup();
    process.env.FAKE_CLAUDE_SCENARIO = 'usage_stream';
    expect((await app.inject({ method: 'POST', url: '/api/projects/acme/turns', payload: { prompt: 'ciao' }, headers })).statusCode).toBe(202);
    await waitJobs();
    await appendFile(join(base, 'ws', 'acme', '.studio', 'usage.jsonl'), '{"broken": \n\u0000\u2028garbage');
    const r = (await app.inject({ url: '/api/usage', headers })).json() as UsageReport;
    expect(r.byKind.find((k) => k.kind === 'console')).toEqual({ kind: 'console', tokens: 310, costUsd: 0.01 });
    expect(r.byProject).toEqual([{ slug: 'acme', name: 'Acme', tokens: 310, costUsd: 0.01 }]);
    expect(r.byDay.at(-1)!.tokens).toBe(310);
    expect(r.trackedSince).not.toBeNull();
    expect(typeof r.utcOffsetMinutes).toBe('number');
    const one = (await app.inject({ url: '/api/usage?project=acme', headers })).json() as UsageReport;
    expect(one.byProject).toHaveLength(1);
    // Cached: the auth status is read once.
    expect(billingCalls).toBe(1);
  });

  it('validates the range and the project', async () => {
    await setup();
    expect((await app.inject({ url: '/api/usage?from=nope', headers })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/usage?from=2026-10-09T00:00:00Z&to=2026-10-01T00:00:00Z', headers })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/usage?from=2020-01-01T00:00:00Z&to=2026-10-01T00:00:00Z', headers })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/usage?project=nobody', headers })).statusCode).toBe(404);
    const ok = await app.inject({ url: '/api/usage?from=2026-10-01T00:00:00Z&to=2026-10-03T00:00:00Z', headers });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as UsageReport).from).toBe('2026-10-01T00:00:00.000Z');
    // Only `to`: the 7 local days before it, like the default range.
    const toOnly = (await app.inject({ url: `/api/usage?to=${encodeURIComponent(new Date(2026, 9, 10).toISOString())}`, headers })).json() as UsageReport;
    expect(toOnly.byDay.map((d) => d.day)).toEqual(['2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']);
  });
});

describe('GET /api/usage/first-generations', { timeout: 20_000 }, () => {
  const line = (over: Record<string, unknown>) => JSON.stringify({
    at: new Date().toISOString(), jobId: 'j', kind: 'creative', creativeSlug: 'c', version: 1, attempt: 1,
    tokens: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.01, models: [], durationMs: 1, outcome: 'ok', ...over,
  });

  it('requires the UI token', async () => {
    const res = await app.inject({ url: '/api/usage/first-generations' });
    expect(res.statusCode).toBe(401);
  });

  it('is empty before a workspace exists', async () => {
    expect((await app.inject({ url: '/api/usage/first-generations', headers })).json()).toEqual({ tokens: [] });
  });

  it('lists the first-generation totals of the window, and validates days', async () => {
    await setup();
    const old = new Date(Date.now() - 120 * 24 * 3600 * 1000).toISOString();
    await mkdir(join(base, 'ws', 'acme', '.studio'), { recursive: true });
    await appendFile(join(base, 'ws', 'acme', '.studio', 'usage.jsonl'), [
      line({ creativeSlug: 'a' }), line({ creativeSlug: 'a', attempt: 2 }), line({ creativeSlug: 'b', tokens: { input: 50, output: 0, cacheRead: 0, cacheWrite: 0 } }),
      line({ creativeSlug: 'old', at: old }), line({ creativeSlug: 'b', version: 2 }), 'garbage',
    ].join('\n') + '\n');
    const r = (await app.inject({ url: '/api/usage/first-generations', headers })).json() as { tokens: number[] };
    expect(r.tokens.sort((x, y) => x - y)).toEqual([50, 200]);
    const wide = (await app.inject({ url: '/api/usage/first-generations?days=200', headers })).json() as { tokens: number[] };
    expect(wide.tokens).toHaveLength(3);
    for (const bad of ['0', '-1', 'x', '401', '1.5']) {
      expect((await app.inject({ url: `/api/usage/first-generations?days=${bad}`, headers })).statusCode).toBe(400);
    }
  });
});
