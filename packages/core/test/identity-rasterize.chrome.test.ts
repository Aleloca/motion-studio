// @vitest-environment node
/**
 * Identity rasterisation in real Chrome through the core's own render path (Phase 14, spec §4.2, ruling AH): the
 * `ChromeProvider` (BASE_FLAGS, network lockdown, request interception), the composition server and the runtime. Plan Review
 * Focus 5: exact sizes, the `small` variant at 16 px, opaque files without alpha (ffprobe), white with a warning.
 * Skipped without Chrome or ffmpeg, unless MS_REQUIRE_CHROME=1 (CI).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IDENTITY_SETS } from '@motion-studio/shared';
import { ChromeProvider } from '../src/render/chromium-provider.ts';
import { readIco } from '../src/identity/ico.ts';
import { buildIdentitySet } from '../src/identity/identity-set.ts';
import { decodePng, pngSize } from '../src/identity/png.ts';
import { rasterizeSvg, SvgRefusedError } from '../src/identity/rasterize.ts';
import { buildRuntime, renderTools } from './helpers/render-env.ts';

const tools = await renderTools('identity rasterisation');
const work = mkdtempSync(join(tmpdir(), 'ms-test-identity-raster-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const NS = 'xmlns="http://www.w3.org/2000/svg"';

describe.skipIf(!tools.ok)('identity rasterisation (real Chrome)', { timeout: 300_000 }, () => {
  let dist: string;
  let launches = 0;
  const provider = async () => { launches++; return new ChromeProvider({ exe: tools.chrome!.exe, kind: 'system', limits: { timeLimitMs: 5 * 60_000 } }); };
  const raster = () => ({ provider, distDir: dist, tempDir: work });
  const pixFmt = (file: string) => execFileSync(join(tools.ffmpeg!.path, '..', 'ffprobe'), ['-v', 'error', '-show_entries', 'stream=pix_fmt', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim();
  /** Whether ffprobe reports an alpha component (a known format either way; anything else fails). */
  const hasAlpha = (file: string): boolean => {
    const f = pixFmt(file);
    if (['rgba', 'ya8', 'rgba64be', 'ya16be'].includes(f)) return true;
    if (['rgb24', 'gray', 'rgb48be', 'gray16be'].includes(f)) return false;
    throw new Error(`unexpected pix_fmt ${f} for ${file}`);
  };
  const write = (name: string, body: string, viewBox = '0 0 100 100') => {
    const p = join(work, name);
    writeFileSync(p, `<svg ${NS} viewBox="${viewBox}">${body}</svg>`);
    return p;
  };
  // A detailed master (thin stripes) and a simplified small variant (one disc): different at 16 px.
  let master: string;
  let small: string;
  beforeAll(async () => {
    dist = join(work, 'dist');
    await buildRuntime(dist);
    master = write('master.svg', Array.from({ length: 10 }, (_, k) => `<rect x="${k * 10}" y="0" width="3" height="100" fill="#e01010"/>`).join(''));
    small = write('small.svg', '<circle cx="50" cy="50" r="40" fill="#1030e0"/>');
  }, 600_000);

  it('rasterises at the exact sizes, with alpha where the SVG is transparent', async () => {
    const out = await rasterizeSvg(small, [512, 16], raster());
    for (const s of [512, 16]) expect(pngSize(out.get(s)!)).toMatchObject({ width: s, height: s });
    const img = decodePng(out.get(512)!);
    expect(img.alpha).toBe(true);
    expect(img.rgba[3]).toBe(0); // the corner is outside the disc: transparent
    const c = (256 * 512 + 256) * 4;
    expect([...img.rgba.subarray(c, c + 4)]).toEqual([0x10, 0x30, 0xe0, 255]);
  });

  it('an engine that does not keep transparency is caught by the probe: nothing is rasterised', async () => {
    // A provider that drops `transparentBackground` stands in for a render window with an opaque background.
    const opaque = async () => {
      const p = await provider();
      return { kind: p.kind, get failure() { return p.failure; }, close: () => p.close(), open: (o: Parameters<typeof p.open>[0]) => p.open({ ...o, transparentBackground: false }) };
    };
    await expect(rasterizeSvg(small, [64], { ...raster(), provider: opaque })).rejects.toThrow(/does not keep transparency/);
  });

  it('a refused SVG never reaches the browser', async () => {
    const before = launches;
    const bad = write('bad.svg', '<image href="https://example.com/a.png" width="10" height="10"/>');
    await expect(rasterizeSvg(bad, [16], raster())).rejects.toBeInstanceOf(SvgRefusedError);
    expect(launches).toBe(before);
  });

  it('favicon set: the 16 px ICO entry comes from the small variant and differs from the master; opaque files have no alpha', async () => {
    const outDir = join(work, 'favicon');
    const r = await buildIdentitySet('favicon', { master, small, outDir, name: 'Acme', background: '#00000000', raster: raster(), ffmpeg: tools.ffmpeg! });
    expect(r.files.map((f) => f.path)).toEqual(IDENTITY_SETS.favicon.files.map((f) => f.path));
    const ico = readIco(readFileSync(join(outDir, 'favicon.ico')));
    expect(ico.map((e) => [e.width, e.height])).toEqual([[16, 16], [32, 32], [48, 48]]);
    for (const e of ico) expect(decodePng(e.png).width).toBe(e.width);
    const fromMaster = (await rasterizeSvg(master, [16], raster())).get(16)!;
    const fromSmall = (await rasterizeSvg(small, [16], raster())).get(16)!;
    expect(Buffer.from(decodePng(fromMaster).rgba).equals(Buffer.from(decodePng(fromSmall).rgba))).toBe(false);
    expect(Buffer.from(decodePng(ico[0]!.png).rgba).equals(Buffer.from(decodePng(fromSmall).rgba))).toBe(true);
    expect(pngSize(readFileSync(join(outDir, 'icon-512.png')))).toMatchObject({ width: 512, height: 512 });
    expect(hasAlpha(join(outDir, 'apple-touch-icon.png'))).toBe(false);
    expect(hasAlpha(join(outDir, 'icon-512-maskable.png'))).toBe(false);
    expect(hasAlpha(join(outDir, 'icon-512.png'))).toBe(true);
    // Transparent composition, no brand: white, with the warning.
    // (x 12, y 0) of 180 px is 6.7 units of 100: between two stripes.
    const touch = decodePng(readFileSync(join(outDir, 'apple-touch-icon.png')));
    expect([...touch.rgba.subarray(12 * 4, 12 * 4 + 4)]).toEqual([255, 255, 255, 255]);
    expect(r.warnings.join()).toMatch(/white|bianco/);
  });

  it('app icon set: iOS 1024 and Play 512 without alpha, the foreground keeps it; the logo is 1024 on its long side', async () => {
    const outDir = join(work, 'app');
    const r = await buildIdentitySet('app-icon', { master: small, outDir, name: 'Acme', background: '#123456', raster: raster(), ffmpeg: tools.ffmpeg! });
    expect(r.files.map((f) => f.path)).toEqual(IDENTITY_SETS['app-icon'].files.map((f) => f.path));
    expect(hasAlpha(join(outDir, 'AppIcon-1024.png'))).toBe(false);
    expect(hasAlpha(join(outDir, 'ic_launcher-playstore.png'))).toBe(false);
    expect(hasAlpha(join(outDir, 'ic_launcher_foreground.png'))).toBe(true);
    expect(pngSize(readFileSync(join(outDir, 'AppIcon-1024.png')))).toMatchObject({ width: 1024, height: 1024 });
    expect(pngSize(readFileSync(join(outDir, 'mipmap-xxxhdpi/ic_launcher.png')))).toMatchObject({ width: 192, height: 192 });
    // The disc fills 80% of the master's frame; padded to 66/108 (decision 762) it sits inside the safe circle: no warning.
    expect(r.warnings).toEqual([]);
    const fg = decodePng(readFileSync(join(outDir, 'ic_launcher_foreground.png')));
    expect(fg.rgba[((216 - 120) * 432 + 216) * 4 + 3]).toBe(0); // 0.4 × 264 px = 106 px from the centre: outside the mark
    expect(fg.rgba[((216 - 90) * 432 + 216) * 4 + 3]).toBe(255);

    const logoDir = join(work, 'logo');
    const wide = write('wide.svg', '<ellipse cx="200" cy="50" rx="150" ry="40" fill="#000"/>', '0 0 400 100');
    const l = await buildIdentitySet('logo', { master: wide, outDir: logoDir, name: 'Acme', raster: raster(), ffmpeg: tools.ffmpeg! });
    expect(l.files.find((f) => f.path === 'logo.png')).toMatchObject({ width: 1024, height: 256, alpha: true });
    expect(pngSize(readFileSync(join(logoDir, 'logo.png')))).toMatchObject({ width: 1024, height: 256 });
  });
});
