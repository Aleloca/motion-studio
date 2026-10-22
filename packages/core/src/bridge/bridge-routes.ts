import type { FastifyInstance } from 'fastify';
import { ASK_USER_QUESTION_TOOL, EMPTY_BRAND_KIT, askUserQuestionInputSchema, brandKitSchema, type AgentEvent, type BrandPhase } from '@motion-studio/shared';
import { MCP_SERVER, MCP_TOOLS } from '../agent/launcher.ts';
import { BRAND_CODEBASE_DENIED_TOOLS } from '../agent/runner.ts';
import type { ApprovalBroker } from '../approvals/broker.ts';
import { readConfinedFile } from '../brand/agent-guard.ts';
import { ProviderError } from '../providers/http.ts';
import { WorkspaceError } from '../workspace-store.ts';
import type { AgentBridge, BridgeContext } from './bridge.ts';
import { cleanProgress } from '../display-text.ts';
import { defaultClaudeTmpRoot, isInsideClaudeTmp } from './claude-tmp.ts';
import { namesProtectedPath } from './protected-paths.ts';
import { t } from '../i18n.ts';

export { cleanProgress };

export type BridgeHandler = (ctx: BridgeContext, args: Record<string, unknown>) => Promise<unknown>;
export interface BridgeRoutesContext {
  bridge: AgentBridge; approvals: ApprovalBroker; extraTools?: Record<string, BridgeHandler>;
  /** The current workspace settings, read on every permission prompt. Absent or failing: nothing is approved automatically. */
  settings?: () => Promise<{ autoApproveSandboxed: boolean }>;
  /** Claude Code's per-user temp root (tests only; default: claudeTmpRootFor(process.env, uid)). null: no Read is auto-allowed. */
  claudeTmpRoot?: string | null;
  /**
   * Folders no permission prompt may open (Motion Studio's config folder: the UI token and every live job's bridge token).
   * A request whose path argument resolves inside one is denied at once, without a card.
   */
  protectedRoots?: string[];
}

/** The analysis phases the agent reports; `queued` and `done` are the core's own markers. */
export const AGENT_PHASES: readonly BrandPhase[] = ['reading', 'fonts', 'colors', 'logos', 'tone', 'writing'];

/** What a translation turn's agent may still ask to use (reads outside the project): nothing else ever reaches a card. */
const LOCALIZE_READ_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep']);
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
  // A translation turn never gets anything approved by itself (Phase 12, fix I1), nor a directions turn (Phase 15).
  // Decision 1421: nor a brief session.
  if (c.kind === 'localize' || c.kind === 'variant-directions' || c.kind === 'creative-group' || c.kind === 'brief' || c.kind === 'video-analysis' || c.kind === 'subtitles-translate') return false;
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

/**
 * User note 8: Claude Code's built-in `AskUserQuestion` (exact name), reached through the permission prompt. It runs nothing
 * and reads nothing: the only thing it can obtain is the user's answer. An input that is not a valid question is denied
 * without a card; otherwise a question card waits for the user, under the same timer and the same stop as any approval.
 * The answer goes back as documented for the Agent SDK's `canUseTool` (https://code.claude.com/docs/en/agent-sdk/user-input,
 * "Return answers to Claude"): `allow` with the original input plus `answers` (question text → label, several labels joined
 * with ", ", the user's own text for "Other"). That the CLI's `--permission-prompt-tool` honours the same answer is not
 * documented: see scripts/spike/ask-user-question-probe.mjs (decisions log 874).
 */
