import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LibraryStore } from '../library/library-store.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { saveGeneratedFile } from './files.ts';
import { ProviderError, type HttpDeps } from './http.ts';
import { downloadBytes, safeDownload } from './safe-url.ts';
import { t } from '../i18n.ts';

export const validFamily = (f: string): boolean => /^[A-Za-z0-9 ]{1,60}$/.test(f);

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

export async function fetchGoogleFont(deps: HttpDeps, q: { family: string; weights: number[]; italic: boolean; signal?: AbortSignal }) {
  const signalInit: RequestInit = q.signal ? { signal: q.signal } : {};
  const family = q.family.trim();
  if (!validFamily(family)) throw new ProviderError(400, t().providers.invalidFontName);
  const weights = [...new Set(q.weights.length ? q.weights : [400, 700])].filter((w) => Number.isInteger(w) && w >= 100 && w <= 900 && w % 100 === 0).slice(0, 9).sort((a, b) => a - b);
  if (!weights.length) throw new ProviderError(400, t().providers.invalidFontWeights);
  const axis = q.italic ? `ital,wght@${[0, 1].flatMap((i) => weights.map((w) => `${i},${w}`)).join(';')}` : `wght@${weights.join(';')}`;
  const url = `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, '+')}:${axis}`;
  let css: string;
  try {
    const { bytes } = await downloadBytes(deps, url, { headers: { 'user-agent': 'curl/8' }, ...signalInit }, { provider: 'Google Fonts', secrets: [], maxBytes: 1024 * 1024 });
    css = bytes.toString('utf8');
  } catch (e) {
    if (e instanceof ProviderError && e.upstreamStatus === 400) throw new ProviderError(404, t().providers.fontNotFound({ family }));
    throw e;
  }
  const seen = new Set<string>();
  const files = parseFontCss(css).filter((f) => { const k = `${f.weight}/${f.italic}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, weights.length * (q.italic ? 2 : 1));
  if (!files.length) throw new ProviderError(404, t().providers.fontNotFound({ family }));
  const out: Array<{ weight: number; italic: boolean; bytes: Buffer; ext: string }> = [];
  for (const f of files) {
    const { bytes } = await safeDownload(deps, f.url, signalInit, { provider: 'Google Fonts', secrets: [], maxBytes: 10 * 1024 * 1024 });
    out.push({ weight: f.weight, italic: f.italic, bytes, ext: f.url.endsWith('.woff2') ? 'woff2' : f.url.endsWith('.otf') ? 'otf' : 'ttf' });
  }
  return out;
}

export type GoogleFontFile = Awaited<ReturnType<typeof fetchGoogleFont>>[number];

/** Seams of the install (tests inject a failure on one file). */
export interface InstallIo { save?: typeof saveGeneratedFile }

const fileName = (family: string, f: GoogleFontFile) => `${family.replace(/ /g, '')}-${f.weight}${f.italic ? '-italic' : ''}.${f.ext}`;

/**
 * The whole set or nothing: every file is written to a temp folder first, then moved into assets/fonts one by one;
 * a failure on any of them removes the ones already moved. Returns the paths relative to assets/ (`fonts/<name>`).
 */
export async function saveGoogleFontFiles(projectDir: string, family: string, fonts: GoogleFontFile[], io: InstallIo = {}): Promise<string[]> {
  const save = io.save ?? saveGeneratedFile;
  const stage = await mkdtemp(join(tmpdir(), 'ms-gfont-'));
  const moved: string[] = [];
  try {
    const staged: string[] = [];
    for (const [i, f] of fonts.entries()) {
      const path = join(stage, `${i}.bin`);
      await writeFile(path, f.bytes);
      staged.push(path);
    }
    for (const [i, f] of fonts.entries()) moved.push(await save(projectDir, 'fonts', fileName(family, f), await readFile(staged[i]!)));
    return moved;
  } catch (e) {
    await removeQuietly(projectDir, moved);
    throw e;
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}

/** Rollback of saved files: a failure is logged (the leftover is then known) and never hides the original error. */
export async function removeQuietly(projectDir: string, files: string[]): Promise<void> {
  await Promise.all(files.map((m) => rm(join(projectDir, 'assets', ...m.split('/')), { force: true }).catch((err: unknown) => {
    console.warn(`Google Fonts rollback: could not remove assets/${m}: ${(err as Error).message}`);
  })));
}

export const fontAttribution = (): string => t().providers.fontsAttribution;

/**
 * Downloads a family (the one path of the brand picker and of the agent's fonts_fetch), saves all its files and registers
 * them in the library with origin `google-fonts` and the bytes. Nothing stays behind when any step fails.
 */
export async function installGoogleFont(o: {
  http: HttpDeps; projectDir: string; media: MediaTools; family: string; weights: number[]; italic: boolean; io?: InstallIo; alive?: () => void; signal?: AbortSignal;
}): Promise<{ files: string[]; fonts: GoogleFontFile[] }> {
  const fonts = await fetchGoogleFont(o.http, { family: o.family, weights: o.weights, italic: o.italic, ...(o.signal ? { signal: o.signal } : {}) });
  o.alive?.();
  const family = o.family.trim();
  const files = await saveGoogleFontFiles(o.projectDir, family, fonts, o.io);
  try {
    o.alive?.();
    await new LibraryStore(o.projectDir, o.media).registerAssets(files.map((file, i) => ({
      file, origin: 'google-fonts', sourceUrl: `https://fonts.google.com/specimen/${family.replace(/ /g, '+')}`,
      description: `Font ${family}`, tags: ['font', family], attribution: fontAttribution(), bytes: fonts[i]!.bytes.length,
    })));
  } catch (e) {
    await removeQuietly(o.projectDir, files);
    throw e;
  }
  return { files, fonts };
}
