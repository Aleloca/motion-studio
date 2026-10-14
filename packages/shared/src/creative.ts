import { z } from 'zod';
import { SERVICE_CHOICES } from './services.ts';
import type { AgentEvent } from './events.ts';
import { linkedCodebaseSchema } from './schemas.ts';
import { usageSummarySchema } from './usage.ts';
import { INSTANCE_FOLDER_SOURCE, INSTANCE_ID_RE } from './format-instance.ts';
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
  /**
   * Instance ids freed since a version (Phase 12, final review I1): instance id → the number of the latest version when the
   * id was removed from the brief or added to it (0 before any version). A version's localization rows for that id, up to
   * that number, belong to the old instance and are never carried into a new version: a freed id taken again starts clean,
   * as its links and picks do. Absent in old files (nothing freed).
   */
  freedInstances: z.record(z.string().min(1), z.number().int().min(0)).optional(),
  /**
   * Phase 13: requests queued to run after the current turn (spec §2, "Queue for after"), oldest first; at most
   * `LIVE_LIMITS.queued` from the user (a message that arrives after the agent finished is never dropped). `bootId`: the
   * core process that queued it (Ruling T): the queue starts by itself only when it matches the running core, so after a
   * restart nothing runs until "Run next". Absent in old files (nothing queued).
   */
  queued: z.array(z.lazy(() => queuedRequestSchema)).optional(),
  /**
   * Phase 13: the session of a turn the user stopped (spec §3): the next turn resumes it as a fork, with a note that files
   * in work/ may be partial. Cleared when a turn saves a version or on a restore. Absent in old files.
   */
  stoppedSession: z.object({ sessionId: z.string().min(1), at: z.iso.datetime(), jobId: z.string().min(1) }).optional(),
});
export type CreativeFile = z.infer<typeof creativeFileSchema>;

/**
 * A Claude Code session id the core passes to `--resume` (final review I1): 1..128 of [A-Za-z0-9-], never starting with
 * '-'. Every id the core resumes is checked against it where the command line is built; a stored id that fails is ignored.
 */
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
export const isSessionId = (s: unknown): s is string => typeof s === 'string' && SESSION_ID_RE.test(s);

/** Phase 13 limits (spec §2, decisions log 606): characters per message, live messages per turn, queued requests per creative. */
export const LIVE_LIMITS = { maxChars: 4000, perTurn: 10, queued: 5 } as const;

/**
 * What happened to a message sent while a turn runs (POST …/messages):
 * - `delivered-pending`: it goes to the agent in this turn (written to the running session, or in the next repair attempt's
 *   prompt; the `user_message_delivered` event says when);
 * - `queued`: put in the queue as asked;
 * - `queued-after-finish`: the agent had already finished (or no attempt was left), so it is the next request;
 * - `queued-unsupported`: live messages are off for this Claude Code (or this kind of job), so it is the next request.
 */
export type LiveMessageOutcome = 'delivered-pending' | 'queued' | 'queued-after-finish' | 'queued-unsupported';
/**
 * What a redirect did (POST /api/jobs/:id/redirect); `queued-after-finish`: it came while the version was being saved;
 * `pending-start` (Ruling W): the creative job had not started yet — the words join its first prompt, and are marked
 * delivered (`user_message_delivered`) when it starts.
 */
export type RedirectOutcome = 'interrupted' | 'restarted' | 'queued-after-finish' | 'pending-start';

const HEX64 = /^[0-9a-f]{64}$/;
const FILE_NAME = /^[^/\\]+$/;
/** `compositions/<instance id>`: a composition folder inside `outputs/vN/`. */
const COMPOSITION_DIR = new RegExp(`^compositions/${INSTANCE_FOLDER_SOURCE}$`);

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

/**
 * Why a translation has a problem, as the core knows it when it writes the sentence (Phase 12, Ruling M): the UI flags clips by
 * `code` and `clipId` and words the label itself, never by reading the (translated, stored) sentence. `message` is that sentence.
 * `stale`: the entry's source text changed since the translation (only in `issues`, never in `problems`).
 * `sourceTextOverflow`: the render measured an overflow on a clip that shows the source text (not translated, or outdated):
 * the original's problem, not the translation's (only in `issues`, never in `problems`: it does not ask for "render anyway").
 */
