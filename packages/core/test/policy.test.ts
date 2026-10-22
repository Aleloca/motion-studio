import { describe, expect, it } from 'vitest';
import { buildAgentPolicy, sandboxPath, type PolicyInput } from '../src/agent/policy.ts';
import { AGENT_ALLOWED_TOOLS, BRAND_ANALYSIS_TOOLS, DESCRIBE_TOOLS } from '../src/agent/runner.ts';

const base: PolicyInput = {
  kind: 'creative', sandbox: true, home: '/Users/me', configDir: '/Users/me/Library/Application Support/Motion Studio',
  codebases: ['/Users/me/dev/app [ios]'], protectedFiles: [], protectedDirs: [], extraDomains: ['api.acme.io'],
  projectAllowRules: ['Bash(brew:*)'], mcpTools: ['mcp__studio__report_progress'], autoApproveSandboxed: true,
};
type Sb = { sandbox: { enabled: boolean; autoAllowBashIfSandboxed: boolean; filesystem: { denyRead: string[]; denyWrite: string[] }; network?: { allowedDomains: string[] } } };

describe('buildAgentPolicy with sandbox', () => {
  it('creative: sandbox, read-only codebases, render domains, project rules and MCP tools', () => {
    const p = buildAgentPolicy(base);
    const s = p.settings as Sb;
    expect(s.sandbox).toMatchObject({ enabled: true, autoAllowBashIfSandboxed: true });
    expect(s.sandbox.filesystem.denyRead).toEqual(expect.arrayContaining(['/Users/me/.ssh', base.configDir]));
    expect(s.sandbox.filesystem.denyWrite).toEqual(['/Users/me/dev/app [[]ios]']);
    expect(s.sandbox.network!.allowedDomains).toEqual(expect.arrayContaining(['registry.npmjs.org', 'api.acme.io']));
    expect(p.addDirs).toEqual(['/Users/me/dev/app [ios]']);
    expect(p.disallowedTools[0]).toBe('Edit(//Users/me/dev/app \\[ios\\]/**)');
    expect(p.allowedTools).toEqual(['Bash(brew:*)', 'mcp__studio__report_progress']);
  });
  it('brand analysis: no sandbox network, narrow tools, protected files', () => {
    const p = buildAgentPolicy({ ...base, kind: 'brand-analysis', codebases: [], protectedFiles: ['/p/brand/brand-kit.json'] });
    const s = p.settings as Sb;
    expect(s.sandbox.network).toBeUndefined();
    expect(s.sandbox.filesystem.denyWrite).toEqual(['/p/brand/brand-kit.json']);
    expect(p.allowedTools.slice(0, BRAND_ANALYSIS_TOOLS.length)).toEqual([...BRAND_ANALYSIS_TOOLS]);
    expect(p.disallowedTools).toEqual(expect.arrayContaining(['Write(//p/brand/brand-kit.json)']));
  });
  it('describe: no network at all', () => {
    const s = buildAgentPolicy({ ...base, kind: 'describe', codebases: [] }).settings as Sb;
    expect(s.sandbox.network).toBeUndefined();
  });
});

describe('buildAgentPolicy cache env', () => {
  const input = { ...base, projectDir: '/w/acme', protectedDirs: ['/w/acme/.git', '/w/acme/.claude', '/w/acme/.studio'] };
  it('sets every cache and download variable inside <project>/.cache, only when sandboxed', () => {
    for (const kind of ['creative', 'console', 'brand-analysis', 'describe'] as const) {
      const env = buildAgentPolicy({ ...input, kind }).env;
      expect(env).toMatchObject({
        npm_config_cache: '/w/acme/.cache/npm', PIP_CACHE_DIR: '/w/acme/.cache/pip', XDG_CACHE_HOME: '/w/acme/.cache/xdg',
        PNPM_STORE_DIR: '/w/acme/.cache/pnpm-store', YARN_CACHE_FOLDER: '/w/acme/.cache/yarn',
        PUPPETEER_SKIP_DOWNLOAD: '1', PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', npm_config_update_notifier: 'false', PIP_DISABLE_PIP_VERSION_CHECK: '1',
      });
      for (const v of Object.values(env)) expect(v).not.toContain('/Users/me');
      // npm 11 warns 'Unknown env config "store-dir"' on every command; pnpm reads PNPM_STORE_DIR.
      expect(env).not.toHaveProperty('npm_config_store_dir');
    }
    expect(buildAgentPolicy({ ...input, sandbox: false }).env).toEqual({});
  });
  it('the cache folder is writable (inside the project, no deny rule covers it) and not protected', () => {
    const p = buildAgentPolicy(input);
    const deny = (p.settings as Sb).sandbox.filesystem.denyWrite;
    expect(deny.some((d) => '/w/acme/.cache'.startsWith(d) || d.startsWith('/w/acme/.cache'))).toBe(false);
    expect(p.disallowedTools.some((d) => d.includes('/w/acme/.cache'))).toBe(false);
  });
});

