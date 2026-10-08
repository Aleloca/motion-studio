import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ServerMessage } from '@motion-studio/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalBroker, describeRequest } from '../src/approvals/broker.ts';
import { isAllowedRule, PermissionsStore, ruleFor } from '../src/approvals/permissions-store.ts';

let projectDir: string;
let messages: ServerMessage[];
beforeEach(async () => { projectDir = await mkdtemp(join(tmpdir(), 'ms-appr è ')); messages = []; });
const input = (over = {}) => ({ jobId: 'j1', projectSlug: 'acme', projectDir, creativeSlug: 'c1', kind: 'tool' as const, toolName: 'Bash', input: { command: 'ls -la' }, ...over });

describe('ruleFor', () => {
  it.each([
    ['Bash', { command: 'brew install ffmpeg' }, null],
    ['Bash', { command: 'ls -la' }, 'Bash(ls:*)'],
    ['Bash', { command: 'sudo rm -rf /' }, null],
    ['Bash', { command: 'rm -rf build' }, null],
    ['Write', { file_path: '/Users/me/Desktop/out [1]/a.png' }, 'Edit(//Users/me/Desktop/out \\[1\\]/**)'],
    ['Write', { file_path: '/a.txt' }, null],
    ['WebFetch', { url: 'https://www.python.org/about' }, 'WebFetch(domain:www.python.org)'],
    ['provider:openai-images', {}, 'provider:openai-images'],
    ['mcp__other__x', {}, null],
    ['mcp__studio__report_progress', {}, 'mcp__studio__report_progress'],
    ['mcp__studio__approve', {}, null],
    ['Unknown', {}, null],
  ])('%s %j → %s', (tool, inp, rule) => { expect(ruleFor(tool, inp)?.rule ?? null).toBe(rule); });
});

describe('ruleFor hardening', () => {
  const env = { home: '/Users/me', platform: 'darwin' as const, configDir: '/Users/me/Library/Application Support/Motion Studio' };
  const rule = (tool: string, inp: unknown) => ruleFor(tool, inp, env)?.rule ?? null;
  it.each([
    ['Write', { file_path: '/Users/x.txt' }, null],
    ['Write', { file_path: '/users/me/a' }, null],
    ['Write', { file_path: '/Users/me/.ssh/a' }, null],
    ['Read', { file_path: '/Users/me/.aws/credentials' }, null],
    ['Write', { file_path: '/Users/me/Library/Application Support/Motion Studio/x.json' }, null],
    ['Write', { file_path: '/Users/me/a' }, null],
    ['Write', { file_path: '/Users/me/Desktop/./a.png' }, 'Edit(//Users/me/Desktop/**)'],
    ['Write', { file_path: '/Users/me/Desktop/x/../../Docs/a.png' }, 'Edit(//Users/me/Docs/**)'],
    ['Bash', { command: 'node script.js' }, null],
    ['Bash', { command: 'node -e "x"' }, null],
    ['Bash', { command: 'python3.12 x.py' }, null],
    ['Bash', { command: 'node22 x.js' }, null],
    ['Bash', { command: 'pwsh -c x' }, null],
    ['Bash', { command: 'php x.php' }, null],
    ['Bash', { command: 'npm run build' }, null],
    ['Bash', { command: 'npm exec foo' }, null],
    ['Bash', { command: 'uv run x.py' }, null],
    ['Bash', { command: 'Bash -c x' }, null],
    ['Bash', { command: 'SH -c x' }, null],
    ['Bash', { command: 'FFMPEG -i a b' }, null],
    ['Bash', { command: 'env FOO=1 ls' }, null],
    ['Bash', { command: './run.sh' }, null],
    ['Bash', { command: 'git status' }, null],
    ['Bash', { command: 'brew upgrade' }, null],
    ['Bash', { command: 'ffprobe -i a' }, 'Bash(ffprobe:*)'],
    ['Bash', { command: 'ffprobe -i a; rm -rf x' }, null],
    ['Bash', { command: 'ffmpeg -i a b' }, null],
    ['Bash', { command: 'tar xf a --use-compress-program=x' }, null],
    ['Bash', { command: 'magick a b' }, null],
    ['Bash', { command: 'convert a b' }, null],
    ['Bash', { command: 'cp x ~/.zshrc' }, null],
    ['Bash', { command: 'mv x y' }, null],
    ['Bash', { command: 'unzip a.zip' }, null],
    ['Bash', { command: 'ls $(rm x)' }, null],
    ['Read', { file_path: '/etc/passwd' }, null],
    ['Write', { file_path: '/Applications/X.app/a' }, null],
    ['Write', { file_path: '/Users/me/.claude/hooks/a' }, null],
    ['Write', { file_path: '/Users/me/Library/LaunchAgents/a.plist' }, null],
    ['WebFetch', { url: 'http://2130706433/x' }, null],
    ['WebFetch', { url: 'http://127.1/x' }, null],
    ['WebFetch', { url: 'http://example.com:8080/x' }, 'WebFetch(domain:example.com)'],
    ['WebFetch', { url: 'http://[::1]/x' }, null],
    ['WebFetch', { url: 'http://localhost:3000/x' }, null],
    ['WebFetch', { url: 'http://192.168.1.5/x' }, null],
    ['Bash', { command: 'a'.repeat(600) }, null],
  ])('%s %j → %s', (tool, inp, expected) => { expect(rule(tool, inp)).toBe(expected); });
  it('truncates nothing silently: over-long rules are refused', () => {
    expect(rule('Write', { file_path: `/tmp/${'d'.repeat(600)}/a` })).toBeNull();
  });
});

