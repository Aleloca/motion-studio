import { messages, type Locale } from '../i18n/index.ts';

/**
 * A problem found in a composition: `key` is an i18n key (`composition.<name>`, catalog section `composition`) and `params`
 * its values. Problems go to the agent's fix loop and to the UI, each in its language (`compositionProblemText`).
 */
export interface CompositionProblem { key: string; params: Record<string, string | number> }
export type Problem = CompositionProblem;

const PREFIX = 'composition.';

/** Text of a composition problem in `locale`; an unknown key is returned as is. */
export function compositionProblemText(problem: CompositionProblem, locale: Locale): string {
  if (!problem.key.startsWith(PREFIX)) return problem.key;
  const table = messages(locale).composition as Record<string, string | ((p: never) => string)>;
  const name = problem.key.slice(PREFIX.length);
  if (!Object.hasOwn(table, name)) return problem.key;
  const entry = table[name]!;
  return typeof entry === 'string' ? entry : entry(problem.params as never);
}