describe('buildAgentPolicy hardening', () => {
  it('fails closed and forbids per-command opt-out', () => {
    const s = buildAgentPolicy(base).settings as Sb & { sandbox: { failIfUnavailable: boolean; allowUnsandboxedCommands: boolean } };
    expect(s.sandbox.failIfUnavailable).toBe(true);
    expect(s.sandbox.allowUnsandboxedCommands).toBe(false);
  });
  it('denies the Read tool on sensitive paths, with and without sandbox', () => {
    for (const sandbox of [true, false]) {
      const d = buildAgentPolicy({ ...base, sandbox }).disallowedTools;
      expect(d).toEqual(expect.arrayContaining([
        'Read(//Users/me/.ssh/**)', 'Read(//Users/me/.netrc)',
        'Read(//Users/me/Library/Application Support/Motion Studio/**)',
      ]));
    }
  });
  it('denies Grep and Glob on the config folder (bridge and UI tokens), with the same shape as the Read rule, with and without sandbox', () => {
    for (const sandbox of [true, false]) {
      for (const kind of ['creative', 'console', 'brand-analysis', 'describe'] as const) {
        const d = buildAgentPolicy({ ...base, kind, sandbox }).disallowedTools;
        expect(d).toEqual(expect.arrayContaining([
          'Read(//Users/me/Library/Application Support/Motion Studio/**)',
          'Grep(//Users/me/Library/Application Support/Motion Studio/**)',
          'Glob(//Users/me/Library/Application Support/Motion Studio/**)',
        ]));
      }
    }
    // A config folder with glob characters is escaped as the Read rule is.
    const odd = buildAgentPolicy({ ...base, configDir: '/cfg [x]/Motion Studio' }).disallowedTools;
    const read = odd.find((r) => r.startsWith('Read(//cfg'))!;
    expect(odd).toContain(read.replace(/^Read/, 'Grep'));
    expect(odd).toContain(read.replace(/^Read/, 'Glob'));
  });
  it('console: network on, auto-allowed Bash, no default tools', () => {
    const p = buildAgentPolicy({ ...base, kind: 'console', projectAllowRules: [], mcpTools: [] });
    const s = p.settings as Sb;
    expect(s.sandbox.network!.allowedDomains).toContain('api.acme.io');
    expect(s.sandbox.autoAllowBashIfSandboxed).toBe(true);
    expect(p.allowedTools).toEqual([]);
  });
  it('deduplicates a project rule equal to a default tool', () => {
    const p = buildAgentPolicy({ ...base, sandbox: false, projectAllowRules: ['Bash(node:*)'], mcpTools: [] });
    expect(p.allowedTools.filter((t) => t === 'Bash(node:*)')).toHaveLength(1);
  });
});

describe('buildAgentPolicy protected folders', () => {
  it('denies edits and sandbox writes on the protected folders for every kind, sandbox or not', () => {
    for (const kind of ['creative', 'console', 'brand-analysis', 'describe'] as const) {
      for (const sandbox of [true, false]) {
        const p = buildAgentPolicy({ ...base, kind, sandbox, codebases: [], protectedDirs: ['/p/acme [1]/.studio'] });
        expect(p.disallowedTools).toEqual(expect.arrayContaining(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].map((t) => `${t}(//p/acme \\[1\\]/.studio/**)`)));
        if (sandbox) expect((p.settings as Sb).sandbox.filesystem.denyWrite).toEqual(['/p/acme [[]1]/.studio']);
        else expect(p.settings).toBeNull();
      }
    }
  });
});

