import type { ProviderId } from './permissions.ts';

export const SERVICE_KINDS = ['images', 'voice', 'music', 'sfx'] as const;
export type ServiceKind = typeof SERVICE_KINDS[number];
export const SERVICE_CHOICES = {
  images: ['auto', 'openai', 'stock', 'none'],
  voice: ['auto', 'openai', 'elevenlabs', 'none'],
  music: ['auto', 'elevenlabs', 'none'],
  sfx: ['auto', 'elevenlabs', 'none'],
} as const;
export type BriefServices = {
  images?: 'auto' | 'openai' | 'stock' | 'none';
  voice?: 'auto' | 'openai' | 'elevenlabs' | 'none';
  music?: 'auto' | 'elevenlabs' | 'none';
  sfx?: 'auto' | 'elevenlabs' | 'none';
};

/** The service choices of a brief with absent kinds filled in as `auto`. */
export function effectiveServices(brief: { services?: BriefServices }): Required<BriefServices> {
  const s = brief.services ?? {};
  return { images: s.images ?? 'auto', voice: s.voice ?? 'auto', music: s.music ?? 'auto', sfx: s.sfx ?? 'auto' };
}

export type KeyCapability = 'key' | 'images' | 'tts' | 'voices' | 'account' | 'sfx' | 'music' | 'search';
export type KeyCheckStatus = 'ok' | 'missing' | 'unverified' | 'error';
export type KeyCheckResult = {
  provider: ProviderId;
  checkedAt: string;
  capabilities: { capability: KeyCapability; status: KeyCheckStatus; permission?: string; detail?: string }[];
};

export const BRAND_PHASES = ['queued', 'reading', 'fonts', 'colors', 'logos', 'tone', 'writing', 'done'] as const;
export type BrandPhase = typeof BRAND_PHASES[number];
