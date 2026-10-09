// Deterministic explanation of what an agent tool call will do, for approval cards. No dependencies, no eval,
// linear time. When unsure it says `parsed: false` and never guesses a benign summary.
import type { Messages } from '../i18n/index.ts';
import type { Explanation, IndicatorId, Phrase, Risk } from './types.ts';
import { buildExplanation, Indicators } from './indicators.ts';
import { explainSimple, hostOf, sensitiveWrite, type State } from './dictionary.ts';
import { explainWork } from './work.ts';
import { displayLoc, normalizeAbs, resolveLocs, type ExplainContext } from './paths.ts';
import { tokenize } from './tokenize.ts';

export type { Explanation, Phrase, Indicator, IndicatorId, Risk } from './types.ts';
export { tokenize, isOpaqueCommand, MAX_COMMANDS, MAX_WORDS } from './tokenize.ts';
export type { SimpleCommand, Redirect, RedirectOp, Separator, Tokenized } from './tokenize.ts';
export { classifyPath } from './paths.ts';
export { explainWork } from './work.ts';
export type { ExplainContext, PathClass } from './paths.ts';

const phrase = (key: string, params: Record<string, string | number> = {}): Phrase => ({ key: `explain.${key}`, params });

/** Builtins that evaluate their arguments arithmetically (bash and zsh): a subscript there runs `$(…)`. */
const ARITH_SINKS = ['exit', 'return', 'shift', 'break', 'continue', 'repeat', 'ulimit', 'sched', 'fc', 'history', 'wait', 'unset', 'read'];
/**
 * Code stored as data (`'$(…)'` or a backtick in single quotes) plus any arithmetic sink in the same command:
 * `p='a['; q='$(id)]'; x=$p$q; printf %d x` runs id in zsh. Not modeled.
 */
