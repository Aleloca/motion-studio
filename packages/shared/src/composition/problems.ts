import { messages, type Locale } from '../i18n/index.ts';

/**
 * A problem found in a composition: `key` is an i18n key (`composition.<name>`, catalog section `composition`) and `params`
 * its values. Problems go to the agent's fix loop and to the UI, each in its language (`compositionProblemText`).
 */
export interface CompositionProblem { key: string; params: Record<string, string | number> }
export type Problem = CompositionProblem;

const PREFIX = 'composition.';
/** Longest string param kept in a problem; longer values (names, paths, details taken from the input) are cut with "…". */
export const PROBLEM_PARAM_MAX = 120;

/** A problem with its string params clamped to `PROBLEM_PARAM_MAX` characters (plus "…"), never splitting a surrogate pair. */
export function compositionProblem(key: string, params: CompositionProblem['params'] = {}): CompositionProblem {
  const out: CompositionProblem['params'] = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v !== 'string' || v.length <= PROBLEM_PARAM_MAX) { out[k] = v; continue; }
    let cut = v.slice(0, PROBLEM_PARAM_MAX);
    const last = cut.charCodeAt(cut.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
    out[k] = `${cut}\u2026`;
  }
  return { key, params: out };
}

/** Text of a composition problem in `locale`; an unknown key is returned as is. */
export function compositionProblemText(problem: CompositionProblem, locale: Locale): string {
  if (!problem.key.startsWith(PREFIX)) return problem.key;
  const table = messages(locale).composition as Record<string, string | ((p: never) => string)>;
  const name = problem.key.slice(PREFIX.length);
  if (!Object.hasOwn(table, name)) return problem.key;
  const entry = table[name]!;
  return typeof entry === 'string' ? entry : entry(problem.params as never);
}
