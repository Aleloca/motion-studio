import { z } from 'zod';
import type { AgentEvent } from './events.ts';
import { linkedCodebaseSchema } from './schemas.ts';
import { usageSummarySchema } from './usage.ts';
import { channelName, DEFAULT_FORMATS, formatLabel } from './formats.ts';
import { messages, type Locale } from './i18n/index.ts';
import type { FormatSummary } from './formats/link.ts';

export const creativeStatusSchema = z.enum(['draft', 'working', 'ready', 'incomplete', 'error', 'interrupted']);
export type CreativeStatus = z.infer<typeof creativeStatusSchema>;

export const briefSchema = z.object({
  goal: z.string().trim().min(1),
  message: z.string(),
  formats: z.array(z.string().min(1)).min(1),
  durationSec: z.number().int().min(1).max(600).nullable(),
  assets: z.array(z.string()),
  notes: z.string(),
  /**
   * Linked formats, follower → primary (spec §2.3). A follower is not given to the agent: the core copies the primary's file
   * for it. Absent in old briefs (no links). Kept loose on purpose: a link whose ends are not both in `formats` is ignored by
   * consumers instead of making the creative unreadable.
   */
  links: z.record(z.string().min(1), z.string().min(1)).optional(),
});
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

/**
 * A non-blocking note on an output file: never a problem, never triggers the fix loop. `key` is an i18n key
 * (`outputs.largeFile`, `outputs.keptUnchanged`, `outputs.followerReplaced`) and `params` its values, so the web renders it in the user's language
 * (see `outputWarningText`). Old versions.json files have none.
 */
export const outputWarningSchema = z.object({
  key: z.string(), params: z.record(z.string(), z.union([z.string(), z.number()])),
});
export type OutputWarning = z.infer<typeof outputWarningSchema>;

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
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /**
   * Problems of this file alone (subset of the version's `problems`), so the ★ rule can tell a clean format from a broken one
   * in the same version; a carried-over or materialized file has `[]`. Absent in old versions: then the version-level
   * `problems` count for every file of that version.
   */
  problems: z.array(z.string()).optional(),
});
export type OutputFileInfo = z.infer<typeof outputFileInfoSchema>;

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
});
export type VersionEntry = z.infer<typeof versionEntrySchema>;

export const versionsFileSchema = z.object({ schemaVersion: z.literal(1), versions: z.array(versionEntrySchema).default([]) });
export type VersionsFile = z.infer<typeof versionsFileSchema>;

const FILE_NAME = /^[^/\\]+$/;
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

export const pinSchema = z.object({
  format: z.string().min(1),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  timeSec: z.number().min(0).nullable(),
  note: z.string().optional(),
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
  const name = (v: unknown) => { const id = String(v ?? ''); const preset = DEFAULT_FORMATS.find((p) => p.id === id); return preset ? formatLabel(preset, locale) : id; };
  if (w.key === 'outputs.keptUnchanged') return messages(locale).outputs.keptUnchanged({ format: name(w.params.format) });
  if (w.key === 'outputs.followerReplaced') return messages(locale).outputs.followerReplaced({ format: name(w.params.format), primary: name(w.params.primary) });
  return w.key;
}
