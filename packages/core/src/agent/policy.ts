import { join } from 'node:path';
import { dirDenyRules, escapeGlob, fileDenyRules, globDenyRules, readOnlyRules, secretReadRules, secretSandboxGlobs } from '../codebases.ts';
import { AGENT_ALLOWED_TOOLS, BRAND_ANALYSIS_TOOLS, BRAND_CODEBASE_DENIED_TOOLS, BRAND_CODEBASE_SCOPED_TOOLS, DESCRIBE_TOOLS, LOCALIZE_TOOLS } from './runner.ts';
import { DEFAULT_ALLOWED_DOMAINS, sensitiveHomeEntries, sensitiveHomePaths } from './sandbox.ts';

/**
 * `localize` (Phase 12): a translation turn on an existing version; it writes only through `submit_localization`.
 * `variant-directions` (Phase 15): the short turn that proposes a variant group's missing directions; it writes nothing and
 * only hands them over through `submit_variant_directions`.
 */
/**
 * `creative-group` (phase 3 of the single agent): the coordinator of a variant group, the agent the user talks to. It reads
 * the project and acts through its `studio` tools (it hands the work on files to the variants' own turns): no editing tool,
 * no Bash, no paid tool.
 */
/**
 * `brief` (decision 1421): a project's brief session. It reads the project and the linked folders (secrets scanned as a brand
 * analysis does) and writes only the New creative form, through `fill_brief`: no editing tool, no Bash, no Grep, no network.
 */
/**
 * `video-analysis` (decision 1493): one run of a video's analysis. It reads only the extracted frames (`readDirs`) and writes
 * only through `write_video_analysis`: no editing tool, no Bash, no search, no network, no project "Always" rule.
 */
/**
 * `subtitles-translate` (Task 23): one translation of a creative's subtitle set. The lines are in its prompt; it hands the
 * translation over through `submit_subtitle_translation` and touches nothing else: no file tool (not even Read), no Bash, no
 * search, no network, no project "Always" rule.
 */
export type AgentJobKind = 'creative' | 'brand-analysis' | 'describe' | 'console' | 'localize' | 'variant-directions' | 'creative-group' | 'brief' | 'video-analysis' | 'subtitles-translate';
export interface PolicyInput {
  kind: AgentJobKind; sandbox: boolean; projectDir?: string; home: string; configDir: string;
  codebases: string[]; protectedFiles: string[];
  /** Folders the agent must never write, whatever the job (e.g. `<project>/.studio`, where its permissions live). */
  protectedDirs: string[];
  /** Glob patterns (absolute, literal parts already escaped) the Edit/Write tools must never touch: the transparency logs of every creative and proposal. The sandbox gets the concrete files in `protectedFiles` (works everywhere) plus `sandboxGlobs` (macOS expands globs in denyWrite; Linux/WSL skip them, and also any concrete path that has `[ ] * ?`). */
  protectedGlobs?: string[];
  /** Glob paths added to the sandbox denyWrite as they are; their literal parts already went through `sandboxPath`. */
  sandboxGlobs?: string[];
  extraDomains: string[]; projectAllowRules: string[]; mcpTools: string[];
  /** Workspace setting: sandboxed Bash runs without asking (only meaningful with `sandbox`). */
  autoApproveSandboxed: boolean;
  /**
   * Brand analysis of codebases (Phase 14) and brief sessions (decision 1421): the secret files and folders found in them when
   * the job starts (absolute, every spelling; see findCodebaseSecrets). Denied to Read by exact path and, with the sandbox,
   * listed in denyRead.
   */
  codebaseSecrets?: { files: string[]; dirs: string[] };
  /** `video-analysis` jobs (decision 1493): the absolute folders the job may Read (the frames), and nothing else. */
  readDirs?: string[];
  /**
   * Brand analysis of codebases (Phase 14, fix round 1): whether the analysis also has a website source. Without one,
   * WebFetch is neither allowed nor reachable (denied): nothing read in a codebase can be sent out. Ignored otherwise.
   */
  brandWebsite?: boolean;
}