describe('buildAgentPolicy without sandbox', () => {
  it('brand analysis keeps its narrow tools without curl', () => {
    // Without codebase sources (Phase 14: with them, Read/Glob/Grep are added, see brand-codebase-source.test.ts).
    const p = buildAgentPolicy({ ...base, kind: 'brand-analysis', sandbox: false, codebases: [], projectAllowRules: [], mcpTools: [] });
    expect(p.allowedTools).toEqual([...BRAND_ANALYSIS_TOOLS]);
    expect(p.allowedTools).not.toContain('Bash(curl:*)');
  });
  it('falls back to the phase 3 tool lists', () => {
    expect(buildAgentPolicy({ ...base, sandbox: false }).settings).toBeNull();
    expect(buildAgentPolicy({ ...base, sandbox: false, projectAllowRules: [], mcpTools: [] }).allowedTools).toEqual([...AGENT_ALLOWED_TOOLS]);
    expect(buildAgentPolicy({ ...base, kind: 'describe', sandbox: false, projectAllowRules: [], mcpTools: [] }).allowedTools).toEqual([...DESCRIBE_TOOLS]);
  });
});

describe('buildAgentPolicy automatic approval (spec §3.2)', () => {
  const kinds = ['creative', 'brand-analysis', 'describe', 'console'] as const;
  it('sandboxed: autoAllowBashIfSandboxed follows the setting for every kind', () => {
    for (const kind of kinds) {
      for (const autoApproveSandboxed of [true, false]) {
        const s = buildAgentPolicy({ ...base, kind, autoApproveSandboxed }).settings as Sb;
        expect(s.sandbox.autoAllowBashIfSandboxed, `${kind} ${autoApproveSandboxed}`).toBe(autoApproveSandboxed);
      }
    }
  });
  it('not sandboxed: the setting changes nothing', () => {
    for (const kind of kinds) {
      const on = buildAgentPolicy({ ...base, kind, sandbox: false, autoApproveSandboxed: true });
      const off = buildAgentPolicy({ ...base, kind, sandbox: false, autoApproveSandboxed: false });
      expect(on).toEqual(off);
      expect(on.settings).toBeNull();
    }
  });
});

