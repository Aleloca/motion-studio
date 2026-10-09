import { explainTool, type AgentEvent, type ExplainContext, type Explanation } from '@motion-studio/shared';
import { createContext } from 'react';

/**
 * Every command a turn ran (count work, design-owner decision): built from the turn's events, not only from the
 * automatic approvals our `approve` saw (with the setting on, Claude Code allows most sandboxed Bash itself, and those
 * calls never reach `approve`).
 *
 * Counting rule — a Bash `tool_use` counts as "ran" unless the user's answer (linked by `tool_use_id`) says it did
 * not run:
 * - `approval_decided` once/always → ran, marked "You approved" (counted in N and in M);
 * - `approval_decided` deny → "Denied", not counted; expired/cancelled → "Didn't run", not counted;
 * - no decision → ran without asking. An error `tool_result` still counts (a non-zero exit is a command that ran) and
 *   the row says it ended with an error. No `tool_result` at all (the job was cancelled mid-command, or the log was
 *   cut) still counts: the call was allowed and started.
 * - an `auto_approved` Bash event with no matching `tool_use` (older logs, a capped brand log) is a row of its own and
 *   counts: our `approve` allowed it.
 * - `auto_approved` Read (the Claude tmp safety net) is listed as "Read <file>" and never counted: it is not a command.
 */
export type CommandMark = 'auto' | 'approved' | 'denied' | 'notRun' | 'error';
export type CommandRow =
  | { kind: 'command'; key: string; command: string; explanation: Explanation | null; mark: CommandMark; counted: boolean }
  | { kind: 'read'; key: string; file: string; explanation: Explanation | null };
export interface CommandLog {
  rows: CommandRow[];
  /** Commands that ran (N). */
  ran: number;
  /** Of those, the ones the user approved (M). */
  approved: number;
  /** True when the run was sandboxed (its session event says so, or an older log has automatic Bash approvals, which only sandboxed jobs had). */
  sandboxed: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const commandOf = (input: unknown) => (isRecord(input) && typeof input.command === 'string' ? input.command : '');
/** The event's command was capped at 2000 characters with a trailing ellipsis by the core. */
const sameCommand = (shown: string, full: string) => shown === full || (shown.endsWith('…') && full.startsWith(shown.slice(0, -1)));

/**
 * Where the web judges paths when the core did not explain a call. Projects live directly in the workspace root; the
 * home folder is taken from a workspace under /Users/<name> or /home/<name>. Unknown pieces are replaced by folders
 * that match no real path, so every absolute path is "outside" (conservative: never a benign guess). $TMPDIR is
 * unknown in the web, so temp paths are judged as such only under /tmp.
 */
const UNKNOWN = '/␀motion-studio-unknown';
export function webExplainContext(workspace: string | null | undefined, project: string, creative?: string | null): ExplainContext {
  let root = typeof workspace === 'string' && workspace.startsWith('/') ? workspace : null;
  // Trailing slashes off, without a regex (linear on any input).
  while (root && root.length > 1 && root.endsWith('/')) root = root.slice(0, -1);
  if (root === '/') root = null;
  const projectDir = root ? `${root}/${project}` : `${UNKNOWN}/project`;
  const m = root ? /^\/(?:Users|home)\/[^/]+/.exec(root) : null;
  return {
    projectDir, cwd: projectDir, home: m ? m[0] : `${UNKNOWN}/home`,
    ...(creative ? { workDir: `${projectDir}/creatives/${creative}/work` } : {}),
  };
}

/** The workspace folder (GET /api/workspace), for webExplainContext; null when unknown. */
export const WorkspacePathContext = createContext<string | null>(null);

function explain(input: unknown, ctx: ExplainContext): Explanation | null {
  try { return explainTool('Bash', input, ctx); } catch { return null; }
}

export function commandLog(events: readonly AgentEvent[], ctx: ExplainContext, sandboxedHint?: boolean): CommandLog {
  const decisions = new Map<string, string>();
  const errors = new Map<string, boolean>();
  const bashIds = new Set<string>();
  const bashCommands: string[] = [];
  let sessionSandboxed: boolean | undefined;
  for (const e of events) {
    if (!isRecord(e)) continue;
    if (e.kind === 'approval_decided' && e.toolName === 'Bash' && typeof e.toolUseId === 'string') decisions.set(e.toolUseId, e.decision);
    else if (e.kind === 'tool_result' && typeof e.toolUseId === 'string') errors.set(e.toolUseId, e.isError === true);
    else if (e.kind === 'tool_use' && e.name === 'Bash' && typeof e.id === 'string') { bashIds.add(e.id); bashCommands.push(commandOf(e.input)); }
    else if (e.kind === 'session' && typeof e.sandboxed === 'boolean') sessionSandboxed = e.sandboxed;
  }
  // Automatic approvals: linked by id, else (older events) to the first unclaimed tool_use with the same command.
  const autoById = new Map<string, Explanation>();
  const autoByCommand: { command: string; explanation: Explanation; used: boolean }[] = [];
  const merged = new Set<AgentEvent>();
  const claimed = new Array<boolean>(bashCommands.length).fill(false);
  let anyAutoBash = false;
  for (const e of events) {
    if (e.kind !== 'auto_approved' || e.toolName !== 'Bash') continue;
    anyAutoBash = true;
    if (typeof e.toolUseId === 'string' && bashIds.has(e.toolUseId)) { autoById.set(e.toolUseId, e.explanation); merged.add(e); continue; }
    if (e.toolUseId === undefined && typeof e.command === 'string') {
      const i = bashCommands.findIndex((c, k) => !claimed[k] && sameCommand(e.command, c));
      if (i >= 0) { claimed[i] = true; autoByCommand[i] = { command: e.command, explanation: e.explanation, used: false }; merged.add(e); }
    }
  }

  const rows: CommandRow[] = [];
  let ran = 0;
  let approved = 0;
  let bashIndex = -1;
  events.forEach((e, i) => {
    const key = `c${i}`;
    if (e.kind === 'tool_use' && e.name === 'Bash' && typeof e.id === 'string') {
      bashIndex++;
      const d = decisions.get(e.id);
      const mark: CommandMark = d === 'once' || d === 'always' ? 'approved' : d === 'deny' ? 'denied' : d === 'expired' || d === 'cancelled' ? 'notRun'
        : errors.get(e.id) === true ? 'error' : 'auto';
      const counted = mark !== 'denied' && mark !== 'notRun';
      if (counted) ran++;
      if (mark === 'approved') approved++;
      const known = autoById.get(e.id) ?? autoByCommand[bashIndex]?.explanation;
      rows.push({ kind: 'command', key, command: commandOf(e.input), explanation: known ?? explain(e.input, ctx), mark, counted });
    } else if (e.kind === 'auto_approved' && !merged.has(e)) {
      if (e.toolName === 'Read') rows.push({ kind: 'read', key, file: typeof e.command === 'string' ? e.command : '', explanation: e.explanation ?? null });
      else { ran++; rows.push({ kind: 'command', key, command: typeof e.command === 'string' ? e.command : '', explanation: e.explanation ?? null, mark: 'auto', counted: true }); }
    }
  });
  return { rows, ran, approved, sandboxed: sessionSandboxed ?? sandboxedHint ?? anyAutoBash };
}
