import { randomBytes } from 'node:crypto';
import type { AgentEvent } from '@motion-studio/shared';
import type { AgentJobKind } from '../agent/policy.ts';

/** What a bridge token gives access to: the job that owns it. */
export interface BridgeContext {
  jobId: string; kind: AgentJobKind; projectSlug: string; projectDir: string; creativeSlug: string | null;
  /**
   * The job's agent runs in the sandbox: set by the launcher from the value it computed for the policy (sandboxMode
   * 'auto' and sandbox available), never from anything the agent sends. Read-only: the stored context is a frozen copy.
   */
  readonly sandboxed: boolean;
  /**
   * `autoApproveSandboxed` when the job started (the value its policy was built with). `approve` auto-allows only when
   * it was on at start AND is on now: turning it on mid-job never changes a running job, turning it off applies at once.
   */
  readonly autoApproveAtStart: boolean;
  /** Same sink as the turn's onEvent. */
  emit(e: AgentEvent): void;
  /** Aborted when the job is cancelled or ends: in-flight provider calls must stop. */
  signal: AbortSignal;
  /** Creative turns only. */
  validate?: () => Promise<{ problems: string[]; outputs: unknown[] }>;
}

/** Per-job tokens that let the `studio` MCP server call back into the core on behalf of one agent job. */
export class AgentBridge {
  origin: string | null = null;
  private readonly contexts = new Map<string, BridgeContext>();
  setOrigin(url: string) { this.origin = url.replace(/\/+$/, ''); }
  register(ctx: BridgeContext): string {
    const t = randomBytes(32).toString('hex');
    // A frozen copy: later changes to the caller's object (or to a resolved context) can never flip the flags.
    this.contexts.set(t, Object.freeze({ ...ctx, sandboxed: ctx.sandboxed === true, autoApproveAtStart: ctx.autoApproveAtStart === true }));
    return t;
  }
  unregister(token: string) { this.contexts.delete(token); }
  resolve(token: string | undefined): BridgeContext | null {
    if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
    return this.contexts.get(token) ?? null;
  }
}
