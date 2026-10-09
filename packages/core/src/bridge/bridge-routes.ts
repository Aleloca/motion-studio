import type { FastifyInstance } from 'fastify';
import { EMPTY_BRAND_KIT, brandKitSchema } from '@motion-studio/shared';
import { MCP_SERVER, MCP_TOOLS } from '../agent/launcher.ts';
import type { ApprovalBroker } from '../approvals/broker.ts';
import { readConfinedFile } from '../brand/agent-guard.ts';
import { ProviderError } from '../providers/http.ts';
import { WorkspaceError } from '../workspace-store.ts';
import type { AgentBridge, BridgeContext } from './bridge.ts';
import { cleanProgress } from '../display-text.ts';
import { defaultClaudeTmpRoot, isInsideClaudeTmp } from './claude-tmp.ts';
import { t } from '../i18n.ts';

export { cleanProgress };

export type BridgeHandler = (ctx: BridgeContext, args: Record<string, unknown>) => Promise<unknown>;
export interface BridgeRoutesContext {
  bridge: AgentBridge; approvals: ApprovalBroker; extraTools?: Record<string, BridgeHandler>;
  /** The current workspace settings, read on every permission prompt. Absent or failing: nothing is approved automatically. */
  settings?: () => Promise<{ autoApproveSandboxed: boolean }>;
  /** Claude Code's per-user temp root (tests only; default: claudeTmpRootFor(process.env, uid)). null: no Read is auto-allowed. */
  claudeTmpRoot?: string | null;
}

const denyMessage = (d: 'deny' | 'expired' | 'cancelled'): string => (d === 'deny' ? t().approvals.denied : d === 'expired' ? t().approvals.expired : t().errors.jobCancelled);
const MAX_GUIDELINES = 50_000;

/**
 * Spec §3.2: a permission prompt is answered without asking the user only when ALL of these hold — the tool is exactly
 * `Bash` (case-sensitive, untrimmed: look-alikes and MCP tools keep asking), the job was registered as sandboxed by the
 * launcher, the setting was on when the job started (`autoApproveAtStart`) and is on *now* (read on every call, so turning it off mid-job applies to the next prompt), and the
 * input does not ask to leave the sandbox. `dangerouslyDisableSandbox` must be absent or exactly `false`: `true`, the
 * string "true" or any other value asks. A non-string command asks too.
 */
async function autoApprovable(ctx: BridgeRoutesContext, c: BridgeContext, toolName: unknown, input: Record<string, unknown>): Promise<boolean> {
  if (toolName !== 'Bash' || typeof input.command !== 'string') return false;
  return sameConditions(ctx, c, input);
}

/** The job conditions shared by Bash and Read: sandboxed job, setting on at start and now, no request to leave the sandbox. */
async function sameConditions(ctx: BridgeRoutesContext, c: BridgeContext, input: Record<string, unknown>): Promise<boolean> {
  if (c.sandboxed !== true || c.autoApproveAtStart !== true) return false;
  if (Object.hasOwn(input, 'dangerouslyDisableSandbox') && input.dangerouslyDisableSandbox !== false) return false;
  if (!ctx.settings) return false;
  try { return (await ctx.settings()).autoApproveSandboxed === true; } catch { return false; }
}

/**
 * Final-wave safety net (decisions-log): `Read` (exactly) of a regular file under Claude Code's OWN per-user temp root
 * (/tmp/claude-<uid>, see claude-tmp.ts) — never the rest of $TMPDIR — under the same job conditions as Bash. The
 * sandboxed agent can already read that folder with Bash; the path is checked as written and after resolving every
 * symlink. Claude Code's own deny rules (sensitive home paths, config folder) still apply before `approve` is called.
 */
async function autoApprovableRead(ctx: BridgeRoutesContext, c: BridgeContext, toolName: unknown, input: Record<string, unknown>): Promise<boolean> {
  if (toolName !== 'Read' || typeof input.file_path !== 'string') return false;
  if (!(await sameConditions(ctx, c, input))) return false;
  const root = ctx.claudeTmpRoot === undefined ? defaultClaudeTmpRoot() : ctx.claudeTmpRoot;
  return isInsideClaudeTmp(input.file_path, root);
}

/** Same cap as an approval's detail; the marker says the event shows only the start of the command. */
const MAX_EVENT_COMMAND = 2000;
const capCommand = (command: string) => {
  if (command.length <= MAX_EVENT_COMMAND) return command;
  const head = command.slice(0, MAX_EVENT_COMMAND - 1);
  return `${/[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head}\u2026`;
};

/** Claude Code's `tool_use_id` (e.g. "toolu_01…"): kept only when it looks like one, so a log never carries arbitrary text. */
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const toolUseIdOf = (v: unknown): string | undefined => (typeof v === 'string' && TOOL_USE_ID.test(v) ? v : undefined);

