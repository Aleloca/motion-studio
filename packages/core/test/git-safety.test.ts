import { existsSync } from 'node:fs';
import { appendFile, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execCommand } from '../src/exec.ts';
import { Git } from '../src/git.ts';
import { configVerdict, dangerousAttributeLines, hardenedGitEnv, inspectGitSafety, parseGitConfigList } from '../src/git-safety.ts';

const cleanup: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const d of cleanup.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tmp(prefix = 'ms-gitsafe-'): Promise<string> {
  const p = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(p);
  return p;
}
/** A real `git init` repo (the core's own init), with `extra` appended to its .git/config. */
async function repo(extra = ''): Promise<string> {
  const p = await tmp();
  await new Git().init(p);
  if (extra) await appendFile(join(p, '.git', 'config'), extra);
  return p;
}

describe('parseGitConfigList and configVerdict', () => {
  it('reads origin, key and value (a key with no value too)', () => {
    expect(parseGitConfigList('file:/p/.git/config\0core.bare\nfalse\0command line:\0core.hookspath\n/dev/null\0file:/p/.git/config\0x.flag\0')).toEqual([
      { origin: 'file:/p/.git/config', key: 'core.bare', value: 'false' },
      { origin: 'command line:', key: 'core.hookspath', value: '/dev/null' },
      { origin: 'file:/p/.git/config', key: 'x.flag', value: null },
    ]);
  });
  it('allows the init keys, user.* and the vetted remote/branch keys with plain values', () => {
    for (const [k, v] of [['core.filemode', 'true'], ['user.name', 'x'], ['remote.origin.url', 'https://example.com/r.git'], ['remote.my.fork.pushurl', 'git@host:r.git'],
      ['remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], ['branch.main.remote', 'origin'], ['branch.feat/x.merge', 'refs/heads/feat/x'], ['branch.main.rebase', 'true']] as const) {
      expect(configVerdict(k, v), k).toBe('ok');
    }
  });
  it('refuses dangerous second-tier values and every other key', () => {
    for (const v of ['ext::sh -c touch% /tmp/x', 'EXT::x', '!sh', 'origin --upload-pack=evil', 'x --receive-pack=evil']) expect(configVerdict('remote.origin.url', v), v).toBe('value');
    expect(configVerdict('branch.main.remote', '!x')).toBe('value');
    for (const k of ['filter.lfs.clean', 'filter.lfs.process', 'diff.x.textconv', 'diff.x.command', 'core.sshcommand', 'remote.origin.uploadpack',
      'remote.origin.receivepack', 'remote.origin.proxy', 'branch.main.pushremote', 'include.path', 'includeif.gitdir:/x.path', 'alias.co', 'credential.helper', 'extensions.worktreeconfig']) {
      expect(configVerdict(k, 'x'), k).toBe('key');
    }
  });
});

describe('dangerousAttributeLines', () => {
  it('flags filter/diff/custom-merge drivers but not built-ins or plain attributes', () => {
    expect(dangerousAttributeLines('.studio/usage.jsonl merge=union\n')).toEqual([]);
    expect(dangerousAttributeLines('*.png binary\n*.txt text eol=lf\n# comment filter=x\n   # indented comment filter=x\n')).toEqual([]);
    expect(dangerousAttributeLines('*.py diff=python\n*.java diff=java\n')).toEqual([]);
    expect(dangerousAttributeLines('*.c filter=indent\n')).toEqual(['*.c filter=indent']);
    expect(dangerousAttributeLines('*.bin diff=hexdump\n')).toEqual(['*.bin diff=hexdump']);
    expect(dangerousAttributeLines('x merge=mine\n')).toEqual(['x merge=mine']);
    expect(dangerousAttributeLines('[attr]m filter=x\n')).toEqual(['[attr]m filter=x']);
  });
  it('a # in the middle of a line is not a comment', () => {
    expect(dangerousAttributeLines('*#* filter=x\n')).toEqual(['*#* filter=x']);
    expect(dangerousAttributeLines('a #b filter=x\n')).toEqual(['a #b filter=x']);
  });
  it('a built-in diff name is refused when the config defines that driver', () => {
    expect(dangerousAttributeLines('*.py diff=python\n', new Set(['diff.python.textconv']))).toEqual(['*.py diff=python']);
  });
});

describe('inspectGitSafety (decisions log 141)', () => {
  it('accepts a fresh git init, plus user.*, and a folder with no repo yet', async () => {
    expect(await inspectGitSafety(await repo())).toBeNull();
    expect(await inspectGitSafety(await repo('[user]\n  name = Motion Studio\n  email = a@b\n'))).toBeNull();
    expect(await inspectGitSafety(await tmp('ms-norepo-'))).toBeNull();
  });
  it('accepts the second tier: a remote and its tracking branch, and diff=python attributes', async () => {
    const p = await repo('[remote "origin"]\n\turl = https://example.com/r.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n\tpushurl = git@example.com:r.git\n[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n\trebase = true\n');
    await writeFile(join(p, '.gitattributes'), '*.py diff=python\n.studio/usage.jsonl merge=union\n');
    expect(await inspectGitSafety(p)).toBeNull();
  });
  it('refuses dangerous remote values, naming the key and the fix', async () => {
    for (const v of ['ext::sh -c evil', '!evil', 'x --upload-pack=evil']) {
      const msg = await inspectGitSafety(await repo(`[remote "origin"]\n\turl = "${v}"\n`));
      expect(msg, v).toContain('remote.origin.url');
      expect(msg, v).toContain('git config');
    }
  });
  it('blocks the command-running and include keys, naming the key', async () => {
    for (const [bad, key] of [
      ['[filter "lfs"]\n  clean = run-me\n', 'filter.lfs.clean'], ['[filter "lfs"]\n  process = git-lfs filter-process\n  required = true\n', 'filter.lfs.process'],
      ['[diff "x"]\n  textconv = cat\n', 'diff.x.textconv'], ['[core]\n  sshCommand = ssh -i evil\n', 'core.sshcommand'],
      ['[core]\n  fsmonitor = /x\n', 'core.fsmonitor'], ['[core]\n  pager = less\n', 'core.pager'], ['[alias]\n  co = !sh\n', 'alias.co'],
      ['[credential]\n  helper = evil\n', 'credential.helper'], ['[remote "o"]\n  uploadpack = evil\n', 'remote.o.uploadpack'],
      ['[include]\n  path = /nonexistent/evil\n', 'include.path'],
    ] as const) {
      const msg = await inspectGitSafety(await repo(bad));
      expect(msg, bad).not.toBeNull();
      expect(msg, bad).toContain(key);
    }
  });
  it('blocks a key loaded through an include from another file (origin check)', async () => {
    const other = join(await tmp('ms-inc-'), 'evil.cfg');
    await writeFile(other, '[core]\n\tfilemode = true\n');
    const msg = await inspectGitSafety(await repo(`[include]\n\tpath = ${other}\n`));
    expect(msg).not.toBeNull();
  });
  it('blocks a .git/commondir, a .git/config.worktree, a gitdir: file, and a .git/config that is a folder', async () => {
    const a = await repo();
    await writeFile(join(a, '.git', 'commondir'), '../evil\n');
    expect(await inspectGitSafety(a)).toContain('.git/commondir');
    const b = await repo();
    await writeFile(join(b, '.git', 'config.worktree'), '[filter "x"]\n\tclean = evil\n');
    expect(await inspectGitSafety(b)).toContain('.git/config.worktree');
    const c = await repo();
    const elsewhere = await tmp('ms-gitdir-');
    await cp(join(c, '.git'), join(elsewhere, 'g'), { recursive: true });
    await rm(join(c, '.git'), { recursive: true });
    await writeFile(join(c, '.git'), `gitdir: ${join(elsewhere, 'g')}\n`);
    expect(await inspectGitSafety(c)).toContain('gitdir:');
    const d = await tmp();
    await mkdir(join(d, '.git', 'config'), { recursive: true });
    expect(await inspectGitSafety(d)).not.toBeNull();
  });
  it('checks every attributes file: a subfolder one, an ignored one, info/attributes, and a mid-line #', async () => {
    const sub = await repo();
    await mkdir(join(sub, 'sub'), { recursive: true });
    await writeFile(join(sub, 'sub', '.gitattributes'), '* filter=x\n');
    expect(await inspectGitSafety(sub)).toContain('sub/.gitattributes');
    const ignored = await repo();
    await mkdir(join(ignored, 'ign'), { recursive: true });
    await writeFile(join(ignored, '.gitignore'), 'ign/\n.gitattributes\n');
    await writeFile(join(ignored, 'ign', '.gitattributes'), '* filter=x\n');
    expect(await inspectGitSafety(ignored)).toContain('ign/.gitattributes');
    const info = await repo();
    await writeFile(join(info, '.git', 'info', 'attributes'), '* diff=hexdump\n');
    expect(await inspectGitSafety(info)).toContain('.git/info/attributes');
    const hash = await repo();
    await writeFile(join(hash, '.gitattributes'), '*#* filter=x\n');
    expect(await inspectGitSafety(hash)).not.toBeNull();
  });
});

describe('the commondir bypass from the review (M1), end to end', () => {
  it('a filter defined in a config reached through .git/commondir never runs and nothing is committed', async () => {
    const p = await repo();
    const lab = await tmp('ms-evil-');
    const marker = join(lab, 'ran');
    await cp(join(p, '.git'), join(lab, 'evil'), { recursive: true });
    await appendFile(join(lab, 'evil', 'config'), `[filter "x"]\n\tclean = sh -c 'touch ${marker}; cat'\n`);
    await writeFile(join(p, '.git', 'commondir'), `${join(lab, 'evil')}\n`);
    await mkdir(join(p, 'sub'), { recursive: true });
    await writeFile(join(p, 'sub', '.gitattributes'), '* filter=x\n');
    await writeFile(join(p, 'sub', 'a.txt'), 'x');
    await expect(new Git().commitAll(p, 'c')).rejects.toThrow('.git/commondir');
    expect(existsSync(marker)).toBe(false);
  });
});

describe('hardenedGitEnv', () => {
  it('drops every inherited GIT_* and pins the repository', () => {
    vi.stubEnv('GIT_DIR', '/elsewhere/.git');
    vi.stubEnv('GIT_CONFIG_PARAMETERS', "'filter.x.clean'='evil'");
    vi.stubEnv('GIT_INDEX_FILE', '/elsewhere/index');
    vi.stubEnv('GIT_EXTERNAL_DIFF', 'evil');
    const env = hardenedGitEnv('/p/proj');
    expect(env.GIT_DIR).toBe('/p/proj/.git');
    expect(env.GIT_WORK_TREE).toBe('/p/proj');
    expect(env.GIT_COMMON_DIR).toBe('/p/proj/.git');
    expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
    expect(env.GIT_INDEX_FILE).toBeUndefined();
    expect(env.GIT_EXTERNAL_DIFF).toBeUndefined();
    expect(hardenedGitEnv().GIT_DIR).toBeUndefined();
  });
  it('commits in the project even when the app was started with GIT_DIR pointing elsewhere', async () => {
    const p = await repo();
    const other = await repo();
    vi.stubEnv('GIT_DIR', join(other, '.git'));
    await writeFile(join(p, 'a.txt'), 'x');
    expect(await new Git().commitAll(p, 'c')).toMatch(/^[0-9a-f]{40}$/);
    vi.unstubAllEnvs();
    expect((await execCommand('git', ['log', '--oneline'], { cwd: other })).code).not.toBe(0);
  });
});
