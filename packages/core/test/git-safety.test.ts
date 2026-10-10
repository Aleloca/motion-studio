import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dangerousAttributeLines, inspectGitSafety, parseGitConfigKeys } from '../src/git-safety.ts';

const cleanup: string[] = [];
afterEach(async () => { for (const d of cleanup.splice(0)) await rm(d, { recursive: true, force: true }); });
async function repo(config: string): Promise<string> {
  const p = await mkdtemp(join(tmpdir(), 'ms-gitsafe-'));
  cleanup.push(p);
  await mkdir(join(p, '.git', 'info'), { recursive: true });
  await writeFile(join(p, '.git', 'config'), config);
  return p;
}
const INIT = '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n\tignorecase = true\n\tprecomposeunicode = true\n';

describe('parseGitConfigKeys', () => {
  it('reads sections, dotted and quoted subsections, and keys', () => {
    const keys = parseGitConfigKeys('[core]\n  filemode = true\n[filter "lfs"]\n  clean = x\n[includeIf "gitdir:/x"]\n  path = y\n[core.sub]\n  z = 1\n');
    expect(keys).toContainEqual({ section: 'core', subsection: undefined, key: 'filemode' });
    expect(keys).toContainEqual({ section: 'filter', subsection: 'lfs', key: 'clean' });
    expect(keys).toContainEqual({ section: 'includeif', subsection: 'gitdir:/x', key: 'path' });
    expect(keys).toContainEqual({ section: 'core', subsection: 'sub', key: 'z' });
  });
});

describe('inspectGitSafety', () => {
  it('accepts exactly a fresh git init plus user.* and a missing repo', async () => {
    expect(await inspectGitSafety(await repo(INIT))).toBeNull();
    expect(await inspectGitSafety(await repo(`${INIT}[user]\n  name = Motion Studio\n  email = a@b\n`))).toBeNull();
    const none = await mkdtemp(join(tmpdir(), 'ms-norepo-')); cleanup.push(none);
    expect(await inspectGitSafety(none)).toBeNull();
  });
  it('blocks the command-running and include keys', async () => {
    for (const bad of [
      '[filter "lfs"]\n  clean = run-me\n', '[diff "x"]\n  textconv = cat\n', '[core]\n  sshCommand = ssh -i evil\n',
      '[core]\n  fsmonitor = /x\n', '[core]\n  hooksPath = /x\n', '[core]\n  pager = less\n', '[core]\n  editor = vim\n',
      '[include]\n  path = /etc/evil\n', '[includeIf "gitdir:/x"]\n  path = /x\n', '[alias]\n  co = !sh\n',
      '[credential]\n  helper = evil\n', '[remote "o"]\n  url = x\n',
    ]) {
      expect(await inspectGitSafety(await repo(INIT + bad)), bad).not.toBeNull();
    }
  });
});

describe('dangerousAttributeLines', () => {
  it('flags filter/diff/custom-merge drivers but not our usage.jsonl merge=union or plain attributes', () => {
    expect(dangerousAttributeLines('.studio/usage.jsonl merge=union\n')).toEqual([]);
    expect(dangerousAttributeLines('*.png binary\n*.txt text eol=lf\n# comment\n')).toEqual([]);
    expect(dangerousAttributeLines('*.c filter=indent\n')).toEqual(['*.c filter=indent']);
    expect(dangerousAttributeLines('*.bin diff=hexdump\n')).toEqual(['*.bin diff=hexdump']);
    expect(dangerousAttributeLines('x merge=mine\n')).toEqual(['x merge=mine']);
  });
});