/**
 * The only reads a brand analysis of codebases gets without asking: `Read`/`Glob` scoped to each codebase spelling (the
 * given one and the real one), in the exact case only, escaped like the deny rules. A case-folded allow would also open
 * folders that differ only in case, which on a case-sensitive disk are other, unvalidated folders (fix round 2): the
 * folded forms are for the deny rules only. The project stays readable as the working folder; anything else reaches an
 * approval card, as before Phase 14.
 */
export const codebaseReadAllowRules = (codebases: string[]): string[] => codebases.flatMap((c) => BRAND_CODEBASE_SCOPED_TOOLS.map((t) => `${t}(/${escapeGlob(c)}/**)`));
export interface AgentPolicy { settings: Record<string, unknown> | null; allowedTools: string[]; disallowedTools: string[]; addDirs: string[];
  /** Extra environment of the agent process: package caches inside the project, only for sandboxed jobs. */
  env: Record<string, string>;
}

/** Where a sandboxed job's tools cache downloads: inside the project, so it is in the write allowlist (not under a protected dir), and git-ignored. */
export const CACHE_DIR = '.cache';

export function sandboxCacheEnv(projectDir: string): Record<string, string> {
  const c = (n: string) => join(projectDir, CACHE_DIR, n);
  return {
    npm_config_cache: c('npm'), PIP_CACHE_DIR: c('pip'), XDG_CACHE_HOME: c('xdg'),
    PNPM_STORE_DIR: c('pnpm-store'), YARN_CACHE_FOLDER: c('yarn'),
    PUPPETEER_SKIP_DOWNLOAD: '1', PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    npm_config_update_notifier: 'false', PIP_DISABLE_PIP_VERSION_CHECK: '1',
  };
}

/**
 * A literal path as Claude Code's sandbox must receive it in denyWrite or denyRead. Any `[ ] * ?` makes the sandbox read the entry as a
 * glob, which becomes a seatbelt regex on macOS: `[` and `]` are left as a character class and a backslash escape does not
 * survive (it becomes a literal backslash), so before this an entry under a root like `…/Work [x]/` matched nothing and
 * protected nothing, concrete paths included (verified live, decisions log 141). Here `[` becomes `[[]`, a class holding
 * only `[` (exact in the seatbelt and JS regex engines); a `]` outside a class is already literal; `*` and `?` become `?`,
 * one non-slash character: a match only one character wider, never narrower. Other paths are returned unchanged.
 *
 * Limit: a glob entry gets no ancestor pins past its first glob character, so under such a root the agent can still move
 * a protected file's folder (a creative, `creatives/`, `outputs/`) out, edit it and move it back. The launcher warns about
 * such roots and checks the record folders after each run (run-tripwire.ts).
 */
