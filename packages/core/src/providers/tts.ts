import { ProviderError, requestBytes, requestJson, type HttpDeps } from './http.ts';
import { t } from '../i18n.ts';

/** The OpenAI speech model Motion Studio uses (the key check reads it, read-only). */
export const OPENAI_TTS_MODEL = 'gpt-4o-mini-tts';
/** The ElevenLabs speech model Motion Studio uses. */
export const ELEVENLABS_TTS_MODEL = 'eleven_multilingual_v2';
export interface TtsRequest { text: string; voice?: string; instructions?: string; format: 'mp3' | 'wav' }
const MAX = 50 * 1024 * 1024;

const VOICE = /^[A-Za-z0-9_-]{1,64}$/;
/** The documented text limits, checked at the POST and in the provider calls (before anything is confirmed or sent). */
export const TTS_MAX_CHARS = { openai: 4096, elevenlabs: 5000 } as const;

export async function openaiSpeech(deps: HttpDeps & { apiKey: string }, req: TtsRequest) {
  if (req.text.length > TTS_MAX_CHARS.openai) throw new ProviderError(400, t().providers.textTooLong({ provider: 'OpenAI', max: TTS_MAX_CHARS.openai }));
  const voice = req.voice ?? 'marin';
  if (!VOICE.test(voice)) throw new ProviderError(400, t().providers.invalidVoice);
  const body = { model: OPENAI_TTS_MODEL, input: req.text, voice, ...(req.instructions ? { instructions: req.instructions } : {}), response_format: req.format };
  const { bytes } = await requestBytes(deps, 'https://api.openai.com/v1/audio/speech', {
    method: 'POST', headers: { authorization: `Bearer ${deps.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }, { provider: 'OpenAI', secrets: [deps.apiKey], maxBytes: MAX });
  return { bytes, voice };
}

/**
 * The voice ElevenLabs speech uses when none is given: the first of the account's list (`voices_read`). Callers that track key
 * capabilities resolve it on its own, so a refused list is blamed on the voices and not on `text_to_speech`.
 */
export async function elevenlabsDefaultVoice(deps: HttpDeps & { apiKey: string }): Promise<string> {
  const list = await requestJson<{ voices?: Array<{ voice_id: string }> }>(deps, 'https://api.elevenlabs.io/v2/voices?page_size=10', { headers: { 'xi-api-key': deps.apiKey } }, { provider: 'ElevenLabs', secrets: [deps.apiKey] });
  const voice = list.voices?.[0]?.voice_id;
  if (!voice) throw new ProviderError(502, t().providers.noVoice);
  return voice;
}

export async function elevenlabsSpeech(deps: HttpDeps & { apiKey: string }, req: TtsRequest) {
  if (req.text.length > TTS_MAX_CHARS.elevenlabs) throw new ProviderError(400, t().providers.textTooLong({ provider: 'ElevenLabs', max: TTS_MAX_CHARS.elevenlabs }));
  const headers = { 'xi-api-key': deps.apiKey };
  if (req.voice !== undefined && !VOICE.test(req.voice)) throw new ProviderError(400, t().providers.invalidVoice);
  const voice = req.voice || await elevenlabsDefaultVoice(deps);
  const format = req.format === 'wav' ? 'wav_44100' : 'mp3_44100_128';
  const { bytes } = await requestBytes(deps, `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=${format}`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ text: req.text, model_id: ELEVENLABS_TTS_MODEL }),
  }, { provider: 'ElevenLabs', secrets: [deps.apiKey], maxBytes: MAX });
  return { bytes, voice };
}
