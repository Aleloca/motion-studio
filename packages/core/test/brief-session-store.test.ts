import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_BRIEF_FORM, type ConversationEntry } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BriefSessionStore } from '../src/brief/brief-session-store.ts';

let base: string;
let configDir: string;
let projectDir: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ms-brief-store-'));
  configDir = join(base, 'config');
  projectDir = join(base, 'ws', 'acme');
  await mkdir(projectDir, { recursive: true });
});
afterEach(async () => { await rm(base, { recursive: true, force: true }); });

const init = { form: { ...EMPTY_BRIEF_FORM, goal: 'Lancio' }, userEdited: ['goal' as const] };
const user = (text: string, at: string): ConversationEntry => ({ type: 'user', at, text, pins: [], attachments: [] });

describe('BriefSessionStore', () => {
  it('keeps one open session per project', async () => {
    const store = new BriefSessionStore(configDir);
    expect(await store.open(projectDir)).toBeNull();
    const s = await store.create(projectDir, init);
    expect(s).toMatchObject({ schemaVersion: 1, form: init.form, userEdited: ['goal'], agentFields: [], queued: [], context: { codebases: [], assets: [] } });
    expect((await store.open(projectDir))?.id).toBe(s.id);
    expect((await store.create(projectDir, { form: EMPTY_BRIEF_FORM, userEdited: [] })).id).toBe(s.id);
    // A second store on the same folder (a restart) reads it back.
    expect((await new BriefSessionStore(configDir).open(projectDir))?.form.goal).toBe('Lancio');
  });
  it('refuses a stale id', async () => {
    const store = new BriefSessionStore(configDir);
    const s = await store.create(projectDir, init);
    const next = await store.update(projectDir, s.id, () => ({ agentFields: ['message'] }));
    expect(next.agentFields).toEqual(['message']);
    await expect(store.update(projectDir, 'other', () => ({}))).rejects.toMatchObject({ status: 409, apiCode: 'brief-session-gone' });
    await expect(store.append(projectDir, 'other', user('x', '2026-10-20T10:00:00.000Z'))).rejects.toMatchObject({ apiCode: 'brief-session-gone' });
  });
  it('appends the conversation in order', async () => {
    const store = new BriefSessionStore(configDir);
    const s = await store.create(projectDir, init);
    const at = ['2026-10-20T10:00:00.000Z', '2026-10-20T10:00:01.000Z', '2026-10-20T10:00:02.000Z'];
    for (const [i, a] of at.entries()) await store.append(projectDir, s.id, user(`m${i}`, a));
    const entries = await new BriefSessionStore(configDir).conversation(projectDir, s.id);
    expect(entries.map((e) => [e.type === 'user' ? e.text : '', e.at])).toEqual([['m0', at[0]], ['m1', at[1]], ['m2', at[2]]]);
  });
  it('removes the session and its folder', async () => {
    const store = new BriefSessionStore(configDir);
    const s = await store.create(projectDir, init);
    await store.append(projectDir, s.id, user('x', '2026-10-20T10:00:00.000Z'));
    const dir = await store.dirFor(projectDir);
    await store.remove(projectDir, s.id);
    expect(await store.open(projectDir)).toBeNull();
    await expect(stat(dir!)).rejects.toThrow();
    // A new session after it is a new one.
    expect((await store.create(projectDir, init)).id).not.toBe(s.id);
  });
  it('keeps its files private, in the config folder only', async () => {
    const store = new BriefSessionStore(configDir);
    const s = await store.create(projectDir, init);
    await store.append(projectDir, s.id, user('x', '2026-10-20T10:00:00.000Z'));
    const dir = (await store.dirFor(projectDir))!;
    expect(dir.startsWith(join(configDir, 'brief-sessions'))).toBe(true);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, 'session.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'conversation.jsonl'))).mode & 0o777).toBe(0o600);
    expect(await readdir(projectDir)).toEqual([]);
  });
  it('in memory only, writes nothing', async () => {
    const store = new BriefSessionStore(null);
    const s = await store.create(projectDir, init);
    await store.append(projectDir, s.id, user('x', '2026-10-20T10:00:00.000Z'));
    expect((await store.conversation(projectDir, s.id)).length).toBe(1);
    expect((await store.open(projectDir))?.id).toBe(s.id);
    await expect(stat(configDir)).rejects.toThrow();
  });
  it('a corrupt session file is an error, never a new session', async () => {
    const store = new BriefSessionStore(configDir);
    await store.create(projectDir, init);
    const dir = (await store.dirFor(projectDir))!;
    await writeFile(join(dir, 'session.json'), '{ nope');
    await expect(new BriefSessionStore(configDir).open(projectDir)).rejects.toThrow();
    await expect(new BriefSessionStore(configDir).create(projectDir, init)).rejects.toThrow();
  });
});