export const sandboxPath = (p: string): string => p.replace(/[[*?]/g, (c) => (c === '[' ? '[[]' : '?'));

const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
/** Phase 3: the coordinator reads the project (its own folders, the variants' compositions) and nothing else. */
const COORDINATOR_TOOLS = ['Read', 'Glob', 'Grep'];
// A video analysis's only read rules are scoped to its `readDirs` (buildAgentPolicy).
const SANDBOXED_TOOLS: Record<AgentJobKind, readonly string[]> = { creative: [], console: [], 'brand-analysis': BRAND_ANALYSIS_TOOLS, describe: DESCRIBE_TOOLS, localize: LOCALIZE_TOOLS, 'variant-directions': [], 'creative-group': COORDINATOR_TOOLS, brief: [], 'video-analysis': [], 'subtitles-translate': [] };
const LEGACY_TOOLS: Record<AgentJobKind, readonly string[]> = { creative: AGENT_ALLOWED_TOOLS, console: [], 'brand-analysis': BRAND_ANALYSIS_TOOLS, describe: DESCRIBE_TOOLS, localize: LOCALIZE_TOOLS, 'variant-directions': [], 'creative-group': COORDINATOR_TOOLS, brief: [], 'video-analysis': [], 'subtitles-translate': [] };
/** Decision 1421: what a brief session never uses, wherever (it only reads and fills the form; Grep could cross a secret file). */
const BRIEF_DENIED_TOOLS = [...EDIT_TOOLS, 'Bash', 'Grep', 'WebFetch', 'WebSearch'];
/** Decision 1493: what a video analysis never uses (it looks at the frames it is given and writes through its tool). */
const VIDEO_ANALYSIS_DENIED_TOOLS = [...EDIT_TOOLS, 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Task'];
/** Task 23: what a subtitle translation never uses (its lines are in the prompt; it writes through its tool). */
const SUBTITLE_TRANSLATE_DENIED_TOOLS = [...VIDEO_ANALYSIS_DENIED_TOOLS, 'Read'];
const unique = (xs: string[]) => [...new Set(xs)];

export function buildAgentPolicy(i: PolicyInput): AgentPolicy {
  // The sandbox denyRead only covers Bash: the Read tool needs its own deny rules.
  const sensitive = sensitiveHomeEntries(i.home);
  // Phase 14 (spec §2.2): a brand analysis reads its codebases whole, read-only, never their secret files. Every editing tool
  // is denied there (not only Edit), and Read is denied on the secret patterns (both cases) and on the secrets found now.
  const brandCodebases = i.kind === 'brand-analysis' && i.codebases.length > 0;
  // Decision 1421: a brief session's codebases get the same read-only treatment and secrets scan as a brand analysis's.
  const scansSecrets = (i.kind === 'brand-analysis' || i.kind === 'brief') && i.codebases.length > 0;
  const brief = i.kind === 'brief';
  const secretFiles = scansSecrets ? i.codebaseSecrets?.files ?? [] : [];
  const secretDirs = scansSecrets ? i.codebaseSecrets?.dirs ?? [] : [];
  const disallowedTools = [
    ...readOnlyRules(i.codebases),
    ...(scansSecrets ? [
      ...dirDenyRules(EDIT_TOOLS.filter((t) => t !== 'Edit'), i.codebases),
      ...i.codebases.flatMap(secretReadRules),
      ...dirDenyRules(['Read'], secretDirs),
      ...fileDenyRules(['Read'], [...secretFiles, ...secretDirs]),
    ] : []),
    ...dirDenyRules(['Read'], [...sensitive.dirs, i.configDir]),
    // Motion Studio's config folder holds the UI token and every live job's bridge token. Verified live with Claude Code
    // 2.1.296 (decisions log): the Read rule above already denies Grep and Glob there, also a recursive search started from
    // a parent folder (the folder is left out); `Grep(path)`/`Glob(path)` rules had no effect of their own. They are kept as
    // the declared intent, harmless, in case a version honours them. The bridge's approve also refuses such paths.
    ...dirDenyRules(['Grep', 'Glob'], [i.configDir]),
    ...fileDenyRules(['Read'], sensitive.files),
    ...(i.protectedFiles.length ? fileDenyRules(EDIT_TOOLS, i.protectedFiles) : []),
    ...dirDenyRules(EDIT_TOOLS, i.protectedDirs),
    ...globDenyRules(EDIT_TOOLS, i.protectedGlobs ?? []),
    // Brand analysis of codebases (fix round 1): no Bash (no file dump through an interpreter or ffprobe, no approval card
    // for `cat`), no Grep (a content search could cross a secret file), and no WebFetch without a website source.
    ...(brandCodebases ? [...BRAND_CODEBASE_DENIED_TOOLS, ...(i.brandWebsite ? [] : ['WebFetch'])] : []),
    // A localize turn writes only through `submit_localization` (Phase 12): the editing tools and Bash are denied everywhere,
    // whatever `autoApproveSandboxed` says (fix I1).
    ...(i.kind === 'localize' ? [...EDIT_TOOLS, 'Bash'] : []),
    // The directions turn of a variant group (Phase 15) writes nothing and runs nothing: its only tool is
    // `submit_variant_directions`, whatever `autoApproveSandboxed` or the project's "Always" rules say.
    ...(i.kind === 'variant-directions' ? [...EDIT_TOOLS, 'Bash'] : []),
    // Phase 3 of the single agent: the coordinator never edits a file nor runs a command; its helpers do the work.
    ...(i.kind === 'creative-group' ? [...EDIT_TOOLS, 'Bash', 'WebFetch', 'WebSearch'] : []),
    ...(brief ? BRIEF_DENIED_TOOLS : []),
    ...(i.kind === 'video-analysis' ? VIDEO_ANALYSIS_DENIED_TOOLS : []),
    ...(i.kind === 'subtitles-translate' ? SUBTITLE_TRANSLATE_DENIED_TOOLS : []),
  ];
  // Neither the directions turn nor the coordinator (nor a brief session) takes the project's "Always" rules: nothing of
  // theirs may run a command.
  const directions = i.kind === 'variant-directions' || i.kind === 'creative-group' || brief || i.kind === 'video-analysis' || i.kind === 'subtitles-translate';
  const extra = [...(scansSecrets ? codebaseReadAllowRules(i.codebases) : []), ...(directions ? [] : i.projectAllowRules), ...i.mcpTools];
  // With codebases the brand tools keep only WebFetch, and only with a website source: Bash(mkdir/ffprobe) are dropped.
  // Phase 3 of the single agent (review minor 1): the coordinator reads the project without asking, nothing else (a read
  // elsewhere reaches the permission prompt, which refuses it for this kind).
  const coordinatorReads = i.kind === 'creative-group' && i.projectDir ? COORDINATOR_TOOLS.map((t) => `${t}(/${escapeGlob(i.projectDir!)}/**)`)
    // Decision 1493: a video analysis reads its frames' folders without asking, nothing else.
    : i.kind === 'video-analysis' ? (i.readDirs ?? []).map((d) => `Read(/${escapeGlob(d)}/**)`)
      // Task 23: a subtitle translation reads nothing.
      : i.kind === 'subtitles-translate' ? [] : null;
  const kindTools = (list: readonly string[]) => (coordinatorReads ?? (brandCodebases ? (i.brandWebsite ? list.filter((t) => t === 'WebFetch') : []) : list));
  if (!i.sandbox) {
    return { settings: null, allowedTools: unique([...kindTools(LEGACY_TOOLS[i.kind]), ...extra]), disallowedTools, addDirs: unique([...i.codebases, ...(i.readDirs ?? [])]), env: {} };
  }
  // Only creative/console jobs get sandbox network. Brand analysis reads pages with WebFetch (a tool, not Bash)
  // and downloads files through the Motion Studio `download_file` MCP tool.
  const network = i.kind === 'creative' || i.kind === 'console'
    ? { allowedDomains: unique([...DEFAULT_ALLOWED_DOMAINS, ...i.extraDomains]) }
    : undefined;
  const settings = {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      // Phase 8 (spec §3.2, docs/superpowers/specs/2026-10-09-motion-studio-phase8-approvals-usage-design.md): the per-kind
      // AUTO_BASH table is gone. Every kind follows the workspace setting `autoApproveSandboxed`: brand and describe jobs
      // too, since their sandbox has no network, writes stay in the project and the configuration files are protected.
      autoAllowBashIfSandboxed: i.kind === 'localize' || directions ? false : i.autoApproveSandboxed,
      filesystem: {
        denyRead: [
          ...[...sensitiveHomePaths(i.home), i.configDir].map(sandboxPath),
          ...(scansSecrets ? [...[...secretDirs, ...secretFiles].map(sandboxPath), ...i.codebases.flatMap((c) => secretSandboxGlobs(c, sandboxPath))] : []),
        ],
        denyWrite: [...[...i.codebases, ...i.protectedFiles, ...i.protectedDirs].map(sandboxPath), ...(i.sandboxGlobs ?? [])] },
      ...(network ? { network } : {}),
    },
  };
  return { settings, allowedTools: unique([...kindTools(SANDBOXED_TOOLS[i.kind]), ...extra]), disallowedTools, addDirs: unique([...i.codebases, ...(i.readDirs ?? [])]), env: i.projectDir ? sandboxCacheEnv(i.projectDir) : {} };
}
