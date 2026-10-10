import { randomBytes } from 'node:crypto';
import type { Stats } from 'node:fs';
import { chmod, lstat, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentEvent, WorkspaceSettings } from '@motion-studio/shared';
import { PROVIDER_ENV } from '../secrets/vault.ts';
import type { ApprovalBroker } from '../approvals/broker.ts';
import { isAllowedRule, PermissionsStore } from '../approvals/permissions-store.ts';
import type { AgentBridge, BridgeContext } from '../bridge/bridge.ts';
import { escapeGlob } from '../codebases.ts';
import { t } from '../i18n.ts';
import { buildAgentPolicy, sandboxPath, type AgentJobKind } from './policy.ts';
import { CREATIVE_CORE_FILES, detachProtectedLinks, PROPOSAL_LOG } from './protected-links.ts';
import { armTripwire } from './run-tripwire.ts';
import { IntegrityStore, ProjectQuarantinedError, snapshotDiff } from '../project-integrity.ts';
import type { AgentRun, AgentRunner, AgentTurnRequest } from './runner.ts';
import type { SandboxSupport } from './sandbox.ts';
import { UsageLedger } from '../usage/usage-ledger.ts';
import { UsageTracker } from '../usage/usage-tracker.ts';

const RUN_DIR = 'run';
export const MCP_SERVER = 'studio';
export const MCP_TOOLS: Record<AgentJobKind, string[]> = {
  creative: ['report_progress', 'validate_output', 'read_brand_kit', 'generate_image', 'tts', 'stock_search', 'stock_download', 'fonts_fetch'],
  console: ['report_progress', 'read_brand_kit', 'generate_image', 'tts', 'stock_search', 'stock_download', 'fonts_fetch'],
  'brand-analysis': ['report_progress', 'read_brand_kit', 'fonts_fetch', 'download_file'],
  describe: ['report_progress'],
};

/** Characters that make Claude Code's sandbox read a path as a glob. */
export const GLOB_CHARS = /[[\]*?]/;
/** Project entries the agent may never write, whatever the job or sandbox mode. */
const PROTECTED_PROJECT_DIRS = ['.git', '.claude', '.studio'];
/** `.gitattributes` too (decisions log 141): it can drive a git filter, so it is tripwired; the core's own maintenance write is noted. */
const PROTECTED_PROJECT_FILES = ['CLAUDE.md', 'CLAUDE.local.md', '.mcp.json', '.gitattributes'];
/*
 * Transparency logs the UI shows as facts ("N commands ran in the sandbox", Activity): the core writes them from outside
 * the sandbox, the agent must never alter them. Per creative: CREATIVE_CORE_FILES; per brand proposal: PROPOSAL_LOG.
 * Protected for every job, for every creative and proposal.
 */
/** Secrets the core reads from its own environment: never inherited by the agent (nor by the MCP server it starts). */
const AGENT_UNSET_ENV = [...Object.values(PROVIDER_ENV), 'MOTION_STUDIO_BRIDGE_TOKEN'];

export interface LauncherDeps {
  runner: AgentRunner; bridge: AgentBridge; approvals: ApprovalBroker;
  /** Cached by the caller. */
  sandbox: () => Promise<SandboxSupport>;
  settings: () => Promise<WorkspaceSettings>;
  configDir: string;
  /** Defaults to os.homedir(). */
  home?: string;
  /** e.g. [process.execPath, '/…/server.mjs']; null disables MCP and approvals. */
  mcpCommand: string[] | null;
  /** Extra env of the MCP server process (e.g. ELECTRON_RUN_AS_NODE=1 when the command is Electron's binary). Never overrides the Motion Studio variables. */
  mcpEnv?: Record<string, string>;
  /** Quarantine and last-good state (decisions log 141); defaults to one in `configDir`. Share one per config folder: it caches records. */
  integrity?: IntegrityStore;
  /** Where every run's token and cost usage is recorded (`<project>/.studio/usage.jsonl`); defaults to a private one. */
  usageLedger?: UsageLedger;
}
export interface LaunchInput {
  kind: AgentJobKind; jobId: string; projectSlug: string; projectDir: string; creativeSlug?: string | null;
  codebases?: string[]; protectedFiles?: string[];
  /** Extra folders the agent must never write (e.g. a creative's earlier `outputs/v*` folders); both spellings are protected. */
  protectedDirs?: string[];
  request: Pick<AgentTurnRequest, 'prompt' | 'resumeSessionId' | 'forkSession' | 'model'>;
  onEvent(e: AgentEvent): void;
  validate?: BridgeContext['validate'];
  /** What the run's ledger line is about (a creative's version and fix-loop attempt); null for other jobs. */
  usage?: { version: number | null; attempt: number | null };
  /**
   * The sandbox decision the caller already put in the prompt. It can only downgrade: `false` runs the job unsandboxed,
   * `true` never claims a sandbox the launcher does not detect itself. Callers must take it from `launcher.sandboxed()`,
   * so a prompt never says "sandboxed" for a job that is not (if the sandbox vanished meanwhile, the job runs without it).
   */
  sandboxed?: boolean;
  /**
   * Where a warning about this run goes (e.g. the creative's chat): today, protected files found with a second name on disk
   * (a hard link) before or after the run, which the launcher detached. Without it the warning is sent as a progress event.
   */
  onWarning?: (text: string) => void | Promise<void>;
}

