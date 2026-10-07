import { z } from 'zod';

export const PROVIDER_IDS = ['openai', 'elevenlabs', 'pexels', 'unsplash'] as const;
export type ProviderId = typeof PROVIDER_IDS[number];
export interface SecretStatus { provider: ProviderId; configured: boolean; source: 'env' | 'keychain' | null }

export const permissionsFileSchema = z.object({
  schemaVersion: z.literal(1),
  allow: z.array(z.object({ rule: z.string().min(1).max(500), label: z.string().max(300), addedAt: z.iso.datetime() })).max(200).default([]),
});
export type PermissionsFile = z.infer<typeof permissionsFileSchema>;
