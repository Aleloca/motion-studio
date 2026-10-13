import { z } from 'zod';
import { SERVICE_CHOICES } from './services.ts';
import type { AgentEvent } from './events.ts';
import { linkedCodebaseSchema } from './schemas.ts';
import { usageSummarySchema } from './usage.ts';
import { INSTANCE_ID_RE } from './format-instance.ts';
import { storePackSchema } from './store-pack.ts';
import { localeTag } from './localization/schema.ts';
import { channelName, DEFAULT_FORMATS, formatDisplayName } from './formats.ts';
import { messages, type Locale } from './i18n/index.ts';
import type { FormatSummary } from './formats/link.ts';

export const creativeStatusSchema = z.enum(['draft', 'working', 'ready', 'incomplete', 'error', 'interrupted']);
export type CreativeStatus = z.infer<typeof creativeStatusSchema>;

const makeBriefSchema = (formats: z.ZodType<string[]>) => z.object({
  goal: z.string().trim().min(1),
  message: z.string(),
  /** Format instance ids (`<presetId>` or `<presetId>@<k>`, Phase 12): the order is the display and export order. */
  formats,
  /** A label per instance (1..60 characters); a key that is not in `formats` is refused. */
  formatLabels: z.record(z.string(), z.string().min(1).max(60)).optional(),
  durationSec: z.number().int().min(1).max(600).nullable(),
  assets: z.array(z.string()),
  notes: z.string(),
  /**
   * Linked formats, follower → primary (spec §2.3). A follower is not given to the agent: the core copies the primary's file
   * for it. Absent in old briefs (no links). Kept loose on purpose: a link whose ends are not both in `formats` is ignored by
   * consumers instead of making the creative unreadable.
   */
  links: z.record(z.string().min(1), z.string().min(1)).optional(),
  /** Which external services the agent may use per kind (absent = all `auto`; see `effectiveServices`). */
  services: z.object({
    images: z.enum(SERVICE_CHOICES.images), voice: z.enum(SERVICE_CHOICES.voice),
    music: z.enum(SERVICE_CHOICES.music), sfx: z.enum(SERVICE_CHOICES.sfx),
  }).partial().optional(),
  /** The languages of the creative (Phase 12); absent: no localization. `extra` has up to 10 languages, never the primary. */
  locales: z.object({
    primary: localeTag,
    extra: z.array(localeTag).max(10),
  }).refine((l) => new Set(l.extra).size === l.extra.length && !l.extra.includes(l.primary), 'issue.badLocales').optional(),
  /** The App Store / Google Play pack choices (Phase 12). */
  storePack: storePackSchema.optional(),
}).refine((b) => Object.keys(b.formatLabels ?? {}).every((k) => b.formats.includes(k)), { message: 'issue.labelNotInFormats', path: ['formatLabels'] });

/**
 * Reading (a stored brief, Phase 12 Ruling F): a brief written before instances may hold the same format twice or an id that the
 * instance pattern refuses; neither may make the creative unreadable, so duplicates are dropped (the first stays) and any
 * non-empty id is kept as it is (consumers ignore ids that are not in the catalog, as they always did).
 */
export const briefSchema = makeBriefSchema(z.array(z.string().min(1)).min(1).transform((f) => [...new Set(f)]));
/** Writing (create and edit requests): format ids must be instance ids and unique. */
export const briefWriteSchema = makeBriefSchema(z.array(z.string().regex(INSTANCE_ID_RE)).min(1).refine((f) => new Set(f).size === f.length, 'issue.duplicateFormats'));

export type Brief = z.infer<typeof briefSchema>;

export const creativeFileSchema = z.object({
  schemaVersion: z.literal(1),
  title: z.string().trim().min(1),
  brief: briefSchema,
  status: creativeStatusSchema,
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  resumeFrom: z.object({ version: z.number().int().min(1), sessionId: z.string().min(1) }).nullable(),
  linkedCodebases: z.array(linkedCodebaseSchema).default([]),
  /**
   * Manual ★ per format: formatId → creative version `vN` to export (spec §2.2). Absent (old files) or missing for a format
   * means the default rule (see `starOf`). Picking the latest version of a format's history clears its entry.
   */
  exportPicks: z.record(z.string().min(1), z.number().int().min(1)).optional(),
});
export type CreativeFile = z.infer<typeof creativeFileSchema>;

