// The plain words for an "always allowed" rule, the same the core saves with it (permissions-store: approvals.*
// labels of the shared catalog). The approval request carries only the rule, so the card rebuilds its label here.
import type { Messages } from '@motion-studio/shared';

/** Undoes the core's escapeGlob (codebases.ts) on a folder inside an Edit/Read rule. */
const unescapeGlob = (p: string) => p.replace(/\\([\\[\]*?{}()!+@])/g, '$1');

export function ruleLabel(rule: string, m: Messages): string {
  const a = m.approvals;
  let x = /^Bash\((.+):\*\)$/.exec(rule);
  if (x) return a.commandsLabel({ command: x[1]! });
  x = /^WebFetch\(domain:(.+)\)$/.exec(rule);
  if (x) return a.pagesOf({ host: x[1]! });
  x = /^(Edit|Read)\(\/(.+)\/\*\*\)$/.exec(rule);
  if (x) { const dir = unescapeGlob(x[2]!); return x[1] === 'Edit' ? a.editsIn({ dir }) : a.readsIn({ dir }); }
  if (rule.startsWith('provider:')) return a.providerNoConfirm({ provider: rule.slice('provider:'.length) });
  return a.toolLabel({ tool: rule });
}
