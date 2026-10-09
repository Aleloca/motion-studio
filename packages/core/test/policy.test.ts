import { describe, expect, it } from 'vitest';
import { buildAgentPolicy, type PolicyInput } from '../src/agent/policy.ts';
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
    expect(s.sandbox.filesystem.denyWrite).toEqual(['/Users/me/dev/app [ios]']);
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
        if (sandbox) expect((p.settings as Sb).sandbox.filesystem.denyWrite).toEqual(['/p/acme [1]/.studio']);
        else expect(p.settings).toBeNull();
      }
    }
  });
});

describe('buildAgentPolicy without sandbox', () => {
  it('brand analysis keeps its narrow tools without curl', () => {
    const p = buildAgentPolicy({ ...base, kind: 'brand-analysis', sandbox: false, projectAllowRules: [], mcpTools: [] });
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
