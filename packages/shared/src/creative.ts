import { z } from 'zod';
import type { AgentEvent } from './events.ts';
import { linkedCodebaseSchema } from './schemas.ts';
import { usageSummarySchema } from './usage.ts';
import { channelName } from './formats.ts';
import { messages, type Locale } from './i18n/index.ts';

export const creativeStatusSchema = z.enum(['draft', 'working', 'ready', 'incomplete', 'error', 'interrupted']);
export type CreativeStatus = z.infer<typeof creativeStatusSchema>;

export const briefSchema = z.object({
  goal: z.string().trim().min(1),
  message: z.string(),
  formats: z.array(z.string().min(1)).min(1),
  durationSec: z.number().int().min(1).max(600).nullable(),
  assets: z.array(z.string()),
  notes: z.string(),
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
});
export type CreativeFile = z.infer<typeof creativeFileSchema>;

/**
 * A non-blocking note on an output file: never a problem, never triggers the fix loop. `key` is an i18n key
 * (today only `outputs.largeFile`) and `params` its values, so the web renders it in the user's language
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
  | { type: 'system'; at: string; level: 'info' | 'error'; text: string };

export interface CreativeSummary { slug: string; title: string; status: CreativeStatus; formats: string[]; versions: number; updatedAt: string; cover: string | null }
/** A creative summary tagged with its project, for cross-project lists such as "Jump back in". */
export type RecentCreative = CreativeSummary & { project: { slug: string; name: string } };
export type CreativeListItem = ({ ok: true } & CreativeSummary) | { ok: false; slug: string; error: string };
export interface CreativeDetail { slug: string; creative: CreativeFile; versions: VersionEntry[]; jobKey: string }

/** Localized text of an output warning; an unknown key (a newer version's) falls back to the key itself. */
export function outputWarningText(w: OutputWarning, locale: Locale): string {
  if (w.key === 'outputs.largeFile') {
    const { sizeMB, maxMB, channel } = w.params;
    return messages(locale).outputs.largeFile({ sizeMB: Number(sizeMB), maxMB: Number(maxMB), channel: channelName(String(channel), locale) });
  }
  return w.key;
}
