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
  /**
   * Phase 15 (spec §3, "Servizi a pagamento"): the paid services a variant fan-out may use, one item per variant and service,
   * confirmed together on ONE card. `chars`/`seconds`: the size when it is known before the turn (music: the brief's duration);
   * `estimate`: the cost text when the provider's price is known. `provider`/`calls` stay filled (one call line per item) so a
   * card that does not know `items` still renders. Absent: a phase 12 batch.
   */
  items: z.array(z.object({
    variant: z.enum(['a', 'b', 'c', 'd', 'e']),
    provider: z.enum(PROVIDER_IDS),
    capability: z.enum(['images', 'voice', 'music', 'sfx']),
    chars: z.number().int().min(0).optional(),
    seconds: z.number().min(0).optional(),
    estimate: z.string().max(100).optional(),
  })).min(1).max(40).optional(),
  /**
   * Phase 15: the batch's total, an estimate of the calls (no price is known): variants, items, the calls per provider (for
   * an intro that names every provider of a mixed batch), and the summed size and estimate when known.
   */
  total: z.object({
    variants: z.number().int().min(1).max(5),
    calls: z.number().int().min(1).max(40),
    providers: z.array(z.object({ provider: z.enum(PROVIDER_IDS), calls: z.number().int().min(1).max(40) })).min(1).max(4).optional(),
    chars: z.number().int().min(0).optional(),
    seconds: z.number().min(0).optional(),
    estimate: z.string().max(100).optional(),
  }).optional(),
});
export type PaidBatch = z.infer<typeof paidBatchSchema>;
