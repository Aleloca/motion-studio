import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApprovalRequest, VersionEntry } from '@motion-studio/shared';
import { fileURLToPath } from 'node:url';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AppConfigStore } from '../src/app-config.ts';
import { buildServer } from '../src/server/app.ts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalBroker } from '../src/approvals/broker.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { exportVersion } from '../src/creatives/export.ts';
import { validateOutputs } from '../src/creatives/output-contract.ts';
import { NoMediaTools } from '../src/media/media-tools.ts';
import { runDoctor } from '../src/doctor.ts';
import type { CommandExec } from '../src/exec.ts';
import { Git } from '../src/git.ts';
import { setLocale } from '../src/i18n.ts';
import { WorkspaceStore } from '../src/workspace-store.ts';

// The setup file starts every test in Italian; these tests check what the core says in English.
beforeEach(() => setLocale('en'));
afterEach(() => setLocale('it'));

describe('English messages', () => {
  it('words a missing project in English, and in Italian after switching', async () => {
    const ws = await WorkspaceStore.open(join(await mkdtemp(join(tmpdir(), 'ms-en-')), 'ws'), new Git());
    await expect(ws.getProject('nope')).rejects.toMatchObject({ status: 404, message: 'Project nope not found' });
    setLocale('it');
    await expect(ws.getProject('nope')).rejects.toMatchObject({ status: 404, message: 'Progetto nope non trovato' });
  });
  it('words Doctor checks and their fixes in English', async () => {
    const exec: CommandExec = async () => ({ code: -1, stdout: '', stderr: 'ENOENT', notFound: true });
    const checks = await runDoctor({ exec, claudeCommand: ['claude'], nodeVersion: 'v24.9.0' });
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    expect(byId.git).toMatchObject({ message: 'Git not found', fix: 'Install Git from https://git-scm.com' });
    expect(byId['claude-auth']).toMatchObject({ label: 'Claude sign-in', message: 'Install Claude Code first' });
  });
  it('titles an approval for a file outside the project in English, keeping the stable kind', async () => {
    const shown: ApprovalRequest[] = [];
    const broker = new ApprovalBroker({ broadcast: (m) => { if (m.type === 'approval') shown.push(m.approval); } });
    void broker.request({ jobId: 'j', projectSlug: 'acme', projectDir: '/w/acme', creativeSlug: null, kind: 'tool', toolName: 'Write', input: { file_path: '/tmp/out.txt' } });
    expect(shown[0]).toMatchObject({ kind: 'tool', toolName: 'Write', title: 'Edit a file outside the project', detail: '/tmp/out.txt' });
    await broker.decide(shown[0]!.id, 'once');
  });
  it('words validation problems in English', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'ms-en-')), 'v1');
    await mkdir(dir);
    expect((await validateOutputs({ dir, requested: ['sq'], presets: [], durationSec: null, media: NoMediaTools })).problems).toEqual(['manifest.json is missing in v1']);
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, files: [], tools: [] }));
    const r = await validateOutputs({ dir, requested: ['ghost'], presets: [], durationSec: null, media: NoMediaTools });
    expect(r.problems).toEqual(['Unknown preset: ghost (not in the format catalog)']);
    expect(r.unknownPresets).toEqual(['ghost']);
  });
  it('words export refusals in English', async () => {
    const version: VersionEntry = { n: 1, commit: null, sessionId: null, status: 'complete', createdAt: 'x', request: '', outputs: [], problems: [], tools: [], renderCommand: null, basedOn: null };
    await expect(exportVersion({ creativeDir: '/nowhere', version, destination: 'relative/dir', slug: 'c' })).rejects.toMatchObject({ status: 400, message: 'Choose a destination folder (absolute path)' });
  });
  it('labels a started turn in English and tags it with a stable kind', async () => {
    const base = await mkdtemp(join(tmpdir(), 'ms-en-'));
    const app = await buildServer({ uiToken: null, sandbox: async () => ({ available: false, reason: 'test' }), appConfig: new AppConfigStore(join(base, 'config')), git: new Git(), doctor: async () => [],
      runner: new ClaudeCodeRunner([process.execPath, fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url))], { killGraceMs: 200 }) });
    try {
      await app.inject({ method: 'PUT', url: '/api/workspace', payload: { path: join(base, 'ws') } });
      await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
      const res = await app.inject({ method: 'POST', url: '/api/projects/acme/turns', payload: { prompt: 'hello' } });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ kind: 'console', label: 'Turn · Acme' });
    } finally {
      await app.close();
    }
  });
});
