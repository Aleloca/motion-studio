import type { AgentEvent } from '@motion-studio/shared';

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
  return JSON.stringify(content ?? '');
}

export function parseClaudeLine(line: string): AgentEvent[] {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return [{ kind: 'parse_error', line: line.slice(0, 500) }];
  }
  if (!isObj(msg)) return [{ kind: 'parse_error', line: line.slice(0, 500) }];

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
        if (c.type === 'tool_use') out.push({ kind: 'tool_use', id: String(c.id), name: String(c.name), input: c.input });
      }
      return out;
    }
    case 'user': {
      const content = isObj(msg.message) && Array.isArray(msg.message.content) ? msg.message.content : [];
      return content.filter((c): c is Json => isObj(c) && c.type === 'tool_result').map((c) => ({
        kind: 'tool_result' as const,
        toolUseId: String(c.tool_use_id),
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
      return [{
        kind: 'result',
        ok,
        ...(typeof msg.session_id === 'string' ? { sessionId: msg.session_id } : {}),
        ...(text !== undefined ? { text } : {}),
        ...(typeof msg.total_cost_usd === 'number' ? { costUsd: msg.total_cost_usd } : {}),
        ...(!ok ? { error: text ?? `Turno terminato con esito ${String(msg.subtype)}` } : {}),
      }];
    }
    default:
      return [];
  }
}