/** Calls from the `studio` MCP server: one per tool, authenticated by the job's bridge token. */
export function registerBridgeRoutes(app: FastifyInstance, ctx: BridgeRoutesContext) {
  const tools: Record<string, BridgeHandler> = {
    approve: async (c, a) => {
      const raw = a.input ?? a.tool_input;
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { behavior: 'deny', message: t().approvals.invalidRequest };
      const input = raw as Record<string, unknown>;
      // 'unknown' is a stable identifier (it reaches the broker and rules); the localized word is only for display.
      const toolName = typeof a.tool_name === 'string' ? a.tool_name : 'unknown';
      const toolUseId = toolUseIdOf(a.tool_use_id);
      const linked = toolUseId ? { toolUseId } : {};
      // Provider confirmations and Motion Studio's own tools never go through the agent's permission prompts.
      if (toolName.startsWith('provider:') || toolName.startsWith(`mcp__${MCP_SERVER}__`)) return { behavior: 'deny', message: t().approvals.invalidRequest };
      const auto = (await autoApprovable(ctx, c, a.tool_name, input)) ? { tool: 'Bash', shown: input.command as string }
        : (await autoApprovableRead(ctx, c, a.tool_name, input)) ? { tool: 'Read', shown: input.file_path as string }
          : null;
      if (auto) {
        // The job ended while the setting was read: nothing more runs on its behalf.
        if (c.signal.aborted) return { behavior: 'deny', message: denyMessage('cancelled') };
        const explanation = ctx.approvals.explain(c, auto.tool, input);
        // No explanation, no silent approval: the event must say what ran.
        if (explanation) {
          c.emit({ kind: 'auto_approved', toolName: auto.tool, command: capCommand(auto.shown), explanation, ...linked });
          return { behavior: 'allow', updatedInput: input };
        }
      }
      const { decision } = await ctx.approvals.request({ jobId: c.jobId, projectSlug: c.projectSlug, projectDir: c.projectDir, creativeSlug: c.creativeSlug, kind: 'tool', toolName, input, ...linked });
      // In the job's log: a finished turn tells the commands you approved or denied from those that ran without asking.
      try { c.emit({ kind: 'approval_decided', toolName, decision, ...linked }); } catch { /* a faulty listener must not change the answer */ }
      return decision === 'once' || decision === 'always'
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: denyMessage(decision) };
    },
    report_progress: async (c, a) => {
      const text = typeof a.message === 'string' ? cleanProgress(a.message) : '';
      if (!text || text.length > 300) throw new WorkspaceError(400, t().errors.invalidProgress);
      c.emit({ kind: 'progress', text });
      return { ok: true };
    },
    validate_output: async (c) => {
      if (!c.validate) throw new WorkspaceError(400, t().errors.validateOnlyCreatives);
      return c.validate();
    },
    // The core is not sandboxed: never follow the agent's symlinks, never read special or huge files.
    read_brand_kit: async (c) => {
      const g = await readConfinedFile(c.projectDir, 'brand/guidelines.md');
      const guidelines = g && 'text' in g ? g.text.slice(0, MAX_GUIDELINES) : '';
      const k = await readConfinedFile(c.projectDir, 'brand/brand-kit.json');
      if (k === null) return { kit: EMPTY_BRAND_KIT, guidelines };
      if ('text' in k) {
        let json: unknown = undefined;
        try { json = JSON.parse(k.text); } catch { /* reported below, without the parser's message */ }
        const parsed = brandKitSchema.safeParse(json);
        if (parsed.success) return { kit: parsed.data, guidelines };
      }
      return { kit: null, guidelines, error: t().errors.kitUnreadable };
    },
    ...ctx.extraTools,
  };

  app.post<{ Params: { tool: string } }>('/api/bridge/:tool', async (req, reply) => {
    const c = ctx.bridge.resolve(req.headers['x-motion-studio-bridge'] as string | undefined);
    if (!c) return reply.status(401).send({ error: t().errors.invalidBridgeAccess });
    const { tool } = req.params;
    const handler = Object.hasOwn(tools, tool) ? tools[tool] : undefined;
    if (!handler) return reply.status(404).send({ error: t().errors.unknownTool({ tool }) });
    // Defence in depth for a leaked token: a job only reaches the tools of its kind.
    if (tool !== 'approve' && !MCP_TOOLS[c.kind].includes(tool)) return reply.status(403).send({ error: t().errors.toolUnavailable });
    try {
      return await handler(c, (req.body ?? {}) as Record<string, unknown>);
    } catch (err) {
      if (err instanceof WorkspaceError || err instanceof ProviderError) return reply.status(err.status).send({ error: err.message });
      return reply.status(500).send({ error: t().errors.internalError });
    }
  });
}