async function existingLogFiles(root: string, creativeSlug?: string | null): Promise<string[]> {
  const out: string[] = [];
  const dirs = async (parent: string) => {
    const names = (await readdir(parent).catch(() => [])).filter((n) => !n.startsWith('.'));
    const checked = await Promise.all(names.map(async (n) => ((await lstat(join(parent, n)).catch(() => null))?.isDirectory() ? n : null)));
    return checked.filter((n): n is string => n !== null);
  };
  const slugs = new Set(await dirs(join(root, 'creatives')));
  if (creativeSlug) slugs.add(creativeSlug);
  for (const s of slugs) for (const n of CREATIVE_CORE_FILES) out.push(join(root, 'creatives', s, n));
  for (const id of await dirs(join(root, 'brand', 'proposals'))) out.push(join(root, 'brand', 'proposals', id, PROPOSAL_LOG));
  return out;
}

/** The only place that starts the agent: applies the job's policy, the project's rules, the MCP server and the UI prompts. */
export class AgentLauncher {
  private readonly usageLedger: UsageLedger;
  /** Jobs already told that their workspace path has glob characters (a creative job launches once per attempt). */
  private readonly weakRootWarned = new Set<string>();
  /** Quarantine and last-good state per project, in the config folder (decisions log 141); also the one Git consults. */
  readonly integrity: IntegrityStore;
  constructor(private readonly deps: LauncherDeps) {
    this.usageLedger = deps.usageLedger ?? new UsageLedger();
    this.integrity = (deps.integrity ?? new IntegrityStore(deps.configDir)).activate();
  }

  /** True when agents get the `studio` MCP server (bridge listening and a command to start it). */
  mcpActive(): boolean { return Boolean(this.deps.bridge.origin && this.deps.mcpCommand?.length); }

  /** True when a job started now runs in the sandbox: what prompts may claim about the environment. */
  async sandboxed(): Promise<boolean> {
    return (await this.deps.settings()).sandboxMode === 'auto' && (await this.deps.sandbox()).available;
  }

