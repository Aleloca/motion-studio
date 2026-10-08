import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
});
