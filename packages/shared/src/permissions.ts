import { z } from 'zod';

export const PROVIDER_IDS = ['openai', 'elevenlabs', 'pexels', 'unsplash'] as const;
export type ProviderId = typeof PROVIDER_IDS[number];
export interface SecretStatus { provider: ProviderId; configured: boolean; source: 'env' | 'keychain' | null }

export const permissionsFileSchema = z.object({
  schemaVersion: z.literal(1),
  allow: z.array(z.object({ rule: z.string().min(1).max(500), label: z.string().max(300), addedAt: z.iso.datetime() })).max(200).default([]),
});
export type PermissionsFile = z.infer<typeof permissionsFileSchema>;

/**
 * Detail of a `paid-batch` approval (Phase 12): several paid calls of one provider confirmed together (one confirmation per
 * localize turn). `chars` is what each call sends; `estimate` is the cost text when the provider's price is known.
 */
export const paidBatchSchema = z.object({
  provider: z.enum(PROVIDER_IDS),
  calls: z.array(z.object({ label: z.string().max(300), chars: z.number().int().min(0) })).min(1).max(200),
  estimate: z.string().max(100).optional(),
});
export type PaidBatch = z.infer<typeof paidBatchSchema>;
