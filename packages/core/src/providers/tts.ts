import { ProviderError, requestBytes, requestJson, type HttpDeps } from './http.ts';

export interface TtsRequest { text: string; voice?: string; instructions?: string; format: 'mp3' | 'wav' }
const MAX = 50 * 1024 * 1024;

export async function openaiSpeech(deps: HttpDeps & { apiKey: string }, req: TtsRequest) {
  if (req.text.length > 4096) throw new ProviderError(400, 'Testo troppo lungo per OpenAI (massimo 4096 caratteri)');
  const voice = req.voice ?? 'marin';
  const body = { model: 'gpt-4o-mini-tts', input: req.text, voice, ...(req.instructions ? { instructions: req.instructions } : {}), response_format: req.format };
  const { bytes } = await requestBytes(deps, 'https://api.openai.com/v1/audio/speech', {
    method: 'POST', headers: { authorization: `Bearer ${deps.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }, { provider: 'OpenAI', secrets: [deps.apiKey], maxBytes: MAX });
  return { bytes, voice };
}

export async function elevenlabsSpeech(deps: HttpDeps & { apiKey: string }, req: TtsRequest) {
  if (req.text.length > 5000) throw new ProviderError(400, 'Testo troppo lungo per ElevenLabs (massimo 5000 caratteri)');
  const headers = { 'xi-api-key': deps.apiKey };
  let voice = req.voice;
  if (!voice) {
    const list = await requestJson<{ voices?: Array<{ voice_id: string }> }>(deps, 'https://api.elevenlabs.io/v2/voices?page_size=10', { headers }, { provider: 'ElevenLabs', secrets: [deps.apiKey] });
    voice = list.voices?.[0]?.voice_id;
    if (!voice) throw new ProviderError(502, 'Nessuna voce disponibile su ElevenLabs');
  }
  const format = req.format === 'wav' ? 'wav_44100' : 'mp3_44100_128';
  const { bytes } = await requestBytes(deps, `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=${format}`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ text: req.text, model_id: 'eleven_multilingual_v2' }),
  }, { provider: 'ElevenLabs', secrets: [deps.apiKey], maxBytes: MAX });
  return { bytes, voice };
}
