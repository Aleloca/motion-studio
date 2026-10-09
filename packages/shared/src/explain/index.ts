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
const DECLARE = ['declare', 'typeset', 'local', 'export', 'readonly', 'integer', 'float'];
/** Builtins whose operands are arithmetic expressions in zsh (`exit y` evaluates `y`). */
const NUMERIC_OPERANDS = ['exit', 'return', 'shift', 'break', 'continue', 'repeat'];
const TEST_OPS = ['-eq', '-ne', '-lt', '-le', '-gt', '-ge'];
const NUMBER = /^[-+]?(?:0[xX][0-9a-fA-F]+|[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/;
/** A single expansion and nothing else: `$n`, `${n}`, `$?`, `$#`, `$1`. */
const LONE_EXPANSION = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9?#!$@*-]|\{[A-Za-z_][A-Za-z0-9_]*\})$/;
/** Special parameters that always hold a number. */
const NUMERIC_SPECIAL = ['$?', '$#', '$!', '$$'];

/**
 * The conversions of a printf format, in order: 'num' (evaluated arithmetically), 'str', or 'strict' (a `*` width or
 * precision, or a `'` flag: number literals only, and for every operand). Null when the format holds an expansion.
 * Linear: one pass.
 */
function printfConversions(format: string): ('num' | 'str' | 'strict')[] | null {
  if (format.includes('$')) return null;
  const out: ('num' | 'str' | 'strict')[] = [];
  for (let i = 0; i < format.length; i++) {
    if (format[i] !== '%') continue;
    i++;
    if (format[i] === '%') continue;
    let strict = false;
    while (i < format.length && "-+ #0123456789.'*".includes(format[i]!)) { if (format[i] === '*' || format[i] === "'") strict = true; i++; }
    const conv = format[i] ?? '';
    out.push(strict ? 'strict' : 'diouxXeEfFgGaA'.includes(conv) && conv !== '' ? 'num' : 'str');
  }
  return out;
}

/**
 * Arithmetic contexts evaluate their operands as expressions, and an expression with a subscript runs code
 * (`p='a[$'; q='(id)]'; printf %d $p$q` runs id in zsh). No data flow is tracked; the rules are structural.
 * Parsed false when:
 * - any word holds `$(` or a backtick (code as data) and the command uses any arithmetic builtin;
 * - an operand of an arithmetic sink (printf/`print -f` with a numeric format, exit, return, shift, break, continue,
 *   repeat, `test -eq`…) is not a number literal and not a single expansion; a `*` or `'` format takes number literals only;
 * - a single expansion goes to an arithmetic sink and some variable in the command was set from an expansion, a
 *   bracket or a parenthesis, or by `read`;
 * - declare/typeset/local/export/readonly with an integer option, `integer`, `float`, or `unset` of a subscript.
 */
function hasArithmeticRisk(tok: ReturnType<typeof tokenize>): boolean {
  const words = tok.commands.flatMap((c) => [...c.argv, ...Object.values(c.env), ...c.redirects.map((r) => r.target)]);
  explainWork.add(words.reduce((n, w) => n + w.length, 0));
  const codeAsData = words.some((w) => w.includes('$(') || w.includes('`'));
  // A variable whose value may hold an expression: set from anything but plain text (`x=$p$q`, `x=$1`, `read x`).
  const risky = (v: string) => (v.includes('$') && !NUMERIC_SPECIAL.includes(v)) || v.includes('[') || v.includes('(') || v.includes('`');
  let tainted = false;
  for (const c of tok.commands) {
    const name = c.argv[0];
    if (Object.values(c.env).some(risky)) tainted = true;
    if (name === 'read' || name === 'vared' || name === 'getopts' || name === 'mapfile' || name === 'readarray') tainted = true;
    if (name !== undefined && DECLARE.includes(name)) for (const a of c.argv.slice(1)) if (a.includes('=') && risky(a.slice(a.indexOf('=') + 1))) tainted = true;
  }
  const okOperand = (a: string) => NUMBER.test(a) || (LONE_EXPANSION.test(a) && !tainted);
  return tok.commands.some((c) => {
    const name = c.argv[0] ?? '';
    const args = c.argv.slice(1);
    if (codeAsData) {
      if (name === 'test' || name === '[') { if (args.some((x) => TEST_OPS.includes(x))) return true; }
      else if (ARITH_SINKS.includes(name) || DECLARE.includes(name)) return true;
      else if ((name === 'printf' || name === 'print') && args.some((a) => (printfConversions(a) ?? []).some((x) => x !== 'str'))) return true;
    }
    if (NUMERIC_OPERANDS.includes(name)) return !args.every(okOperand);
    if (name === 'test' || name === '[') {
      return args.some((x, k) => TEST_OPS.includes(x) && !(okOperand(args[k - 1] ?? '') && okOperand(args[k + 1] === ']' ? '' : (args[k + 1] ?? ''))));
    }
    if (name === 'printf' || (name === 'print' && args.includes('-f'))) {
      // The format is the first operand (after `-v var` for printf, after `-f` for print).
      let k = 0;
      if (name === 'printf') { while (args[k] === '-v') k += 2; if (args[k] === '--') k++; }
      else k = args.indexOf('-f') + 1;
      const format = args[k];
      if (format === undefined) return false;
      const operands = args.slice(k + 1);
      if (operands.length === 0) return false;
      const convs = printfConversions(format);
      if (convs === null) return true; // the format itself comes from a variable
      if (convs.includes('strict')) return !operands.every((x) => NUMBER.test(x));
      if (!convs.includes('num')) return false;
      // The format is reused until the operands run out: operand j goes to conversion j mod n.
      return operands.some((x, j) => convs[j % convs.length] === 'num' && !okOperand(x));
    }
    if (DECLARE.includes(name)) {
      if (name === 'integer' || name === 'float') return true;
      return args.some((a) => (a.startsWith('-') || a.startsWith('+')) && /[iEF]/.test(a.slice(1)) && !a.includes('='));
    }
    if (name === 'unset') return args.some((a) => a.includes('['));
    return false;
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
  if (hasArithmeticRisk(tok)) return { phrases: complex(command, ind), parsed: false };
  const st: State = {
    ctx, cwd: normalizeAbs(ctx.cwd ?? ctx.projectDir), altCwds: [], ind, phrases: [], parsed: true,
    pipedIn: false, pipeNet: false, usedNet: false, chainNet: false, written: [], found: null, stdout: null, stdinFile: null,
  };
  /**
   * The folders a command may run in, as a set that only grows (a `cd` that may have failed keeps the folder before it).
   * Each and-or list is followed with two sets: where the shell may be if the last pipeline succeeded (`ok`) or failed
   * (`fail`). `&&` runs the next pipeline in `ok`, `||` in `fail`, and the other branch is carried along. A `cd x` that
   * runs alone moves `ok` to x and leaves `fail` where it was; `exit` (alone) ends both (`return` doesn't: bash goes on).
   * `;`, a newline and `&` start a new list in `ok ∪ fail`; after `&` (the whole list ran in a subshell) the folders from the start of the list are added too.
   * More than MAX_CWDS folders: unknown (null), so relative paths are rated worst case.
   */
  const MAX_CWDS = 8;
  const join = (...xs: (string | null)[][]): (string | null)[] => {
    const u = [...new Set(xs.flat())];
    return u.length > MAX_CWDS ? [null] : u;
  };
  let listStart: (string | null)[] = [st.cwd];
  let ok: (string | null)[] = [st.cwd];
  let fail: (string | null)[] = [];
  let inSet: (string | null)[] = [st.cwd];
  let carryOk: (string | null)[] = [];
  let carryFail: (string | null)[] = [];
  let pipeStart = 0;
  tok.commands.forEach((c, i) => {
    if (!st.parsed) return;
    const sepBefore = i > 0 ? tok.separators[i - 1] : undefined;
    const sep = tok.separators[i];
    if (sepBefore !== '|') {
      // A new pipeline: where it runs depends on the operator before it.
      pipeStart = i;
      if (sepBefore === '&&') { inSet = ok; carryOk = []; carryFail = fail; }
      else if (sepBefore === '||') { inSet = fail; carryOk = ok; carryFail = []; }
      else {
        const all = join(ok, fail);
        inSet = sepBefore === '&' ? join(all, listStart) : all;
        listStart = inSet;
        carryOk = []; carryFail = [];
      }
      // A pipeline that can't run (after `exit`) is still explained, from an unknown folder.
      if (inSet.length === 0) inSet = [null];
    }
    st.pipedIn = sepBefore === '|';
    if (!st.pipedIn) st.pipeNet = false;
    st.usedNet = false;
    st.cdTarget = undefined;
    st.cwd = inSet[0] ?? null;
    st.altCwds = inSet.slice(1);
    explainSimple(c, st);
    if (st.usedNet) { st.pipeNet = true; st.chainNet = true; }
    if (sep === '|') return; // the pipeline goes on
    const alone = pipeStart === i;
    let pOk = inSet;
    let pFail = inSet;
    if (st.cdTarget !== undefined) {
      // Alone, a cd moves the shell on success. As the last part of a pipeline (zsh runs it in the shell) it may or may not.
      if (alone) pOk = join(st.cdTarget);
      else { pOk = join(inSet, st.cdTarget); pFail = pOk; }
    } else if (alone && c.argv[0] === 'exit' && c.wrappers.length === 0) {
      // Only `exit`: bash prints an error for a `return` outside a function and goes on.
      pOk = []; pFail = [];
    }
    ok = join(carryOk, pOk);
    fail = join(carryFail, pFail);
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