describe('isAllowedRule', () => {
  it('accepts what ruleFor produces', () => {
    for (const [t, i] of [['Bash', { command: 'ls -la' }], ['Bash', { command: 'pngquant a.png' }], ['Write', { file_path: '/Users/me/Desktop/out [1]/a.png' }],
      ['Read', { file_path: '/tmp/a/b.txt' }], ['WebFetch', { url: 'https://www.python.org/' }], ['provider:tts-openai', {}], ['provider:openai-images', {}], ['mcp__studio__report_progress', {}]] as const) {
      const r = ruleFor(t, i);
      expect(r, t).not.toBeNull();
      expect(isAllowedRule(r!.rule), r!.rule).toBe(true);
    }
  });
  it.each([
    'Bash(*)', 'Bash(:*)', 'Bash(sudo:*)', 'Bash(env:*)', 'Bash(.:*)', 'Bash(node:*)', 'Bash(node -e:*)', 'Bash(brew:*)', 'Bash(brew install:*)', 'Bash(git status:*)',
    'Bash(Bash:*)', 'Bash(tar:*)', 'Bash(magick:*)', 'Bash(convert:*)', 'Bash(cp:*)', 'Bash(mv:*)', 'Bash(unzip:*)', 'Bash(ffmpeg:*)', 'Bash(SH:*)', 'Bash(python3.12:*)', 'Bash(npm run:*)', 'Bash(ffmpeg -i:*)', 'Bash(FFMPEG:*)',
    'WebFetch(domain:*)', 'WebFetch(domain:*.com)', 'WebFetch(domain:2130706433)', 'WebFetch(domain:0x7f000001)', 'WebFetch(domain:127.1)',
    'WebFetch(domain:example.com:8080)', 'WebFetch(domain:Example.com)', 'WebFetch(domain:com)',
    'Edit(//tmp/a\\x/**)', 'Edit(//tmp/a\nb/**)', 'Edit(//etc/**)', 'Edit(//Applications/Foo/**)', 'Edit(//tmp/a*/**)',
    'Edit(///**)', 'Edit(//**)', 'Edit(//Users/**)', 'Edit(//tmp/../etc/**)', 'Edit(//tmp/a)', 'Read(//**/**)',
    'WebFetch(domain:localhost)', 'WebFetch(domain:127.0.0.1)', 'WebFetch(*)', 'provider:evil', 'mcp__studio__approve', 'mcp__other__x', 'Write(x)', '',
  ])('rejects %j', (r) => { expect(isAllowedRule(r)).toBe(false); });
  it('rejects the home dir, its ancestors and sensitive folders', () => {
    const home = homedir();
    expect(isAllowedRule(`Edit(/${home}/**)`)).toBe(false);
    expect(isAllowedRule(`Edit(/${home}/.ssh/**)`)).toBe(false);
    expect(isAllowedRule(`Edit(/${dirname(home)}/**)`)).toBe(false);
  });
});