async function askUser(ctx: BridgeRoutesContext, c: BridgeContext, input: Record<string, unknown>, linked: { toolUseId?: string }) {
  const parsed = askUserQuestionInputSchema.safeParse(input);
  if (!parsed.success) return { behavior: 'deny', message: t().approvals.invalidRequest };
  if (c.signal.aborted) return { behavior: 'deny', message: denyMessage('cancelled') };
  const { questions } = parsed.data;
  const { decision, answers } = await ctx.approvals.request({ jobId: c.jobId, projectSlug: c.projectSlug, projectDir: c.projectDir, creativeSlug: c.creativeSlug, kind: 'question', toolName: ASK_USER_QUESTION_TOOL, input, questions, ...linked });
  const answered = decision === 'once' && answers !== undefined;
  const event: AgentEvent = {
    kind: 'question_answered', outcome: answered ? 'answered' : decision === 'expired' || decision === 'cancelled' ? decision : 'deny',
    // Own string values only (review fix): a question text never reads a property of Object.prototype.
    items: questions.map((q) => {
      const a = answered && Object.hasOwn(answers, q.question) ? answers[q.question] : undefined;
      const other = typeof a === 'string' ? userPartOf(a, q.options.map((o) => o.label)) : undefined;
      return { header: q.header, question: q.question, ...(typeof a === 'string' ? { answer: a } : {}), ...(other ? { other } : {}) };
    }), ...linked,
  };
  // In the conversation as the question and its answer, never as a permission.
  try { c.emit(event); } catch { /* a faulty listener must not change the answer */ }
  if (answered) return { behavior: 'allow', updatedInput: { ...input, answers } };
  return { behavior: 'deny', message: decision === 'expired' ? t().approvals.questionExpired : decision === 'cancelled' ? denyMessage('cancelled') : t().approvals.questionSkipped };
}

/**
 * Re-review of phase 3: the part of an answer the user wrote (the "Other" text), without the options the agent wrote. The
 * answer joins the chosen labels and the user's text with ", " (`askUser` above); a label may hold ", " itself, so the
 * longest run of parts that is a label goes first. Undefined when nothing is the user's own.
 */
