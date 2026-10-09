import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type { ApprovalDecision, ApprovalKind, ApprovalRequest, ServerMessage } from '@motion-studio/shared';
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

interface Pending { request: ApprovalRequest; alwaysLabel: string; projectDir: string; resolve(o: ApprovalOutcome): void; timer: NodeJS.Timeout }

export class ApprovalBroker {
  private readonly items = new Map<string, Pending>();
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  constructor(private readonly opts: { broadcast(m: ServerMessage): void; timeoutMs?: number; now?: () => Date }) {
    this.timeoutMs = opts.timeoutMs ?? 600_000;
    this.now = opts.now ?? (() => new Date());
  }

  request(input: ApprovalInput): Promise<ApprovalOutcome> {
    const described = describeRequest(input.toolName, input.input);
    // Projects live directly in the workspace root.
    const always = ruleFor(input.toolName, input.input, { workspaceRoot: dirname(input.projectDir) });
    const created = this.now();
    const request: ApprovalRequest = {
      id: randomUUID(), jobId: input.jobId, projectSlug: input.projectSlug, creativeSlug: input.creativeSlug, kind: input.kind,
      title: input.title ?? described.title, detail: (input.detail ?? described.detail).slice(0, 2000), toolName: input.toolName,
      alwaysRule: always?.rule ?? null, explanation: null, agentReason: null,
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
