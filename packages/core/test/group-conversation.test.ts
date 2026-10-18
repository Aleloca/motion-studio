// @vitest-environment node
/**
 * Decisions 980 and 982 (phase 2 of the single agent): a variant group's one conversation. The store routes a member's
 * writes and reads to the group's conversation, stamps each entry with its variant, merges the members' logs in memory
 * until the group is migrated, and migrates once (time order, originals kept as conversation.premerge.jsonl), safely when
 * cut at any step.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sisterSlug, type Brief, type ConversationEntry, type CreativeFile, type VariantGroup } from '@motion-studio/shared';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { mergeConversations } from '../src/creatives/group-conversation.ts';
import { CREATIVE_CORE_FILES } from '../src/agent/protected-links.ts';

const brief: Brief = { goal: 'Lancio app', message: '', formats: ['instagram-post-1x1'], durationSec: 6, assets: [], notes: '' };
const T = (s: number) => new Date(Date.UTC(2026, 9, 18, 10, 0, s)).toISOString();
const user = (s: number, text: string, extra: Partial<ConversationEntry> = {}): ConversationEntry => ({ type: 'user', at: T(s), text, pins: [], attachments: [], ...extra } as ConversationEntry);
const info = (s: number, text: string): ConversationEntry => ({ type: 'system', at: T(s), level: 'info', text });
const session = (s: number, jobId: string, sessionId: string): ConversationEntry => ({ type: 'agent', at: T(s), jobId, event: { kind: 'session', sessionId } });
const IDLE = async () => true;

let dir: string;
let store: CreativeStore;
let host: string;
const sis = (l: string) => sisterSlug(host, l);
const log = (slug: string, name = 'conversation.jsonl') => join(dir, 'creatives', slug, name);
const raw = (slug: string, name = 'conversation.jsonl') => readFile(log(slug, name), 'utf8');
const texts = (es: ConversationEntry[]) => es.map((e) => `${e.variant ?? '-'}:${e.type === 'agent' ? e.jobId : e.type === 'version' ? `v${e.n}` : e.text}`);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ms-group-chat-'));
  store = new CreativeStore(dir);
  host = (await store.create({ title: 'Lancio', brief })).slug;
  const at = T(0);
  const sister: CreativeFile = { schemaVersion: 1, title: 'Lancio', brief, status: 'draft', error: null, createdAt: at, updatedAt: at, resumeFrom: null, linkedCodebases: [], variantOf: host };
  for (const l of ['b', 'c']) await store.createSister(host, l, sister);
  const group: VariantGroup = {
    members: ['a', 'b', 'c'].map((l) => ({ slug: sisterSlug(host, l), letter: l, direction: null, directionSource: null, status: 'active' as const, createdAt: at })),
    picks: {}, layout: 'variant',
  };
  await store.update(host, { variantGroup: group });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/** Old logs, as phase 15 wrote them: no `variant` anywhere. */
async function oldLogs() {
  await writeFile(log(host), [user(1, 'ciao A'), info(4, 'A fatto'), session(5, 'ja', 'sa')].map((e) => JSON.stringify(e)).join('\n') + '\n');
  await writeFile(log(sis('b')), [user(2, 'ciao B'), session(3, 'jb', 'sb'), info(6, 'B fatto')].map((e) => JSON.stringify(e)).join('\n') + '\n');
  await writeFile(log(sis('c')), `${JSON.stringify(user(4, 'ciao C'))}\nnot json\n`);
}

describe('mergeConversations', () => {
  it('orders by time, keeps each log\'s own order (a clock step never reorders a log), ties go to the member listed first', () => {
    const merged = mergeConversations([
      { letter: 'a', entries: [info(5, 'a1'), info(1, 'a2 (clock went back)'), info(9, 'a3')] },
      { letter: 'b', entries: [info(2, 'b1'), info(5, 'b2')] },
      { letter: 'aa', entries: [{ ...info(0, 'x'), at: 'not a time' }, info(3, 'aa2')] },
    ]);
    expect(texts(merged)).toEqual(['aa:x', 'b:b1', 'aa:aa2', 'a:a1', 'a:a2 (clock went back)', 'b:b2', 'a:a3']);
  });
});

