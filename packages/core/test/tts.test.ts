import { describe, expect, it } from 'vitest';
import { elevenlabsSpeech, openaiSpeech } from '../src/providers/tts.ts';

const recorder = (responses: Response[]) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return responses.shift()!; }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};
const audio = () => new Response(new Uint8Array([7, 7]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });

describe('openaiSpeech', () => {
  it('posts the request and returns audio', async () => {
    const { calls, fetchImpl } = recorder([audio()]);
    const r = await openaiSpeech({ fetch: fetchImpl, apiKey: 'sk' }, { text: 'Ciao', instructions: 'Tono energico', format: 'mp3' });
    expect([...r.bytes]).toEqual([7, 7]);
    expect(r.voice).toBe('marin');
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/audio/speech');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ model: 'gpt-4o-mini-tts', input: 'Ciao', voice: 'marin', instructions: 'Tono energico', response_format: 'mp3' });
  });
  it('rejects text over 4096 characters', async () => {
    const { fetchImpl } = recorder([]);
    expect((await openaiSpeech({ fetch: fetchImpl, apiKey: 'sk' }, { text: 'x'.repeat(4097), format: 'mp3' }).catch((e) => e)).status).toBe(400);
  });
});

describe('elevenlabsSpeech', () => {
  it('picks the first voice when none is given', async () => {
    const voices = new Response(JSON.stringify({ voices: [{ voice_id: 'v1', name: 'Bella' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    const { calls, fetchImpl } = recorder([voices, audio()]);
    const r = await elevenlabsSpeech({ fetch: fetchImpl, apiKey: 'xi' }, { text: 'Ciao', format: 'wav' });
    expect(r.voice).toBe('v1');
    expect(calls[1]!.url).toBe('https://api.elevenlabs.io/v1/text-to-speech/v1?output_format=wav_44100');
    expect((calls[1]!.init.headers as Record<string, string>)['xi-api-key']).toBe('xi');
  });
});