const HEX64 = /^[0-9a-f]{64}$/;
const FILE_NAME = /^[^/\\]+$/;
/** `compositions/<instance id>`: a composition folder inside `outputs/vN/`. */
const COMPOSITION_DIR = /^compositions\/[a-z0-9][a-z0-9-]{0,62}(@([2-9]|1[0-9]|20))?$/;

/**
 * A non-blocking note on an output file: never a problem, never triggers the fix loop. `key` is an i18n key
 * (`outputs.largeFile`, `outputs.keptUnchanged`, `outputs.followerReplaced`) and `params` its values, so the web renders it in the user's language
 * (see `outputWarningText`). Old versions.json files have none.
 */
export const outputWarningSchema = z.object({
  key: z.string(), params: z.record(z.string(), z.union([z.string(), z.number()])),
});
export type OutputWarning = z.infer<typeof outputWarningSchema>;

/** A checked problem of an output file, as a code and its figures (`OutputFileInfo.issues`). */
export const outputIssueSchema = z.object({
  code: z.enum(['tooLarge', 'durationOffTarget', 'durationOverMax', 'badResolution', 'notReadable', 'badExtension']),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
});
export type OutputIssue = z.infer<typeof outputIssueSchema>;

export const outputFileInfoSchema = z.object({
  format: z.string(), file: z.string(), width: z.number(), height: z.number(),
  durationSec: z.number().nullable(), verified: z.boolean(), preview: z.string().nullable(),
  warnings: z.array(outputWarningSchema).optional(),
  /**
   * sha256 (hex) of the file's content, the identity used by the per-format history (`formatHistory`). Always computed by
   * the core after the turn, never taken from the agent. Optional: old versions have none and get it lazily; the computed
   * hashes are cached in `.studio/cache/hashes/<creative>/v<N>.json`, outside `outputs/vN/`, so old versions.json files
   * are never rewritten. A missing hash counts as "changed".
   */
  sha256: z.string().regex(HEX64).optional(),
  /**
   * Problems of this file alone (subset of the version's `problems`), so the ★ rule can tell a clean format from a broken one
   * in the same version; a carried-over or materialized file has `[]`. Absent in old versions: then the version-level
   * `problems` count for every file of that version.
   */
  problems: z.array(z.string()).optional(),
  /**
   * The output checks' problems as codes with their figures (final wave P2), alongside the texts in `problems`: the UI
   * says them briefly in its own language ("duration 4.8 s instead of 6 s"). Render outputs only; absent elsewhere.
   */
  issues: z.array(outputIssueSchema).optional(),
  /**
   * v2 versions: the composition hash (`compositionHash`) this file was rendered from. The render counts as current only while
   * it equals the version's composition hash for the format (`renderState`). Absent on legacy files (their media is the result).
   */
  fromComposition: z.string().regex(HEX64).optional(),
});
export type OutputFileInfo = z.infer<typeof outputFileInfoSchema>;

/**
 * A format's composition in a v2 version (spec §3.1): `dir` is the composition folder relative to `outputs/vN/`
 * (`compositions/<format>`), `hash` its canonical `compositionHash`. A follower uses its primary's composition: its entry has
 * `followsFormat` (the primary) and the primary's `dir` and `hash`.
 */
export const versionCompositionSchema = z.object({
  format: z.string().min(1),
  dir: z.string().regex(COMPOSITION_DIR),
  hash: z.string().regex(HEX64),
  followsFormat: z.string().min(1).optional(),
  /**
   * Problems of this format's composition alone (a subset of the version's `problems`), so the ★ rule can tell a clean
   * format from a broken one in the same v2 version (`starOf`). Absent: the version-level `problems` count for it.
   */
  problems: z.array(z.string()).optional(),
  /**
   * A duration far from the brief that the USER chose in the editor (decisions log 270): the duration, and the brief's duration
   * it was chosen against. Carried while the composition keeps that duration; an agent turn is not told to bring it back to
   * the brief only while the brief still says `briefDurationSec`. Absent: no such choice.
   */
  userDuration: z.object({ durationSec: z.number().positive(), briefDurationSec: z.number().positive() }).optional(),
});
export type VersionComposition = z.infer<typeof versionCompositionSchema>;

