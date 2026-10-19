// Format instances in the UI (Phase 12): the catalog lookup and the name an instance goes by. An instance id is
// `<presetId>` or `<presetId>@<k>`; only the shared helpers split it (`presetOf`, `instanceIndex`, `instancePreset`).
import { formatName, instanceLabel, instancePreset, presetOf, type FormatPreset, type Locale } from '@motion-studio/shared';

/** The preset of an instance (`x@2` gives the catalog's `x` carrying the instance id), or null when the catalog lacks it. */
export const presetFor = (presets: readonly FormatPreset[], id: string): FormatPreset | null => instancePreset(presets, id) ?? null;

/** The preset's own (translated) name: translations are keyed by the preset id, never the instance id. */
export const presetNameOf = (preset: FormatPreset, locale: Locale): string => formatName({ id: presetOf(preset.id), name: preset.name }, locale);

/** What an instance is called: its label, else `Name #k` (k > 1), else `Name`; the id itself when its preset is unknown. */
export function instanceName(preset: FormatPreset | null, id: string, locale: Locale, labels?: Record<string, string>): string {
  return preset ? instanceLabel(id, presetNameOf(preset, locale), labels) : id;
}

/**
 * Report 55 review: the labels a full brief save sends, for `formats`. A key the user changed in the draft (it differs from
 * `baseline`, the stored labels the draft started from) sends the draft's text; an untouched key sends the `latest` label
 * the app has (the agent may have named the format meanwhile). Empty labels are not sent. Undefined when there are none.
 */
export function fullSaveLabels(formats: readonly string[], draft: Record<string, string> | undefined, baseline: Record<string, string> | undefined, latest: Record<string, string> | undefined): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const k of formats) {
    const d = draft?.[k] ?? '';
    const v = d === (baseline?.[k] ?? '') ? latest?.[k] ?? d : d;
    if (v.trim() !== '') out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
