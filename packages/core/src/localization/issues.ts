import type { LocalizationIssue, LocalizationRow } from '@motion-studio/shared';

/** The `problems` and `issues` fields of a row for these issues (Ruling M): one sentence per problem, `stale` only in `issues`. */
export function issueFields(issues: readonly LocalizationIssue[]): Pick<LocalizationRow, 'problems' | 'issues'> {
  const seen = new Set<string>();
  const unique = issues.filter((i) => { const k = `${i.code}|${i.clipId ?? ''}|${i.message}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const problems = [...new Set(unique.filter((i) => i.code !== 'stale').map((i) => i.message))];
  return { ...(problems.length ? { problems } : {}), ...(unique.length ? { issues: unique.slice(0, 400) } : {}) };
}

/** `row` with `extra` issues added (their sentences join `problems`). */
export function withIssues(row: LocalizationRow, extra: readonly LocalizationIssue[]): LocalizationRow {
  const { problems: _p, issues: _i, ...rest } = row;
  // A row written before issues keeps its sentences: they stay in `problems` without a code.
  const old = (row.issues ?? []);
  const oldOnly = (row.problems ?? []).filter((p) => !old.some((i) => i.message === p));
  const fields = issueFields([...old, ...extra]);
  const problems = [...new Set([...oldOnly, ...(fields.problems ?? [])])];
  return { ...rest, ...(problems.length ? { problems } : {}), ...(fields.issues ? { issues: fields.issues } : {}) };
}

/** `row` without the issues for which `drop` is true (and their sentences). */
export function withoutIssues(row: LocalizationRow, drop: (i: LocalizationIssue) => boolean, dropProblem: (p: string) => boolean = () => false): LocalizationRow {
  const { problems: _p, issues: _i, ...rest } = row;
  const issues = (row.issues ?? []).filter((i) => !drop(i));
  const gone = new Set((row.issues ?? []).filter(drop).map((i) => i.message));
  const problems = (row.problems ?? []).filter((p) => !gone.has(p) && !dropProblem(p));
  return { ...rest, ...(problems.length ? { problems } : {}), ...(issues.length ? { issues } : {}) };
}
