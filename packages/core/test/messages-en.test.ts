import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
});
