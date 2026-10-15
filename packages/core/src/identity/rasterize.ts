import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMPOSITION_SCHEMA_ID, type Composition } from '@motion-studio/shared';
import { RUNTIME_DIST_DIR } from '@motion-studio/composition-runtime/dist';
import { startCompositionServer, type CompositionServer } from '../compositions/composition-server.ts';
import { readRegularFile } from '../safe-read.ts';
import { captureFrame } from '../render/capture.ts';
import { RenderError, type ChromiumProvider } from '../render/chromium-provider.ts';
import { makeOwnedTempDir } from '../render/owner.ts';
import { createRenderEngine } from '../render/renderer.ts';
import { checkVectorSvg, MAX_VECTOR_SVG_BYTES, svgAspect } from './svg-check.ts';
import { pngSize } from './png.ts';

/**
 * Rasterisation of an identity SVG (Phase 14, spec §4.2): every PNG is the SVG drawn by Chrome at its exact size, never a
 * big PNG scaled down. It goes through the render path itself (ruling AH): the core's `ChromiumProvider` (system Chrome or
 * Chrome for Testing through `ChromeProvider` with `BASE_FLAGS` and the network lockdown, or the injected desktop provider),
 * the composition server and the runtime, with the same request interception (isolation.ts). Nothing of the isolation is
 * changed here.
 *
 * - The file is read once (a regular file, at most 512 KB), checked with `checkVectorSvg`, and only those checked bytes are
 *   written to a fresh temp folder that the composition server serves: a refused SVG is never rasterised, and a file
 *   changed after the check is never what Chrome reads.
 * - Each size is a still composition of one full-frame `svg` clip (`fit: contain`). The runtime draws it with `<img>`, so
 *   the SVG is an image document: no script runs and it loads nothing, and the browser has no network anyway.
 * - The page background is transparent (`transparentBackground`), so the PNG keeps the SVG's alpha; `background` paints
 *   the stage instead (a composition colour).
 * - `shape: 'square'` (default): each size is `size`×`size`, the drawing centred. `'long-side'` (the logo, spec §4.1): the
 *   longer side is `size` and the other follows the SVG's `viewBox` (at least 16 px, the composition minimum).
 * - One browser and one composition server serve every size; both are closed at the end, with the temp folder.
 */

export interface RasterizeOptions {
  /** A composition colour (`#rrggbb[aa]`) painted behind the SVG; default fully transparent. */
  background?: string;
  shape?: 'square' | 'long-side';
  /** The browser (one per call, always closed); default the core's render engine (system Chrome, else Chrome for Testing). */
  provider?: () => Promise<ChromiumProvider>;
  /** The built runtime; default `RUNTIME_DIST_DIR`. */
  distDir?: string;
  /** Where the temp folder goes; default the OS temp folder. */
  tempDir?: string;
  signal?: AbortSignal;
  /** Wall-clock limit of the whole call, ms; default 2 min + 20 s a size. */
  timeLimitMs?: number;
}

/** A refused SVG: `reasons` from `checkVectorSvg`, for the repair turn. */
export class SvgRefusedError extends Error {
  constructor(readonly reasons: string[]) {
    super(`the SVG was refused: ${reasons.join('; ')}`);
  }
}

const COMPOSITION_MIN = 16;
const FORMAT_DIR = 'raster';
const SVG_NAME = 'assets/mark.svg';

/** The pixel size of `size` for an SVG of `aspect` (see `shape`). */
export function rasterDims(size: number, shape: 'square' | 'long-side', aspect: { width: number; height: number } | null): { width: number; height: number } {
  if (shape === 'square' || !aspect) return { width: size, height: size };
  const short = (s: number, l: number) => Math.max(COMPOSITION_MIN, Math.min(size, Math.round((size * s) / l)));
  return aspect.width >= aspect.height ? { width: size, height: short(aspect.height, aspect.width) } : { width: short(aspect.width, aspect.height), height: size };
}

function stillOf(width: number, height: number, background: string): Composition {
  return {
    $schema: COMPOSITION_SCHEMA_ID, width, height, fps: 30, duration: 0, background, fonts: [], scenes: [],
    tracks: [{ id: 'mark', kind: 'visual', clips: [{ id: 'mark', type: 'svg', src: SVG_NAME, start: 0, duration: 0, props: { x: 0, y: 0, width, height, fit: 'contain' } }] }],
  } as Composition;
}