describe('the group conversation before the migration', () => {
  it('a member writes its own log, stamped; every member reads the same merged conversation; `own` is one variant', async () => {
    await oldLogs();
    await store.appendConversation(sis('b'), info(7, 'B dopo'));
    await store.appendConversation(host, info(8, 'A dopo'));
    // Still its own log (the group is not migrated), with the stamp.
    expect((await raw(sis('b'))).trim().split('\n').at(-1)).toContain('"variant":"b"');
    const want = ['a:ciao A', 'b:ciao B', 'b:jb', 'a:A fatto', 'c:ciao C', 'a:ja', 'b:B fatto', 'b:B dopo', 'a:A dopo'];
    for (const s of [host, sis('b'), sis('c')]) expect(texts(await store.readConversation(s)), s).toEqual(want);
    expect(texts(await store.readConversation(sis('b'), { own: true }))).toEqual(['b:ciao B', 'b:jb', 'b:B fatto', 'b:B dopo']);
    // Each variant's last turn session is its own.
    expect((await store.lastTurnSession(sis('b')))?.sessionId).toBe('sb');
    expect((await store.lastTurnSession(host))?.sessionId).toBe('sa');
  });

  it('a creative outside any group is unchanged: no stamp, its own log', async () => {
    const single = (await store.create({ title: 'Solo', brief })).slug;
    await store.appendConversation(single, info(1, 'x'));
    expect(await store.readConversation(single)).toEqual([info(1, 'x')]);
  });
});

