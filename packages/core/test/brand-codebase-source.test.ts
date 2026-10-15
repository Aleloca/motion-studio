import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { SECRET_PATTERNS } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildClaudeArgs } from '../src/agent/claude-code-runner.ts';
import { buildAgentPolicy, type PolicyInput } from '../src/agent/policy.ts';
import type { AgentRunner, AgentTurnRequest } from '../src/agent/runner.ts';
import { AppConfigStore } from '../src/app-config.ts';
import { caseFoldGlob, findCodebaseSecrets, resolveBrandCodebase, secretReadRules, secretSandboxGlobs } from '../src/codebases.ts';
import { Git } from '../src/git.ts';
import { buildServer } from '../src/server/app.ts';
import { fixtureCodebase } from './helpers/brand-codebase.ts';
import { testLauncher } from './helpers/launcher.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const cleanup: string[] = [];
afterEach(async () => { for (const d of cleanup.splice(0)) await rm(d, { recursive: true, force: true }); });
const temp = async (prefix: string) => { const d = await realpath(await mkdtemp(join(tmpdir(), prefix))); cleanup.push(d); return d; };
const codebase = async (git = true) => { const d = await fixtureCodebase({ git }); cleanup.push(dirname(d)); return d; };

/** A runner that never starts anything: it records the request and ends the turn at once. */
function recordingRunner() {
  const requests: AgentTurnRequest[] = [];
  const runner: AgentRunner = { start: (req) => { requests.push(req); return { done: Promise.resolve({ status: 'succeeded' as const }), cancel: () => {} }; } };
  return { runner, requests };
}

describe('secretReadRules', () => {
  it('denies every secret pattern under the folder, in the exact case and case-folded', () => {
    const rules = secretReadRules('/Users/me/dev/app');
    expect(rules).toContain('Read(//Users/me/dev/app/**/.env*)');
    expect(rules).toContain('Read(//Users/me/dev/app/**/*.pem)');
    expect(rules).toContain('Read(//Users/me/dev/app/**/GoogleService-Info.plist)');
    expect(rules).toContain(`Read(/${caseFoldGlob('/Users/me/dev/app')}/**/.[eE][nN][vV]*)`);
    expect(rules).toContain('Read(//[uU][sS][eE][rR][sS]/[mM][eE]/[dD][eE][vV]/[aA][pP][pP]/**/.[eE][nN][vV]*)');
    for (const p of SECRET_PATTERNS) expect(rules).toContain(`Read(//Users/me/dev/app/**/${p})`);
  });
  it('also denies the contents of patterns that name folders', () => {
    const rules = secretReadRules('/a/app');
    for (const r of ['Read(//a/app/**/credentials*/**)', 'Read(//a/app/**/secrets*/**)', 'Read(//a/app/**/.git/**)', 'Read(//a/app/**/.env*/**)']) expect(rules).toContain(r);
    expect(rules).not.toContain('Read(//a/app/**/*.pem/**)');
  });
  it('escapes the folder\'s glob characters and refuses control characters', () => {
    const rules = secretReadRules('/a/My App [x] {y} (z)*?');
    expect(rules[0]).toBe('Read(//a/My App \\[x\\] \\{y\\} \\(z\\)\\*\\?/**/.env*)');
    // Folded: the escapes stay, only letters become classes.
    expect(rules.find((r) => r.endsWith('/**/.[eE][nN][vV]*)'))).toBe('Read(//[aA]/[mM][yY] [aA][pP][pP] \\[[xX]\\] \\{[yY]\\} \\([zZ]\\)\\*\\?/**/.[eE][nN][vV]*)');
    expect(secretReadRules('/a/b\nc')).toEqual([]);
    expect(secretReadRules('/a/b\u0007c')).toEqual([]);
  });
});

