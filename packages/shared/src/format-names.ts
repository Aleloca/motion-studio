// Report 55: speaking names of the formats. The agent names every format it makes (`name_formats`); a name the user gave (an
// inline rename, a store pack caption typed in the wizard, any label of a brief written before) is never the agent's to change.
// Where a label comes from: `brief.agentFormatLabels` (the text the agent gave), see `briefSchema`.
import type { Brief } from './creative.ts';
import { instanceIndex, presetOf } from './format-instance.ts';
import { cutLabel, packSlotOf, screenshotLabel, STORE_DEVICE_PRESET } from './store-pack.ts';

/** The longest name (a format label, `briefSchema.formatLabels`). */
export const FORMAT_NAME_MAX = 60;

type NamedBrief = Pick<Brief, 'formats' | 'formatLabels' | 'agentFormatLabels' | 'storePack'>;

const SCREENSHOT_PRESETS: readonly string[] = Object.values(STORE_DEVICE_PRESET).flatMap((m) => Object.values(m) as string[]).filter((p) => p !== STORE_DEVICE_PRESET.playstore.feature);

/** A store pack screenshot's number and caption, or null for any other format (the feature graphic and the videos included). */
function screenshotOf(brief: NamedBrief, id: string): { n: number; caption: string } | null {
  if (!brief.storePack) return null;
  const slot = packSlotOf(brief.storePack).get(id);
  if (!slot || !SCREENSHOT_PRESETS.includes(presetOf(slot))) return null;
  const n = instanceIndex(slot);
  return { n, caption: brief.storePack.screenshots[n - 1]?.caption.trim() ?? '' };
}

const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
/** A screenshot number the agent wrote in front of a name ("2 · ", "2 - "): Motion Studio puts the number itself. */
const NUMBER_PREFIX = /^\d+\s*[·\-–—:.]\s*/;
/** The text of a name for `id`: one line, without a number in front for a store screenshot. */
const nameText = (shot: unknown, name: string) => (shot ? oneLine(name).replace(NUMBER_PREFIX, '') : oneLine(name));

/** A name the agent gives a format that is not a store screenshot (a duplicate's label too): one line, within the 60 of a label. */
export const agentNameLabel = (name: string): string => cutLabel(oneLine(name), FORMAT_NAME_MAX);

/**
 * Whether the instance's name is the user's: a store screenshot with a caption from the wizard; else a label that is not the
 * agent's (`agentFormatLabels` holds another text, or nothing) and not a screenshot's bare number ("3", made by the pack).
 */
export function isUserNamed(brief: NamedBrief, id: string): boolean {
  const shot = screenshotOf(brief, id);
  if (shot && shot.caption) return true;
  const label = brief.formatLabels?.[id];
  if (label === undefined || label === '') return false;
  if (brief.agentFormatLabels?.[id] === label) return false;
  return !(shot && label === String(shot.n));
}

/** The name the agent gave the instance, as it gave it (a screenshot's without "N · "); null when its label is not the agent's. */
export function agentNamedLabel(brief: NamedBrief, id: string): string | null {
  const label = brief.formatLabels?.[id];
  if (label === undefined || brief.agentFormatLabels?.[id] !== label) return null;
  return screenshotOf(brief, id) ? label.replace(/^\d+ · /, '') : label;
}

/** The label the agent's `name` gives the instance: one line, at most 60 characters; "N · name" for a store screenshot. */
export function agentLabelFor(brief: NamedBrief, id: string, name: string): string {
  const shot = screenshotOf(brief, id);
  return shot ? screenshotLabel(shot.n, nameText(shot, name)) : agentNameLabel(name);
}

/** The entries of `agent` whose label is still the text the agent gave; undefined when none is left. */
export function keptAgentLabels(agent: Record<string, string> | undefined, labels: Record<string, string> | undefined): Record<string, string> | undefined {
  const kept = Object.entries(agent ?? {}).filter(([k, v]) => labels?.[k] === v);
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

export type AgentNameRefusal = { format: string; reason: 'not-in-brief' | 'user-named' | 'empty' | 'named' };

/**
 * The agent's names (`name_formats`, format → name) applied to `brief`: each format of the brief that is not the user's gets
 * its name and is marked the agent's; the others are refused (never applied, whatever the prompt said). A name equal to the
 * agent's name now is `unchanged` (nothing written). `onlyUnnamed` (a variant's own turn in a group, report 55 review): a
 * format the agent already named is refused (`named`); renaming the group's names is its coordinator's. Pure.
 */
export function withAgentNames<B extends NamedBrief>(brief: B, names: Record<string, string>, opts: { onlyUnnamed?: boolean } = {}):
  { brief: B; named: string[]; unchanged: string[]; refused: AgentNameRefusal[] } {
  const labels = { ...brief.formatLabels };
  const agent = { ...brief.agentFormatLabels };
  const named: string[] = [];
  const unchanged: string[] = [];
  const refused: AgentNameRefusal[] = [];
  for (const [id, name] of Object.entries(names)) {
    if (!brief.formats.includes(id)) { refused.push({ format: id, reason: 'not-in-brief' }); continue; }
    if (isUserNamed(brief, id)) { refused.push({ format: id, reason: 'user-named' }); continue; }
    if (!nameText(screenshotOf(brief, id), name)) { refused.push({ format: id, reason: 'empty' }); continue; }
    const label = agentLabelFor(brief, id, name);
    const mine = agentNamedLabel(brief, id) !== null;
    if (mine && brief.formatLabels?.[id] === label) { unchanged.push(id); continue; }
    if (mine && opts.onlyUnnamed) { refused.push({ format: id, reason: 'named' }); continue; }
    labels[id] = agent[id] = label;
    named.push(id);
  }
  const { formatLabels: _l, agentFormatLabels: _a, ...rest } = brief;
  const kept = keptAgentLabels(agent, labels);
  return { brief: { ...rest, ...(Object.keys(labels).length > 0 ? { formatLabels: labels } : {}), ...(kept ? { agentFormatLabels: kept } : {}) } as B, named, unchanged, refused };
}
