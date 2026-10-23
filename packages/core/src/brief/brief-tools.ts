import { BRIEF_FIELDS, CUSTOM_VIDEO_MAX, briefFillSchema, channelName, formatLabel, instanceIdOf, instanceIndex, isCustomPreset, presetOf, sameCustomName, type BriefContext, type BriefField, type BriefForm, type FormatPreset, type Locale } from '@motion-studio/shared';
import { t } from '../i18n.ts';
import { CodedError } from '../workspace-store.ts';

/**
 * Decision 1421: the brief agent's two tools. `list_formats` gives it the catalog so it never guesses an id; `fill_brief`
 * writes fields of the New creative form, never one the user edited after the agent's last write (spec §5.3). Nothing here
 * creates anything: the user reviews the form and presses Genera.
 */

export interface BriefFormatItem { id: string; label: string; channel: string; kind: 'video' | 'image'; width: number; height: number; maxDurationSec?: number }

/**
 * Every preset of the catalog the brief may name, in catalog order; identity presets are left out (their own rules), and so are
 * hidden ones (report 59: custom formats deleted while creatives use them). Custom formats are listed like any other.
 */
export function listFormats(presets: readonly FormatPreset[], locale: Locale): { formats: BriefFormatItem[] } {
  return {
    formats: presets.filter((p) => !p.identity && !p.hidden).map((p) => ({
      id: p.id, label: formatLabel(p, locale), channel: channelName(p.channel, locale), kind: p.kind, width: p.width, height: p.height,
      ...(p.maxDurationSec !== undefined ? { maxDurationSec: p.maxDurationSec } : {}),
    })),
  };
}

/** The largest side of a custom image (`customFormatInputSchema`). */
const CUSTOM_IMAGE_MAX = 8192;

/**
 * Report 70: the size of a format made from a source (an attached video or image) for "the original format". A video keeps
 * its size with each odd side one pixel less (H.264 in yuv420p wants even sides: 1081 × 1921 → 1080 × 1920), and one larger
 * than 4096 px is scaled so its longer side is 4096 (ratio kept, sides rounded down, then made even). An image keeps its size
 * up to 8192 px. Null: a side below 16 px, which no format can have.
 */
export function sourceFormatSize(s: { kind: 'video' | 'image'; width: number; height: number }): { width: number; height: number } | null {
  const max = s.kind === 'video' ? CUSTOM_VIDEO_MAX : CUSTOM_IMAGE_MAX;
  const longest = Math.max(s.width, s.height);
  const side = (n: number) => {
    const x = longest > max ? Math.floor((n * max) / longest) : Math.floor(n);
    return s.kind === 'video' ? x - (x % 2) : x;
  };
  const width = side(s.width), height = side(s.height);
  return width >= 16 && height >= 16 ? { width, height } : null;
}

/**
 * Report 70: a visible custom format of that kind and size with nothing more (no maximum length, no safe zone), which "the
 * original format" reuses; one named `preferName` first. A shipped preset of the same size is not reused, nor a custom one with
 * a limit (round 1, I4): both carry constraints (a platform's, or a use the user made it for) the source's video does not have.
 */
export function sameSizeCustom(presets: readonly FormatPreset[], kind: 'video' | 'image', width: number, height: number, preferName?: string): FormatPreset | undefined {
  const plain = presets.filter((p) => isCustomPreset(p) && !p.hidden && !p.identity && p.kind === kind && p.width === width && p.height === height
    && p.maxDurationSec === undefined && !p.safeZone);
  return (preferName ? plain.find((p) => sameCustomName(p.name, preferName)) : undefined) ?? plain[0];
}

export interface FillOutcome {
  form: BriefForm;
  /** The fields this fill changed, in form order. */
  written: BriefField[];
  /** The fields it named that stay the user's. */
  kept: Array<{ field: BriefField; reason: 'user-edited' }>;
  /** Every field the agent wrote so far (the form marks them). */
  agentFields: BriefField[];
  /** The user's fields this fill took back because the user asked (`reclaim`): written, and no longer the user's. */
  reclaimed: BriefField[];
  /** The fields that stay the user's after this fill. */
  userEdited: BriefField[];
}

const bad = (message: string) => new CodedError(400, message, 'brief-fill-invalid');

/**
 * Applies the agent's `raw` fill to the session's form. All or nothing: any invalid value refuses the whole call (400,
 * translated, naming the field). A field in `userEdited` is left as it is and listed in `kept` (a list field counts whole),
 * unless the fill names it in `reclaim` (the user asked to have it rewritten): then it is written and is the user's no more.
 */