describe('the migration (decision 982)', () => {
  it('merges once in time order, keeps the originals, retires the sisters\' logs; later writes go to the host, stamped', async () => {
    await oldLogs();
    const before = { a: await raw(host), b: await raw(sis('b')), c: await raw(sis('c')) };
    const view = texts(await store.readConversation(sis('c')));
    const updatedAt = (await store.get(host)).updatedAt;
    expect(await store.migrateConversation(host, IDLE)).toBe('migrated');
    expect((await store.get(host)).variantGroup?.chat).toBe('single');
    // The originals, byte for byte (the unreadable line too).
    expect(await raw(host, 'conversation.premerge.jsonl')).toBe(before.a);
    expect(await raw(sis('b'), 'conversation.premerge.jsonl')).toBe(before.b);
    expect(await raw(sis('c'), 'conversation.premerge.jsonl')).toBe(before.c);
    expect(existsSync(log(sis('b')))).toBe(false);
    expect(existsSync(log(host, 'conversation.merged.jsonl'))).toBe(false);
    // The same conversation as before the merge, now from the host's log.
    for (const s of [host, sis('b'), sis('c')]) expect(texts(await store.readConversation(s))).toEqual(view);
    await store.appendConversation(sis('c'), info(9, 'C dopo'));
    expect(existsSync(log(sis('c')))).toBe(false);
    expect(texts(await store.readConversation(host)).at(-1)).toBe('c:C dopo');
    expect(texts(await store.readConversation(sis('c'), { own: true }))).toEqual(['c:ciao C', 'c:C dopo']);
    expect((await store.lastTurnSession(sis('b')))?.sessionId).toBe('sb');
    expect((await store.lastTurnSession(host))?.sessionId).toBe('sa');
    // Idempotent: a second run changes nothing.
    const after = await raw(host);
    expect(await store.migrateConversation(host, IDLE)).toBe('done');
    expect(await raw(host)).toBe(after);
    // `updatedAt` is not a user change.
    expect((await store.get(host)).updatedAt).toBe(updatedAt);
  });

  it('waits while the group is busy: nothing changes', async () => {
    await oldLogs();
    const before = await raw(sis('b'));
    expect(await store.migrateConversation(host, async () => false)).toBe('busy');
    expect(await raw(sis('b'))).toBe(before);
    expect((await store.get(host)).variantGroup?.chat).toBeUndefined();
    expect(existsSync(log(host, 'conversation.premerge.jsonl'))).toBe(false);
  });

  it('is a no-op on a sister or a creative outside a group', async () => {
    expect(await store.migrateConversation(sis('b'), IDLE)).toBe('none');
    const single = (await store.create({ title: 'Solo', brief })).slug;
    expect(await store.migrateConversation(single, IDLE)).toBe('none');
  });

  it('cut before its commit point: the group stays unmigrated with every log whole; a later run loses and doubles nothing', async () => {
    await oldLogs();
    const view = texts(await store.readConversation(host));
    await expect(store.migrateConversation(host, IDLE, { afterMerged: async () => { throw new Error('crash'); } })).rejects.toThrow('crash');
    expect((await store.get(host)).variantGroup?.chat).toBeUndefined();
    expect(texts(await store.readConversation(sis('b')))).toEqual(view);
    // Written after the cut, before the next run: kept.
    await store.appendConversation(sis('b'), info(20, 'B più tardi'));
    expect(await store.migrateConversation(host, IDLE)).toBe('migrated');
    expect(texts(await store.readConversation(host))).toEqual([...view, 'b:B più tardi']);
    // The copy of the cut attempt is kept; the merge's own copy has the later message (decision 1164).
    const copies = (await readdir(join(dir, 'creatives', sis('b')))).filter((f) => f.startsWith('conversation.premerge'));
    expect(copies).toHaveLength(2);
    expect((await Promise.all(copies.map((f) => raw(sis('b'), f)))).some((x) => x.includes('B più tardi'))).toBe(true);
  });

  it('cut after its commit point: the next read or write finishes it first; nothing lost or doubled', async () => {
    await oldLogs();
    const view = texts(await store.readConversation(host));
    await expect(store.migrateConversation(host, IDLE, { afterFlag: async () => { throw new Error('crash'); } })).rejects.toThrow('crash');
    expect((await store.get(host)).variantGroup?.chat).toBe('single');
    expect(existsSync(log(host, 'conversation.merged.jsonl'))).toBe(true);
    // A write first (the riskiest case: it must not land in the host's old log, about to be replaced).
    await store.appendConversation(sis('b'), info(30, 'B dopo il taglio'));
    expect(existsSync(log(host, 'conversation.merged.jsonl'))).toBe(false);
    expect(existsSync(log(sis('b')))).toBe(false);
    expect(texts(await store.readConversation(sis('c')))).toEqual([...view, 'b:B dopo il taglio']);
    expect(await store.migrateConversation(host, IDLE)).toBe('done');
    expect(texts(await store.readConversation(host))).toEqual([...view, 'b:B dopo il taglio']);
  });

  it('concurrent writes during the migration all land once (one lock for the group)', async () => {
    await oldLogs();
    const writes = Array.from({ length: 30 }, (_, i) => store.appendConversation(i % 2 ? sis('b') : sis('c'), info(40 + i, `w${i}`)));
    const [result] = await Promise.all([store.migrateConversation(host, IDLE), ...writes]);
    expect(result).toBe('migrated');
    const all = texts(await store.readConversation(host)).filter((x) => /:w\d+$/.test(x));
    expect(all.sort()).toEqual(Array.from({ length: 30 }, (_, i) => `${i % 2 ? 'b' : 'c'}:w${i}`).sort());
  });

  it('a host whose group is gone (its last sister left) keeps the merged chat; its own readers still see only its turns', async () => {
    await oldLogs();
    await store.migrateConversation(host, IDLE);
    await store.appendConversation(sis('b'), session(60, 'jb2', 'sb2'));
    await store.update(host, { variantGroup: undefined });
    expect(texts(await store.readConversation(host)).at(-1)).toBe('b:jb2');
    expect((await store.lastTurnSession(host))?.sessionId).toBe('sa');
  });

  it('a sister that leaves the group after the merge reads its history from before it', async () => {
    await oldLogs();
    await store.migrateConversation(host, IDLE);
    const g = (await store.get(host)).variantGroup!;
    await store.update(host, { variantGroup: { ...g, members: g.members.filter((m) => m.letter !== 'c') } });
    await store.appendConversation(sis('c'), info(50, 'orfana'));
    expect(texts(await store.readConversation(sis('c')))).toEqual(['-:ciao C', '-:orfana']);
  });
});

