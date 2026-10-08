import { randomBytes } from 'node:crypto';
import type { AgentEvent } from '@motion-studio/shared';
import type { AgentJobKind } from '../agent/policy.ts';

/** What a bridge token gives access to: the job that owns it. */
export interface BridgeContext {
  jobId: string; kind: AgentJobKind; projectSlug: string; projectDir: string; creativeSlug: string | null;
  /** Same sink as the turn's onEvent. */
  emit(e: AgentEvent): void;
  /** Creative turns only. */
  validate?: () => Promise<{ problems: string[]; outputs: unknown[] }>;
}

/** Per-job tokens that let the `studio` MCP server call back into the core on behalf of one agent job. */
export class AgentBridge {
  origin: string | null = null;
  private readonly contexts = new Map<string, BridgeContext>();
  setOrigin(url: string) { this.origin = url.replace(/\/+$/, ''); }
  register(ctx: BridgeContext): string { const t = randomBytes(32).toString('hex'); this.contexts.set(t, ctx); return t; }
  unregister(token: string) { this.contexts.delete(token); }
  resolve(token: string | undefined): BridgeContext | null {
    if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
    return this.contexts.get(token) ?? null;
  }
}
