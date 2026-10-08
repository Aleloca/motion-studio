import { ProviderError, requestJson, type HttpDeps } from './http.ts';

const MIN_PIXELS = 655_360, MAX_PIXELS = 8_294_400, MAX_EDGE = 3840;
const r16 = (v: number) => Math.max(16, Math.round(v / 16) * 16);

export function normalizeImageSize(width: number, height: number): { width: number; height: number } {
  if (!(width > 0 && height > 0)) throw new ProviderError(400, 'Dimensioni immagine non valide');
  const ratio = Math.min(3, Math.max(1 / 3, width / height));
  const pixels = Math.min(MAX_PIXELS, Math.max(MIN_PIXELS, width * height));
  let w = Math.sqrt(pixels * ratio);
  let h = w / ratio;
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  w *= scale; h *= scale;
  return { width: r16(w), height: r16(h) };
}

export interface ImageRequest {
  prompt: string; width: number; height: number;
  quality?: 'low' | 'medium' | 'high' | 'auto'; background?: 'transparent' | 'opaque' | 'auto';
  references?: Array<{ name: string; bytes: Buffer }>;
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

export async function generateImage(deps: HttpDeps & { apiKey: string }, req: ImageRequest) {
  const { width, height } = normalizeImageSize(req.width, req.height);
  const common = { model: 'gpt-image-2', prompt: req.prompt.slice(0, 32_000), size: `${width}x${height}`, quality: req.quality ?? 'auto', background: req.background ?? 'auto', output_format: 'png' };
  const auth = { authorization: `Bearer ${deps.apiKey}` };
  type Out = { data?: Array<{ b64_json?: string; revised_prompt?: string }> };
  let out: Out;
  if (!req.references?.length) {
    out = await requestJson<Out>(deps, 'https://api.openai.com/v1/images/generations', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ ...common, n: 1 }) }, { provider: 'OpenAI', secrets: [deps.apiKey] });
  } else {
    const form = new FormData();
    for (const [k, v] of Object.entries(common)) form.append(k, String(v));
    for (const r of req.references.slice(0, 16)) {
      const type = MIME[r.name.split('.').pop()?.toLowerCase() ?? ''] ?? 'image/png';
      form.append('image[]', new Blob([new Uint8Array(r.bytes)], { type }), r.name);
    }
    out = await requestJson<Out>(deps, 'https://api.openai.com/v1/images/edits', { method: 'POST', headers: auth, body: form }, { provider: 'OpenAI', secrets: [deps.apiKey] });
  }
  const b64 = out.data?.[0]?.b64_json;
  if (!b64) throw new ProviderError(502, 'Risposta non valida da OpenAI');
  return { bytes: Buffer.from(b64, 'base64'), width, height, revisedPrompt: out.data?.[0]?.revised_prompt ?? null };
}
