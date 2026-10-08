import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerMessage } from '@motion-studio/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalBroker, describeRequest } from '../src/approvals/broker.ts';
import { PermissionsStore, ruleFor } from '../src/approvals/permissions-store.ts';

let projectDir: string;
let messages: ServerMessage[];
beforeEach(async () => { projectDir = await mkdtemp(join(tmpdir(), 'ms-appr è ')); messages = []; });
const input = (over = {}) => ({ jobId: 'j1', projectSlug: 'acme', projectDir, creativeSlug: 'c1', kind: 'tool' as const, toolName: 'Bash', input: { command: 'brew install ffmpeg' }, ...over });

describe('ruleFor', () => {
  it.each([
    ['Bash', { command: 'brew install ffmpeg' }, 'Bash(brew:*)'],
    ['Bash', { command: 'sudo rm -rf /' }, null],
    ['Bash', { command: 'rm -rf build' }, null],
    ['Write', { file_path: '/Users/me/Desktop/out [1]/a.png' }, 'Edit(//Users/me/Desktop/out \\[1\\]/**)'],
    ['Write', { file_path: '/a.txt' }, null],
    ['WebFetch', { url: 'https://www.python.org/about' }, 'WebFetch(domain:www.python.org)'],
    ['provider:openai-images', {}, 'provider:openai-images'],
    ['mcp__other__x', {}, 'mcp__other__x'],
    ['Unknown', {}, null],
  ])('%s %j → %s', (tool, inp, rule) => { expect(ruleFor(tool, inp)?.rule ?? null).toBe(rule); });
});

describe('describeRequest', () => {
  it('summarizes in Italian', () => {
    expect(describeRequest('Bash', { command: 'brew install ffmpeg' })).toEqual({ title: 'Eseguire un comando', detail: 'brew install ffmpeg' });
    expect(describeRequest('Write', { file_path: '/x/a.txt' })).toEqual({ title: 'Modificare un file fuori dal progetto', detail: '/x/a.txt' });
  });
});

describe('ApprovalBroker', () => {
  it('broadcasts, resolves once and records "always" rules', async () => {
    const broker = new ApprovalBroker({ broadcast: (m) => messages.push(m) });
    const p = broker.request(input());
    const [req] = broker.pending();
    expect(req).toMatchObject({ projectSlug: 'acme', creativeSlug: 'c1', title: 'Eseguire un comando', alwaysRule: 'Bash(brew:*)' });
    expect(messages[0]).toMatchObject({ type: 'approval' });
    await broker.decide(req!.id, 'always');
    expect(await p).toEqual({ decision: 'always' });
    expect(await new PermissionsStore(projectDir).list()).toEqual([expect.objectContaining({ rule: 'Bash(brew:*)', label: 'Comandi "brew"' })]);
    expect(messages.at(-1)).toEqual({ type: 'approval_resolved', id: req!.id, decision: 'always' });
    expect((await broker.decide(req!.id, 'deny').catch((e) => e)).status).toBe(404);
  });
  it('expires after the timeout', async () => {
    const broker = new ApprovalBroker({ broadcast: (m) => messages.push(m), timeoutMs: 30 });
    expect(await broker.request(input())).toEqual({ decision: 'expired' });
    expect(broker.pending()).toEqual([]);
  });
  it('a second concurrent decide gets 404 and a failed "always" write still resolves as once', async () => {
    const broker = new ApprovalBroker({ broadcast: (m) => messages.push(m) });
    const p = broker.request(input());
    const [req] = broker.pending();
    const results = await Promise.allSettled([broker.decide(req!.id, 'once'), broker.decide(req!.id, 'deny')]);
    expect(results[0]!.status).toBe('fulfilled');
    expect((results[1] as PromiseRejectedResult).reason.status).toBe(404);
    expect(await p).toEqual({ decision: 'once' });

    await mkdir(join(projectDir, '.studio'), { recursive: true });
    await writeFile(join(projectDir, '.studio', 'permissions.json'), '{bad');
    const p2 = broker.request(input());
    const [req2] = broker.pending();
    await expect(broker.decide(req2!.id, 'always')).rejects.toMatchObject({ reason: 'invalid-json' });
    expect(await p2).toEqual({ decision: 'once' });
    expect(messages.at(-1)).toEqual({ type: 'approval_resolved', id: req2!.id, decision: 'once' });
  });
  it('cancels the requests of a job and everything on close', async () => {
    const broker = new ApprovalBroker({ broadcast: () => {} });
    const a = broker.request(input());
    const b = broker.request(input({ jobId: 'j2' }));
    broker.cancelJob('j1');
    expect(await a).toEqual({ decision: 'cancelled' });
    broker.cancelAll();
    expect(await b).toEqual({ decision: 'cancelled' });
  });
});

describe('PermissionsStore', () => {
  it('adds without duplicates, removes and never rewrites a corrupt file', async () => {
    const s = new PermissionsStore(projectDir);
    await s.add('Bash(brew:*)', 'x');
    await s.add('Bash(brew:*)', 'x');
    expect(await s.list()).toHaveLength(1);
    expect(await s.has('Bash(brew:*)')).toBe(true);
    await s.remove('Bash(brew:*)');
    expect((await s.remove('Bash(brew:*)').catch((e) => e)).status).toBe(404);
    await mkdir(join(projectDir, '.studio'), { recursive: true });
    await writeFile(join(projectDir, '.studio', 'permissions.json'), '{bad');
    await expect(s.add('Bash(x:*)', 'x')).rejects.toMatchObject({ reason: 'invalid-json' });
    expect(await readFile(join(projectDir, '.studio', 'permissions.json'), 'utf8')).toBe('{bad');
  });
});