export const LOCALIZATION_ISSUE_CODES = [
  'textOverflow', 'textOverflowMeasured', 'notTranslated', 'stale', 'voiceTooLong', 'voiceFailed', 'voiceDurationUnknown', 'voiceFileInvalid',
  'assetChanged', 'fallbackFontUnavailable', 'renderCheckFailed', 'invalid', 'sourceTextOverflow',
] as const;
/** Issue codes that are notes on a row, never its problems (`problems` leaves them out). */
export const LOCALIZATION_NOTE_CODES: ReadonlySet<string> = new Set(['stale', 'sourceTextOverflow']);
export const localizationIssueSchema = z.object({
  code: z.enum(LOCALIZATION_ISSUE_CODES), clipId: z.string().max(200).optional(), message: z.string().max(1000),
});
export type LocalizationIssue = z.infer<typeof localizationIssueSchema>;

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
    /** Phase 12, Ruling M: the same problems (and the outdated entries) with their code and clip; absent on rows written before. */
    issues: z.array(localizationIssueSchema).max(400).optional(),
    /**
     * Phase 12, Task 4: why a language asked to translate its voices keeps a fallback (`voice` is then `original`): the brief's
     * voice service is off, no key, a key known to lack text-to-speech (F5), the batch confirmation declined, or the
     * generation failed. Absent: no fallback.
     */
    voiceFallback: z.enum(['off', 'noKey', 'missingPermission', 'declined', 'failed']).optional(),
    /** Phase 12, Task 4: voice clips with no known script (no `script`, no tts description): they keep the original voice. */
    noScript: z.array(z.string().max(200)).max(200).optional(),
    /**
     * Phase 12, Ruling L: the sha256 of each project file the core wrote or attached for this language (a translated voice in
     * `assets/audio/`, a fallback font in `assets/fonts/`), by its overlay path. The localized render (and the export) checks
     * the file it uses against it: a file changed since is a problem, never rendered silently. Absent: nothing recorded.
     */
    assetHashes: z.record(z.string().max(1024), z.string().regex(HEX64)).optional(),
    /**
     * The latest render of this language and instance (`outputs/vN/<instanceId>.<locale>.<ext>`, Phase 12 §3.5), written by
     * the core. Current while `overlayHash` is the row's `hash` and `fromComposition` the instance's composition hash;
     * `forced`: rendered with open problems or outdated entries ("render anyway"), whose ids are in `stale`.
     */
    render: z.object({
      file: z.string().regex(FILE_NAME).refine((f) => f !== '.' && f !== '..', 'issue.fileName'),
      width: z.number().int().positive(), height: z.number().int().positive(), durationSec: z.number().positive().nullable(),
      sha256: z.string().regex(HEX64), fromComposition: z.string().regex(HEX64), overlayHash: z.string().regex(HEX64),
      forced: z.boolean(), stale: z.array(z.string()), problems: z.array(z.string()).optional(), renderedAt: z.iso.datetime(),
    }).optional(),
  })).optional(),
});
export type VersionEntry = z.infer<typeof versionEntrySchema>;
/** One localization row of a version (Phase 12). */
export type LocalizationRow = NonNullable<VersionEntry['localizations']>[number];

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
    /**
     * A localized render (Phase 12 §3.5): its language, whether it was made with open problems or outdated entries
     * ("render anyway"), and the outdated ids it shows in the source language. Absent on the primary language's renders.
     */
    locale: localeTag.optional(),
    forced: z.boolean().optional(),
    stale: z.array(z.string()).optional(),
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

/** A request queued for after the current turn (Phase 13, creative.json `queued[]`). */
export const queuedRequestSchema = z.object({
  clientId: z.string().min(1).max(100),
  text: z.string().max(10_000),
  pins: z.array(pinSchema).max(50).default([]),
  at: z.iso.datetime(),
  /** The core process that queued it (Ruling T); absent: never started by itself. */
  bootId: z.string().min(1).max(100).optional(),
});
export type QueuedRequest = z.infer<typeof queuedRequestSchema>;

export type ConversationEntry =
  /**
   * Phase 13 (all optional, absent in older logs): `mode` says how a message sent while the agent worked was given
   * (`live`: into the running turn; `queued`: a queued request that started; `redirect`: Stop and redirect), `clientId` the
   * client's id of it (idempotency), `jobId` the turn it belongs to, `deliveredAt` when it went into a prompt.
   */
  | { type: 'user'; at: string; text: string; pins: Pin[]; attachments: string[]; jobId?: string; mode?: 'live' | 'queued' | 'redirect'; clientId?: string; deliveredAt?: string }
  | { type: 'agent'; at: string; jobId: string; event: AgentEvent }
  | { type: 'version'; at: string; n: number; status: 'complete' | 'incomplete' }
  /** `warning`: something the user should know that did not fail the turn (e.g. a link removed); shown like `info`. */
  | { type: 'system'; at: string; level: 'info' | 'warning' | 'error'; text: string };

export interface CreativeSummary { slug: string; title: string; status: CreativeStatus; formats: string[]; /** The brief's labels of format instances (Phase 12); absent when there are none. */ formatLabels?: Record<string, string>; versions: number; updatedAt: string; cover: string | null }
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
