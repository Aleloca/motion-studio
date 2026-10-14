import type { Pin } from '@motion-studio/shared';
import type { AgentRun } from './runner.ts';

/**
 * Phase 13: the core's side of a running turn that takes messages (creative and console turns). One per job; every change
 * (a message, a redirect, the turn moving between attempts) runs through `serial`, so delivery order is the order the
 * messages arrived in and a message never meets a half-switched state (Review Focus 1).
 */
export type LivePhase =
  /** Before the first agent run (queued or preparing): messages wait and are sent once the run starts. */
  | 'preparing'
  /** An agent run is attached: messages are written to it. */
  | 'agent'
  /** Between two attempts (the core checks the outputs): messages go into the next attempt's prompt. */
  | 'between'
  /** The agent is done and the core saves the version: messages become the next request. */
  | 'finalizing'
  | 'ended';

export interface LiveMessage {
  clientId: string; text: string; pins: Pin[];
  mode: 'live' | 'redirect';
  /** `sent`: written to a running session; `prompt`: given in an attempt's prompt; `pending`: not given yet; `queued`: moved to the queue. */
  state: 'sent' | 'prompt' | 'pending' | 'queued';
  /** The `user_message_delivered` marker was emitted (sent by the runner, or by the core for a prompt). */
  announced?: boolean;
}

export interface LiveCapabilities { liveInput: boolean; interrupt: boolean }
export const NO_LIVE: LiveCapabilities = { liveInput: false, interrupt: false };

export class LiveSession {
  phase: LivePhase = 'preparing';
  run: AgentRun | null = null;
  /** No attempt follows the current one (a message the run refuses becomes the next request). */
  lastAttempt = false;
  /** The session of the agent run now or last attached (from its events). */
  sessionId: string | undefined;
  /** Every message of the turn (live and redirect), in arrival order. */
  readonly messages: LiveMessage[] = [];
  /** A redirect that waits for the next attempt (the fallback: the run was cancelled, a new one resumes the session). */
  redirect: LiveMessage | null = null;
  private tools = new AbortController();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly jobId: string, public caps: LiveCapabilities) {}

  /** Runs `fn` after every earlier change of this turn; a failure is the caller's only. */
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn);
    this.chain = p.catch(() => {});
    return p;
  }

  /** The signal of the core tools started now (preview frames): a redirect aborts it, not the job. */
  get toolSignal(): AbortSignal { return this.tools.signal; }

  /** Aborts the core tools running now (the turn's own and the agent's bridge calls); later ones get a fresh signal. */
  abortTools(): void {
    this.tools.abort();
    this.tools = new AbortController();
    this.run?.abortTools?.();
  }

  pending(): LiveMessage[] { return this.messages.filter((m) => m.state === 'pending'); }
  /** The user's words of the turn for a prompt: every message not moved to the queue, in order. */
  words(): LiveMessage[] { return this.messages.filter((m) => m.state !== 'queued'); }
}

/** A live message as the agent reads it: the text, then its pinned comments (no attachments in live messages). */
export function liveMessageText(text: string, pins: readonly Pin[], pinLine: (p: Pin) => string): string {
  if (pins.length === 0) return text;
  return [text, '', 'Pinned comments:', ...pins.map(pinLine)].filter((l, i) => !(i === 0 && l === '')).join('\n');
}
