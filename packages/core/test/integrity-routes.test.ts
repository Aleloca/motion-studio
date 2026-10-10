import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AppConfigStore } from '../src/app-config.ts';
import { Git } from '../src/git.ts';
import { activeIntegrityStore, snapshotProtected } from '../src/project-integrity.ts';
import { buildServer } from '../src/server/app.ts';

const TOKEN = 'cd'.repeat(32);
const H = { 'x-motion-studio-ui': TOKEN };
const P = '/api/projects/acme';
let app: FastifyInstance;
let base: string;
let dir: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ms-integ-'));
  app = await buildServer({ uiToken: TOKEN, configDir: join(base, 'config'), sandbox: async () => ({ available: false, reason: 'test' }), appConfig: new AppConfigStore(join(base, 'config')), git: new Git(), doctor: async () => [], runner: new ClaudeCodeRunner(['true']) });
  await app.inject({ method: 'PUT', url: '/api/workspace', headers: H, payload: { path: join(base, 'ws') } });
  expect((await app.inject({ method: 'POST', url: '/api/projects', headers: H, payload: { name: 'Acme' } })).statusCode).toBe(201);
  dir = join(base, 'ws', 'acme');
});
afterEach(async () => { await app.close(); await rm(base, { recursive: true, force: true }); });

/** Quarantines the project the way the launcher does after a run, against the state before `tamper`. */
async function quarantineAfter(tamper: () => Promise<void>, files: string[]) {
  const before = await snapshotProtected(dir);
  await tamper();
  await activeIntegrityStore().quarantine(dir, 'tampered', files, before);
}
const get = async () => (await app.inject({ method: 'GET', url: `${P}/integrity`, headers: H })).json() as { quarantined: boolean; files: Array<{ path: string; change: string }>; gitProblem: string | null; token: string };
const accept = (token: string, headers: Record<string, string> = H) => app.inject({ method: 'POST', url: `${P}/integrity/accept`, headers, payload: { token } });

describe('project integrity routes (decisions log 141, round 5)', () => {
  it('a project in order is not blocked', async () => {
    expect(await get()).toMatchObject({ quarantined: false, files: [], gitProblem: null });
  });
  it('lists the changed, added and removed files; accept with the shown token lifts the quarantine', async () => {
    await quarantineAfter(async () => {
      await writeFile(join(dir, 'CLAUDE.md'), '# my own notes\n');
      await mkdir(join(dir, '.claude'), { recursive: true });
      await writeFile(join(dir, '.claude', 'settings.json'), '{}');
      await rm(join(dir, '.gitattributes'));
    }, ['CLAUDE.md']);
    const s = await get();
    expect(s.quarantined).toBe(true);
    expect(s.files).toEqual([
      { path: '.claude/settings.json', change: 'added' }, { path: '.gitattributes', change: 'removed' }, { path: 'CLAUDE.md', change: 'changed' },
    ]);
    expect(s.gitProblem).toBeNull();
    await expect(new Git().commitAll(dir, 'c')).rejects.toThrow();
    const res = await accept(s.token);
    expect(res.statusCode).toBe(200);
    expect(await get()).toMatchObject({ quarantined: false, files: [] });
    await expect(new Git().commitAll(dir, 'c')).resolves.toMatch(/^[0-9a-f]{40}$/);
  });
  it('requires the UI token and a loopback origin', async () => {
    await quarantineAfter(() => writeFile(join(dir, 'CLAUDE.md'), 'x'), ['CLAUDE.md']);
    const { token } = await get();
    expect((await accept(token, {})).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `${P}/integrity` })).statusCode).toBe(401);
    expect((await accept(token, { ...H, origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await get()).quarantined).toBe(true);
  });
  it('refuses (409) when the files changed after the list was shown, or the token is wrong', async () => {
    await quarantineAfter(() => writeFile(join(dir, 'CLAUDE.md'), 'x'), ['CLAUDE.md']);
    const shown = await get();
    await writeFile(join(dir, '.mcp.json'), '{"mcpServers":{}}');
    const res = await accept(shown.token);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('integrity-changed');
    expect((await accept('0'.repeat(64))).statusCode).toBe(409);
    expect((await accept('nope')).statusCode).toBe(400);
    expect((await get()).quarantined).toBe(true);
  });
  it('never accepts an unacceptable git state: it is shown with its remedy and the accept is refused', async () => {
    await quarantineAfter(() => appendFile(join(dir, '.git', 'config'), '[filter "x"]\n\tclean = evil\n'), ['.git/config']);
    const s = await get();
    expect(s.quarantined).toBe(true);
    expect(s.gitProblem).toContain('filter.x.clean');
    expect(s.gitProblem).toContain('git config --unset filter.x.clean');
    const res = await accept(s.token);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('git-unsafe');
    expect((await get()).quarantined).toBe(true);
  });
  it('a .git/commondir is never acceptable either', async () => {
    await quarantineAfter(() => writeFile(join(dir, '.git', 'commondir'), '../evil\n'), ['.git/commondir']);
    const s = await get();
    expect(s.files).toEqual([{ path: '.git/commondir', change: 'added' }]);
    expect(s.gitProblem).toContain('.git/commondir');
    expect((await accept(s.token)).statusCode).toBe(409);
  });
});