describe('review fixes of the merge', () => {
  const forged = JSON.stringify(session(99, 'jx', 'forged-session')) + '\n';

  it('C1: the merge files are core files (the agent cannot write them; the tripwire watches them)', () => {
    expect(CREATIVE_CORE_FILES).toEqual(expect.arrayContaining(['conversation.merged.jsonl', 'conversation.premerge.jsonl']));
  });

  it('C1: a conversation.merged.jsonl that appears in a merged group is never adopted: nothing is lost, no session planted', async () => {
    await oldLogs();
    await store.migrateConversation(host, IDLE);
    await store.appendConversation(sis('b'), info(30, 'dopo il merge'));
    const before = texts(await store.readConversation(host));
    await writeFile(log(host, 'conversation.merged.jsonl'), forged);
    await store.appendConversation(sis('c'), info(31, 'ancora'));
    expect(texts(await store.readConversation(sis('b')))).toEqual([...before, 'c:ancora']);
    expect((await store.lastTurnSession(host))?.sessionId).toBe('sa');
    expect(await store.migrateConversation(host, IDLE)).toBe('done');
    expect(texts(await store.readConversation(host))).toEqual([...before, 'c:ancora']);
  });

  it('C1: cut after the commit point, a forged merged log is refused; the merge is rebuilt from the copies', async () => {
    await oldLogs();
    const view = texts(await store.readConversation(host));
    await expect(store.migrateConversation(host, IDLE, { afterFlag: async () => { throw new Error('crash'); } })).rejects.toThrow('crash');
    await writeFile(log(host, 'conversation.merged.jsonl'), forged);
    expect(texts(await store.readConversation(sis('c')))).toEqual(view);
    expect((await store.get(host)).variantGroup?.chatMerge).toBeUndefined();
    expect(existsSync(log(sis('b')))).toBe(false);
  });

  it('minor 1: cut after the host took the merged log but before a sister\'s log was retired: the next access retires it; an orphan never reads it twice', async () => {
    await oldLogs();
    const view = texts(await store.readConversation(host));
    await expect(store.migrateConversation(host, IDLE, { afterAdopt: async () => { throw new Error('crash'); } })).rejects.toThrow('crash');
    expect(existsSync(log(sis('b')))).toBe(true);
    expect(texts(await store.readConversation(host))).toEqual(view);
    expect(existsSync(log(sis('b')))).toBe(false);
    expect((await store.get(host)).variantGroup?.chatMerge).toBeUndefined();
    // An orphan whose log starts with its copy (an unfinished retire, by hand) reads it once.
    const g = (await store.get(host)).variantGroup!;
    await store.update(host, { variantGroup: { ...g, members: g.members.filter((m) => m.letter !== 'c') } });
    await writeFile(log(sis('c')), await raw(sis('c'), 'conversation.premerge.jsonl'));
    await store.appendConversation(sis('c'), info(50, 'orfana'));
    expect(texts(await store.readConversation(sis('c')))).toEqual(['-:ciao C', '-:orfana']);
  });

  it('minor 4 and 2: a member\'s log found again after the merge (its folder was missing) is merged in at the next idle merge; no earlier copy is overwritten', async () => {
    await oldLogs();
    const bLog = await raw(sis('b'));
    await rm(join(dir, 'creatives', sis('b')), { recursive: true });
    await store.migrateConversation(host, IDLE);
    const hostCopy = await raw(host, 'conversation.premerge.jsonl');
    expect(texts(await store.readConversation(host)).filter((x) => x.startsWith('b:'))).toEqual([]);
    // The folder comes back (from a backup, or git).
    const at = T(0);
    await store.createSister(host, 'b', { schemaVersion: 1, title: 'Lancio', brief, status: 'draft', error: null, createdAt: at, updatedAt: at, resumeFrom: null, linkedCodebases: [], variantOf: host }).catch(() => null);
    await writeFile(log(sis('b')), bLog);
    await store.appendConversation(host, info(40, 'A più tardi'));
    expect(await store.migrateConversation(host, async () => false)).toBe('busy');
    expect(await store.migrateConversation(host, IDLE)).toBe('migrated');
    expect(texts(await store.readConversation(host))).toEqual(['a:ciao A', 'b:ciao B', 'b:jb', 'a:A fatto', 'c:ciao C', 'a:ja', 'b:B fatto', 'a:A più tardi']);
    expect(existsSync(log(sis('b')))).toBe(false);
    // The first copy of the host's log is still there, beside the second.
    expect(await raw(host, 'conversation.premerge.jsonl')).toBe(hostCopy);
    const copies = (await readdir(join(dir, 'creatives', host))).filter((f) => f.startsWith('conversation.premerge'));
    expect(copies.length).toBe(2);
    // A new sister's empty log is no reason to merge again.
    expect(await store.migrateConversation(host, IDLE)).toBe('done');
  });

  it('steady state: a merged group needs nothing (the conversation route skips the locks)', async () => {
    await oldLogs();
    expect(await store.chatNeedsMerge(host)).toBe(true);
    await store.migrateConversation(host, IDLE);
    expect(await store.chatNeedsMerge(host)).toBe(false);
    expect(await store.chatNeedsMerge(sis('b'))).toBe(false);
  });
});

