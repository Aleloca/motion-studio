import type { Explanation, Indicator, IndicatorId, Phrase, Risk } from './types.ts';
import { isInvisibleOrControl } from './tokenize.ts';

export const RISK_RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2 };

/** Tie-break order among indicators of the same risk: the most alarming first. */
const ORDER: IndicatorId[] = [
  'outside-sandbox', 'elevated', 'deletes-files', 'writes-outside-project', 'runs-code', 'complex', 'unknown-command',
  'uses-network', 'installs-packages', 'kills-processes', 'changes-git', 'reads-outside-project',
];

export const MAX_PHRASES = 6;
const MAX_PARAM = 120;

/** Collects indicators, keeping the highest risk per id. */
export class Indicators {
  private readonly byId = new Map<IndicatorId, Indicator>();
  add(id: IndicatorId, risk: Risk, params?: Record<string, string>): void {
    const prev = this.byId.get(id);
    if (prev && RISK_RANK[prev.risk] >= RISK_RANK[risk]) return;
    this.byId.set(id, params ? { id, risk, params } : { id, risk });
  }
  has(id: IndicatorId): boolean { return this.byId.has(id); }
  list(): Indicator[] {
    return [...this.byId.values()].sort((a, b) => RISK_RANK[b.risk] - RISK_RANK[a.risk] || ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
  }
}

/** Replaces the home folder with `~` (at path boundaries), invisible and control characters with `?`, and caps the length. */
export function sanitizeText(text: string, home: string): string {
  let s = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    s += code === 0x09 || code === 0x0a ? ' ' : isInvisibleOrControl(code) ? '?' : text[i];
  }
  if (home.length > 1) {
    const h = home.endsWith('/') ? home.slice(0, -1) : home;
    let out = '';
    let from = 0;
    for (;;) {
      const at = s.indexOf(h, from);
      if (at < 0) { out += s.slice(from); break; }
      const after = s[at + h.length];
      const boundary = after === undefined || after === '/' || after === ' ' || after === ',' || after === '"' || after === "'" || after === ':';
      out += s.slice(from, at) + (boundary ? '~' : h);
      from = at + h.length;
    }
    s = out;
  }
  if (s.length > MAX_PARAM) {
    let cut = s.slice(0, MAX_PARAM - 1);
    const last = cut.charCodeAt(cut.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
    s = `${cut}…`;
  }
  return s;
}

function sanitizeParams<T extends string | number>(params: Record<string, T>, home: string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(params)) out[k] = (typeof v === 'string' ? sanitizeText(v, home) : v) as T;
  return out;
}

/** Builds the final explanation: at most 6 phrases plus "and N more steps", sanitized parameters, risk = max. */
export function buildExplanation(phrases: Phrase[], ind: Indicators, parsed: boolean, home: string): Explanation {
  const shown = phrases.length > MAX_PHRASES ? phrases.slice(0, MAX_PHRASES) : phrases;
  const summary = shown.map((p) => ({ key: p.key, params: sanitizeParams(p.params, home) }));
  if (phrases.length > MAX_PHRASES) summary.push({ key: 'explain.more', params: { count: phrases.length - MAX_PHRASES } });
  const indicators = ind.list().map((i) => (i.params ? { ...i, params: sanitizeParams(i.params, home) } : i));
  const risk = indicators.reduce<Risk>((m, i) => (RISK_RANK[i.risk] > RISK_RANK[m] ? i.risk : m), 'low');
  return { summary, indicators, risk, parsed };
}
