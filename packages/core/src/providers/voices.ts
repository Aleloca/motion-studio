import { ProviderError, type HttpDeps } from './http.ts';
import { safeDownload } from './safe-url.ts';
import { t } from '../i18n.ts';

/** The voices OpenAI documents for text to speech (`gpt-4o-mini-tts`); there is no endpoint that lists them. */
export const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'] as const;

/**
 * The provider a voice id belongs to: OpenAI's voices are a fixed, documented list; any other id is an ElevenLabs one (their
 * ids are opaque strings, never one of OpenAI's names).
 */
export const voiceProviderOf = (voice: string): 'openai' | 'elevenlabs' => ((OPENAI_VOICES as readonly string[]).includes(voice) ? 'openai' : 'elevenlabs');

/** A voice id as the providers write it; anything else never reaches a URL or the brand kit. */
export const VOICE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Largest preview the core fetches and serves. */
export const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

/** The one Google Cloud Storage bucket ElevenLabs previews come from (with the slash: `/eleven-public-prodx/` is not it). */
export const PREVIEW_BUCKET_PATH = '/eleven-public-prod/';

/**
 * Whether `raw` may be fetched as an ElevenLabs voice preview: https only, no credentials or port, and a host the
 * ElevenLabs API documents for previews: `*.elevenlabs.io`, or exactly their public bucket on Google Cloud Storage
 * (`storage.googleapis.com/eleven-public-prod/…`, the bucket of the `GET /v2/voices` example; any other bucket, even one
 * whose name starts the same, belongs to whoever created it). The bucket is checked on the parsed (normalised) path, and a
 * path with an encoded slash, backslash or dot is refused, so no encoding can step out of it. The URL comes from an API
 * response, so it is never trusted as it is; the same rule applies at every redirect hop.
 */
export function isElevenLabsPreviewUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  const host = u.hostname.toLowerCase();
  if (host === 'elevenlabs.io' || host.endsWith('.elevenlabs.io')) return true;
  if (host !== 'storage.googleapis.com') return false;
  const path = u.pathname;
  if (/%2f|%5c|%2e|\\/i.test(path)) return false;
  return path.startsWith(PREVIEW_BUCKET_PATH) && path.length > PREVIEW_BUCKET_PATH.length;
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
