// Format instances (Phase 12, spec §2): a brief's `formats` hold instance ids, `<presetId>` for the first instance of a preset and
// `<presetId>@<k>` (k from 2 to 20) for the others. Only the helpers here split or build an id: never `split('@')` elsewhere.

/** An instance id: a preset id plus an optional `@2`..`@20`. The preset part is checked against the catalog where the id is used. */
export const INSTANCE_ID_RE = /^[a-z0-9][a-z0-9-]*(@([2-9]|1[0-9]|20))?$/;
/** The most instances of one preset in a creative. */
export const MAX_INSTANCES = 20;

/** The preset id of an instance id (`appstore-iphone-69@3` → `appstore-iphone-69`; a bare id is returned as it is). */
export function presetOf(instanceId: string): string {
  const at = instanceId.lastIndexOf('@');
  return at === -1 ? instanceId : instanceId.slice(0, at);
}

/** The 1-based index of an instance (a bare id is 1, `@3` is 3). */
export function instanceIndex(instanceId: string): number {
  const at = instanceId.lastIndexOf('@');
  if (at === -1) return 1;
  const k = Number(instanceId.slice(at + 1));
  return Number.isInteger(k) && k >= 2 ? k : 1;
}

/** The id of the `k`-th instance of a preset (1 is the bare id). */
export const instanceIdOf = (presetId: string, k: number): string => (k <= 1 ? presetId : `${presetId}@${k}`);

/** The first free instance id of `presetId` given the ids `taken` (gaps are reused); null when all 20 are taken. */
export function nextInstanceId(presetId: string, taken: readonly string[]): string | null {
  const used = new Set(taken);
  for (let k = 1; k <= MAX_INSTANCES; k++) {
    const id = instanceIdOf(presetId, k);
    if (!used.has(id)) return id;
  }
  return null;
}

/** What the UI shows for an instance: its label, else `Name #k` (k > 1), else `Name`. */
export function instanceLabel(instanceId: string, presetName: string, labels?: Record<string, string>): string {
  const own = labels?.[instanceId];
  if (own !== undefined && own !== '') return own;
  const k = instanceIndex(instanceId);
  return k > 1 ? `${presetName} #${k}` : presetName;
}
