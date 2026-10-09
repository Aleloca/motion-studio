import { describe, expect, it } from 'vitest';
import { explainWork, tokenize, type SimpleCommand } from '../src/index.ts';

const argvs = (cmd: string): string[][] => tokenize(cmd).commands.map((c) => c.argv);
const one = (cmd: string): SimpleCommand => {
  const r = tokenize(cmd);
  expect(r.parsed, cmd).toBe(true);
  expect(r.commands, cmd).toHaveLength(1);
  return r.commands[0]!;
};

describe('tokenize: words and quotes', () => {
  it('splits on blanks and keeps quoted text together', () => {
    expect(one('ls  -la\twork').argv).toEqual(['ls', '-la', 'work']);
    expect(one(`echo 'a b' "c d" e\\ f`).argv).toEqual(['echo', 'a b', 'c d', 'e f']);
  });
  it('joins adjacent quoted and unquoted parts into one word', () => {
    expect(one(`echo a'b'"c"d`).argv).toEqual(['echo', 'abcd']);
  });
  it('keeps empty quoted words', () => {
    expect(one(`sed -i '' file`).argv).toEqual(['sed', '-i', '', 'file']);
  });
  it('handles escapes outside and inside double quotes', () => {
    expect(one('echo \\"x\\"').argv).toEqual(['echo', '"x"']);
    expect(one('echo "a\\"b\\\\c\\$d\\n"').argv).toEqual(['echo', 'a"b\\c$d\\n']);
    expect(one(`echo 'a\\b'`).argv).toEqual(['echo', 'a\\b']);
  });
  it('keeps separators that are inside quotes', () => {
    expect(argvs(`echo "a; rm -rf ~" 'b && c' "d|e"`)).toEqual([['echo', 'a; rm -rf ~', 'b && c', 'd|e']]);
  });
  it('keeps simple parameter expansions as text', () => {
    expect(one('ls $HOME ${TMPDIR}/x "$PWD"').argv).toEqual(['ls', '$HOME', '${TMPDIR}/x', '$PWD']);
  });
});

describe('tokenize: separators', () => {
  it('splits on ; && || | & and newline', () => {
    const r = tokenize('a; b && c || d | e & f\ng');
    expect(r.parsed).toBe(true);
    expect(r.commands.map((c) => c.argv[0])).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(r.separators).toEqual([';', '&&', '||', '|', '&', '\n']);
  });
  it('accepts a trailing ; or & and newlines after && and |', () => {
    expect(argvs('a;')).toEqual([['a']]);
    expect(argvs('a &')).toEqual([['a']]);
    expect(argvs('a &&\n b |\n c')).toEqual([['a'], ['b'], ['c']]);
    expect(argvs('\n\na\n\nb\n')).toEqual([['a'], ['b']]);
  });
  it('treats |& as a pipe', () => {
    const r = tokenize('a |& b');
    expect(r.separators).toEqual(['|']);
  });
  it('rejects empty commands between separators', () => {
    for (const c of ['; a', 'a ;; b', 'a && && b', 'a |', 'a &&', '| a', 'a & & b']) expect(tokenize(c).parsed, c).toBe(false);
  });
});

describe('tokenize: redirects', () => {
  it('records file redirects with their targets', () => {
    expect(one('cmd > out.txt').redirects).toEqual([{ op: '>', target: 'out.txt' }]);
    expect(one('cmd >>log 2>err <in').redirects).toEqual([
      { op: '>>', target: 'log' }, { op: '2>', target: 'err' }, { op: '<', target: 'in' },
    ]);
    expect(one('cmd &> all.txt').redirects).toEqual([{ op: '&>', target: 'all.txt' }]);
    expect(one('cmd 1>a 2>>b').redirects).toEqual([{ op: '>', target: 'a' }, { op: '2>', target: 'b' }]);
    expect(one('cmd >| a').redirects).toEqual([{ op: '>', target: 'a' }]);
  });
  it('ignores fd duplications but keeps >&file as a file write', () => {
    const c = one('python3 x.py 2>&1');
    expect(c.argv).toEqual(['python3', 'x.py']);
    expect(c.redirects).toEqual([]);
    expect(one('cmd >&2').redirects).toEqual([]);
    expect(one('cmd >& out.log').redirects).toEqual([{ op: '&>', target: 'out.log' }]);
  });
  it('a digit word not touching > stays an argument', () => {
    expect(one('tail -n 2 >x').argv).toEqual(['tail', '-n', '2']);
    expect(one('echo "2">x').argv).toEqual(['echo', '2']);
  });
  it('fails on a redirect without a target', () => {
    for (const c of ['cmd >', 'cmd > ; ls', 'cmd 2> | x']) expect(tokenize(c).parsed, c).toBe(false);
  });
});

