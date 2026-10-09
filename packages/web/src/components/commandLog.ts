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
 *   the row says it ended with an error;
 * - no decision and no `tool_result` in a finished turn (cancelled or failed mid-command) → "Interrupted": counted,
 *   and the line then says "ran or were attempted" (it may have stopped before doing anything). While the turn runs,
 *   or when the log was cut (`finished` false), such a call is simply in progress: counted, no mark;
 * - an `auto_approved` Bash event with no matching `tool_use` (older logs, a capped brand log) is a row of its own and
 *   counts: our `approve` allowed it;
 * - `auto_approved` Read (the Claude tmp safety net) is listed as "Read <file>" and never counted: it is not a command.
 */
export type CommandMark = 'auto' | 'approved' | 'denied' | 'notRun' | 'error' | 'interrupted';
export type CommandRow =
  | { kind: 'command'; key: string; command: string; explanation: Explanation | null; mark: CommandMark; counted: boolean }
  | { kind: 'read'; key: string; file: string; explanation: Explanation | null };
export interface CommandLog {
  rows: CommandRow[];
  /** Commands that ran (N). */
  ran: number;
  /** Of those, the ones the user approved (M). */
  approved: number;
  /** Some counted calls were interrupted: the line says "ran or were attempted". */
  attempted: boolean;
  /**
   * True when the run was sandboxed: its FIRST session event says so (a line appended later cannot flip it), or an
   * older log without the flag has automatic Bash approvals, which only sandboxed jobs had.
   */
  sandboxed: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const commandOf = (input: unknown) => (isRecord(input) && typeof input.command === 'string' ? input.command : '');

/** The command as an `auto_approved` event shows it: the core's cap (bridge-routes capCommand), 2000 characters with a marker. */
const MAX_EVENT_COMMAND = 2000;
function shownCommand(command: string): string {
  if (command.length <= MAX_EVENT_COMMAND) return command;
  const head = command.slice(0, MAX_EVENT_COMMAND - 1);
  const last = head.charCodeAt(head.length - 1);
  return `${last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head}…`;
}

/** The placeholder root for unknown locations: never shown (ExplainContext.opaqueRoot). */
export const UNKNOWN_ROOT = '/␀motion-studio-unknown';

/**
 * Where the web judges paths when the core did not explain a call. Projects live directly in the workspace root; the
 * home folder is taken from a workspace under /Users/<name> or /home/<name>. Unknown pieces are replaced by folders
 * under UNKNOWN_ROOT, which match no real path, so every absolute path is "outside" (conservative: never a benign
 * guess), and are never displayed. $TMPDIR is unknown in the web, so temp paths are judged as such only under /tmp.
 */
export function webExplainContext(workspace: string | null | undefined, project: string, creative?: string | null): ExplainContext {
  let root = typeof workspace === 'string' && workspace.startsWith('/') ? workspace : null;
  // Trailing slashes off, without a regex (linear on any input).
  while (root && root.length > 1 && root.endsWith('/')) root = root.slice(0, -1);
  if (root === '/') root = null;
  const projectDir = root ? `${root}/${project}` : `${UNKNOWN_ROOT}/project`;
  const m = root ? /^\/(?:Users|home)\/[^/]+/.exec(root) : null;
  return {
    projectDir, cwd: projectDir, home: m ? m[0] : `${UNKNOWN_ROOT}/home`, opaqueRoot: UNKNOWN_ROOT,
    ...(creative ? { workDir: `${projectDir}/creatives/${creative}/work` } : {}),
  };
}

/** The workspace folder (GET /api/workspace), for webExplainContext; null when unknown. */
export const WorkspacePathContext = createContext<string | null>(null);

function explain(input: unknown, ctx: ExplainContext): Explanation | null {
  try { return explainTool('Bash', input, ctx); } catch { return null; }
}

/**
 * `finished`: the turn is over (succeeded, failed or cancelled) and its log is complete, so a call with neither a
 * result nor a decision was interrupted. `sandboxedHint`: the brand endpoint's flag (already first-wins).
 */
export function commandLog(events: readonly AgentEvent[], ctx: ExplainContext, opts: { finished: boolean; sandboxedHint?: boolean }): CommandLog {
  const decisions = new Map<string, string>();
  const results = new Map<string, boolean>();
  const bashIds = new Set<string>();
  const bashCommands: string[] = [];
  let sessionSandboxed: boolean | undefined;
  for (const e of events) {
    if (!isRecord(e)) continue;
    if (e.kind === 'approval_decided' && e.toolName === 'Bash' && typeof e.toolUseId === 'string') decisions.set(e.toolUseId, e.decision);
    else if (e.kind === 'tool_result' && typeof e.toolUseId === 'string') results.set(e.toolUseId, e.isError === true);
    else if (e.kind === 'tool_use' && e.name === 'Bash' && typeof e.id === 'string') { bashIds.add(e.id); bashCommands.push(commandOf(e.input)); }
    else if (e.kind === 'session' && typeof e.sandboxed === 'boolean' && sessionSandboxed === undefined) sessionSandboxed = e.sandboxed;
  }
  // Automatic approvals: linked by id, else (older events) to the first unclaimed tool_use with the same (capped)
  // command — one queue of tool_use positions per shown command, so the matching stays linear.
  const autoById = new Map<string, Explanation>();
  const autoByIndex = new Map<number, Explanation>();
  const queues = new Map<string, number[]>();
  bashCommands.forEach((c, k) => {
    const key = shownCommand(c);
    const q = queues.get(key);
    if (q) q.push(k); else queues.set(key, [k]);
  });
  const heads = new Map<string, number>();
  const merged = new Set<AgentEvent>();
  let anyAutoBash = false;
  for (const e of events) {
    if (e.kind !== 'auto_approved' || e.toolName !== 'Bash') continue;
    anyAutoBash = true;
    if (typeof e.toolUseId === 'string' && bashIds.has(e.toolUseId)) { autoById.set(e.toolUseId, e.explanation); merged.add(e); continue; }
    if (e.toolUseId === undefined && typeof e.command === 'string') {
      const q = queues.get(e.command);
      const h = heads.get(e.command) ?? 0;
      if (q && h < q.length) { heads.set(e.command, h + 1); autoByIndex.set(q[h]!, e.explanation); merged.add(e); }
    }
  }

  const rows: CommandRow[] = [];
  let ran = 0;
  let approved = 0;
  let attempted = false;
  let bashIndex = -1;
  events.forEach((e, i) => {
    const key = `c${i}`;
    if (e.kind === 'tool_use' && e.name === 'Bash' && typeof e.id === 'string') {
      bashIndex++;
      const d = decisions.get(e.id);
      const mark: CommandMark = d === 'once' || d === 'always' ? 'approved' : d === 'deny' ? 'denied' : d === 'expired' || d === 'cancelled' ? 'notRun'
        : results.get(e.id) === true ? 'error' : !results.has(e.id) && opts.finished ? 'interrupted' : 'auto';
      const counted = mark !== 'denied' && mark !== 'notRun';
      if (counted) ran++;
      if (mark === 'approved') approved++;
      if (mark === 'interrupted') attempted = true;
      const known = autoById.get(e.id) ?? autoByIndex.get(bashIndex);
      rows.push({ kind: 'command', key, command: commandOf(e.input), explanation: known ?? explain(e.input, ctx), mark, counted });
    } else if (e.kind === 'auto_approved' && !merged.has(e)) {
      if (e.toolName === 'Read') rows.push({ kind: 'read', key, file: typeof e.command === 'string' ? e.command : '', explanation: e.explanation ?? null });
      else { ran++; rows.push({ kind: 'command', key, command: typeof e.command === 'string' ? e.command : '', explanation: e.explanation ?? null, mark: 'auto', counted: true }); }
    }
  });
  return { rows, ran, approved, attempted, sandboxed: sessionSandboxed ?? opts.sandboxedHint ?? anyAutoBash };
}