/** Reads and checks the SVG at `svgPath`; throws `SvgRefusedError` (or a read error). */
export async function readCheckedSvg(svgPath: string): Promise<{ text: string; warnings: string[] }> {
  const r = await readRegularFile(svgPath, MAX_VECTOR_SVG_BYTES);
  if (r.kind === 'too-large') throw new SvgRefusedError([`the SVG is over ${MAX_VECTOR_SVG_BYTES / 1024} KB`]);
  if (r.kind !== 'file') throw new Error(`cannot read the SVG (${r.kind})`);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(r.data);
  } catch {
    throw new SvgRefusedError(['the SVG is not valid UTF-8']);
  }
  const check = checkVectorSvg(text);
  if (!check.ok) throw new SvgRefusedError(check.reasons);
  return { text, warnings: check.warnings };
}

/** The SVG at `svgPath` as PNGs, one per size (see the module comment). Throws `SvgRefusedError` for a refused SVG. */
export async function rasterizeSvg(svgPath: string, sizes: number[], opts: RasterizeOptions = {}): Promise<Map<number, Buffer>> {
  const { text } = await readCheckedSvg(svgPath);
  const out = new Map<number, Buffer>();
  const wanted = [...new Set(sizes)];
  if (wanted.length === 0) return out;
  for (const s of wanted) if (!Number.isInteger(s) || s < COMPOSITION_MIN || s > 4096) throw new RangeError(`rasterize: bad size ${s}`);
  const shape = opts.shape ?? 'square';
  const aspect = svgAspect(text);
  const background = opts.background ?? '#00000000';
  const distDir = opts.distDir ?? RUNTIME_DIST_DIR;
  const ctl = new AbortController();
  const onAbort = () => ctl.abort(new RenderError('cancelled', 'cancelled'));
  if (opts.signal?.aborted) onAbort(); else opts.signal?.addEventListener('abort', onAbort, { once: true });
  const deadline = setTimeout(() => ctl.abort(new RenderError('timeLimit', 'rasterising took too long')), opts.timeLimitMs ?? 120_000 + wanted.length * 20_000);
  const work = await makeOwnedTempDir(join(opts.tempDir ?? tmpdir(), 'ms-identity-raster-'));
  let server: CompositionServer | null = null;
  let provider: ChromiumProvider | null = null;
  const onStop = () => { void provider?.close().catch(() => {}); };
  ctl.signal.addEventListener('abort', onStop, { once: true });
  try {
    const compDir = join(work, 'outputs', 'v1', 'compositions', FORMAT_DIR);
    await mkdir(join(compDir, 'assets'), { recursive: true });
    // The checked bytes, never the file again.
    await writeFile(join(compDir, ...SVG_NAME.split('/')), text, { flag: 'wx', mode: 0o644 });
    server = await startCompositionServer({ uiOrigins: [], distDir });
    provider = await (opts.provider ?? (() => createRenderEngine().provider()))();
    if (ctl.signal.aborted) throw ctl.signal.reason;
    const clock = await readRegularFile(join(distDir, 'clock.js'), 1024 * 1024).then((r) => (r.kind === 'file' ? r.data.toString('utf8') : undefined), () => undefined);
    for (const size of wanted) {
      const { width, height } = rasterDims(size, shape, aspect);
      const composition = stillOf(width, height, background);
      const session = await server.mintSession({ creativeDir: work, versionDir: 'outputs/v1', format: FORMAT_DIR, composition, mode: 'render', ttlMs: 10 * 60_000 });
      try {
        const page = await provider.open({ width, height, url: session.url, signal: ctl.signal, purpose: 'render', transparentBackground: true, ...(clock ? { clockSource: clock } : {}) });
        try {
          const bad = [...page.info.errors, ...(await page.errors())].filter((e) => e.code !== 'textOverflow');
          if (bad.length) throw new RenderError('runtimeErrors', `the SVG could not be drawn: ${bad.map((e) => `${e.code} ${e.message}`).join('; ').slice(0, 300)}`, bad);
          const png = await captureFrame(page, 0, { format: 'png', width, height });
          const dims = pngSize(png);
          if (!dims || dims.width !== width || dims.height !== height) throw new RenderError('badFrame', `the ${size} px capture is not a ${width}×${height} PNG`);
          out.set(size, png);
        } finally {
          await page.close().catch(() => {});
        }
      } finally {
        session.revoke();
      }
    }
    return out;
  } catch (e) {
    const f = provider?.failure;
    if (f) throw new RenderError(f.code, f.message);
    if (opts.signal?.aborted) throw new RenderError('cancelled', 'cancelled');
    const r: unknown = ctl.signal.aborted ? ctl.signal.reason : null;
    if (r instanceof RenderError && r.code === 'timeLimit') throw r;
    throw e;
  } finally {
    clearTimeout(deadline);
    opts.signal?.removeEventListener('abort', onAbort);
    ctl.signal.removeEventListener('abort', onStop);
    await provider?.close().catch(() => {});
    await server?.close().catch(() => {});
    await rm(work, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}