describe('tokenize: env prefixes and wrappers', () => {
  it('collects leading assignments', () => {
    const c = one('A=1 B="x y" python3 render.py');
    expect(c.env).toEqual({ A: '1', B: 'x y' });
    expect(c.argv).toEqual(['python3', 'render.py']);
  });
  it('an assignment after the command name is an argument', () => {
    expect(one('make A=1').argv).toEqual(['make', 'A=1']);
    expect(one('"A"=1 x').argv).toEqual(['A=1', 'x']);
  });
  it('strips time, sudo, nohup and env, recording them', () => {
    const c = one('time PYTHONPATH=pydeps python3 render.py ../outputs/v1');
    expect(c.wrappers).toEqual(['time']);
    expect(c.env).toEqual({ PYTHONPATH: 'pydeps' });
    expect(c.argv).toEqual(['python3', 'render.py', '../outputs/v1']);
    const d = one('sudo -u root env -i X=1 nohup time -p rm -rf /');
    expect(d.wrappers).toEqual(['sudo', 'env', 'nohup', 'time']);
    expect(d.env).toEqual({ X: '1' });
    expect(d.argv).toEqual(['rm', '-rf', '/']);
  });
  it('accepts a whole array, ${a[@]} and ${a[*]}, but no other subscript', () => {
    expect(one('printf %s "${files[@]}" ${a[*]}').argv).toEqual(['printf', '%s', '${files[@]}', '${a[*]}']);
    for (const c of ['echo ${a[@]x}', 'echo ${a[@}', 'echo ${a[$i]}', 'echo ${a[@]:1}']) expect(tokenize(c).parsed).toBe(false);
  });
  it('accepts simple defaults in ${…}', () => {
    expect(one('echo ${HOME} ${X:-a/b.c} ${1} ${X:=x} ${X:+y} ${X-z}').argv).toEqual(['echo', '${HOME}', '${X:-a/b.c}', '${1}', '${X:=x}', '${X:+y}', '${X-z}']);
  });
  it('recognises wrappers by system path and in any case', () => {
    expect(one('/usr/bin/env A=1 ls').wrappers).toEqual(['env']);
    expect(one('//usr//bin/sudo ls').wrappers).toEqual(['sudo']);
    expect(one('SUDO ls').wrappers).toEqual(['sudo']);
    expect(one('nice --adjustment 5 ls').argv).toEqual(['ls']);
    expect(one('arch -arm64 ls -la').argv).toEqual(['ls', '-la']);
    expect(one('arch').argv).toEqual(['arch']);
    expect(one('caffeinate -i ls').argv).toEqual(['ls']);
    expect(one('xcrun --show-sdk-path').argv).toEqual(['xcrun', '--show-sdk-path']);
    expect(one('script -q /dev/null ls').argv).toEqual(['ls']);
    expect(one('noglob ls *').argv).toEqual(['ls', '*']);
    expect(one('=ls -la').argv).toEqual(['ls', '-la']);
  });
  it('keeps a bare env or sudo with nothing after it', () => {
    const c = one('env');
    expect(c.wrappers).toEqual(['env']);
    expect(c.argv).toEqual([]);
  });
  it('joins backslash-newline continuations', () => {
    expect(argvs('ffmpeg -i in.mp4 \\\n  -c:v libx264 \\\n  out.mp4')).toEqual([['ffmpeg', '-i', 'in.mp4', '-c:v', 'libx264', 'out.mp4']]);
    expect(argvs('rm -r\\\nf x')).toEqual([['rm', '-rf', 'x']]);
    expect(argvs('echo "a\\\nb"')).toEqual([['echo', 'ab']]);
  });
});