describe('buildAgentPolicy for a brand analysis of codebases', () => {
  const base: PolicyInput = {
    kind: 'brand-analysis', sandbox: true, home: '/Users/me', configDir: '/Users/me/Library/Application Support/Motion Studio',
    codebases: ['/Users/me/dev/app'], protectedFiles: [], protectedDirs: [], extraDomains: [], projectAllowRules: [], mcpTools: [],
    autoApproveSandboxed: false, codebaseSecrets: { files: ['/Users/me/dev/app/.ENV'], dirs: ['/Users/me/dev/app/.git'] },
  };
  type Sb = { sandbox: { filesystem: { denyRead: string[]; denyWrite: string[] } } };
  it('read-only, secrets denied by pattern and by exact path, Read/Glob/Grep allowed', () => {
    const p = buildAgentPolicy(base);
    for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) expect(p.disallowedTools).toContain(`${t}(//Users/me/dev/app/**)`);
    expect(p.disallowedTools).toEqual(expect.arrayContaining(secretReadRules('/Users/me/dev/app')));
    expect(p.disallowedTools).toEqual(expect.arrayContaining(['Read(//Users/me/dev/app/.ENV)', 'Read(//Users/me/dev/app/.git/**)', 'Read(//Users/me/dev/app/.git)']));
    expect(p.allowedTools).toEqual(expect.arrayContaining(['Read', 'Glob', 'Grep']));
    expect(p.addDirs).toEqual(['/Users/me/dev/app']);
    const fs = (p.settings as Sb).sandbox.filesystem;
    expect(fs.denyWrite).toContain('/Users/me/dev/app');
    expect(fs.denyRead).toEqual(expect.arrayContaining(['/Users/me/dev/app/.ENV', '/Users/me/dev/app/.git', ...secretSandboxGlobs('/Users/me/dev/app', (x) => x)]));
    expect(fs.denyRead).toContain('/Users/me/dev/app/**/.env*');
    expect(fs.denyRead).toContain('/Users/me/dev/app/**/.[eE][nN][vV]*');
  });
  it('without codebases the brand tools stay as they were', () => {
    const p = buildAgentPolicy({ ...base, codebases: [], codebaseSecrets: undefined });
    expect(p.allowedTools).not.toContain('Read');
    expect(p.disallowedTools.some((r) => r.includes('.env'))).toBe(false);
  });
  it('without the sandbox the tool rules are the same', () => {
    const p = buildAgentPolicy({ ...base, sandbox: false });
    expect(p.settings).toBeNull();
    expect(p.disallowedTools).toEqual(expect.arrayContaining(secretReadRules('/Users/me/dev/app')));
    expect(p.allowedTools).toEqual(expect.arrayContaining(['Read', 'Glob', 'Grep']));
  });
  it('a creative keeps its codebase rules unchanged (no secret rules, Edit only)', () => {
    const p = buildAgentPolicy({ ...base, kind: 'creative' });
    expect(p.disallowedTools.some((r) => r.startsWith('Read(//Users/me/dev/app'))).toBe(false);
    expect(p.disallowedTools).not.toContain('Write(//Users/me/dev/app/**)');
  });
});

describe('findCodebaseSecrets', () => {
  it('finds secret files and folders whatever the case, and links that leave the codebase', async () => {
    const cb = await codebase();
    const outside = await temp('ms-outside-');
    await writeFile(join(outside, 'notes.txt'), 'x');
    await writeFile(join(cb, 'public', 'Secrets.JSON'), '{}');
    await writeFile(join(cb, '.ENV.local'), 'x');
    await symlink(join(outside, 'notes.txt'), join(cb, 'public', 'away.svg'));
    await symlink(join(cb, '.env'), join(cb, 'public', 'inner.png'));
    await symlink(join(cb, 'src', 'theme.css'), join(cb, 'public', 'theme-link.css'));
    const found = await findCodebaseSecrets(cb);
    expect(found.truncated).toBe(false);
    expect(found.files.sort()).toEqual([join(cb, '.ENV.local'), join(cb, '.env'), join(cb, 'config', '.env.production'), join(cb, 'public', 'Secrets.JSON'), join(cb, 'public', 'away.svg'), join(cb, 'public', 'inner.png')].sort());
    expect(found.dirs).toEqual([join(cb, '.git')]);
  });
});

