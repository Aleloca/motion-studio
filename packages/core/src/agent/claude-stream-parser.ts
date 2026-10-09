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
        ...(typeof msg.total_cost_usd === 'number' ? { costUsd: msg.total_cost_usd } : {}),
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

const sameTokens = (a: TokenCounts, b: TokenCounts) => a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite;

/**
 * Stateful parser for one `claude` run: the events of parseClaudeLine plus a live usage estimate.
 * `assistant` events carry `message.usage` per API call, and the same `message.id` repeats on consecutive events (one
 * per content block): the last value per id is kept and the SUM over ids is emitted as `usage` with `live: true`,
 * at most once per `liveIntervalMs` and only when it changed. A held-back sum goes out with the next line after the
 * interval, or from end() if no final usage arrived (so a cancelled run keeps its latest estimate).
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

  constructor(opts: { now?: () => number; liveIntervalMs?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.interval = opts.liveIntervalMs ?? 1000;
  }

  parse(line: string): AgentEvent[] {
    const { events, msg } = parseLine(line);
    if (events.some((e) => e.kind === 'usage' && !e.live)) { this.final = true; this.pending = false; return events; }
    if (msg && msg.type === 'assistant' && isObj(msg.message) && isObj(msg.message.usage)) {
      const id = typeof msg.message.id === 'string' && msg.message.id !== '' ? msg.message.id : `#${this.anonymous++}`;
      this.perMessage.set(id, apiTokens(msg.message.usage));
      this.pending = !this.lastEmitted || !sameTokens(this.sum(), this.lastEmitted);
    }
    const live = this.release(false);
    return live ? [...events, live] : events;
  }

  /** At the end of the stream: the estimate the throttle held back, unless the final usage arrived. */
  end(): AgentEvent[] {
    const live = this.release(true);
    return live ? [live] : [];
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
