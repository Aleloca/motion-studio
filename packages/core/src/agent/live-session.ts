import { LIVE_LIMITS, type Pin, type RedirectOutcome } from '@motion-studio/shared';
import { t } from '../i18n.ts';
import { CodedError } from '../workspace-store.ts';
import type { AgentRun } from './runner.ts';

/**
 * Phase 13: the core's side of a running turn that takes messages (creative and console turns). One per job; every change
 * (a message, a redirect, the turn moving between attempts) runs through `serial`, so delivery order is the order the
 * messages arrived in and a message never meets a half-switched state (Review Focus 1). Shared by creative turns and the
 * console (fix round 1, I3): the message check, the answer cache and the redirect sequence live here once.
 */
export type LivePhase =
  /** Before the first agent run (queued or preparing): messages wait and are sent once the run starts. */
  | 'preparing'
  /** An agent run is attached: messages are written to it. */
  | 'agent'
  /** Between two runs (the core checks the outputs, or restarts for a redirect): messages wait for the next run. */
  | 'between'
  /** The agent is done and the core saves the version: messages become the next request. */
  | 'finalizing'
  | 'ended';

/**
 * Where a message ended up (fix round 1, I2: every message reaches one): `delivered` (written to a run, or given in a run's
 * prompt), `queued` (moved to the creative's queue as the next request), `dropped` (the turn ended with no run to take it:
 * only the console, which has no queue, and its answer says so).
 */
export type LiveFinal = 'delivered' | 'queued' | 'dropped';

export interface LiveMessage {
  clientId: string; text: string; pins: Pin[];
  mode: 'live' | 'redirect';
  /** `sent`: written to a running session; `prompt`: given in an attempt's prompt; `pending`: not given yet; `queued`: moved to the queue. */
  state: 'sent' | 'prompt' | 'pending' | 'queued';
  /** The `user_message_delivered` marker was emitted (sent by the runner, or by the core for a prompt). */
  announced?: boolean;
  /** Resolves once, with where the message ended up. */
  final: Promise<LiveFinal>;
  /** Settles `final` (the first call wins). */
  settle(f: LiveFinal): void;
}

export interface UserMessageInput { clientId: string; text: string; pins: Pin[] }

export function newLiveMessage(m: UserMessageInput, mode: LiveMessage['mode']): LiveMessage {
  let resolve!: (f: LiveFinal) => void;
  let done = false;
  const final = new Promise<LiveFinal>((r) => { resolve = r; });
  return { ...m, mode, state: 'pending', final, settle: (f) => { if (!done) { done = true; resolve(f); } } };
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
  /** A redirect that waits for the next run (the fallback: the run was cancelled, a new one takes it). */
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
  /** A message written to a run, or given in a run's prompt: delivered. */
  given(m: LiveMessage, state: 'sent' | 'prompt'): void { m.state = state; m.settle('delivered'); }
}

/**
 * A message's text and pins checked against the limits (Review Focus 3): every refusal is a translated 409 `limit`, an
 * empty message a 400. Pin notes count with the text (they reach the agent too).
 */
export function checkLiveMessage(m: UserMessageInput): UserMessageInput {
  const text = m.text.trim();
  if (!text && m.pins.length === 0) throw new CodedError(400, t().live.emptyMessage, 'empty-message');
  const notes = m.pins.reduce((n, p) => n + (p.note?.length ?? 0), 0);
  if (text.length + notes > LIVE_LIMITS.maxChars) throw new CodedError(409, t().live.tooLong({ max: LIVE_LIMITS.maxChars }), 'limit');
  return { clientId: m.clientId, text, pins: m.pins };
}

/** Answers by id, kept for a repeat of the same request (a double click shares the pending one); a refusal is forgotten. */
export class AnswerCache {
  private readonly answers = new Map<string, Promise<unknown>>();
  constructor(private readonly max = 1000) {}
  once<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const had = this.answers.get(id);
    if (had) return had as Promise<T>;
    const p = fn();
    this.answers.set(id, p);
    if (this.answers.size > this.max) this.answers.delete(this.answers.keys().next().value!);
    p.catch(() => { if (this.answers.get(id) === p) this.answers.delete(id); });
    return p;
  }
}

/** A live message as the agent reads it: the text, then its pinned comments (no attachments in live messages). */
export function liveMessageText(text: string, pins: readonly Pin[], pinLine: (p: Pin) => string): string {
  if (pins.length === 0) return text;
  return [text, '', 'Pinned comments:', ...pins.map(pinLine)].filter((l, i) => !(i === 0 && l === '')).join('\n');
}

export interface RedirectHooks {
  /** The job's open approvals, cancelled before anything else (no spending after a redirect). */
  cancelApprovals(): void;
  /** The turn is over (saving or ended): the creative queues the words, the console refuses (it has no queue). */
  late(m: UserMessageInput): Promise<RedirectOutcome>;
  /** Records the redirect (the creative's user entry) and its count, inside the turn's serial chain. */
  record(msg: LiveMessage, count: number): Promise<void>;
  /** The core's `interrupted` marker, when the fallback stops a run. */
  interrupted(): void | Promise<void>;
  /** The redirect as the agent reads it. */
  text(msg: LiveMessage): string;
}

/**
 * Stop and redirect (spec §3), shared by creative and console turns. Approvals first, then the running core tools (the job
 * goes on), then, inside the serial chain with the phase checked there: with interrupt on, `interrupt()` and `send()` into
 * the same run (`interrupted`); otherwise the fallback — the run (if one runs) is cancelled and the next run takes the
 * message. The answer waits for that, so it is the truth: `restarted` when a run took it, `queued-after-finish` when the
 * turn ended first and the words were queued, a 409 `not-running` when they could go nowhere (the UI keeps them).
 */
export async function redirectLive(live: LiveSession, m: UserMessageInput, hooks: RedirectHooks): Promise<RedirectOutcome> {
  if (live.messages.length >= LIVE_LIMITS.perTurn) throw new CodedError(409, t().live.tooManyLive({ max: LIVE_LIMITS.perTurn }), 'limit');
  hooks.cancelApprovals();
  live.abortTools();
  const step = await live.serial(async (): Promise<{ now: RedirectOutcome } | { msg: LiveMessage }> => {
    if (live.phase === 'finalizing' || live.phase === 'ended') return { now: await hooks.late(m) };
    if (live.messages.length >= LIVE_LIMITS.perTurn) throw new CodedError(409, t().live.tooManyLive({ max: LIVE_LIMITS.perTurn }), 'limit');
    const msg = newLiveMessage(m, 'redirect');
    live.messages.push(msg);
    await hooks.record(msg, live.messages.length);
    const run = live.phase === 'agent' ? live.run : null;
    if (run && live.caps.interrupt && (await run.interrupt?.()) === 'interrupted'
      && (await run.send?.({ text: hooks.text(msg), clientId: msg.clientId })) === 'written') {
      live.given(msg, 'sent');
      return { now: 'interrupted' };
    }
    live.redirect = msg;
    // Only a run that is really stopped gets the marker (before the agent started, nothing is interrupted).
    if (run) { await hooks.interrupted(); run.cancel(); }
    return { msg };
  });
  if ('now' in step) return step.now;
  const f = await step.msg.final;
  if (f === 'delivered') return 'restarted';
  if (f === 'queued') return 'queued-after-finish';
  throw new CodedError(409, t().live.notRunning, 'not-running');
}
