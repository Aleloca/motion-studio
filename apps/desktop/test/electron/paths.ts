import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';

/** The real path of `p`'s nearest existing ancestor (itself when it exists). */
function realAncestor(p: string): string {
  for (let cur = p; ; cur = dirname(cur)) {
    try { return realpathSync(cur); } catch { if (dirname(cur) === cur) return cur; }
  }
}

/**
 * The data folders of a harness `paths` report that are not under `scratch` (final wave B2); empty when all are. A folder
 * counts as under it when its path is, and its real path (the nearest existing part, links followed) is too.
 */
export function electronDataOutside(report: Record<string, unknown>, scratch: string): string[] {
  const root = `${realpathSync(scratch)}/`;
  return ['appData', 'userData', 'sessionData', 'logs', 'crashDumps'].filter((k) => {
    const v = report[k];
    if (typeof v !== 'string') return true;
    const given = v.startsWith(`${scratch}/`) || v.startsWith(root);
    const real = `${realAncestor(v)}/`;
    return !(given && real.startsWith(root));
  });
}