describe('tokenize: bail-outs', () => {
  const bad = [
    'echo $(whoami)', 'echo "$(whoami)"', 'echo `id`', 'echo "`id`"', 'echo $((1+2))',
    'cat <<EOF\nhi\nEOF', 'cat <<< hi', 'diff <(ls) x', 'tee >(cat)',
    'eval "rm -rf ~"', 'source x.sh', '. ./x.sh', 'exec rm x',
    'bash -c "rm -rf ~"', 'sh -c ls', 'zsh -c ls', 'bash -lc ls', 'sh -ec ls', 'sudo sh -c ls', 'env bash -c ls', 'time zsh -c ls',
    `echo 'unbalanced`, 'echo "unbalanced', 'echo trailing\\',
    '(cd x; ls)', '{ ls; }', 'if true; then ls; fi', 'for f in *; do rm $f; done', 'while true; do ls; done',
    '! ls', 'a=(1 2)', `echo $'\\x41'`, 'echo ${HOME:-$(id)}', 'echo ${unterminated',
    'ls # ; rm -rf ~', 'case x in a) ls;; esac',
    'ls​ -la', 'ls ‮rm', 'ls⁦', 'ls\u0000', 'ls\r', 'ls x', 'ls﻿',
    'env -S "rm -rf ~"', 'sudo -s', 'sudo',
    'echo ${X:Y}', 'echo ${#X}', 'echo ${X/a/b}', 'echo ${!X}', 'echo "${(e)X}"', 'echo ${X[1]}', 'echo ${X}[1]', 'echo $X[1]', 'echo "$X[1]"', 'echo $[1]',
    'echo ${X:-$Y}', 'su -c ls', 'watch ls', 'script -q out ls', 'nice --frob ls', 'timeout --frob 1 ls',
  ];
  for (const c of bad) it(`bails out on ${JSON.stringify(c)}`, () => expect(tokenize(c).parsed).toBe(false));

  it('keeps single-quoted $( and backticks as literal text', () => {
    expect(one(`echo '$(id)' '\`id\`'`).argv).toEqual(['echo', '$(id)', '`id`']);
  });
  it('a # inside a word is not a comment', () => {
    expect(one('echo a#b').argv).toEqual(['echo', 'a#b']);
  });
  it('bails out above 1000 words', () => {
    expect(tokenize(`rm ${'a '.repeat(999)}`).parsed).toBe(true);
    expect(tokenize(`rm ${'a '.repeat(1000)}`).parsed).toBe(false);
  });
  it('bails out above 50 simple commands', () => {
    expect(tokenize(Array.from({ length: 50 }, () => 'a').join(';')).parsed).toBe(true);
    expect(tokenize(Array.from({ length: 51 }, () => 'a').join(';')).parsed).toBe(false);
  });
});

describe('tokenize: linear work on 20 KB hostile input', () => {
  const N = 20 * 1024;
  const cases: Record<string, string> = {
    'a; repeated': 'a;'.repeat(N / 2),
    'nested quotes': `"'`.repeat(N / 2),
    'balanced nested quotes': `"'"'`.repeat(N / 4),
    'single word': 'a'.repeat(N),
    'escapes': '\\a'.repeat(N / 2),
    'spaces': 'a '.repeat(N / 2),
    'dollar braces': '${a}'.repeat(N / 4),
    'dollar names': '$abc'.repeat(N / 4),
  };
  for (const [name, input] of Object.entries(cases)) {
    it(`${name}: characters visited ≤ 3·n`, () => {
      explainWork.reset();
      tokenize(input);
      expect(explainWork.get()).toBeLessThanOrEqual(3 * input.length);
    });
  }
});
