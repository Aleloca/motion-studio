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

/** The capabilities a key check reports for each provider, in display order. */
export const KEY_CAPABILITIES: Record<ProviderId, readonly KeyCapability[]> = {
  openai: ['key', 'images', 'tts'],
  elevenlabs: ['key', 'account', 'voices', 'tts', 'sfx', 'music'],
  pexels: ['key', 'search'],
  unsplash: ['key', 'search'],
};

/**
 * The provider permission each capability needs (docs/providers.md has the same table). ElevenLabs: the names of its API key
 * permissions. OpenAI: the scope of restricted keys (`model.request` = "Model capabilities: Write"). Pexels and Unsplash
 * keys have no permissions.
 */
export const KEY_PERMISSIONS: Record<ProviderId, Partial<Record<KeyCapability, string>>> = {
  openai: { images: 'model.request', tts: 'model.request' },
  elevenlabs: { account: 'user_read', voices: 'voices_read', tts: 'text_to_speech', sfx: 'sound_generation', music: 'music_generation' },
  pexels: {},
  unsplash: {},
};

export const BRAND_PHASES = ['queued', 'reading', 'fonts', 'colors', 'logos', 'tone', 'writing', 'done'] as const;
export type BrandPhase = typeof BRAND_PHASES[number];