describe('transparency log protection', () => {
  // Minimal matcher for the deny rule syntax: `//abs` is an absolute path, `*` one segment, `\x` a literal.
  const matches = (rule: string, tool: string, path: string) => {
    const m = /^(\w+)\((.*)\)$/.exec(rule);
    if (!m || m[1] !== tool) return false;
    let re = '';
    const g = m[2]!.slice(1);
    for (let k = 0; k < g.length; k++) {
      const c = g[k]!;
      if (c === '\\') re += g[++k]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      else if (c === '*') re += '[^/]*';
      else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${re}$`).test(path);
  };
  it('denies Edit/Write on any creative log and proposal log, and not on outputs', () => {
    const p = buildAgentPolicy({ ...base, kind: 'creative', projectDir: '/w/acme [1]', protectedGlobs: [
      '/w/acme \\[1\\]/creatives/*/conversation.jsonl', '/w/acme \\[1\\]/brand/proposals/*/log.jsonl',
    ] });
    const denied = (tool: string, path: string) => p.disallowedTools.some((r) => matches(r, tool, path));
    for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      expect(denied(t, '/w/acme [1]/creatives/any-2/conversation.jsonl')).toBe(true);
      expect(denied(t, '/w/acme [1]/brand/proposals/p-3/log.jsonl')).toBe(true);
      expect(denied(t, '/w/acme [1]/creatives/any-2/outputs/v1/a.png')).toBe(false);
    }
  });
});

/**
 * Claude Code 2.1.295's write-deny form of a glob entry (read from the installed binary, decisions log 141): `K9t`, that is
 * `q9t` (`[.^$+{}()|\\]` escaped, `*` → `[^/]*`, `?` → `[^/]`, `[`/`]` left as a character class) with `(/.*)?$` at the
 * end, so the entry and everything below it. Reproduced so the escaping is checked against the real conversion.
 */
const claudeGlobToRegex = (g: string) => new RegExp(`^${g.replace(/[.^$+{}()|\\]/g, '\\$&').replace(/\[([^\]]*?)$/g, '\\[$1')
  .replace(/\*\*\//g, '__GLOBSTAR_SLASH__').replace(/\*\*/g, '__GLOBSTAR__').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
  .replace(/__GLOBSTAR_SLASH__/g, '(.*/)?').replace(/__GLOBSTAR__/g, '.*')}(/.*)?$`);
const isGlob = (p: string) => /[*?[\]]/.test(p);

describe('sandboxPath', () => {
  it('leaves plain paths unchanged (they stay literal in the sandbox)', () => {
    for (const p of ['/Users/me/Motion Studio/acme/.studio', '/w/a (1)/b{c}.d+e^f$g|h']) {
      expect(sandboxPath(p)).toBe(p);
      expect(isGlob(sandboxPath(p))).toBe(false);
    }
  });
  it('a path with [ ] * ? still matches itself once the sandbox reads it as a glob, and not its bracket-less twin', () => {
    const cases = ['/w/ws[x]/demo/.studio', '/w/a]b[c/x', '/w/[[x]]/y', '/w/a*b/c', '/w/a?b/c', '/w/[a-z]/x', '/w/[!x]/x', '/w/x[/y'];
    for (const p of cases) {
      const re = claudeGlobToRegex(sandboxPath(p));
      expect(re.test(p), p).toBe(true);
      // Unescaped, the same path does not protect itself (the bug): `[x]` is a class matching "x".
    }
    for (const p of ['/w/ws[x]/demo/.studio', '/w/[a-z]/x', '/w/[!x]/x']) expect(claudeGlobToRegex(p).test(p), p).toBe(false);
    expect(claudeGlobToRegex(sandboxPath('/w/ws[x]/demo/.studio')).test('/w/wsx/demo/.studio')).toBe(false);
  });
  it('a glob built on an escaped root matches the files under the real root', () => {
    const root = '/w/Work [x] *1?/demo';
    const re = claudeGlobToRegex(`${sandboxPath(`${root}/creatives`)}/*/conversation.jsonl`);
    expect(re.test(`${root}/creatives/2026-10-10-b/conversation.jsonl`)).toBe(true);
    expect(re.test(`${root}/creatives/b/work/conversation.jsonl`)).toBe(false);
    expect(re.test(`${root}/creatives/b/work/a.txt`)).toBe(false);
  });
  it('the policy sends every concrete denyWrite entry through it, and the globs as given', () => {
    const p = buildAgentPolicy({ ...base, codebases: ['/c/[a]'], protectedFiles: ['/w/[x]/f'], protectedDirs: ['/w/[x]/.studio'], sandboxGlobs: ['/w/[[]x]/creatives/*/log'] });
    expect((p.settings as Sb).sandbox.filesystem.denyWrite).toEqual(['/c/[[]a]', '/w/[[]x]/f', '/w/[[]x]/.studio', '/w/[[]x]/creatives/*/log']);
    // denyRead goes through the same glob conversion on macOS.
    const r = buildAgentPolicy({ ...base, home: '/Users/me [1]', configDir: '/cfg [x]/Motion Studio' });
    const denyRead = (r.settings as Sb).sandbox.filesystem.denyRead;
    expect(denyRead).toContain('/cfg [[]x]/Motion Studio');
    expect(denyRead).toContain('/Users/me [[]1]/.ssh');
    expect(denyRead.some((d) => /\[x\]|\[1\]/.test(d))).toBe(false);
  });
});

describe('buildAgentPolicy for a brief session (decision 1421)', () => {
  const brief: PolicyInput = { ...base, kind: 'brief', projectDir: '/w/acme', codebases: ['/c/app'], codebaseSecrets: { files: ['/c/app/.env'], dirs: [] }, mcpTools: ['mcp__studio__fill_brief'] };
  it('brief: read-only codebases with the secrets scan, no Bash/Grep/Edit, no network', () => {
    const p = buildAgentPolicy(brief);
    const s = p.settings as Sb;
    expect(p.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Grep', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Read(//c/app/.env)', 'Edit(//c/app/**)']));
    expect(p.allowedTools).toEqual(['Read(//c/app/**)', 'Glob(//c/app/**)', 'mcp__studio__fill_brief']);
    expect(s.sandbox.network).toBeUndefined();
    expect(s.sandbox.autoAllowBashIfSandboxed).toBe(false);
    expect(s.sandbox.filesystem.denyRead).toEqual(expect.arrayContaining(['/c/app/.env']));
    expect(p.addDirs).toEqual(['/c/app']);
  });
  it('brief without the sandbox: the same tools, never the project rules', () => {
    const p = buildAgentPolicy({ ...brief, sandbox: false });
    expect(p.allowedTools).toEqual(['Read(//c/app/**)', 'Glob(//c/app/**)', 'mcp__studio__fill_brief']);
    expect(p.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Grep', 'Edit', 'Read(//c/app/.env)']));
  });
  it('brief with no codebase: still nothing but reads and its tools', () => {
    const p = buildAgentPolicy({ ...brief, codebases: [], codebaseSecrets: undefined });
    expect(p.allowedTools).toEqual(['mcp__studio__fill_brief']);
    expect(p.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Grep', 'Edit', 'Write', 'WebFetch']));
  });
});

describe('buildAgentPolicy for a video analysis (decision 1493)', () => {
  const analysis: PolicyInput = { ...base, kind: 'video-analysis', projectDir: '/p', codebases: [], readDirs: ['/p/.studio/cache/analysis/ab'], mcpTools: ['mcp__studio__report_progress', 'mcp__studio__write_video_analysis'] };
  it('video-analysis: reads only the frames, no Bash, no network', () => {
    const p = buildAgentPolicy(analysis);
    const s = p.settings as Sb;
    expect(p.allowedTools).toEqual(['Read(//p/.studio/cache/analysis/ab/**)', 'mcp__studio__report_progress', 'mcp__studio__write_video_analysis']);
    expect(p.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Grep', 'Glob', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'Task']));
    expect(s.sandbox.network).toBeUndefined();
    expect(s.sandbox.autoAllowBashIfSandboxed).toBe(false);
    expect(p.addDirs).toEqual(['/p/.studio/cache/analysis/ab']);
  });
  it('without the sandbox: the same tools, never the project rules', () => {
    const p = buildAgentPolicy({ ...analysis, sandbox: false });
    expect(p.allowedTools).toEqual(['Read(//p/.studio/cache/analysis/ab/**)', 'mcp__studio__report_progress', 'mcp__studio__write_video_analysis']);
    expect(p.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Edit']));
  });
});

describe('buildAgentPolicy for a subtitle translation (Task 23)', () => {
  const translate: PolicyInput = { ...base, kind: 'subtitles-translate', projectDir: '/p', codebases: [], mcpTools: ['mcp__studio__report_progress', 'mcp__studio__submit_subtitle_translation'] };
  it('subtitles-translate: only its tools, no file tool, no Bash, no network, no project rule', () => {
    for (const sandbox of [true, false]) {
      const p = buildAgentPolicy({ ...translate, sandbox });
      expect(p.allowedTools).toEqual(['mcp__studio__report_progress', 'mcp__studio__submit_subtitle_translation']);
      expect(p.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Read', 'Grep', 'Glob', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'Task']));
      expect(p.addDirs).toEqual([]);
    }
    const s = buildAgentPolicy(translate).settings as Sb;
    expect(s.sandbox.network).toBeUndefined();
    expect(s.sandbox.autoAllowBashIfSandboxed).toBe(false);
  });
});
