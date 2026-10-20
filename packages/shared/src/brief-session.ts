import { z } from 'zod';
import { BRIEF_TEXT_MAX } from './creative.ts';
import { linkedCodebaseSchema } from './schemas.ts';
import { INSTANCE_ID_RE } from './format-instance.ts';
import type { JobSummary } from './events.ts';

/**
 * The brief with the agent (decisions 1410–1423): a project-level session in which a read-only agent fills the fields of the
 * "New creative" form. Nothing is created until the user presses Genera (or Salva bozza).
 */

/** The fields of the form the agent may write, in display order (the fill line lists them in this order). */
export const BRIEF_FIELDS = ['goal', 'message', 'durationSec', 'assets', 'linkedCodebases', 'notes', 'formats', 'variants'] as const;
export type BriefField = (typeof BRIEF_FIELDS)[number];
export const briefFieldSchema = z.enum(BRIEF_FIELDS);

/** The most variants a brief may ask for (the variants route's own cap is higher: the brief asks only for a starting count). */
export const BRIEF_VARIANTS_MAX = 5;
/** The longest message the user sends to the brief agent. */
export const BRIEF_MESSAGE_MAX = 10_000;

const assetPath = z.string().min(1).max(1024).regex(/^assets\//);
const codebases = z.array(linkedCodebaseSchema).max(20);
const formatIds = z.array(z.string().regex(INSTANCE_ID_RE)).max(100).refine((f) => new Set(f).size === f.length, 'issue.duplicateFormats');

/** The form as the user sees it: the goal may be empty (not filled yet), as may the format list. */
export const briefFormSchema = z.object({
  goal: z.string().max(BRIEF_TEXT_MAX),
  message: z.string().max(BRIEF_TEXT_MAX),
  notes: z.string().max(BRIEF_TEXT_MAX),
  durationSec: z.number().int().min(1).max(600).nullable(),
  assets: z.array(assetPath).max(200),
  linkedCodebases: codebases,
  formats: formatIds,
  variants: z.number().int().min(1).max(BRIEF_VARIANTS_MAX),
});
export type BriefForm = z.infer<typeof briefFormSchema>;

/** An empty form (a session started before the user typed anything). */
export const EMPTY_BRIEF_FORM: BriefForm = { goal: '', message: '', notes: '', durationSec: null, assets: [], linkedCodebases: [], formats: [], variants: 1 };

/** What the agent writes with `fill_brief`: only what changes, at least one field; a goal it writes is never blank. */
export const briefFillSchema = briefFormSchema.extend({
  goal: z.string().trim().min(1).max(BRIEF_TEXT_MAX),
  formats: formatIds.refine((f) => f.length > 0, 'issue.noFormats'),
}).partial().strict().refine((f) => Object.keys(f).length > 0, 'issue.emptyFill');
export type BriefFill = z.infer<typeof briefFillSchema>;

/** What the session may read: the folders the user linked and the library assets they attached. */
export const briefContextSchema = z.object({
  codebases,
  assets: z.array(assetPath).max(200),
}).strict();
export type BriefContext = z.infer<typeof briefContextSchema>;

/** A message to the brief agent: the user's words, the session's context and the form as it is now (the agent sees edits). */
export const briefMessageSchema = z.object({
  clientId: z.string().min(1).max(100),
  text: z.string().max(BRIEF_MESSAGE_MAX),
  context: briefContextSchema,
  form: briefFormSchema,
  userEdited: z.array(briefFieldSchema).max(BRIEF_FIELDS.length),
  mode: z.enum(['live', 'queued']).optional(),
}).strict();
export type BriefMessageInput = z.infer<typeof briefMessageSchema>;

/** The form saved without a message (the web saves it, debounced, when the user edits it). */
export const briefFormSaveSchema = z.object({
  form: briefFormSchema,
  userEdited: z.array(briefFieldSchema).max(BRIEF_FIELDS.length),
}).strict();
export type BriefFormSave = z.infer<typeof briefFormSaveSchema>;

/** A message waiting for the running brief turn to end. `context`: the items it added (paths). */
export const briefQueuedSchema = z.object({
  clientId: z.string().min(1).max(100),
  text: z.string().max(BRIEF_MESSAGE_MAX),
  at: z.iso.datetime(),
  context: z.object({ codebases: z.array(z.string()), assets: z.array(z.string()) }),
});
export type BriefQueued = z.infer<typeof briefQueuedSchema>;

/** GET /api/projects/:slug/brief-session: the open session (null: none). `jobId`: its job while queued or running. */
export interface BriefSessionView {
  id: string;
  createdAt: string;
  updatedAt: string;
  context: BriefContext;
  form: BriefForm;
  /** Fields the user changed after the agent's last write: the agent never changes them. */
  userEdited: BriefField[];
  /** Fields the agent wrote (the form marks them "Agente" until the user edits them). */
  agentFields: BriefField[];
  queued: BriefQueued[];
  jobId: string | null;
}

/** POST …/brief-session/:id/messages: a new turn, a message given to the running one, or queued for after it. */
export type BriefSendResult = { outcome: 'started'; job: JobSummary } | { outcome: 'delivered-pending' | 'queued' };

/** The create route's link to a brief session (Genera / Salva bozza): `group` when the brief asks for variants. */
export const briefSessionRefSchema = z.object({ id: z.string().min(1).max(100), group: z.boolean().optional() }).strict();
export type BriefSessionRef = z.infer<typeof briefSessionRefSchema>;
