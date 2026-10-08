import { z } from 'zod';
import { LOCALES } from './i18n/index.ts';

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
});
export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;

/**
 * Reading the settings file: a domain typed by hand that is no longer valid (e.g. `printer.local`) is left out, one by
 * one, and reported in `droppedDomains` instead of making the whole workspace unreadable. Writes use the strict schema.
 */
export const storedWorkspaceSettingsSchema = workspaceSettingsSchema
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
  });
/** Settings as read from disk (and returned by GET /api/workspace). */
export type WorkspaceSettingsView = WorkspaceSettings & { droppedDomains?: string[] };

export const linkedCodebaseSchema = z.object({
  path: z.string().min(1),
  note: z.string().optional(),
});
export type LinkedCodebase = z.infer<typeof linkedCodebaseSchema>;

export const projectFileSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().trim().min(1),
  description: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  linkedCodebases: z.array(linkedCodebaseSchema),
});
export type ProjectFile = z.infer<typeof projectFileSchema>;
