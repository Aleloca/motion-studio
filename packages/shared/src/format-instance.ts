// Format instances (Phase 12, spec §2): a brief's `formats` hold instance ids, `<presetId>` for the first instance of a preset and
// `<presetId>@<k>` (k from 2 to 20) for the others. Only the helpers here split or build an id: never `split('@')` elsewhere.

/** The optional instance suffix `@2`..`@20`, as a regex source: the one definition every id or folder pattern builds on. */
export const INSTANCE_SUFFIX_SOURCE = '(@([2-9]|1[0-9]|20))?';
/** An instance id: a preset id plus an optional `@2`..`@20`. The preset part is checked against the catalog where the id is used. */
export const INSTANCE_ID_RE = new RegExp(`^[a-z0-9][a-z0-9-]*${INSTANCE_SUFFIX_SOURCE}$`);
/** A composition folder's name, as a regex source: a preset id (the catalog's 63-character limit) plus the instance suffix. */
export const INSTANCE_FOLDER_SOURCE = `[a-z0-9][a-z0-9-]{0,62}${INSTANCE_SUFFIX_SOURCE}`;
/** A composition folder's name (`compositions/<this>`): a preset id or an instance id. */
export const INSTANCE_FOLDER_RE = new RegExp(`^${INSTANCE_FOLDER_SOURCE}$`);
/** The most instances of one preset in a creative. */
export const MAX_INSTANCES = 20;

/** The preset id of an instance id (`appstore-iphone-69@3` → `appstore-iphone-69`; a bare id is returned as it is). */
export function presetOf(instanceId: string): string {
  const at = instanceId.lastIndexOf('@');
  return at === -1 ? instanceId : instanceId.slice(0, at);
}

/**
 * The catalog preset of an instance id, carrying the INSTANCE id (`{ ...preset, id: instanceId }`), so whatever is named
 * after `preset.id` (composition folders, render files, prompt lines) is the instance's own. A bare id, or an id that is not
 * an instance id (a legacy brief, Ruling F), is looked up exactly as before (the catalog's own object); unknown: undefined.
 */
export function instancePreset<P extends { id: string }>(presets: readonly P[], instanceId: string): P | undefined {
  if (!INSTANCE_ID_RE.test(instanceId) || !instanceId.includes('@')) return presets.find((p) => p.id === instanceId);
  const preset = presets.find((p) => p.id === presetOf(instanceId));
  return preset ? { ...preset, id: instanceId } : undefined;
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