function hasArithmeticInjection(tok: ReturnType<typeof tokenize>): boolean {
  const words = tok.commands.flatMap((c) => [...c.argv, ...Object.values(c.env), ...c.redirects.map((r) => r.target)]);
  explainWork.add(words.reduce((n, w) => n + w.length, 0));
  if (!words.some((w) => w.includes('$(') || w.includes('`'))) return false;
  return tok.commands.some((c) => {
    const name = c.argv[0] ?? '';
    if (name === 'test' || name === '[') return c.argv.some((x) => ['-eq', '-ne', '-lt', '-le', '-gt', '-ge'].includes(x));
    if (ARITH_SINKS.includes(name)) return true;
    // A numeric conversion (`%d`, `%5.2f`…). Linear: the flag class can't contain `%`, so runs after each `%` are disjoint.
    if (name === 'printf' || (name === 'print' && c.argv.includes('-f'))) return c.argv.some((a) => /%[-+ #0-9.]*[diouxXceEfgGa]/.test(a));
    // `a[x]=…` as a command is already refused (its name has `[`); `(( ))`, `let` and `[[` are refused by the tokenizer.
    return ['declare', 'typeset', 'local', 'export', 'readonly', 'integer', 'float'].includes(name);
  });
}

/** Word-like occurrence of `w` (preceded by a shell boundary, followed by a blank or the end). Linear: indexOf only. */
function hasWord(s: string, w: string): boolean {
  explainWork.add(s.length);
  const BOUND = ' \t\n;&|(`"\'$={';
  for (let from = 0; ;) {
    const at = s.indexOf(w, from);
    if (at < 0) return false;
    const before = at === 0 ? ' ' : s[at - 1]!;
    const after = s[at + w.length];
    if (BOUND.includes(before) && (after === undefined || ' \t\n$"\'\\;&|)},'.includes(after))) return true;
    from = at + 1;
  }
}

/** For a command we can't analyze: the generic phrase, `complex`, and (only upwards) obvious danger words in the text. */
function complex(command: string, ind: Indicators): Phrase[] {
  ind.add('complex', 'medium');
  if (hasWord(command, 'rm') || ['rmtree', 'rmdir', '-delete', 'unlink', 'shred', 'rmSync'].some((t) => command.includes(t))) ind.add('deletes-files', 'high');
  if (hasWord(command, 'sudo')) ind.add('elevated', 'high');
  if (hasWord(command, 'curl') || hasWord(command, 'wget') || command.includes('://')) ind.add('uses-network', 'medium');
  return [phrase('complex')];
}

function explainBash(command: string, ctx: ExplainContext, ind: Indicators): { phrases: Phrase[]; parsed: boolean } {
  const tok = tokenize(command);
  if (!tok.parsed) return { phrases: complex(command, ind), parsed: false };
  if (hasArithmeticInjection(tok)) return { phrases: complex(command, ind), parsed: false };
  const st: State = {
    ctx, cwd: normalizeAbs(ctx.cwd ?? ctx.projectDir), altCwds: [], ind, phrases: [], parsed: true,
    pipedIn: false, pipeNet: false, usedNet: false, chainNet: false, written: [], found: null, stdout: null, stdinFile: null,
  };
  /**
   * The folders the next command may run in. A `cd x` followed by `&&` moves there; followed by `;`, `&`, a newline or `||`
   * it may have failed, so both folders count ({x, old}); a pipe changes nothing (a subshell). An `||` after a chain
   * that started with `cd x &&` adds the folder from before the cd. `cd x || exit` leaves only x.
   */
  let cur: (string | null)[] = [st.cwd];
  let beforeCd: (string | null)[] | null = null;
  let ifNoFailure: (string | null)[] | null = null;
  const uniq = (xs: (string | null)[]) => [...new Set(xs)];
  tok.commands.forEach((c, i) => {
    if (!st.parsed) return;
    const sepBefore = i > 0 ? tok.separators[i - 1] : undefined;
    const sep = tok.separators[i];
    st.pipedIn = sepBefore === '|';
    if (!st.pipedIn) st.pipeNet = false;
    st.usedNet = false;
    st.cdTarget = undefined;
    st.cwd = cur[0] ?? null;
    st.altCwds = cur.slice(1);
    explainSimple(c, st);
    if (st.usedNet) { st.pipeNet = true; st.chainNet = true; }
    if (st.cdTarget !== undefined) {
      const target = st.cdTarget;
      if (sep === '|') { /* a subshell: no effect */ }
      else if (sep === '&&') { beforeCd ??= cur; cur = target; }
      else {
        if (sep === '||') ifNoFailure = target;
        cur = uniq([...target, ...cur]);
      }
    } else if (sep === '||' && beforeCd !== null) {
      ifNoFailure = cur;
      cur = uniq([...cur, ...beforeCd]);
    }
    // `… || exit`: the shell stops when the `||` branch runs, so what follows runs where the chain succeeded.
    if (sepBefore === '||' && ifNoFailure !== null && (c.argv[0] === 'exit' || c.argv[0] === 'return')) cur = ifNoFailure;
    if (sep === ';' || sep === '\n' || sep === '&') { beforeCd = null; ifNoFailure = null; }
  });
  if (!st.parsed) return { phrases: complex(command, ind), parsed: false };
  return { phrases: st.phrases, parsed: true };
}

const asRecord = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * Explains a tool call. `input.description` (the agent's own words) is never used: the card shows it separately, as a quote.
 * `ctx.cwd` defaults to the project directory (the cwd of the `claude` process).
 */
export function explainTool(toolName: string, input: unknown, ctx: ExplainContext): Explanation {
  const ind = new Indicators();
  const inp = asRecord(input);
  if (inp.dangerouslyDisableSandbox === true) ind.add('outside-sandbox', 'high');
  let phrases: Phrase[];
  let parsed = true;
  const cwd = normalizeAbs(ctx.cwd ?? ctx.projectDir);
  const fileLoc = (p: unknown) => (typeof p === 'string' && p !== '' ? resolveLocs(p, cwd, ctx) : []);
  switch (toolName) {
    case 'Bash': {
      const command = inp.command;
      if (typeof command !== 'string' || command.trim() === '') { phrases = complex('', ind); parsed = false; break; }
      ({ phrases, parsed } = explainBash(command, ctx, ind));
      break;
    }
    case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': {
      // Not sandboxed: anything outside the project, temp folders included, is an outside write.
      const locs = fileLoc(inp.file_path ?? inp.notebook_path);
      if (locs.length === 0 || locs.some((l) => l.cls !== 'work' && l.cls !== 'project')) {
        ind.add('writes-outside-project', 'high', locs[0] ? { path: displayLoc(locs[0], ctx) } : undefined);
      }
      for (const l of locs) sensitiveWrite(ind, l.abs, displayLoc(l, ctx));
      phrases = [phrase('edit', { path: locs[0] ? displayLoc(locs[0], ctx) : '?' })];
      break;
    }
    case 'Read': {
      const locs = fileLoc(inp.file_path);
      if (locs.length === 0 || locs.some((l) => l.cls === 'outside' || l.cls === 'unknown')) {
        ind.add('reads-outside-project', 'medium', locs[0] ? { path: displayLoc(locs[0], ctx) } : undefined);
      }
      phrases = [phrase('read', { path: locs[0] ? displayLoc(locs[0], ctx) : '?' })];
      break;
    }
    case 'WebFetch': {
      const host = typeof inp.url === 'string' ? hostOf(inp.url) : '…';
      ind.add('uses-network', 'medium', { host });
      phrases = [phrase('webFetch', { host })];
      break;
    }
    case 'WebSearch':
      ind.add('uses-network', 'medium');
      phrases = [phrase('webSearch')];
      break;
    default:
      ind.add('unknown-command', 'medium');
      phrases = [phrase('tool', { tool: toolName === '' ? '?' : toolName })];
  }
  return buildExplanation(phrases, ind, parsed, ctx.home);
}

export interface RenderedIndicator { id: IndicatorId; risk: Risk; label: string }
export interface RenderedExplanation { summary: string[]; indicators: RenderedIndicator[]; risk: Risk; riskLabel: string }

/** `explain.pipInstall` → the catalog entry, called with the params; an unknown key renders as itself. */
function lookup(t: Messages, key: string, params: Record<string, string | number> = {}): string {
  let node: unknown = t;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, part)) return key;
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node === 'string') return node;
  if (typeof node === 'function') {
    try { const out = (node as (p: unknown) => unknown)(params); return typeof out === 'string' ? out : key; } catch { return key; }
  }
  return key;
}

const camel = (id: string) => id.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());

/** Renders an explanation with a catalog (`messages(locale)` or the web's `useT()`): strings ready for the approval card. */
export function renderExplanation(e: Explanation, t: Messages): RenderedExplanation {
  return {
    summary: e.summary.map((p) => lookup(t, p.key, p.params)),
    indicators: e.indicators.map((i) => ({ id: i.id, risk: i.risk, label: lookup(t, `explain.indicators.${camel(i.id)}`, i.params ?? {}) })),
    risk: e.risk,
    riskLabel: lookup(t, `explain.risk.${e.risk}`),
  };
}
