import type { AgentEvent, ModelUsage, TokenCounts } from '@motion-studio/shared';
import { t } from '../i18n.ts';

export class LineSplitter {
  private buf = '';
  push(chunk: string): string[] {
    this.buf += chunk;
    const parts = this.buf.split('\n');
    this.buf = parts.pop() ?? '';
    return parts.map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== '');
  }
  flush(): string[] {
    const rest = this.buf.trim();
    this.buf = '';
    return rest ? [rest] : [];
  }
}

const MAX_TOOL_RESULT = 4000;
type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (isObj(c) && typeof c.text === 'string' ? c.text : JSON.stringify(c))).join('\n');
  }
  if (content === undefined || content === null) return '';
  return JSON.stringify(content);
}

/** A token count as Claude Code reports it; anything else (missing, negative, fractional, text) reads as 0, never a guess. */
const count = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);
const money = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** `usage` of a result or of an assistant message (snake_case, Anthropic API shape). */
function apiTokens(u: Json): TokenCounts {
  return { input: count(u.input_tokens), output: count(u.output_tokens), cacheRead: count(u.cache_read_input_tokens), cacheWrite: count(u.cache_creation_input_tokens) };
}

/** `modelUsage` of a result (camelCase, one entry per model). CUMULATIVE over a resumed session, like `total_cost_usd`. */
function modelUsages(m: unknown): ModelUsage[] {
  if (!isObj(m)) return [];
  return Object.entries(m).flatMap(([model, u]) => (model !== '' && isObj(u) ? [{
    model,
    tokens: { input: count(u.inputTokens), output: count(u.outputTokens), cacheRead: count(u.cacheReadInputTokens), cacheWrite: count(u.cacheCreationInputTokens) },
    costUsd: money(u.costUSD),
  }] : []));
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

/** One line of Claude Code's stream-json; `msg` is the parsed object when the line was valid JSON. */
function parseLine(line: string): { events: AgentEvent[]; msg: Json | null } {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return { events: [{ kind: 'parse_error', line: line.slice(0, 500) }], msg: null };
  }
  if (!isObj(msg)) return { events: [{ kind: 'parse_error', line: line.slice(0, 500) }], msg: null };
  return { events: eventsOf(msg), msg };
}

/** Stateless: the events of one line (no live usage, see ClaudeStreamParser). */
export function parseClaudeLine(line: string): AgentEvent[] {
  return parseLine(line).events;
}

function eventsOf(msg: Json): AgentEvent[] {
  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init' && typeof msg.session_id === 'string') {
        return [{ kind: 'session', sessionId: msg.session_id, ...(typeof msg.model === 'string' ? { model: msg.model } : {}) }];
      }
      return [];
    case 'assistant': {
      const content = isObj(msg.message) && Array.isArray(msg.message.content) ? msg.message.content : [];
      const out: AgentEvent[] = [];
      for (const c of content) {
        if (!isObj(c)) continue;
        if (c.type === 'text' && typeof c.text === 'string' && c.text !== '') out.push({ kind: 'text', text: c.text });
        if (c.type === 'tool_use') out.push({ kind: 'tool_use', id: str(c.id), name: str(c.name), input: c.input });
      }
      return out;
    }
    case 'user': {
      const content = isObj(msg.message) && Array.isArray(msg.message.content) ? msg.message.content : [];
      return content.filter((c): c is Json => isObj(c) && c.type === 'tool_result').map((c) => ({
        kind: 'tool_result' as const,
        toolUseId: str(c.tool_use_id),
        isError: c.is_error === true,
        content: toolResultText(c.content).slice(0, MAX_TOOL_RESULT),
      }));
    }
    case 'rate_limit_event': {
      const info = isObj(msg.rate_limit_info) ? msg.rate_limit_info : {};
      return [{ kind: 'rate_limit', status: String(info.status ?? 'unknown'), ...(typeof info.resetsAt === 'number' ? { resetsAt: info.resetsAt } : {}) }];
    }
    case 'result': {
      const ok = msg.is_error !== true && msg.subtype === 'success';
      const text = typeof msg.result === 'string' ? msg.result : undefined;
      const out: AgentEvent[] = [{
        kind: 'result',
        ok,
        ...(typeof msg.session_id === 'string' ? { sessionId: msg.session_id } : {}),
        ...(text !== undefined ? { text } : {}),
        ...(typeof msg.total_cost_usd === 'number' ? { cumulativeCostUsd: msg.total_cost_usd } : {}),
        ...(!ok ? { error: text ?? t().providers.turnEnded({ subtype: String(msg.subtype) }) } : {}),
        ...(money(msg.duration_ms) !== null ? { durationMs: msg.duration_ms as number } : {}),
        ...(count(msg.num_turns) > 0 ? { numTurns: msg.num_turns as number } : {}),
      }];
      // Tokens are PER RUN (`usage`); cost and models are CUMULATIVE over a resumed session: the usage tracker turns
      // them into per-run values against the ledger. Without `usage` nothing is reported (never invented).
      if (isObj(msg.usage)) {
        out.push({ kind: 'usage', live: false, tokens: apiTokens(msg.usage), costUsd: money(msg.total_cost_usd), models: modelUsages(msg.modelUsage) });
      }
      return out;
    }
    default:
      return [];
  }
}

/** A `control_response` line: the answer to a control request the runner wrote (Phase 13 interrupt). */
/**
 * `stillQueued` (runner review round 2): the LENGTH of `response.response.still_queued` when it is an array (2.1.301
 * answered `[]` to an interrupt); absent when the CLI did not say. The items' shape is never read (unmeasured).
 */
export interface ControlResponse { requestId: string; ok: boolean; error?: string; stillQueued?: number }