describe('the launcher with a brand analysis of a codebase', () => {
  it('passes --add-dir, the read-only and secret rules, and Read/Glob/Grep only with codebases', async () => {
    const cb = await codebase();
    const project = await temp('ms-proj-');
    const { runner, requests } = recordingRunner();
    const launcher = testLauncher(runner);
    const run = await launcher.start({ kind: 'brand-analysis', jobId: 'j1', projectSlug: 'acme', projectDir: project, codebases: [cb], request: { prompt: 'x' }, onEvent: () => {} });
    await run.done;
    const args = buildClaudeArgs(requests[0]!);
    expect(args.join('\n')).toContain(`--add-dir\n${cb}`);
    const disallowed = requests[0]!.disallowedTools!;
    expect(disallowed).toContain(`Edit(/${cb}/**)`);
    expect(disallowed).toContain(`Write(/${cb}/**)`);
    expect(disallowed).toContain(`Read(/${cb}/**/.env*)`);
    expect(disallowed).toContain(`Read(/${cb}/.env)`);
    expect(disallowed).toContain(`Read(/${cb}/config/.env.production)`);
    expect(disallowed).toContain(`Read(/${cb}/.git/**)`);
    expect(requests[0]!.allowedTools).toEqual(expect.arrayContaining(['Read', 'Glob', 'Grep']));
    const again = await launcher.start({ kind: 'brand-analysis', jobId: 'j2', projectSlug: 'acme', projectDir: project, codebases: [], request: { prompt: 'x' }, onEvent: () => {} });
    await again.done;
    expect(requests[1]!.allowedTools).not.toContain('Read');
    expect(buildClaudeArgs(requests[1]!)).not.toContain('--add-dir');
  });
  it('gives the sandbox denyWrite on the codebase and denyRead on its secrets', async () => {
    const cb = await codebase();
    const project = await temp('ms-proj-');
    const { runner, requests } = recordingRunner();
    const launcher = testLauncher(runner, { sandbox: async () => ({ available: true, reason: 'ok' }) });
    await (await launcher.start({ kind: 'brand-analysis', jobId: 'j1', projectSlug: 'acme', projectDir: project, codebases: [cb], request: { prompt: 'x' }, onEvent: () => {} })).done;
    const fs = (requests[0]!.settings as { sandbox: { filesystem: { denyRead: string[]; denyWrite: string[] } } }).sandbox.filesystem;
    expect(fs.denyWrite).toContain(cb);
    expect(fs.denyRead).toEqual(expect.arrayContaining([join(cb, '.env'), join(cb, 'config', '.env.production'), join(cb, '.git'), `${cb}/**/.env*`]));
  });
  it('refuses a codebase path with control characters', async () => {
    const project = await temp('ms-proj-');
    const { runner, requests } = recordingRunner();
    await expect(testLauncher(runner).start({ kind: 'brand-analysis', jobId: 'j1', projectSlug: 'acme', projectDir: project, codebases: ['/tmp/a\nb'], request: { prompt: 'x' }, onEvent: () => {} })).rejects.toThrow();
    expect(requests).toEqual([]);
  });
});

