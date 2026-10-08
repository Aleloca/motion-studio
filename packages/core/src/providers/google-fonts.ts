import { ProviderError, requestBytes, type HttpDeps } from './http.ts';
import { safeDownload } from './safe-url.ts';

export interface FontFile { weight: number; italic: boolean; url: string }

export function parseFontCss(css: string): FontFile[] {
  const out: FontFile[] = [];
  for (const block of css.match(/@font-face\s*{[^}]*}/g) ?? []) {
    const weight = Number(block.match(/font-weight:\s*(\d+)/)?.[1] ?? 400);
    const italic = /font-style:\s*italic/.test(block);
    const url = block.match(/url\(([^)]+)\)/)?.[1]?.replace(/['"]/g, '');
    if (url?.startsWith('https://fonts.gstatic.com/')) out.push({ weight, italic, url });
  }
  return out;
}

export async function fetchGoogleFont(deps: HttpDeps, q: { family: string; weights: number[]; italic: boolean }) {
  const family = q.family.trim();
  if (!/^[A-Za-z0-9 ]{1,60}$/.test(family)) throw new ProviderError(400, 'Nome del font non valido');
  const weights = [...new Set(q.weights.length ? q.weights : [400, 700])].filter((w) => Number.isInteger(w) && w >= 100 && w <= 900 && w % 100 === 0).slice(0, 9).sort((a, b) => a - b);
  if (!weights.length) throw new ProviderError(400, 'Pesi del font non validi');
  const axis = q.italic ? `ital,wght@${[0, 1].flatMap((i) => weights.map((w) => `${i},${w}`)).join(';')}` : `wght@${weights.join(';')}`;
  const url = `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, '+')}:${axis}`;
  let css: string;
  try {
    const { bytes } = await requestBytes(deps, url, { headers: { 'user-agent': 'curl/8' } }, { provider: 'Google Fonts', secrets: [], maxBytes: 1024 * 1024 });
    css = bytes.toString('utf8');
  } catch (e) {
    if (e instanceof ProviderError && e.status === 502) throw new ProviderError(404, `Font "${family}" non trovato su Google Fonts`);
    throw e;
  }
  const files = parseFontCss(css);
  if (!files.length) throw new ProviderError(404, `Font "${family}" non trovato su Google Fonts`);
  const out: Array<{ weight: number; italic: boolean; bytes: Buffer; ext: string }> = [];
  for (const f of files) {
    const { bytes } = await safeDownload(deps, f.url, {}, { provider: 'Google Fonts', secrets: [], maxBytes: 10 * 1024 * 1024 });
    out.push({ weight: f.weight, italic: f.italic, bytes, ext: f.url.endsWith('.woff2') ? 'woff2' : 'ttf' });
  }
  return out;
}
