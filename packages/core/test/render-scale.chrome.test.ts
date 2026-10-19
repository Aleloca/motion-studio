// @vitest-environment node
/**
 * Report 51 (decisions 1340, 1345–1347): an html layer is rasterised at the render's scale, in real Chrome. The layers are
 * sandboxed iframes, out of process (OOPIF): `Emulation.setDeviceMetricsOverride` reaches the top-level page only, so at
 * scale 2 the layer drew at devicePixelRatio 1 and the page stretched it (every html layer of an export at another
 * resolution, since decision 974). The browser of a scaled render is now launched with `--force-device-scale-factor`.
 * The capture at scale 2 is compared with its ground truth: the same layer laid out twice as large (CSS zoom) in a
 * composition twice as large, at scale 1 (squared gradient energy of the text block), and the layer reads its own
 * devicePixelRatio (a bar `20 × devicePixelRatio` CSS pixels wide). Report 38's camera rig is checked at scale 2 too.
 * Below 1 (a 720p export of a 1080p composition) nothing changes (decision 1346): the layer draws at 1x, the page shrinks it.
 * Skipped without Chrome or ffmpeg, unless MS_REQUIRE_CHROME=1. `MS_CFT_EXE` (a chrome-headless-shell) runs the scale-2
 * case with it too (decision 1340).
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Composition } from '@motion-studio/shared';
import { ChromeProvider } from '../src/render/chromium-provider.ts';
import { startCompositionServer, type CompositionServer } from '../src/compositions/composition-server.ts';
import { buildRuntime, FONT, put, renderTools } from './helpers/render-env.ts';
import { barDpr, gradientEnergy, SCALE_W, scaleComposition, scaleLayer, TEXT_BOX } from './helpers/scale-layers.ts';

const tools = await renderTools('render scale tests');
const VERSION_DIR = 'outputs/v1';

describe.skipIf(!tools.ok)('renderer: an html layer is rasterised at the render scale (report 51)', { timeout: 300_000 }, () => {
  let work: string;
  let creative: string;
  let server: CompositionServer;
  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'ms-test-render-scale-'));
    const dist = join(work, 'dist');
    await buildRuntime(dist);
    creative = join(work, 'creative');
    for (const [id, html] of Object.entries({ text: scaleLayer(), truth: scaleLayer(2), rig: scaleLayer(1, true), 'rig-truth': scaleLayer(2, true) })) {
      const dir = join(creative, VERSION_DIR, 'compositions', id);
      mkdirSync(join(dir, 'assets'), { recursive: true });
      copyFileSync(FONT, join(dir, 'assets', 'Mono.woff2'));
      put(join(dir, 'layers', `${id}.html`), html);
    }
    server = await startCompositionServer({ uiOrigins: [], distDir: dist });
  }, 600_000);
  afterAll(async () => {
    await server?.close();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  /** One PNG of composition `id` (`zoom` times the base size) at time `t`, rasterised at `dsf` (none: the page's default). */
  const capture = async (id: string, zoom: number, dsf: number | undefined, t = 0, browser: { exe: string; kind: 'system' | 'cft' } = { exe: tools.chrome!.exe, kind: 'system' }): Promise<{ px: Uint8Array; width: number }> => {
    const composition: Composition = scaleComposition(id, zoom);
    const session = await server.mintSession({ creativeDir: creative, versionDir: VERSION_DIR, format: id, composition, mode: 'render' });
    const provider = new ChromeProvider({ ...browser, limits: { timeLimitMs: 5 * 60_000 } });
    try {
      const page = await provider.open({ width: composition.width, height: composition.height, url: session.url, signal: new AbortController().signal, ...(dsf !== undefined ? { deviceScaleFactor: dsf } : {}) });
      expect(page.info.errors).toEqual([]);
      await page.seek(t);
      const file = join(work, `${id}-${dsf ?? 'x'}-${t}.png`);
      writeFileSync(file, await page.capture('png'));
      const px = new Uint8Array(execFileSync(tools.ffmpeg!.path, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 26 }));
      const width = Math.round(composition.width * (dsf ?? 1));
      expect(px.length).toBe(width * Math.round(composition.height * (dsf ?? 1)));
      return { px, width };
    } finally {
      await provider.close();
    }
  };

  it('at scale 2 the layer sees devicePixelRatio 2 and its text is as sharp as the ground truth', async () => {
    const scaled = await capture('text', 1, 2);
    const truth = await capture('truth', 2, undefined);
    const e = { scaled: gradientEnergy(scaled.px, scaled.width, TEXT_BOX, 2), truth: gradientEnergy(truth.px, truth.width, TEXT_BOX, 2) };
    console.info(`[scale] chrome text energy at scale 2: ${e.scaled.toFixed(1)}, ground truth ${e.truth.toFixed(1)}, ratio ${(e.scaled / e.truth).toFixed(3)}`);
    expect(e.truth).toBeGreaterThan(100);
    expect(barDpr(scaled.px, scaled.width, 2)).toBe(2);
    expect(e.scaled / e.truth).toBeGreaterThan(0.9);
    // The user's case: 1920 × 1080 exported at 2560 × 1440.
    const third = await capture('text', 1, 4 / 3);
    expect(barDpr(third.px, third.width, 4 / 3)).toBeCloseTo(4 / 3, 1);
  });

  it('at scale 1 (stills, previews, a render at the composition size) nothing changes: devicePixelRatio 1', async () => {
    for (const dsf of [undefined, 1]) {
      const plain = await capture('text', 1, dsf);
      expect(plain.width).toBe(SCALE_W);
      expect(barDpr(plain.px, plain.width, 1), String(dsf)).toBe(1);
    }
  });

  it('below 1 (a 720p export of a 1080p composition) nothing changes: the layer draws at 1x, the capture is the scaled size', async () => {
    const half = await capture('text', 1, 0.5);
    expect(half.width).toBe(160);
    expect(barDpr(half.px, half.width, 0.5)).toBe(1);
  });

  it.skipIf(!process.env.MS_CFT_EXE)('chrome-headless-shell (kind cft): the same at scale 2', async () => {
    const browser = { exe: process.env.MS_CFT_EXE!, kind: 'cft' as const };
    const scaled = await capture('text', 1, 2, 0, browser);
    const truth = await capture('truth', 2, undefined, 0, browser);
    const ratio = gradientEnergy(scaled.px, scaled.width, TEXT_BOX, 2) / gradientEnergy(truth.px, truth.width, TEXT_BOX, 2);
    console.info(`[scale] chrome-headless-shell text energy ratio at scale 2: ${ratio.toFixed(3)}`);
    expect(barDpr(scaled.px, scaled.width, 2)).toBe(2);
    expect(ratio).toBeGreaterThan(0.9);
  });

  it("report 38's camera rig (will-change, scaled by the layer) stays sharp at scale 2", async () => {
    const scaled = await capture('rig', 1, 2, 1);
    const truth = await capture('rig-truth', 2, undefined, 1);
    const e = { scaled: gradientEnergy(scaled.px, scaled.width, TEXT_BOX, 2), truth: gradientEnergy(truth.px, truth.width, TEXT_BOX, 2) };
    console.info(`[scale] chrome rig energy at scale 2, t = 1: ${e.scaled.toFixed(1)}, ground truth ${e.truth.toFixed(1)}, ratio ${(e.scaled / e.truth).toFixed(3)}`);
    expect(e.scaled / e.truth).toBeGreaterThan(0.9);
  });
});