describe('always rules never reach .studio or the workspace root', () => {
  const env = { home: '/Users/me', platform: 'darwin' as const, configDir: '/Users/me/Library/Application Support/Motion Studio', workspaceRoot: '/Users/me/Motion Studio' };
  it.each([
    ['Write', { file_path: '/Users/me/Motion Studio/acme/.studio/permissions.json' }, null],
    ['Write', { file_path: '/Users/me/Motion Studio/acme/.studio/x/a.json' }, null],
    ['Write', { file_path: '/tmp/other/.STUDIO/a' }, null],
    ['Read', { file_path: '/tmp/other/.studio/a' }, null],
    ['Write', { file_path: '/Users/me/Motion Studio/a.json' }, null],
    ['Write', { file_path: '/Users/me/motion studio/a.json' }, null],
    ['Write', { file_path: '/Users/me/Motion Studio/acme/out/a.png' }, 'Edit(//Users/me/Motion Studio/acme/out/**)'],
    ['Write', { file_path: '/Users/me/Desktop/a.png' }, 'Edit(//Users/me/Desktop/**)'],
  ])('%s %j → %s', (tool, inp, expected) => { expect(ruleFor(tool, inp, env)?.rule ?? null).toBe(expected); });
  it('isAllowedRule refuses them too, with or without the workspace root', () => {
    expect(isAllowedRule('Edit(//tmp/p/.studio/**)')).toBe(false);
    expect(isAllowedRule('Edit(//Users/me/Motion Studio/**)', env)).toBe(false);
    expect(isAllowedRule('Edit(//tmp/p/out/**)')).toBe(true);
  });
  it('the broker offers no "always" rule inside the workspace root of the request', async () => {
    const broker = new ApprovalBroker({ broadcast: (m) => messages.push(m) });
    const p = broker.request(input({ toolName: 'Write', input: { file_path: join(dirname(projectDir), 'x.txt') } }));
    const req = (messages[0] as Extract<ServerMessage, { type: 'approval' }>).approval;
    expect(req.alwaysRule).toBeNull();
    broker.cancelAll();
    await p;
  });
});

describe('PermissionsStore limits', () => {
  it('refuses invalid rules and a 201st entry', async () => {
    const s = new PermissionsStore(projectDir);
    expect((await s.add('Bash(*)', 'x').catch((e) => e)).status).toBe(400);
    await mkdir(join(projectDir, '.studio'), { recursive: true });
    const allow = Array.from({ length: 200 }, (_, n) => ({ rule: `Bash(tool${n}:*)`, label: 'x', addedAt: new Date().toISOString() }));
    await writeFile(join(projectDir, '.studio', 'permissions.json'), JSON.stringify({ schemaVersion: 1, allow }));
    const err = await s.add('Bash(ls:*)', 'x').catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/Troppi permessi/);
  });
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
    expect(req).toMatchObject({ projectSlug: 'acme', creativeSlug: 'c1', title: 'Eseguire un comando', alwaysRule: 'Bash(ls:*)' });
    expect(messages[0]).toMatchObject({ type: 'approval' });
    await broker.decide(req!.id, 'always');
    expect(await p).toEqual({ decision: 'always' });
    expect(await new PermissionsStore(projectDir).list()).toEqual([expect.objectContaining({ rule: 'Bash(ls:*)', label: 'Comandi "ls"' })]);
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
    await s.add('Bash(ls:*)', 'x');
    await s.add('Bash(ls:*)', 'x');
    expect(await s.list()).toHaveLength(1);
    expect(await s.has('Bash(ls:*)')).toBe(true);
    await s.remove('Bash(ls:*)');
    expect((await s.remove('Bash(ls:*)').catch((e) => e)).status).toBe(404);
    await mkdir(join(projectDir, '.studio'), { recursive: true });
    await writeFile(join(projectDir, '.studio', 'permissions.json'), '{bad');
    await expect(s.add('Bash(ls:*)', 'x')).rejects.toMatchObject({ reason: 'invalid-json' });
    expect(await readFile(join(projectDir, '.studio', 'permissions.json'), 'utf8')).toBe('{bad');
  });
});