  async start(i: LaunchInput): Promise<AgentRun> {
    // A quarantined project gets no agent (its .claude/.mcp.json/CLAUDE.md may be tampered); it clears by itself once
    // the protected files match the recorded state again.
    await this.integrity.assertUsable(i.projectDir);
    const settings = await this.deps.settings();
    const detected = settings.sandboxMode === 'auto' && (await this.deps.sandbox()).available;
    const sandbox = i.sandboxed === false ? false : detected;
    const autoApproveAtStart = settings.autoApproveSandboxed === true;
    const home = this.deps.home ?? homedir();
    const { configDir, bridge, mcpCommand, approvals } = this.deps;
    // The file is agent-reachable in the fallback mode: only rules that "Sempre" could have produced are honoured;
    // provider rules are checked by the core before paid calls, they are not agent permissions.
    const stored = await new PermissionsStore(i.projectDir).list().catch(() => []);
    const rules = stored.map((r) => r.rule).filter((r) => !r.startsWith('provider:') && isAllowedRule(r, { home, configDir, workspaceRoot: dirname(i.projectDir) }));
    // Files the core or a later turn executes or loads outside the sandbox: .studio holds the project's permissions
    // (the agent must never grant itself more), .git hooks/config run on every commit, .claude / CLAUDE*.md / .mcp.json
    // configure the next agent turn.
    const realDir = await realpath(i.projectDir).catch(() => i.projectDir);
    const roots = [...new Set([i.projectDir, realDir])];
    const protectedDirs = roots.flatMap((d) => PROTECTED_PROJECT_DIRS.map((n) => join(d, n)));
    // Caller-supplied files get both spellings (plain and realpath) like the project entries.
    const spellings = (f: string) => (f.startsWith(`${i.projectDir}/`) && realDir !== i.projectDir ? [f, join(realDir, f.slice(i.projectDir.length + 1))] : [f]);
    const protectedFiles = [...(i.protectedFiles ?? []).flatMap(spellings), ...roots.flatMap((d) => PROTECTED_PROJECT_FILES.map((n) => join(d, n)))];
    protectedDirs.push(...(i.protectedDirs ?? []).flatMap(spellings));
    const logGlobs = roots.flatMap((d) => [
      ...CREATIVE_CORE_FILES.map((n) => `${escapeGlob(join(d, 'creatives'))}/*/${n}`),
      `${escapeGlob(join(d, 'brand', 'proposals'))}/*/${PROPOSAL_LOG}`,
    ]);
    // Sandbox denyWrite: the concrete files that exist now (plus this job's own creative) work everywhere. macOS also
    // expands globs there (seatbelt regex), Linux/WSL skip them, so the globs are added too. Any `[ ] * ?` in a path makes
    // the sandbox read it as a glob, so every literal part goes through sandboxPath (concrete paths in the policy, here the
    // roots of the globs). The Edit/Write rules use escaped globs always.
    const sandboxGlobs = roots.flatMap((d) => [
      ...CREATIVE_CORE_FILES.map((n) => `${sandboxPath(join(d, 'creatives'))}/*/${n}`),
      `${sandboxPath(join(d, 'brand', 'proposals'))}/*/${PROPOSAL_LOG}`,
    ]);
    const logFiles = (await Promise.all(roots.map((d) => existingLogFiles(d, i.creativeSlug)))).flat();
    protectedFiles.push(...logFiles);
    const mcpOn = this.mcpActive();
    // Aborted on cancel and when the run settles: provider calls started by the agent's tools stop with the job.
    const abort = new AbortController();
    const policy = buildAgentPolicy({
      kind: i.kind, sandbox, projectDir: i.projectDir, home, configDir,
      codebases: i.codebases ?? [], protectedFiles, protectedDirs, protectedGlobs: logGlobs, sandboxGlobs,
      extraDomains: settings.extraAllowedDomains, projectAllowRules: rules,
      mcpTools: mcpOn ? MCP_TOOLS[i.kind].map((t) => `mcp__${MCP_SERVER}__${t}`) : [],
      autoApproveSandboxed: autoApproveAtStart,
    });

    let token: string | null = null;
    let configFile: string | null = null;
    let tokenFile: string | null = null;
    let released = false;
    // Token first (synchronously), then the job's pending approvals (on every call), then the config file.
    const release = async () => {
      const first = !released;
      released = true;
      abort.abort();
      if (first && token) bridge.unregister(token);
      approvals.cancelJob(i.jobId);
      if (first) await Promise.all([configFile, tokenFile].map((f) => (f ? rm(f, { force: true }).catch(() => {}) : undefined)));
    };
    let mcp: Pick<AgentTurnRequest, 'mcpConfigPath' | 'permissionPromptTool'> = {};
    try {
      if (mcpOn && mcpCommand) {
        token = bridge.register({
          jobId: i.jobId, kind: i.kind, projectSlug: i.projectSlug, projectDir: i.projectDir, creativeSlug: i.creativeSlug ?? null,
          // The same value the policy was built with: `approve` auto-allows only for jobs that really run in the sandbox.
          sandboxed: sandbox,
          // The same value as the policy's autoAllowBashIfSandboxed: a setting turned on later never reaches this job.
          autoApproveAtStart,
          emit: i.onEvent, signal: abort.signal, ...(i.validate ? { validate: i.validate } : {}),
        });
        // The paths are recorded before writing, so release() also removes a half-written pair.
        const files = await prepareRunFiles(configDir, i.jobId);
        configFile = files.config;
        tokenFile = files.token;
        const config = {
          mcpServers: {
            [MCP_SERVER]: {
              type: 'stdio', command: mcpCommand[0], args: mcpCommand.slice(1),
              env: { ...this.deps.mcpEnv, MOTION_STUDIO_BRIDGE_URL: bridge.origin!, MOTION_STUDIO_BRIDGE_TOKEN_FILE: files.token, MOTION_STUDIO_TOOLS: MCP_TOOLS[i.kind].join(',') },
            },
          },
        };
        // The token travels in a private file (the config folder is denied to the agent), never in argv or env where `ps` shows it.
        await writeFile(files.token, token, { mode: 0o600, flag: 'wx' });
        await writeFile(files.config, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
        mcp = { mcpConfigPath: files.config, permissionPromptTool: `mcp__${MCP_SERVER}__approve` };
      }
      // Every run is metered here, whatever the job: the final usage is held back and re-emitted with per-run values.
      const tracker = new UsageTracker({
        projectDir: i.projectDir, jobId: i.jobId, kind: i.kind, creativeSlug: i.creativeSlug ?? null,
        version: i.usage?.version ?? null, attempt: i.usage?.attempt ?? null,
        ...(i.request.resumeSessionId ? { resumeSessionId: i.request.resumeSessionId } : {}),
      }, this.usageLedger);
      // The session event carries the job's sandbox decision: a finished turn says "ran in the sandbox" only when it did.
      const forward = (e: AgentEvent) => {
        const out = tracker.observe(e);
        if (out) i.onEvent(out.kind === 'session' ? { ...out, sandboxed: sandbox } : out);
      };
      const warn = async (text: string) => {
        try {
          if (i.onWarning) await i.onWarning(text);
          else i.onEvent({ kind: 'progress', text });
        } catch { /* a faulty listener must not stop the run */ }
      };
      const list = (xs: string[]) => xs.slice(0, 5).join(', ') + (xs.length > 5 ? ', …' : '');
      // Protected files with a second name (a hard link) are detached before and after every run, with a warning.
      const detachLinks = async () => {
        const found = await detachProtectedLinks(i.projectDir).catch(() => [] as string[]);
        if (found.length > 0) await warn(t().jobs.protectedLinksDetached({ list: list(found) }));
      };
      await detachLinks();
      // Under a path with `[ ] * ?` the sandbox cannot pin the record folders (decisions log 141): said once per job,
      // and the logs' history is checked too.
      const weakRoot = roots.some((d) => GLOB_CHARS.test(d));
      if (weakRoot && !this.weakRootWarned.has(i.jobId)) {
        if (this.weakRootWarned.size > 200) this.weakRootWarned.clear();
        this.weakRootWarned.add(i.jobId);
        await warn(t().jobs.workspacePathGlob);
      }
      const tripwire = await armTripwire(i.projectDir, { logs: weakRoot });
      // Changes made between runs (a leftover process, an edit while the app was closed) are compared against the state the
      // last clean run ended with: the arm must not take a tampered state as its baseline.
      const lastGood = await this.integrity.lastGood(i.projectDir);
      const between = lastGood ? snapshotDiff(i.projectDir, lastGood, tripwire.armed) : [];
      if (lastGood && between.length > 0) {
        await this.integrity.quarantine(i.projectDir, 'between-runs', between, lastGood);
        const detail = t().jobs.protectedFilesChangedBetweenRuns({ list: list(between) });
        await warn(detail);
        throw new ProjectQuarantinedError(detail, between);
      }
      const run = this.deps.runner.start({
        cwd: i.projectDir, ...i.request,
        addDirs: policy.addDirs, allowedTools: policy.allowedTools, disallowedTools: policy.disallowedTools,
        ...(policy.settings ? { settings: policy.settings } : {}), ...mcp,
        env: { MCP_TOOL_TIMEOUT: '900000', ...policy.env }, unsetEnv: AGENT_UNSET_ENV,
      }, forward);
      const done = run.done.then(async (r) => {
        // Leftover processes are killed before the checks, so nothing can make a link or move a folder after them. Console
        // turns are the exception (decisions log 141): the user's own agent may leave a dev server or preview running on
        // purpose, so their group is left alone; the detach and the tripwire still run.
        if (i.kind !== 'console') run.killGroup?.();
        await detachLinks();
        // The check fails closed: if it cannot run, the project is quarantined against the pre-run state.
        const tw = await tripwire.check().catch(() => null);
        if (tw === null) {
          await this.integrity.quarantine(i.projectDir, 'check-failed', [], tripwire.armed);
          const detail = t().jobs.integrityCheckFailed;
          await warn(detail);
          await tracker.finish(r.status).catch(() => {});
          throw new Error(detail);
        }
        // A protected config/exec file changed, appeared or vanished (git config/layout/hooks/attributes, .claude,
        // .mcp.json, CLAUDE*.md, .studio/permissions.json) other than by a noted core write: an unambiguous tamper (a move
        // out of the sandbox and back, or a run with the sandbox off). The project is quarantined against the pre-run
        // state (no agent and no git until it matches again) and the job fails before any commit.
        if (tw.tampered.length > 0) {
          await this.integrity.quarantine(i.projectDir, 'tampered', tw.tampered, tripwire.armed);
          const detail = t().jobs.protectedFilesTampered({ list: list(tw.tampered) });
          await warn(detail);
          await tracker.finish(r.status).catch(() => {});
          throw new Error(detail);
        }
        await this.integrity.setLastGood(i.projectDir, tw.snapshot).catch(() => {});
        if (tw.moved.length > 0) await warn(t().jobs.recordFoldersMoved({ list: list(tw.moved) }));
        if (tw.rewritten.length > 0) await warn(t().jobs.logHistoryRewritten({ list: list(tw.rewritten) }));
        const { record, event } = await tracker.finish(r.status);
        if (event) { try { i.onEvent(event); } catch { /* a faulty listener must not lose the outcome */ } }
        return { ...r, usage: record };
      });
      return {
        done: done.finally(release),
        // Revoked before the process is told to stop: it may keep calling the bridge until it exits.
        cancel: () => { void release(); run.cancel(); },
        killGroup: () => run.killGroup?.(),
      };
    } catch (err) {
      await release();
      throw err;
    }
  }
}

/** Private paths for one job's MCP config and token file (same base name; the folder is 0700). */
async function prepareRunFiles(configDir: string, jobId: string): Promise<{ config: string; token: string }> {
  const dir = await ensureRunDir(configDir);
  const base = join(dir, `${jobId.replace(/[^A-Za-z0-9-]/g, '_')}-${randomBytes(8).toString('hex')}`);
  return { config: `${base}.mcp.json`, token: `${base}.token` };
}

/** A real folder (not a link) owned by this user. */
const isOwnFolder = (st: Stats) => !st.isSymbolicLink() && st.isDirectory() && (process.getuid === undefined || st.uid === process.getuid());

/** `<configDir>/run`, private (0700): a link, a file or a folder owned by someone else is replaced, never followed nor chmod-ed. */
export async function ensureRunDir(configDir: string): Promise<string> {
  const dir = join(configDir, RUN_DIR);
  await mkdir(configDir, { recursive: true });
  const st = await lstat(dir).catch(() => null);
  if (st && isOwnFolder(st)) {
    if ((st.mode & 0o777) !== 0o700) await chmod(dir, 0o700);
    return dir;
  }
  if (st) await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { mode: 0o700 });
  return dir;
}

/** Removes what a crashed run left behind (the running server's `server.json` is kept). Assumes a single running instance per configDir (a second instance booting would delete the first one's live files). The folder is never followed if it was replaced by a link or a file. */
export async function sweepRunDir(configDir: string): Promise<void> {
  const dir = join(configDir, RUN_DIR);
  const st = await lstat(dir).catch(() => null);
  if (!st) return;
  if (!isOwnFolder(st)) { await rm(dir, { recursive: true, force: true }); return; }
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (name.endsWith('.mcp.json') || name.endsWith('.token')) await rm(join(dir, name), { force: true }).catch(() => {});
  }
}
