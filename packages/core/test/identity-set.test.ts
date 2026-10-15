// @vitest-environment node
/**
 * The identity file sets (Phase 14, spec §4.1–4.2) with a stand-in rasteriser (Chrome is covered by
 * identity-rasterize.chrome.test.ts): file lists, the ICO, the `small` variant rule, opaque files (ffprobe on the flattened
 * files, plan Review Focus 5), templates and warnings. The opaque cases need ffmpeg: skipped without it unless
 * MS_REQUIRE_CHROME=1.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EMPTY_BRAND_KIT, FAVICON_ICO_SIZES, IDENTITY_SETS, type BrandKit } from '@motion-studio/shared';
import { findFfmpeg } from '../src/render/encode.ts';
import { readIco } from '../src/identity/ico.ts';
import {
  androidAdaptiveXml, buildIdentitySet, headSnippet, iosContentsJson, opaqueBackground, sourceOf, webManifest,
} from '../src/identity/identity-set.ts';
import { decodePng, encodePng } from '../src/identity/png.ts';
import { rasterDims, SvgRefusedError } from '../src/identity/rasterize.ts';

const work = mkdtempSync(join(tmpdir(), 'ms-test-identity-set-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const ff = await findFfmpeg();
if (!ff && process.env.MS_REQUIRE_CHROME === '1') it('identity sets: ffmpeg is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('missing ffmpeg'); });
const ffprobe = ff ? join(ff.path, '..', 'ffprobe') : '';
const pixFmt = (file: string) => execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=pix_fmt', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim();
/** Whether ffprobe reports an alpha component: a known pixel format with or without one, anything else fails the test. */
const hasAlpha = (file: string): boolean => {
  const f = pixFmt(file);
  if (['rgba', 'ya8', 'rgba64be', 'ya16be'].includes(f)) return true;
  if (['rgb24', 'gray', 'rgb48be', 'gray16be'].includes(f)) return false;
  throw new Error(`unexpected pix_fmt ${f} for ${file}`);
};

const NS = 'xmlns="http://www.w3.org/2000/svg"';
let seq = 0;
function svgFile(body = '<circle cx="50" cy="50" r="20"/>'): string {
  const p = join(work, `in-${seq++}.svg`);
  writeFileSync(p, `<svg ${NS} viewBox="0 0 100 100">${body}</svg>`);
  return p;
}
/**
 * A stand-in rasteriser: a transparent PNG with a centred disc (red for files named *master*, blue for *small*) whose
 * diameter is `disc` of the drawing's frame; a job's `scale` shrinks the frame, as Chrome does.
 */
function fakeRasterize(calls: Array<{ path: string; jobs: Array<{ size: number; scale?: number }> }>, disc = 0.4) {
  return async (path: string, jobs: Array<{ size: number; scale?: number }>) => {
    calls.push({ path, jobs: [...jobs].sort((a, b) => a.size - b.size || (a.scale ?? 1) - (b.scale ?? 1)) });
    const colour = path.includes('small') ? [0, 0, 255] : [255, 0, 0];
    return jobs.map(({ size: s, scale = 1 }) => {
      const px = new Uint8Array(s * s * 4);
      const r = (s * scale * disc) / 2;
      for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
        const dx = x + 0.5 - s / 2, dy = y + 0.5 - s / 2;
        if (dx * dx + dy * dy <= r * r) px.set([...colour, 255], (y * s + x) * 4);
      }
      return encodePng(s, s, px, 4);
    });
  };
}
const brand = (hex?: string): BrandKit => ({ ...EMPTY_BRAND_KIT, colors: hex ? [{ id: 'c1', name: 'Primary', hex, role: 'primary', source: { kind: 'manual' } }] as BrandKit['colors'] : [] });
const listFiles = (dir: string, rel = ''): string[] => readdirSync(join(dir, rel), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? listFiles(dir, rel ? `${rel}/${e.name}` : e.name) : [rel ? `${rel}/${e.name}` : e.name])).sort();
const centre = (png: Buffer) => { const d = decodePng(png); const i = (Math.floor(d.height / 2) * d.width + Math.floor(d.width / 2)) * 4; return [...d.rgba.subarray(i, i + 4)]; };