export const versionEntrySchema = z.object({
  n: z.number().int().min(1),
  commit: z.string().nullable(),
  sessionId: z.string().nullable(),
  status: z.enum(['complete', 'incomplete']),
  createdAt: z.iso.datetime(),
  request: z.string(),
  outputs: z.array(outputFileInfoSchema),
  problems: z.array(z.string()),
  tools: z.array(z.string()),
  renderCommand: z.string().nullable(),
  basedOn: z.number().int().nullable(),
  usage: usageSummarySchema.optional(),
  /**
   * v2 versions (manifest v2): one composition per delivered format, the identity the per-format history compares
   * (`formatHistory`). Absent on legacy versions, whose identity is the file's `sha256`.
   */
  compositions: z.array(versionCompositionSchema).optional(),
  /** Who wrote the version: the agent (default when absent) or a direct edit in the editor (Phase 10b). */
  origin: z.enum(['agent', 'editor']).optional(),
  /**
   * Localization overlays of this version (Phase 12): one per language and format instance. `hash` is the overlay file's hash;
   * `stale` lists the ids (clips, `<clipId>.<key>` params) whose source text changed since the translation; `voice` says what
   * the voices of that language do. Absent on versions without localizations.
   */
  localizations: z.array(z.object({
    locale: localeTag, instanceId: z.string().regex(INSTANCE_ID_RE), hash: z.string().regex(HEX64),
    origin: z.enum(['agent', 'editor']), stale: z.array(z.string()),
    voice: z.enum(['translated', 'original', 'muted']), problems: z.array(z.string()).optional(),
  })).optional(),
});
export type VersionEntry = z.infer<typeof versionEntrySchema>;

export const versionsFileSchema = z.object({ schemaVersion: z.literal(1), versions: z.array(versionEntrySchema).default([]) });
export type VersionsFile = z.infer<typeof versionsFileSchema>;

export const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  files: z.array(z.object({
    format: z.string().min(1),
    file: z.string().regex(FILE_NAME).refine((f) => f !== '.' && f !== '..', 'issue.fileName'),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    durationSec: z.number().positive().nullish(),
    /** Set by the core on a follower's entry: the file is a byte-identical copy of this primary format's file. */
    followsFormat: z.string().min(1).optional(),
  })),
  tools: z.array(z.string()).default([]),
  renderCommand: z.string().nullish(),
});
export type ManifestFile = z.infer<typeof manifestSchema>;

/**
 * `outputs/vN/manifest.json` v2, written by the core (spec §3.1): the compositions of the version and the renders made from
 * them. Additive: v1 manifests stay readable (`anyManifestSchema`). A render's `fromComposition` is the composition hash it
 * was made from (copied to `OutputFileInfo.fromComposition`); `renderedAt` is an ISO date.
 */
export const manifestV2Schema = z.object({
  schemaVersion: z.literal(2),
  compositions: z.array(versionCompositionSchema),
  renders: z.array(z.object({
    format: z.string().min(1),
    file: z.string().regex(FILE_NAME).refine((f) => f !== '.' && f !== '..', 'issue.fileName'),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    durationSec: z.number().positive().nullable(),
    sha256: z.string().regex(HEX64),
    renderedAt: z.iso.datetime(),
    fromComposition: z.string().regex(HEX64).optional(),
  })),
});
export type ManifestV2 = z.infer<typeof manifestV2Schema>;
/** A manifest of either version, told apart by `schemaVersion`. */
export const anyManifestSchema = z.discriminatedUnion('schemaVersion', [manifestSchema, manifestV2Schema]);
export type AnyManifest = z.infer<typeof anyManifestSchema>;

