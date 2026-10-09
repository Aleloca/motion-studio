import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { explainTool, type ApprovalDecision, type ApprovalKind, type ApprovalRequest, type ExplainContext, type Explanation, type ServerMessage } from '@motion-studio/shared';
import { CREATIVE_SLUG_RE } from '../creatives/creative-store.ts';
import { cleanAgentReason } from '../display-text.ts';
import { WorkspaceError } from '../workspace-store.ts';
import { PermissionsStore, ruleFor } from './permissions-store.ts';
import { t } from '../i18n.ts';

export interface ApprovalInput { jobId: string; projectSlug: string; projectDir: string; creativeSlug: string | null; kind: ApprovalKind; toolName: string; input: unknown; title?: string; detail?: string }
export interface ApprovalOutcome { decision: ApprovalDecision | 'expired' | 'cancelled' }

export function describeRequest(toolName: string, input: unknown): { title: string; detail: string } {
  const i = (input ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  const a = t().approvals;
  if (toolName === 'Bash') return { title: a.runCommand, detail: s(i.command) };
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) return { title: a.editOutside, detail: s(i.file_path) };
  if (toolName === 'Read') return { title: a.readOutside, detail: s(i.file_path) };
  if (toolName === 'WebFetch') return { title: a.openPage, detail: s(i.url) };
  return { title: a.useTool({ tool: toolName === 'unknown' ? a.unknownTool : toolName }), detail: JSON.stringify(input ?? {}).slice(0, 500) };
}

export { cleanAgentReason };

/** Where an agent job's paths are judged: relative paths start in the project (the `claude` process cwd). */
export function explainContext(job: { projectDir: string; creativeSlug: string | null }, env: { home?: string; tmpDir?: string } = {}): ExplainContext {
  const workDir = job.creativeSlug && CREATIVE_SLUG_RE.test(job.creativeSlug) ? join(job.projectDir, 'creatives', job.creativeSlug, 'work') : undefined;
  return {
    projectDir: job.projectDir, cwd: job.projectDir, ...(workDir ? { workDir } : {}),
    home: env.home ?? homedir(), tmpDir: env.tmpDir ?? (process.env.TMPDIR || tmpdir()),
  };
}

/** The deterministic explanation of a tool call; null if the analysis itself fails (the card then shows the title). */
export function explainRequest(toolName: string, input: unknown, ctx: ExplainContext): Explanation | null {
  try { return explainTool(toolName, input, ctx); } catch { return null; }
}

interface Pending { request: ApprovalRequest; alwaysLabel: string; projectDir: string; resolve(o: ApprovalOutcome): void; timer: NodeJS.Timeout }

export class ApprovalBroker {
  private readonly items = new Map<string, Pending>();
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  constructor(private readonly opts: { broadcast(m: ServerMessage): void; timeoutMs?: number; now?: () => Date; home?: string; tmpDir?: string }) {
    this.timeoutMs = opts.timeoutMs ?? 600_000;
    this.now = opts.now ?? (() => new Date());
  }

  /** What an agent job's tool call does, judged with this broker's home and temp folder. */
  explain(job: { projectDir: string; creativeSlug: string | null }, toolName: string, input: unknown): Explanation | null {
    return explainRequest(toolName, input, explainContext(job, this.opts));
  }

  request(input: ApprovalInput): Promise<ApprovalOutcome> {
    const described = describeRequest(input.toolName, input.input);
    // Projects live directly in the workspace root.
    const always = ruleFor(input.toolName, input.input, { workspaceRoot: dirname(input.projectDir) });
    const created = this.now();
    // Agent tool calls only: provider confirmations are summarized by the core itself (title/detail).
    const agentTool = input.kind === 'tool';
    const explanation = agentTool ? this.explain(input, input.toolName, input.input) : null;
    const agentReason = agentTool ? cleanAgentReason((input.input as { description?: unknown } | null)?.description) : null;
    const request: ApprovalRequest = {
      id: randomUUID(), jobId: input.jobId, projectSlug: input.projectSlug, creativeSlug: input.creativeSlug, kind: input.kind,
      title: input.title ?? described.title, detail: (input.detail ?? described.detail).slice(0, 2000), toolName: input.toolName,
      alwaysRule: always?.rule ?? null, explanation, agentReason,
      createdAt: created.toISOString(), expiresAt: new Date(created.getTime() + this.timeoutMs).toISOString(),
    };
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finish(request.id, 'expired'), this.timeoutMs);
      timer.unref();
      this.items.set(request.id, { request, alwaysLabel: always?.label ?? '', projectDir: input.projectDir, resolve, timer });
      this.opts.broadcast({ type: 'approval', approval: request });
    });
  }

  async decide(id: string, decision: ApprovalDecision): Promise<ApprovalRequest> {
    const item = this.items.get(id);
    if (!item) throw new WorkspaceError(404, t().errors.approvalNotFound);
    // Claim the request synchronously, before any await: a concurrent decide() gets 404.
    this.items.delete(id);
    clearTimeout(item.timer);
    if (decision === 'always' && item.request.alwaysRule) {
      try {
        await new PermissionsStore(item.projectDir).add(item.request.alwaysRule, item.alwaysLabel);
      } catch (err) {
        // The user did approve this call: let it through once, but report that the rule was not saved.
        this.settle(item, 'once');
        throw err;
      }
    }
    this.settle(item, decision);
    return item.request;
  }

  cancelJob(jobId: string) { for (const [id, i] of this.items) if (i.request.jobId === jobId) this.finish(id, 'cancelled'); }
  cancelAll() { for (const id of [...this.items.keys()]) this.finish(id, 'cancelled'); }
  pending(): ApprovalRequest[] { return [...this.items.values()].map((i) => i.request); }

  private finish(id: string, decision: ApprovalOutcome['decision']) {
    const item = this.items.get(id);
    if (!item) return;
    this.items.delete(id);
    clearTimeout(item.timer);
    this.settle(item, decision);
  }

  private settle(item: Pending, decision: ApprovalOutcome['decision']) {
    item.resolve({ decision });
    this.opts.broadcast({ type: 'approval_resolved', id: item.request.id, decision });
  }
}