describe('second review round of the merge', () => {
  it('item 2: a member\'s log found again keeps no foreign stamp: every entry is that member\'s', async () => {
    await oldLogs();
    const bLog = await raw(sis('b'));
    await rm(join(dir, 'creatives', sis('b')), { recursive: true });
    await store.migrateConversation(host, IDLE);
    const at = T(0);
    await store.createSister(host, 'b', { schemaVersion: 1, title: 'Lancio', brief, status: 'draft', error: null, createdAt: at, updatedAt: at, resumeFrom: null, linkedCodebases: [], variantOf: host });
    await writeFile(log(sis('b')), bLog + JSON.stringify({ ...info(7, 'timbro estraneo'), variant: 'c' }) + '\n');
    expect(await store.migrateConversation(host, IDLE)).toBe('migrated');
    expect(texts(await store.readConversation(host)).filter((x) => x.endsWith('timbro estraneo'))).toEqual(['b:timbro estraneo']);
  });

  it('item 3: a normal merge warns about nothing; a foreign merged file in the window is warned about once and removed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await oldLogs();
      await store.migrateConversation(host, IDLE);
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it('item 3: the foreign file found in the window is removed after the warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await oldLogs();
      await expect(store.migrateConversation(host, IDLE, { afterFlag: async () => { throw new Error('crash'); } })).rejects.toThrow('crash');
      await writeFile(log(host, 'conversation.merged.jsonl'), 'forged\n');
      await store.readConversation(host);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(existsSync(log(host, 'conversation.merged.jsonl'))).toBe(false);
    } finally { warn.mockRestore(); }
  });

  it('item 4: a member that left during the crash window: the merge is rebuilt with each copy\'s own letter and its log is not retired', async () => {
    await oldLogs();
    const view = texts(await store.readConversation(host));
    await expect(store.migrateConversation(host, IDLE, { afterMerged: async () => {}, afterFlag: async () => { throw new Error('crash'); } })).rejects.toThrow('crash');
    // Lost merged file (rebuild path) and C leaves the group meanwhile.
    await rm(log(host, 'conversation.merged.jsonl'));
    const g = (await store.get(host)).variantGroup!;
    await store.update(host, { variantGroup: { ...g, members: g.members.filter((m) => m.letter !== 'c') } });
    expect(texts(await store.readConversation(host))).toEqual(view);
    expect(existsSync(log(sis('c')))).toBe(true);
    expect((await store.get(host)).variantGroup?.chatMerge).toBeUndefined();
  });

  it('item 4: settleChat finishes a pending merge (called before a group dissolves)', async () => {
    await oldLogs();
    const view = texts(await store.readConversation(host));
    await expect(store.migrateConversation(host, IDLE, { afterFlag: async () => { throw new Error('crash'); } })).rejects.toThrow('crash');
    await store.settleChat(host);
    expect((await store.get(host)).variantGroup?.chatMerge).toBeUndefined();
    await store.update(host, { variantGroup: undefined });
    expect(texts(await store.readConversation(host))).toEqual(view);
  });

  it('item 1: the merge tells its caller exactly the copies it took (the only ones committed)', async () => {
    await oldLogs();
    await writeFile(log(sis('b'), 'conversation.premerge-planted.jsonl'), 'x\n');
    const taken: string[] = [];
    await store.migrateConversation(host, IDLE, { copies: async (files) => { taken.push(...files); } });
    expect(taken.sort()).toEqual([log(host, 'conversation.premerge.jsonl'), log(sis('b'), 'conversation.premerge.jsonl'), log(sis('c'), 'conversation.premerge.jsonl')].sort());
  });
});
