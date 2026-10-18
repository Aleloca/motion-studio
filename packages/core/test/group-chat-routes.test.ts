// @vitest-environment node
/**
 * Decisions 980 and 982 (phase 2 of the single agent), through the app: every member's conversation route answers the
 * group's one chat, each entry with its variant; the group's chats merge once, lazily, on a read while no member works or
 * waits; sending keeps today's targets (a variant's own turn, "Tutte" as the fan-out), and its entries land once in the one
 * chat. Controlled runner only (no `claude`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationEntry } from '@motion-studio/shared';
import { cid } from './helpers/live-app.ts';
import { variantApp, type VariantApp } from './helpers/variant-app.ts';

vi.setConfig({ testTimeout: 60_000 });

let v: VariantApp;
afterEach(async () => { await v?.close(); });

const chat = async (slug: string) => (await v.app.inject(`${v.url(slug)}/conversation`)).json() as ConversationEntry[];
const users = (es: ConversationEntry[]) => es.filter((e) => e.type === 'user').map((e) => `${e.variant}:${e.type === 'user' ? e.text : ''}`);
const merged = async (slug: string) => (await v.detail(slug)).creative.variantGroup?.chat;

describe('one chat per variant group (phase 2)', () => {
  it('the fan-out lands in one chat with labels; the merge waits for the group to be idle, then happens once', async () => {
    v = await variantApp();
    const slug = await v.group(['Audace', 'Calma', 'Retro']);
    const res = await v.app.inject({ method: 'POST', url: `${v.url(slug)}/variants/run`, payload: { targets: 'all-active', request: { text: 'Più contrasto' } } });
    expect(res.statusCode, res.body).toBe(202);
    // The same chat from every member, each request labelled with its variant (one turn per variant, as today).
    for (const s of [slug, `${slug}~b`, `${slug}~c`]) expect(users(await chat(s)).sort(), s).toEqual(['a:Più contrasto', 'b:Più contrasto', 'c:Più contrasto']);
    // Working: not merged yet (each member still writes its own log).
    expect(await merged(slug)).toBeUndefined();
    expect(existsSync(join(v.projectDir, 'creatives', `${slug}~b`, 'conversation.jsonl'))).toBe(true);
    const [ra, rb] = [await v.runOf(slug), await v.runOf(`${slug}~b`)];
    ra.finish();
    rb.finish();
    (await v.runOf(`${slug}~c`)).finish();
    await v.waitIdle();
    const before = await chat(`${slug}~c`);
    expect(await merged(slug)).toBe('single');
    for (const l of ['b', 'c']) {
      expect(existsSync(join(v.projectDir, 'creatives', `${slug}~${l}`, 'conversation.jsonl')), l).toBe(false);
      expect(existsSync(join(v.projectDir, 'creatives', `${slug}~${l}`, 'conversation.premerge.jsonl')), l).toBe(true);
    }
    expect(execFileSync('git', ['log', '--format=%s'], { cwd: v.projectDir, encoding: 'utf8' })).toMatch(/chat delle varianti unite|variants' chats merged/);
    expect(execFileSync('git', ['status', '--porcelain', '--', `creatives/${slug}~b/conversation.jsonl`], { cwd: v.projectDir, encoding: 'utf8' })).toBe('');
    // Same entries, same order, from any member.
    expect(await chat(slug)).toEqual(before);
    expect(await chat(`${slug}~b`)).toEqual(before);
    // Every version line says whose it is.
    expect(before.filter((e) => e.type === 'version').map((e) => e.variant).sort()).toEqual(['a', 'b', 'c']);
  });

  it('after the merge, a variant\'s own turn still goes to that variant only (today\'s target), resumes its own session, and its queued message is written once', async () => {
    v = await variantApp();
    const slug = await v.group(['Audace', 'Calma']);
    await v.app.inject({ method: 'POST', url: `${v.url(slug)}/variants/run`, payload: { targets: 'all-active', request: null } });
    const first = await v.runOf(`${slug}~b`);
    first.finish();
    (await v.runOf(slug)).finish();
    await v.waitIdle();
    await chat(slug);
    expect(await merged(slug)).toBe('single');
    // A message on B: B's turn, nobody else's.
    const turn = await v.app.inject({ method: 'POST', url: `${v.url(`${slug}~b`)}/turns`, payload: { text: 'Titolo più grande' } });
    expect(turn.statusCode, turn.body).toBe(202);
    const rb = await v.runOf(`${slug}~b`, 1);
    expect(rb.req.resumeSessionId).toBe(first.sessionId);
    expect(v.runner.runs.filter((r) => r.req.prompt.includes(`creatives/${slug}/outputs`))).toHaveLength(1);
    // While B works, a queued message for after.
    const clientId = cid();
    const q = await v.app.inject({ method: 'POST', url: `${v.url(`${slug}~b`)}/messages`, payload: { clientId, text: 'Poi il colore', mode: 'queued' } });
    expect(q.statusCode, q.body).toBe(200);
    // Busy (B works, B has a queue): A's chat is the group's, B's message labelled.
    expect(users(await chat(slug))).toContain('b:Titolo più grande');
    rb.finish();
    const next = await v.runOf(`${slug}~b`, 2);
    next.finish();
    await v.waitIdle();
    const all = await chat(slug);
    expect(users(all).filter((x) => x === 'b:Poi il colore')).toHaveLength(1);
    expect(users(all).filter((x) => x === 'b:Titolo più grande')).toHaveLength(1);
    expect(all.every((e) => e.variant === 'a' || e.variant === 'b')).toBe(true);
    // The host's log holds it all; B has no log of its own any more.
    expect(existsSync(join(v.projectDir, 'creatives', `${slug}~b`, 'conversation.jsonl'))).toBe(false);
  });
});
