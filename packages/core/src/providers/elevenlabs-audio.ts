import { ProviderError, requestBytes, requestJson, type HttpDeps } from './http.ts';
import { t } from '../i18n.ts';
import { musicBill, sfxBill, type PaidBill } from '../usage/paid-usage.ts';

const BASE = 'https://api.elevenlabs.io';
const FORMAT = 'mp3_44100_128';
const MAX_BYTES = 50 * 1024 * 1024;
export const AUDIO_PROMPT_MAX = 1000;
export const SFX_SECONDS = { min: 0.5, max: 30 } as const;
export const MUSIC_SECONDS = { min: 10, max: 300 } as const;
export const SFX_MODEL = 'eleven_text_to_sound_v2';
export const MUSIC_MODEL = 'music_v1';
const PROVIDER = 'ElevenLabs';

type Deps = HttpDeps & { apiKey: string };
const bad = (msg: string) => new ProviderError(400, msg);

function checkPrompt(prompt: string): string {
  const p = typeof prompt === 'string' ? prompt.trim() : '';
  if (!p) throw bad(t().providers.promptRequired);
  if (p.length > AUDIO_PROMPT_MAX) throw bad(t().providers.promptTooLong({ max: AUDIO_PROMPT_MAX }));
  return p;
}
function checkRange(v: number, r: { min: number; max: number }): void {
  if (!Number.isFinite(v) || v < r.min || v > r.max) throw bad(t().providers.durationOutOfRange(r));
}
const post = (deps: Deps, path: string, body: unknown) => requestBytes(deps, `${BASE}${path}?output_format=${FORMAT}`, {
  method: 'POST', headers: { 'xi-api-key': deps.apiKey, 'content-type': 'application/json' }, body: JSON.stringify(body),
}, { provider: PROVIDER, secrets: [deps.apiKey], maxBytes: MAX_BYTES });

type SfxRequest = { prompt: string; durationSec?: number; loop?: boolean; promptInfluence?: number };
type MusicRequest = { prompt: string; durationSec: number; instrumental?: boolean };

/** Limit checks, run before anything is asked or sent. Returns the trimmed prompt. */
export function validateSoundEffect(req: SfxRequest): string {
  const text = checkPrompt(req.prompt);
  if (req.durationSec !== undefined) checkRange(req.durationSec, SFX_SECONDS);
  if (req.promptInfluence !== undefined) checkRange(req.promptInfluence, { min: 0, max: 1 });
  return text;
}
export function validateMusic(req: MusicRequest): string {
  const prompt = checkPrompt(req.prompt);
  checkRange(req.durationSec, MUSIC_SECONDS);
  return prompt;
}

export async function elevenlabsSoundEffect(deps: Deps, req: SfxRequest): Promise<{ bytes: Uint8Array; format: 'mp3'; bill: PaidBill }> {
  const text = validateSoundEffect(req);
  const body = {
    text,
    ...(req.durationSec !== undefined ? { duration_seconds: req.durationSec } : {}),
    ...(req.promptInfluence !== undefined ? { prompt_influence: req.promptInfluence } : {}),
    ...(req.loop !== undefined ? { loop: req.loop } : {}),
    model_id: SFX_MODEL,
  };
  const { bytes } = await post(deps, '/v1/sound-generation', body);
  return { bytes, format: 'mp3', bill: sfxBill(req.durationSec) };
}

export async function elevenlabsMusic(deps: Deps, req: MusicRequest): Promise<{ bytes: Uint8Array; format: 'mp3'; bill: PaidBill }> {
  const prompt = validateMusic(req);
  const body = { prompt, music_length_ms: Math.round(req.durationSec * 1000), ...(req.instrumental !== undefined ? { force_instrumental: req.instrumental } : {}), model_id: MUSIC_MODEL };
  const { bytes } = await post(deps, '/v1/music', body);
  return { bytes, format: 'mp3', bill: musicBill(req.durationSec) };
}

export async function elevenlabsVoices(deps: Deps, req: { search?: string; pageSize?: number }): Promise<{ id: string; name: string; labels: Record<string, string>; previewUrl: string | null }[]> {
  const size = Math.min(100, Math.max(1, Math.trunc(Number.isFinite(req.pageSize) ? req.pageSize! : 20)));
  const q = new URLSearchParams({ page_size: String(size) });
  const search = req.search?.trim().slice(0, 100);
  if (search) q.set('search', search);
  const json = await requestJson<{ voices?: Array<{ voice_id?: unknown; name?: unknown; labels?: unknown; preview_url?: unknown }> }>(
    deps, `${BASE}/v2/voices?${q}`, { headers: { 'xi-api-key': deps.apiKey } }, { provider: PROVIDER, secrets: [deps.apiKey] });
  const out: { id: string; name: string; labels: Record<string, string>; previewUrl: string | null }[] = [];
  for (const v of Array.isArray(json.voices) ? json.voices : []) {
    if (typeof v.voice_id !== 'string' || !v.voice_id) continue;
    const labels: Record<string, string> = {};
    if (v.labels && typeof v.labels === 'object') for (const [k, val] of Object.entries(v.labels)) if (typeof val === 'string') labels[k.slice(0, 40)] = val.slice(0, 100);
    out.push({ id: v.voice_id, name: typeof v.name === 'string' ? v.name.slice(0, 200) : v.voice_id, labels, previewUrl: typeof v.preview_url === 'string' ? v.preview_url : null });
  }
  return out;
}