export function userPartOf(answer: string, labels: readonly string[]): string | undefined {
  const parts = answer.split(', ');
  const own: string[] = [];
  for (let i = 0; i < parts.length;) {
    let j = parts.length;
    while (j > i && !labels.includes(parts.slice(i, j).join(', '))) j--;
    if (j > i) { i = j; continue; }
    own.push(parts[i]!);
    i++;
  }
  const text = own.join(', ').trim();
  return text || undefined;
}

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
      // A translation turn only reads (Phase 12, fix I1): Bash and every tool that could write are refused without a card.
      if (c.kind === 'localize' && !LOCALIZE_READ_TOOLS.has(toolName)) return { behavior: 'deny', message: t().approvals.readOnlyTurn };
      // The directions turn of a variant group (Phase 15) only hands its directions over: nothing else ever reaches a card.
      if (c.kind === 'variant-directions') return { behavior: 'deny', message: t().approvals.directionsTurnOnly };
      // Decision 1421: a brief session reads the project and its linked folders (allowed by its rules) and asks the user short
      // questions; anything else (a read elsewhere, a command, a write) is refused without a card.
      if (c.kind === 'brief' && toolName !== ASK_USER_QUESTION_TOOL) return { behavior: 'deny', message: t().approvals.briefReadOnly };
      // Decision 1493: a video analysis reads its frames (allowed by its rules) and writes through its tool; nobody is there to
      // answer a card, so everything else (a read elsewhere, a question, a command) is refused without one.
      if (c.kind === 'video-analysis') return { behavior: 'deny', message: t().approvals.videoAnalysisReadOnly };
      // Task 23: a subtitle translation only hands its lines over; nobody is there to answer a card.
      if (c.kind === 'subtitles-translate') return { behavior: 'deny', message: t().approvals.subtitlesTranslateOnly };
      // A brand analysis of codebases (Phase 14, fix round 1) never runs commands nor searches file contents: Bash and Grep
      // are refused without a card, whatever the sandbox (they are also denied by the job's rules).
      if (c.kind === 'brand-analysis' && (c.codebases?.length ?? 0) > 0 && BRAND_CODEBASE_DENIED_TOOLS.includes(toolName)) return { behavior: 'deny', message: t().approvals.brandCodebaseToolDenied };
      // Motion Studio's config folder (tokens) is never opened, whatever the tool, whoever would answer: denied before any
      // auto-approval or card. Bash is not parsed here: its pre-allowed commands never reach this prompt (see the README).
      if (await namesProtectedPath(toolName, input, ctx.protectedRoots ?? [], c.projectDir).catch(() => true)) {
        return { behavior: 'deny', message: t().approvals.protectedPath };
      }
      // Never auto-approved, never "Always": a question card (user note 8).
      if (toolName === ASK_USER_QUESTION_TOOL) return askUser(ctx, c, input, linked);
      // Phase 3 of the single agent: the coordinator only reads the project (allowed without a card) and asks; anything else is
      // its helpers' work, refused without a card.
      if (c.kind === 'creative-group') return { behavior: 'deny', message: t().approvals.coordinatorReadOnly };
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
      // A phase only means something in a brand analysis; other jobs keep their text and the field is dropped.
      if (c.kind === 'brand-analysis' && a.phase !== undefined && a.phase !== null) {
        if (typeof a.phase !== 'string' || !AGENT_PHASES.includes(a.phase as BrandPhase)) throw new WorkspaceError(400, t().errors.invalidPhase);
        c.emit({ kind: 'progress', text, phase: a.phase as BrandPhase });
        return { ok: true };
      }
      c.emit({ kind: 'progress', text });
      return { ok: true };
    },
    validate_composition: async (c, a) => {
      if (!c.validateComposition) throw new WorkspaceError(400, t().errors.validateOnlyCreatives);
      const format = typeof a.format === 'string' && a.format.trim() ? a.format.trim().slice(0, 200) : undefined;
      return c.validateComposition(format);
    },
    preview_frames: async (c, a) => {
      if (!c.previewFrames) throw new WorkspaceError(400, t().errors.validateOnlyCreatives);
      return c.previewFrames({ format: a.format, times: a.times, ...(Object.hasOwn(a, 'locale') ? { locale: a.locale } : {}) });
    },
    submit_localization: async (c, a) => {
      if (!c.submitLocalization) throw new WorkspaceError(400, t().errors.toolUnavailable);
      return c.submitLocalization(a);
    },
    // Phase 3 of the single agent: the coordinator's own tools, bound to its group turn (MCP_TOOLS and the handlers).
    list_variants: async (c, a) => {
      if (c.kind !== 'creative-group' || !c.groupTools) throw new WorkspaceError(403, t().errors.toolUnavailable);
      return c.groupTools.listVariants(a);
    },
    work_on_variants: async (c, a) => {
      if (c.kind !== 'creative-group' || !c.groupTools) throw new WorkspaceError(403, t().errors.toolUnavailable);
      return c.groupTools.workOnVariants(a);
    },
    add_variants: async (c, a) => {
      if (c.kind !== 'creative-group' || !c.groupTools) throw new WorkspaceError(403, t().errors.toolUnavailable);
      return c.groupTools.addVariants(a);
    },
    // Phase 15: only a `variant-directions` job has it (MCP_TOOLS, checked below for every tool, and the handler itself).
    submit_variant_directions: async (c, a) => {
      if (c.kind !== 'variant-directions' || !c.submitVariantDirections) throw new WorkspaceError(403, t().errors.toolUnavailable);
      return c.submitVariantDirections(a);
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
      // Phase 13: a call of a live turn gets the signal of the current tool generation (a redirect aborts it, not the job).
      const call: BridgeContext = c.toolSignal ? Object.freeze({ ...c, signal: c.toolSignal() }) : c;
      return await handler(call, (req.body ?? {}) as Record<string, unknown>);
    } catch (err) {
      if (err instanceof WorkspaceError || err instanceof ProviderError) return reply.status(err.status).send({ error: err.message });
      return reply.status(500).send({ error: t().errors.internalError });
    }
  });
}
