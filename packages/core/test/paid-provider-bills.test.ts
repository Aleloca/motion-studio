import { describe, expect, it } from 'vitest';
import { elevenlabsMusic, elevenlabsSoundEffect } from '../src/providers/elevenlabs-audio.ts';
import { generateImage } from '../src/providers/openai-images.ts';
import { elevenlabsSpeech, openaiSpeech } from '../src/providers/tts.ts';

/** Report 66: each paid provider call returns what it measured (its `bill`), from the answer when the provider says it. */
const fetchOf = (res: () => Response) => (async () => res()) as unknown as typeof fetch;
const audio = (headers: Record<string, string> = {}) => () => new Response(new Uint8Array([1, 2]), { status: 200, headers: { 'content-type': 'audio/mpeg', ...headers } });
const image = (extra: Record<string, unknown>) => () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('png').toString('base64') }], ...extra }), { status: 200, headers: { 'content-type': 'application/json' } });

describe('paid provider bills', () => {
  it('images: the tokens of `usage` when the answer has it', async () => {
    const r = await generateImage({ fetch: fetchOf(image({ usage: { input_tokens: 50, output_tokens: 1000, total_tokens: 1050, input_tokens_details: { text_tokens: 50, image_tokens: 0 } } })), apiKey: 'sk' }, { prompt: 'p', width: 1024, height: 1024, quality: 'low' });
    expect(r.bill).toMatchObject({ provider: 'openai', service: 'images', units: { amount: 1050, unit: 'tokens' } });
    expect(r.bill.costUsd).toBeCloseTo((50 * 5 + 1000 * 30) / 1e6, 9);
  });
  it('images: a price per picture by quality without `usage`', async () => {
    const r = await generateImage({ fetch: fetchOf(image({})), apiKey: 'sk' }, { prompt: 'p', width: 1024, height: 1024, quality: 'low' });
    expect(r.bill).toMatchObject({ units: { amount: 1, unit: 'images' }, costUsd: 0.006 });
  });
  it('OpenAI voice: the characters of the input', async () => {
    const r = await openaiSpeech({ fetch: fetchOf(audio()), apiKey: 'sk' }, { text: 'Ciao mondo', format: 'mp3' });
    expect(r.bill).toMatchObject({ provider: 'openai', service: 'voice', model: 'gpt-4o-mini-tts', units: { amount: 10, unit: 'characters' } });
  });
  it('ElevenLabs voice: the `character-cost` header when present, else the text length', async () => {
    const withHeader = await elevenlabsSpeech({ fetch: fetchOf(audio({ 'character-cost': '7' })), apiKey: 'xi' }, { text: 'Ciao mondo', voice: 'v1', format: 'mp3' });
    expect(withHeader.bill).toMatchObject({ provider: 'elevenlabs', service: 'voice', units: { amount: 7, unit: 'characters' } });
    const without = await elevenlabsSpeech({ fetch: fetchOf(audio()), apiKey: 'xi' }, { text: 'Ciao mondo', voice: 'v1', format: 'mp3' });
    expect(without.bill.units).toEqual({ amount: 10, unit: 'characters' });
    const bad = await elevenlabsSpeech({ fetch: fetchOf(audio({ 'character-cost': 'n/a' })), apiKey: 'xi' }, { text: 'Ciao', voice: 'v1', format: 'mp3' });
    expect(bad.bill.units.amount).toBe(4);
  });
  it('music: the seconds asked; sound effects: the seconds asked or the default', async () => {
    expect((await elevenlabsMusic({ fetch: fetchOf(audio()), apiKey: 'xi' }, { prompt: 'p', durationSec: 45 })).bill).toMatchObject({ service: 'music', units: { amount: 45, unit: 'seconds' } });
    expect((await elevenlabsSoundEffect({ fetch: fetchOf(audio()), apiKey: 'xi' }, { prompt: 'p', durationSec: 2 })).bill).toMatchObject({ service: 'sfx', units: { amount: 2, unit: 'seconds' } });
    expect((await elevenlabsSoundEffect({ fetch: fetchOf(audio()), apiKey: 'xi' }, { prompt: 'p' })).bill.units).toEqual({ amount: 5, unit: 'seconds', estimated: true });
  });
});
