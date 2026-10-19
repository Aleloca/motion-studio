import { z } from 'zod';
import { LOCALES } from './i18n/index.ts';
import { relativeFileSchema } from './library.ts';

export const appConfigSchema = z.object({
  schemaVersion: z.literal(1),
  workspacePath: z.string().min(1).nullable().default(null),
  language: z.enum(['system', ...LOCALES]).default('system'),
});
export type AppConfig = z.infer<typeof appConfigSchema>;

const DOMAIN_ERROR = 'issue.domain';
/** Local-only names: never a network allowance for the agent. */
const LOCAL_SUFFIXES = ['localhost', 'local', 'internal', 'home.arpa'];
/** Two-label public suffixes: `*.co.uk` would open a whole country's sites. */
const TWO_LEVEL_SUFFIXES = new Set(['co.uk', 'org.uk', 'com.au', 'co.jp', 'com.br', 'co.nz']);
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export const domainSchema = z.string().trim().toLowerCase().max(253, DOMAIN_ERROR).refine((value) => {
  const wildcard = value.startsWith('*.');
  const host = wildcard ? value.slice(2) : value;
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL_RE.test(l)) || !/^[a-z]{2,}$/.test(labels.at(-1)!)) return false;
  if (LOCAL_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) return false;
  if (wildcard && TWO_LEVEL_SUFFIXES.has(host)) return false;
  return true;
}, DOMAIN_ERROR);

export const workspaceSettingsSchema = z.object({
  schemaVersion: z.literal(1),
  maxConcurrentJobs: z.number().int().min(1).max(8).default(2),
  expertMode: z.boolean().default(false),
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  model: z.string().min(1).nullable().default(null),
  sandboxMode: z.enum(['auto', 'off']).default('auto'),
  extraAllowedDomains: z.array(domainSchema).max(100).default([]),
  confirmPaidProviders: z.boolean().default(true),
  /** Allow Bash in a sandboxed job without asking; absent in an old settings.json means on. */
  autoApproveSandboxed: z.boolean().default(true),
  /** File name pattern of exports; tokens `{title} {channel} {format} {ratio} {v} {date}`. Absent in an old settings.json: the default. */
  exportNamePattern: z.string().min(1).max(200).default('{title}-{format}-v{v}'),
  /**
   * Phase 13, default on since decision 804: write messages into the running agent session. Effective only for a Claude
   * Code version verified live (2.1.301 and newer, measured by the user's probe); off, or an older or unknown version,
   * means a message sent while the agent works is queued as the next request.
   */
  agentLiveInput: z.boolean().default(true),
  /**
   * Phase 13, default on since decision 804 (needs agentLiveInput): interrupt the current step in the same process, for a
   * verified Claude Code version; off, or an older or unknown version, means stop and resume.
   */
  agentInterrupt: z.boolean().default(true),
  /**
   * Decision 804 marker: the two settings above were written under the decision-804 defaults (on). A file without it
   * predates them: its `false` values are the old default (Phase 13 had no switch for them in the app), so reading it
   * (`storedWorkspaceSettingsSchema`) turns both on once; a later `false` saved with the marker is the user's own choice.
   */
  agentLiveDefaults: z.literal(804).optional(),
  /**
   * Phase 3 of the single agent (decisions 977–983): a variant group has one agent, the coordinator, that the user talks to;
   * off: the per-variant turns of phase 15 (the composer's "Invia a" and "Tutte"). Absent: `SINGLE_AGENT_DEFAULT`.
   */
  singleAgent: z.boolean().optional(),
});
export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;
/** Phase 3 of the single agent: what an absent `singleAgent` means (see `singleAgentOn`). */
export const SINGLE_AGENT_DEFAULT = true;
/** Whether a variant group has one agent (the coordinator) under these settings. */
export const singleAgentOn = (s: Pick<WorkspaceSettings, 'singleAgent'> | null | undefined): boolean => s?.singleAgent ?? SINGLE_AGENT_DEFAULT;

/**
 * Reading the settings file: a domain typed by hand that is no longer valid (e.g. `printer.local`) is left out, one by
 * one, and reported in `droppedDomains` instead of making the whole workspace unreadable. Writes use the strict schema.
 */
/** Decision 804: a settings file written before the marker gets live input and interrupt on (see `agentLiveDefaults`). */
const withLiveDefaults = (raw: unknown): unknown => (
  raw !== null && typeof raw === 'object' && !Array.isArray(raw) && (raw as Record<string, unknown>).agentLiveDefaults === undefined
    ? { ...raw, agentLiveInput: true, agentInterrupt: true, agentLiveDefaults: 804 }
    : raw
);
export const storedWorkspaceSettingsSchema = z.preprocess(withLiveDefaults, workspaceSettingsSchema
  .extend({ extraAllowedDomains: z.array(z.unknown()).max(100).default([]) })
  .transform(({ extraAllowedDomains, ...rest }) => {
    const kept: string[] = [];
    const dropped: string[] = [];
    for (const d of extraAllowedDomains) {
      const r = domainSchema.safeParse(d);
      if (!r.success) dropped.push(typeof d === 'string' ? d : JSON.stringify(d));
      else if (!kept.includes(r.data)) kept.push(r.data);
    }
    return { ...rest, extraAllowedDomains: kept, ...(dropped.length ? { droppedDomains: dropped } : {}) };
  }));
/** Settings as read from disk (and returned by GET /api/workspace). */
export type WorkspaceSettingsView = WorkspaceSettings & { droppedDomains?: string[] };

export const linkedCodebaseSchema = z.object({
  path: z.string().min(1),
  note: z.string().optional(),
});
export type LinkedCodebase = z.infer<typeof linkedCodebaseSchema>;

/** Report 44: a chosen project icon: an image of the library, or the initials. */
export const projectIconSchema = z.union([z.object({ asset: relativeFileSchema }).strict(), z.literal('initials')]);
export type ProjectIcon = z.infer<typeof projectIconSchema>;

export const projectFileSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().trim().min(1),
  description: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  linkedCodebases: z.array(linkedCodebaseSchema),
  /**
   * Report 44: the project's icon. Absent: automatic (`autoProjectIcon`, else the initials); `{ asset }`: an image of the
   * library (its path relative to `assets/`); `'initials'`: the initials, even when the brand has an icon.
   */
  icon: projectIconSchema.optional(),
});
export type ProjectFile = z.infer<typeof projectFileSchema>;