/**
 * Whether a video lasts far from the brief's duration (the phase 8 rule: more than 1 s and more than 10 % off): the agent's
 * compositions are checked with it; a direct edit's duration is the user's choice (decisions log 262) and only shown.
 */
export function isDurationOffBrief(duration: number, briefDurationSec: number | null | undefined): boolean {
  return briefDurationSec !== null && briefDurationSec !== undefined && duration > 0 && Math.abs(duration - briefDurationSec) > Math.max(1, briefDurationSec * 0.1);
}

/** C0 and C1 control characters (newlines included), DEL and the Unicode line/paragraph separators: never in a pin's clip id or name. */
const PIN_LABEL_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
/** A clip name as a pin may carry it: control characters and separators become spaces, at most 200 characters. */
export const pinClipName = (name: string): string => name.replace(new RegExp(PIN_LABEL_FORBIDDEN.source, 'g'), ' ').slice(0, 200);
const pinLabel = (max: number) => z.string().max(max).refine((s) => !PIN_LABEL_FORBIDDEN.test(s), { message: 'control characters are not allowed' });

export const pinSchema = z.object({
  format: z.string().min(1),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  timeSec: z.number().min(0).nullable(),
  note: z.string().optional(),
  /** The composition clip the comment is about (Phase 10b). Absent on older pins. */
  clipId: pinLabel(64).optional(),
  /** The clip's name when the comment was placed (for the chip and the agent's prompt; the clip may be renamed or gone later). */
  clipName: pinLabel(200).optional(),
  /** The time range, in seconds, the comment is about (Phase 10b): `0 <= start < end`. */
  range: z.object({ start: z.number().min(0), end: z.number() }).refine((r) => r.start < r.end).optional(),
});
export type Pin = z.infer<typeof pinSchema>;

export type ConversationEntry =
  | { type: 'user'; at: string; text: string; pins: Pin[]; attachments: string[] }
  | { type: 'agent'; at: string; jobId: string; event: AgentEvent }
  | { type: 'version'; at: string; n: number; status: 'complete' | 'incomplete' }
  /** `warning`: something the user should know that did not fail the turn (e.g. a link removed); shown like `info`. */
  | { type: 'system'; at: string; level: 'info' | 'warning' | 'error'; text: string };

export interface CreativeSummary { slug: string; title: string; status: CreativeStatus; formats: string[]; versions: number; updatedAt: string; cover: string | null }
/** A creative summary tagged with its project, for cross-project lists such as "Jump back in". */
export type RecentCreative = CreativeSummary & { project: { slug: string; name: string } };
export type CreativeListItem = ({ ok: true } & CreativeSummary) | { ok: false; slug: string; error: string };
/**
 * `formats`: one summary per brief format (history, ★, linkable primaries), always sent by the core; optional in the type
 * only so older fixtures stay valid. `versions` may carry hashes the core computed lazily for old versions.
 */
export interface CreativeDetail { slug: string; creative: CreativeFile; versions: VersionEntry[]; jobKey: string; formats?: FormatSummary[] }

/** Localized text of an output warning; an unknown key, or params that are not numbers, fall back to the key itself. */
export function outputWarningText(w: OutputWarning, locale: Locale): string {
  if (w.key === 'outputs.largeFile') {
    const sizeMB = Number(w.params.sizeMB);
    const mbps = Number(w.params.mbps);
    const targetMbps = Number(w.params.targetMbps);
    if (![sizeMB, mbps, targetMbps].every(Number.isFinite)) return w.key;
    return messages(locale).outputs.largeFile({ sizeMB, mbps, targetMbps, channel: channelName(String(w.params.channel ?? ''), locale) });
  }
  // A catalog format is named in the reader's language; any other id is shown as stored.
  const name = (v: unknown) => formatDisplayName(DEFAULT_FORMATS, String(v ?? ''), locale);
  if (w.key === 'outputs.keptUnchanged') return messages(locale).outputs.keptUnchanged({ format: name(w.params.format) });
  if (w.key === 'outputs.followerReplaced') return messages(locale).outputs.followerReplaced({ format: name(w.params.format), primary: name(w.params.primary) });
  return w.key;
}