export function applyFill(s: { form: BriefForm; userEdited: readonly BriefField[]; agentFields: readonly BriefField[]; context: BriefContext }, raw: unknown, presets: readonly FormatPreset[]): FillOutcome {
  const parsed = briefFillSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.length ? String(issue.path[0]) : 'fill_brief';
    throw bad(t().errors.briefBadField({ field, detail: issue?.message ?? 'invalid' }));
  }
  const { reclaim = [], ...fill } = parsed.data;
  const formats = fill.formats ?? [];
  for (const id of formats) {
    const preset = presets.find((p) => p.id === presetOf(id) && !p.hidden);
    if (!preset) throw bad(t().errors.briefUnknownFormat({ id }));
    if (preset.identity) throw bad(t().errors.briefIdentityFormat({ id }));
    // Report 58: copies of a format are `<id>`, `<id>@2`… `<id>@N` with none left out (the schema caps N at 20, no repeats).
    for (let k = 1; k < instanceIndex(id); k++) {
      const missing = instanceIdOf(preset.id, k);
      if (!formats.includes(missing)) throw bad(t().errors.briefFormatGap({ id, missing }));
    }
  }
  const assets = new Set([...s.context.assets, ...s.form.assets]);
  for (const a of fill.assets ?? []) if (!assets.has(a)) throw bad(t().errors.briefAssetOutside({ path: a }));
  const folders = new Set([...s.context.codebases, ...s.form.linkedCodebases].map((c) => c.path));
  for (const c of fill.linkedCodebases ?? []) if (!folders.has(c.path)) throw bad(t().errors.briefCodebaseOutside({ path: c.path }));

  const form: BriefForm = { ...s.form };
  const written: BriefField[] = [];
  const kept: FillOutcome['kept'] = [];
  const reclaimed: BriefField[] = [];
  for (const field of BRIEF_FIELDS) {
    if (!Object.hasOwn(fill, field) || fill[field] === undefined) continue;
    if (s.userEdited.includes(field)) {
      if (!reclaim.includes(field)) { kept.push({ field, reason: 'user-edited' }); continue; }
      reclaimed.push(field);
    }
    (form as Record<BriefField, unknown>)[field] = fill[field];
    written.push(field);
  }
  return {
    form, written, kept, reclaimed,
    agentFields: BRIEF_FIELDS.filter((f) => s.agentFields.includes(f) || written.includes(f)),
    userEdited: BRIEF_FIELDS.filter((f) => s.userEdited.includes(f) && !reclaimed.includes(f)),
  };
}

/** The chat line of a reclaim: the user sees which of their fields the agent rewrote on their request. */
export function reclaimLine(fields: readonly BriefField[]): string {
  const m = t().briefSession;
  return m.reclaimed({ fields: BRIEF_FIELDS.filter((f) => fields.includes(f)).map((f) => m.fieldNames[f]).join(', ') });
}

/** The chat line of a fill (prototype: "Compilato il brief: testi, durata, 3 asset, 2 codebase, 4 formati"). */
export function fillLine(written: readonly BriefField[], kept: readonly BriefField[], form: BriefForm): string {
  const m = t().briefSession;
  const parts: string[] = [];
  if (written.some((f) => f === 'goal' || f === 'message' || f === 'notes')) parts.push(m.parts.texts);
  if (written.includes('durationSec')) parts.push(m.parts.length);
  if (written.includes('assets')) parts.push(m.parts.assets({ count: form.assets.length }));
  if (written.includes('linkedCodebases')) parts.push(m.parts.codebases({ count: form.linkedCodebases.length }));
  if (written.includes('formats')) parts.push(m.parts.formats({ count: form.formats.length }));
  if (written.includes('variants')) parts.push(m.parts.variants({ count: form.variants }));
  const keptText = kept.length ? m.keptYours({ fields: BRIEF_FIELDS.filter((f) => kept.includes(f)).map((f) => m.fieldNames[f]).join(', ') }) : '';
  return `${parts.length ? m.filled({ parts: parts.join(', ') }) : m.nothingWritten}${keptText}`;
}

/**
 * Decision 1422: the form a client sends (a save or a message), merged by field into the session's. The client's value is
 * taken for a field the user owns on the server (with the ownership the client now says), or one the client marks as the
 * user's, unless the agent took it back (`reclaim`) after the revision the client's form is based on; every other field
 * keeps the server's value (an older save never reverts an agent's write). `revision` grows when anything changed.
 */
export function mergeClientForm(
  s: { form: BriefForm; userEdited: readonly BriefField[]; revision: number; reclaimedAt: Readonly<Record<string, number>> },
  c: { form: BriefForm; userEdited: readonly BriefField[]; baseRevision: number },
): { form: BriefForm; userEdited: BriefField[]; revision: number } {
  const base = c.baseRevision;
  const form: BriefForm = { ...s.form };
  const userEdited: BriefField[] = [];
  for (const f of BRIEF_FIELDS) {
    const clientOwns = c.userEdited.includes(f);
    const at = Object.hasOwn(s.reclaimedAt, f) ? s.reclaimedAt[f] : undefined;
    const takenBack = at !== undefined && at > base;
    if (s.userEdited.includes(f) || (clientOwns && !takenBack)) {
      (form as Record<BriefField, unknown>)[f] = c.form[f];
      if (clientOwns) userEdited.push(f);
    }
  }
  const same = JSON.stringify(form) === JSON.stringify(s.form) && JSON.stringify(userEdited) === JSON.stringify(BRIEF_FIELDS.filter((f) => s.userEdited.includes(f)));
  return { form, userEdited, revision: same ? s.revision : s.revision + 1 };
}