/**
 * Reads a `control_response` line. Shape from the public Agent SDK docs (the `{ type: "control_request", request_id,
 * request }` envelope and its `control_response` echoing `request_id`): https://code.claude.com/docs/en/agent-sdk/typescript .
 * Measured on Claude Code 2.1.301 by the user's probe (decision 804): `{ type: 'control_response', response: { subtype:
 * 'success', request_id, response: { still_queued: [] } } }`. The id is read from `response.request_id`, or from a
 * top-level `request_id`. Anything else is null (and the line yields no event, as before).
 */
export function controlResponseOf(msg: Json): ControlResponse | null {
  if (msg.type !== 'control_response') return null;
  const r = isObj(msg.response) ? msg.response : {};
  const requestId = typeof r.request_id === 'string' ? r.request_id : typeof msg.request_id === 'string' ? msg.request_id : null;
  if (!requestId) return null;
  const ok = r.subtype === 'success';
  const inner = isObj(r.response) ? r.response : null;
  const stillQueued = inner && Array.isArray(inner.still_queued) ? { stillQueued: inner.still_queued.length } : {};
  return ok ? { requestId, ok, ...stillQueued } : { requestId, ok, error: typeof r.error === 'string' ? r.error : String(r.subtype ?? 'error'), ...stillQueued };
}

const sameTokens = (a: TokenCounts, b: TokenCounts) => a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite;

/**
 * Stateful parser for one `claude` run: the events of parseClaudeLine plus a live usage estimate.
 * `assistant` events carry `message.usage` per API call, and the same `message.id` repeats on consecutive events (one
 * per content block): the last value per id is kept and the SUM over ids is emitted as `usage` with `live: true`,
 * at most once per `liveIntervalMs` and only when it changed. A held-back sum goes out with the next line after the
 * interval, from a trailing timer (with `onLive`, so a long tool call does not freeze the counter), or from end() if
 * no final usage arrived (so a cancelled run keeps its latest estimate).
 */
export class ClaudeStreamParser {
  private readonly perMessage = new Map<string, TokenCounts>();
  private anonymous = 0;
  private lastEmitAt = -Infinity;
  private lastEmitted: TokenCounts | null = null;
  private pending = false;
  private final = false;
  private readonly now: () => number;
  private readonly interval: number;
  private readonly onLive: ((e: AgentEvent) => void) | null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly onControlResponse: ((r: ControlResponse) => void) | null;
  private readonly onResult: ((subtype: string | null) => void) | null;

  /**
   * `onLive`: receives a held-back estimate from the trailing timer (at most one per interval); without it, no timer.
   * `onControlResponse` (Phase 13): receives each `control_response` line (never an AgentEvent).
   * `onResult` (decision 804): the raw `subtype` of each `result` line, before parse() returns that line's events (the
   * runner tells an interrupted turn, `error_during_execution`, from any other error).
   */
  constructor(opts: { now?: () => number; liveIntervalMs?: number; onLive?: (e: AgentEvent) => void; onControlResponse?: (r: ControlResponse) => void; onResult?: (subtype: string | null) => void } = {}) {
    this.now = opts.now ?? Date.now;
    this.interval = opts.liveIntervalMs ?? 1000;
    this.onLive = opts.onLive ?? null;
    this.onControlResponse = opts.onControlResponse ?? null;
    this.onResult = opts.onResult ?? null;
  }

  parse(line: string): AgentEvent[] {
    const { events, msg } = parseLine(line);
    const control = msg ? controlResponseOf(msg) : null;
    if (control) { try { this.onControlResponse?.(control); } catch { /* a faulty listener must not break the parser */ } }
    if (msg && msg.type === 'result') { try { this.onResult?.(typeof msg.subtype === 'string' ? msg.subtype : null); } catch { /* as above */ } }
    if (events.some((e) => e.kind === 'usage' && !e.live)) { this.final = true; this.pending = false; this.stop(); return events; }
    if (msg && msg.type === 'assistant' && isObj(msg.message) && isObj(msg.message.usage)) {
      const id = typeof msg.message.id === 'string' && msg.message.id !== '' ? msg.message.id : `#${this.anonymous++}`;
      this.perMessage.set(id, apiTokens(msg.message.usage));
      this.pending = !this.lastEmitted || !sameTokens(this.sum(), this.lastEmitted);
    }
    const live = this.release(false);
    this.schedule();
    return live ? [...events, live] : events;
  }

  /** At the end of the stream: the estimate the throttle held back, unless the final usage arrived. Stops the timer. */
  end(): AgentEvent[] {
    this.stop();
    const live = this.release(true);
    return live ? [live] : [];
  }

  /** Stops the trailing timer without emitting (the run is over). */
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (!this.onLive || this.timer || !this.pending || this.final) return;
    const wait = Math.max(0, this.lastEmitAt + this.interval - this.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      const live = this.release(false);
      if (live) { try { this.onLive?.(live); } catch { /* a faulty listener must not break the parser */ } }
      this.schedule();
    }, wait);
    this.timer.unref?.();
  }

  private release(force: boolean): AgentEvent | null {
    if (!this.pending || this.final) return null;
    const at = this.now();
    if (!force && at - this.lastEmitAt < this.interval) return null;
    this.pending = false;
    this.lastEmitAt = at;
    this.lastEmitted = this.sum();
    return { kind: 'usage', live: true, tokens: this.lastEmitted, costUsd: null };
  }

  private sum(): TokenCounts {
    const s = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const t of this.perMessage.values()) { s.input += t.input; s.output += t.output; s.cacheRead += t.cacheRead; s.cacheWrite += t.cacheWrite; }
    return s;
  }
}
