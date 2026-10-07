import { z } from 'zod';

export const appConfigSchema = z.object({
  schemaVersion: z.literal(1),
  workspacePath: z.string().min(1).nullable().default(null),
});
export type AppConfig = z.infer<typeof appConfigSchema>;

export const domainSchema = z.string().trim().toLowerCase().regex(/^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$/, 'dominio non valido (es. api.esempio.it o *.esempio.it)');

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