describe('identity set helpers', () => {
  it('opaqueBackground: an opaque composition colour, else the brand primary, else white with a warning', () => {
    expect(opaqueBackground('#112233', '#FF0000')).toEqual({ color: '#112233' });
    expect(opaqueBackground('#123', undefined)).toEqual({ color: '#112233' });
    expect(opaqueBackground('#112233ff', undefined)).toEqual({ color: '#112233' });
    expect(opaqueBackground('#11223380', '#FF0000')).toEqual({ color: '#ff0000' });
    expect(opaqueBackground('#00000000', undefined)).toMatchObject({ color: '#ffffff', warning: expect.any(String) });
    expect(opaqueBackground(undefined, undefined).warning).toBeDefined();
  });

  it('sourceOf: auto takes the small variant up to 48 px only when there is one', () => {
    expect(sourceOf({ from: 'auto' }, 16, true)).toBe('small');
    expect(sourceOf({ from: 'auto' }, 48, true)).toBe('small');
    expect(sourceOf({ from: 'auto' }, 72, true)).toBe('master');
    expect(sourceOf({ from: 'auto' }, 16, false)).toBe('master');
    expect(sourceOf({}, 16, true)).toBe('master');
  });

  it('rasterDims: square sets are square, the logo is 1024 on its long side', () => {
    expect(rasterDims(512, 'square', { width: 400, height: 100 })).toEqual({ width: 512, height: 512 });
    expect(rasterDims(1024, 'long-side', { width: 400, height: 100 })).toEqual({ width: 1024, height: 256 });
    expect(rasterDims(1024, 'long-side', { width: 100, height: 300 })).toEqual({ width: 341, height: 1024 });
    expect(rasterDims(1024, 'long-side', { width: 1000, height: 1 })).toEqual({ width: 1024, height: 16 });
    expect(rasterDims(1024, 'long-side', null)).toEqual({ width: 1024, height: 1024 });
  });

  it('templates: manifest, head snippet, iOS Contents.json, Android adaptive xml', () => {
    const m = JSON.parse(webManifest({ name: 'Acme "Pro" <b>', themeColor: '#ff0000', backgroundColor: '#ffffff' }));
    expect(m).toMatchObject({ name: 'Acme "Pro" <b>', theme_color: '#ff0000', background_color: '#ffffff', display: 'standalone' });
    expect(m.icons.map((i: { src: string }) => i.src)).toEqual(['/icon-192.png', '/icon-512.png', '/icon-512-maskable.png']);
    expect(m.icons[2].purpose).toBe('maskable');
    const h = headSnippet({ themeColor: '#ff0000"><script>' });
    expect(h).toContain('href="/favicon.ico"');
    expect(h).toContain('rel="manifest" href="/site.webmanifest"');
    expect(h).not.toContain('<script>');
    expect(JSON.parse(iosContentsJson()).images).toEqual([{ filename: 'AppIcon-1024.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }]);
    const x = androidAdaptiveXml();
    expect(x).toContain('<background android:drawable="@mipmap/ic_launcher_background"/>');
    expect(x).toContain('<foreground android:drawable="@mipmap/ic_launcher_foreground"/>');
  });
});

describe.skipIf(!ff)('buildIdentitySet (stand-in rasteriser, real ffmpeg)', () => {
  for (const kind of ['logo', 'favicon', 'app-icon'] as const) {
    it(`${kind}: the files written are exactly IDENTITY_SETS.${kind}`, async () => {
      const outDir = join(work, `set-${kind}`);
      const r = await buildIdentitySet(kind, { master: svgFile(), outDir, name: 'Acme', background: '#123456', rasterize: fakeRasterize([]), ffmpeg: ff! });
      const expected = IDENTITY_SETS[kind].files.map((f) => f.path);
      expect(r.files.map((f) => f.path)).toEqual(expected);
      expect(listFiles(outDir)).toEqual([...expected].sort());
    });
  }

  it('favicon: the ICO has 16/32/48 PNG entries from the small variant; the bigger files and the master SVG from the master', async () => {
    const calls: Array<{ path: string; jobs: Array<{ size: number; scale?: number }> }> = [];
    const outDir = join(work, 'favicon-small');
    const master = join(work, 'master-a.svg');
    const small = join(work, 'small-a.svg');
    writeFileSync(master, `<svg ${NS} viewBox="0 0 10 10"><rect width="10" height="10"/></svg>`);
    writeFileSync(small, `<svg ${NS} viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"/></svg>`);
    await buildIdentitySet('favicon', { master, small, outDir, name: 'Acme', background: '#123456', rasterize: fakeRasterize(calls), ffmpeg: ff! });
    expect(calls).toEqual([
      { path: master, jobs: [{ size: 180 }, { size: 192 }, { size: 512, scale: 0.72 }, { size: 512 }] },
      { path: small, jobs: FAVICON_ICO_SIZES.map((size) => ({ size })) },
    ]);
    const ico = readIco(readFileSync(join(outDir, 'favicon.ico')));
    expect(ico.map((e) => e.width)).toEqual([16, 32, 48]);
    for (const e of ico) expect(centre(e.png)).toEqual([0, 0, 255, 255]);
    expect(centre(readFileSync(join(outDir, 'icon-192.png')))).toEqual([255, 0, 0, 255]);
    expect(readFileSync(join(outDir, 'favicon.svg'), 'utf8')).toBe(readFileSync(master, 'utf8'));
  });

  it('favicon without a small variant: the ICO comes from the master', async () => {
    const outDir = join(work, 'favicon-master');
    await buildIdentitySet('favicon', { master: join(work, 'master-a.svg'), outDir, name: 'Acme', background: '#123456', rasterize: fakeRasterize([]), ffmpeg: ff! });
    for (const e of readIco(readFileSync(join(outDir, 'favicon.ico')))) expect(centre(e.png)).toEqual([255, 0, 0, 255]);
  });

  it('opaque files have no alpha (ffprobe pix_fmt), the others keep it; the background is the composition colour', async () => {
    const fav = join(work, 'opaque-fav');
    const app = join(work, 'opaque-app');
    const rf = await buildIdentitySet('favicon', { master: svgFile(), outDir: fav, name: 'Acme', background: '#123456', rasterize: fakeRasterize([]), ffmpeg: ff! });
    const ra = await buildIdentitySet('app-icon', { master: svgFile(), small: svgFile(), outDir: app, name: 'Acme', background: '#123456', rasterize: fakeRasterize([]), ffmpeg: ff! });
    for (const f of [join(fav, 'apple-touch-icon.png'), join(fav, 'icon-512-maskable.png'), join(app, 'AppIcon-1024.png'), join(app, 'ic_launcher-playstore.png')]) {
      expect(hasAlpha(f)).toBe(false);
      // The corner (outside the disc) is the composition background.
      expect([...decodePng(readFileSync(f)).rgba.subarray(0, 4)]).toEqual([0x12, 0x34, 0x56, 255]);
    }
    expect(hasAlpha(join(fav, 'icon-192.png'))).toBe(true);
    expect(hasAlpha(join(app, 'ic_launcher_foreground.png'))).toBe(true);
    expect(rf.files.find((f) => f.path === 'apple-touch-icon.png')).toMatchObject({ width: 180, height: 180, alpha: false });
    expect(ra.files.find((f) => f.path === 'AppIcon-1024.png')).toMatchObject({ width: 1024, alpha: false });
    expect(ra.files.find((f) => f.path === 'ic_launcher_background.png')).toMatchObject({ width: 432, alpha: false });
    expect([...decodePng(readFileSync(join(app, 'ic_launcher_background.png'))).rgba.subarray(0, 3)]).toEqual([0x12, 0x34, 0x56]);
    // The centred disc is inside both safe zones: no warning.
    expect(rf.warnings).toEqual([]);
    expect(ra.warnings).toEqual([]);
  });

  it('a transparent master with no brand primary flattens onto white, with the warning', async () => {
    const outDir = join(work, 'white');
    const r = await buildIdentitySet('app-icon', { master: svgFile(), outDir, name: 'Acme', background: '#00000000', rasterize: fakeRasterize([]), ffmpeg: ff! });
    expect([...decodePng(readFileSync(join(outDir, 'AppIcon-1024.png'))).rgba.subarray(0, 4)]).toEqual([255, 255, 255, 255]);
    expect(hasAlpha(join(outDir, 'AppIcon-1024.png'))).toBe(false);
    expect(r.warnings.join()).toMatch(/white|bianco/);
    // With a brand primary it is that colour instead, and no warning.
    const b = await buildIdentitySet('app-icon', { master: svgFile(), outDir: join(work, 'brand-bg'), name: 'Acme', background: '#00000000', brand: brand('#00AA00'), rasterize: fakeRasterize([]), ffmpeg: ff! });
    expect([...decodePng(readFileSync(join(work, 'brand-bg', 'AppIcon-1024.png'))).rgba.subarray(0, 3)]).toEqual([0, 0xaa, 0]);
    expect(b.warnings).toEqual([]);
  });

  it('the manifest theme colour is the brand primary, else the background', async () => {
    const a = join(work, 'theme-brand');
    await buildIdentitySet('favicon', { master: svgFile(), outDir: a, name: 'Acme', background: '#123456', brand: brand('#ABCDEF'), rasterize: fakeRasterize([]), ffmpeg: ff! });
    expect(JSON.parse(readFileSync(join(a, 'site.webmanifest'), 'utf8'))).toMatchObject({ name: 'Acme', theme_color: '#abcdef', background_color: '#123456' });
    expect(readFileSync(join(a, 'head-snippet.html'), 'utf8')).toContain('content="#abcdef"');
    const b = join(work, 'theme-bg');
    await buildIdentitySet('favicon', { master: svgFile(), outDir: b, name: 'Acme', background: '#123456', rasterize: fakeRasterize([]), ffmpeg: ff! });
    expect(JSON.parse(readFileSync(join(b, 'site.webmanifest'), 'utf8')).theme_color).toBe('#123456');
  });

  it('padded (decision 762): a full-bleed master no longer warns; the maskable icon is opaque with the drawing at 72%, the foreground at 66/108 with alpha', async () => {
    // A mark that touches every edge of its frame (a disc as wide as the frame): unpadded it would cross both safe circles.
    const bleed = fakeRasterize([], 1);
    const f = await buildIdentitySet('favicon', { master: svgFile(), outDir: join(work, 'bleed-f'), name: 'A', background: '#123456', rasterize: bleed, ffmpeg: ff! });
    expect(f.warnings).toEqual([]);
    const m = decodePng(readFileSync(join(work, 'bleed-f', 'icon-512-maskable.png')));
    expect(hasAlpha(join(work, 'bleed-f', 'icon-512-maskable.png'))).toBe(false);
    const at = (img: ReturnType<typeof decodePng>, x: number, y: number) => [...img.rgba.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)];
    expect(at(m, 256, 256)).toEqual([255, 0, 0]);
    expect(at(m, 256, 256 - 190)).toEqual([0x12, 0x34, 0x56]); // outside the 72% disc (radius 184 px): the background
    expect(at(m, 256, 256 - 170)).toEqual([255, 0, 0]);
    const a = await buildIdentitySet('app-icon', { master: svgFile(), outDir: join(work, 'bleed-a'), name: 'A', background: '#123456', rasterize: bleed, ffmpeg: ff! });
    expect(a.warnings).toEqual([]);
    const fg = decodePng(readFileSync(join(work, 'bleed-a', 'ic_launcher_foreground.png')));
    expect(fg.alpha).toBe(true);
    expect(fg.rgba[3]).toBe(0);
    expect(at(fg, 216, 216 - 140)).toEqual([0, 0, 0]); // outside the 66/108 disc (radius 132 px): transparent
    expect(fg.rgba[((216 - 140) * 432 + 216) * 4 + 3]).toBe(0);
    expect(at(fg, 216, 216 - 125)).toEqual([255, 0, 0]);
  });

  it('the safe-zone check stays a guard: a drawing whose content still crosses the circle once padded warns', async () => {
    const full = async (_p: string, jobs: Array<{ size: number; scale?: number }>) => jobs.map(({ size: s }) => encodePng(s, s, new Uint8Array(s * s * 4).fill(255), 4));
    const f = await buildIdentitySet('favicon', { master: svgFile(), outDir: join(work, 'guard-f'), name: 'A', background: '#123456', rasterize: full, ffmpeg: ff! });
    expect(f.warnings.join()).toMatch(/icon-512-maskable\.png/);
    const a = await buildIdentitySet('app-icon', { master: svgFile(), outDir: join(work, 'guard-a'), name: 'A', background: '#123456', rasterize: full, ffmpeg: ff! });
    expect(a.warnings.join()).toMatch(/ic_launcher_foreground\.png/);
  });

  it('a refused SVG (master or small) rasterises nothing and writes nothing; <text> is a warning', async () => {
    const calls: Array<{ path: string; jobs: Array<{ size: number; scale?: number }> }> = [];
    const outDir = join(work, 'refused');
    const bad = svgFile('<script>alert(1)</script>');
    await expect(buildIdentitySet('favicon', { master: bad, outDir, name: 'A', rasterize: fakeRasterize(calls), ffmpeg: ff! })).rejects.toBeInstanceOf(SvgRefusedError);
    await expect(buildIdentitySet('favicon', { master: svgFile(), small: bad, outDir, name: 'A', rasterize: fakeRasterize(calls), ffmpeg: ff! })).rejects.toThrow(/script/);
    expect(calls).toEqual([]);
    expect(existsSync(outDir)).toBe(false);
    const w = await buildIdentitySet('logo', { master: svgFile('<text x="1" y="9">A</text>'), outDir: join(work, 'text'), name: 'A', rasterize: fakeRasterize([]), ffmpeg: ff! });
    expect(w.warnings.join()).toMatch(/text|testo/);
  });
});
