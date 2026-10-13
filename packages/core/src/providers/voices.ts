import { ProviderError, type HttpDeps } from './http.ts';
import { safeDownload } from './safe-url.ts';
import { t } from '../i18n.ts';

/** The voices OpenAI documents for text to speech (`gpt-4o-mini-tts`); there is no endpoint that lists them. */
export const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'] as const;

/** A voice id as the providers write it; anything else never reaches a URL or the brand kit. */
export const VOICE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Largest preview the core fetches and serves. */
export const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Whether `raw` may be fetched as an ElevenLabs voice preview: https only, no credentials or port, and a host the
 * ElevenLabs API documents for previews: `*.elevenlabs.io`, or their public bucket on Google Cloud Storage
 * (`storage.googleapis.com/eleven-public-…`). The URL comes from an API response, so it is never trusted as it is.
 */
export function isElevenLabsPreviewUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  const host = u.hostname.toLowerCase();
  if (host === 'elevenlabs.io' || host.endsWith('.elevenlabs.io')) return true;
  return host === 'storage.googleapis.com' && u.pathname.startsWith('/eleven-public-');
}

/** Downloads one validated preview (2 MB cap, every redirect hop checked against the same rule). */
export async function fetchVoicePreview(deps: HttpDeps, url: string, signal?: AbortSignal): Promise<{ bytes: Buffer; contentType: string }> {
  if (!isElevenLabsPreviewUrl(url)) throw new ProviderError(502, t().providers.invalidResponse({ provider: 'ElevenLabs' }));
  const out = await safeDownload(deps, url, signal ? { signal } : {}, {
    provider: 'ElevenLabs', secrets: [], maxBytes: PREVIEW_MAX_BYTES, allowHop: (next) => isElevenLabsPreviewUrl(next.href),
  });
  if (!out.contentType.toLowerCase().startsWith('audio/')) throw new ProviderError(502, t().providers.invalidResponse({ provider: 'ElevenLabs' }));
  return out;
}