describe('resolveBrandCodebase', () => {
  it('normalises the spelling and resolves the real path', async () => {
    const cb = await codebase(false);
    const project = await temp('ms-proj-');
    for (const spelling of [`${cb}/`, `${cb}/./`, `/${cb}`, `${dirname(cb)}/./${'acme-app'}//`]) {
      expect(await resolveBrandCodebase(spelling, [project])).toEqual({ path: cb, real: cb });
    }
    const links = await temp('ms-links-');
    await symlink(cb, join(links, 'alias'));
    expect(await resolveBrandCodebase(join(links, 'alias'), [project])).toEqual({ path: join(links, 'alias'), real: cb });
  });
  it('refuses unsafe, relative, root, home, missing and overlapping folders', async () => {
    const project = await temp('ms-proj-');
    const links = await temp('ms-links-');
    // The test home (test-support/isolate-user-data.ts): a throwaway folder, never the user's.
    await mkdir(homedir(), { recursive: true });
    await symlink(homedir(), join(links, 'home'));
    await symlink('/', join(links, 'root'));
    await mkdir(join(project, 'inner'));
    const cases: Array<[string, string]> = [
      ['/tmp/a\u0000b', 'unsafe-path'], ['/tmp/a\nb', 'unsafe-path'], ['dev/app', 'not-absolute'], ['/', 'disk-root'], ['//', 'disk-root'],
      ['~', 'home'], [`${homedir()}/`, 'home'], [join(links, 'home'), 'home'], [join(links, 'root'), 'disk-root'],
      [join(project, 'missing'), 'missing'], [join(project, 'inner'), 'overlap'], [dirname(project), 'overlap'],
    ];
    for (const [raw, problem] of cases) expect(await resolveBrandCodebase(raw, [project]), raw).toEqual({ problem });
  });
});

describe('POST /brand/sources with a codebase', () => {
  let app: FastifyInstance;
  let base: string;
  const P = '/api/projects/acme';
  beforeEach(async () => {
    base = await temp('ms-brs-');
    vi.stubEnv('MOTION_STUDIO_CONFIG_DIR', join(base, 'config'));
    const { runner } = recordingRunner();
    app = await buildServer({ uiToken: null, sandbox: async () => ({ available: false, reason: 'test' }), appConfig: new AppConfigStore(join(base, 'config')), configDir: join(base, 'config'), git: new Git(), doctor: async () => [], runner });
    await app.inject({ method: 'PUT', url: '/api/workspace', payload: { path: join(base, 'ws') } });
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
  });
  afterEach(async () => { await app.close(); vi.unstubAllEnvs(); });
  const add = (payload: unknown) => app.inject({ method: 'POST', url: `${P}/brand/sources`, payload: payload as Record<string, unknown> });

  it('adds a normalised folder with its note, and refuses duplicates (also by another spelling or a link)', async () => {
    const cb = await codebase(false);
    const ok = await add({ kind: 'codebase', path: `${cb}/./`, note: ' the iOS app ' });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ kind: 'codebase', path: cb, note: 'the iOS app', url: null, file: null });
    const links = await temp('ms-links-');
    await symlink(cb, join(links, 'alias'));
    for (const again of [cb, `${cb}/`, `/${cb}`, join(links, 'alias')]) {
      const r = await add({ kind: 'codebase', path: again });
      expect(r.statusCode, again).toBe(409);
      expect(r.json().code).toBe('codebase-duplicate');
    }
  });
  it('refuses a sixth codebase', async () => {
    const parent = await temp('ms-many-');
    for (let n = 1; n <= 6; n++) await mkdir(join(parent, `app${n}`));
    for (let n = 1; n <= 5; n++) expect((await add({ kind: 'codebase', path: join(parent, `app${n}`) })).statusCode).toBe(201);
    const r = await add({ kind: 'codebase', path: join(parent, 'app6') });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('codebase-limit');
  });
  it('refuses invalid folders with a stable code', async () => {
    const cases: Array<[string, string]> = [
      ['dev/app', 'codebase-not-absolute'], ['/', 'codebase-disk-root'], ['~', 'codebase-home'], [join(base, 'nope'), 'codebase-missing'],
      [join(base, 'ws'), 'codebase-overlap'], [join(base, 'ws', 'acme'), 'codebase-overlap'], ['/tmp/a\u0007b', 'codebase-unsafe-path'],
    ];
    for (const [path, code] of cases) {
      const r = await add({ kind: 'codebase', path });
      expect(r.statusCode, path).toBe(400);
      expect(r.json().code, path).toBe(code);
    }
    expect((await add({ kind: 'codebase', path: '' })).statusCode).toBe(400);
  });
});
