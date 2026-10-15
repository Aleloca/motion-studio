import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { FAVICON_ICO_SIZES, IDENTITY_SETS, type BrandKit, type IdentityOutputFile, type IdentitySetFile } from '@motion-studio/shared';
import { findFfmpeg, type FfmpegInfo } from '../render/encode.ts';
import { backgroundRgb, flattenPng } from '../store-pack/flatten.ts';
import { t } from '../i18n.ts';
import { writeIco } from './ico.ts';
import { pngSize, solidPng } from './png.ts';
import { rasterizeSvg, readCheckedSvg, type RasterizeOptions } from './rasterize.ts';
import { safeZoneCheck } from './safe-zone.ts';

/**
 * The file sets of the identity formats (Phase 14, spec §4.1–4.2): from the checked master SVG (and the optional `small`
 * variant) the core writes exactly the files of `IDENTITY_SETS[kind]` into `outDir`.
 *
 * - **Vector files** (`logo.svg`, `favicon.svg`) are the checked SVG bytes.
 * - **PNGs** are rasterised at their exact size (`rasterizeSvg`); `from: 'auto'` takes the `small` variant up to 48 px
 *   when there is one (decision 728). `logo.png` is 1024 px on its long side (the SVG's `viewBox` sets the other).
 * - **Opaque PNGs** (`opaque: true`: apple-touch-icon, iOS 1024, Play 512) are flattened with the store pack's
 *   `flattenPng` (no alpha channel) onto `opaqueBackground` (decision 729).
 * - **`favicon.ico`** packs `FAVICON_ICO_SIZES` as PNG entries (`writeIco`).
 * - **Safe zone** (warning only): `icon-512-maskable.png` (80% circle) and `ic_launcher_foreground.png` (66/108).
 * - **Templates**: `site.webmanifest` (theme colour from the brand's primary colour, else the opaque background),
 *   `head-snippet.html`, the iOS `Contents.json` (single size, 1024 universal) and the Android adaptive `ic_launcher.xml`;
 *   `ic_launcher_background.png` is the opaque background colour.
 * - Every file goes through a temp name and a rename. Warnings are in the core's current language.
 */

export interface IdentitySetInput {
  /** The master SVG (checked again here). */
  master: string;
  /** The `small` variant SVG, when the composition has one. */
  small?: string;
  outDir: string;
  brand?: BrandKit;
  /** The app or site name (the manifest's `name`). */
  name: string;
  /** The composition's background (`#rrggbb[aa]`): the opaque icons' background when it is opaque. */
  background?: string;
  /** The format's label for the warnings; default the kind. */
  label?: string;
  /** How to rasterise (browser, runtime, temp folder, signal). */
  raster?: Omit<RasterizeOptions, 'background' | 'shape'>;
  /** ffmpeg for the flatten step; default the one found on the system. */
  ffmpeg?: FfmpegInfo;
  signal?: AbortSignal;
  /** Replaces `rasterizeSvg` (tests without a browser). It receives only checked SVGs. */
  rasterize?: typeof rasterizeSvg;
}

export type IdentityKind = keyof typeof IDENTITY_SETS;

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Whether a composition colour has no transparency (`#rgb`, `#rrggbb`, or an alpha of `f`/`ff`). */
function isOpaqueColour(c: string): boolean {
  if (!HEX_RE.test(c)) return false;
  const h = c.slice(1).toLowerCase();
  return h.length === 3 || h.length === 6 || (h.length === 4 && h[3] === 'f') || (h.length === 8 && h.slice(6) === 'ff');
}

/**
 * The background of the icons that cannot be transparent (decision 729): the composition background when opaque, else the
 * brand's primary colour, else white with a warning. Always `#rrggbb` (lowercase).
 */
export function opaqueBackground(compBackground: string | undefined, brandPrimary: string | undefined): { color: string; warning?: string } {
  if (compBackground && isOpaqueColour(compBackground)) return { color: `#${backgroundRgb(compBackground)}` };
  if (brandPrimary && HEX_RE.test(brandPrimary)) return { color: `#${backgroundRgb(brandPrimary)}` };
  return { color: '#ffffff', warning: 'no opaque background: white' };
}

/** The brand's primary colour (`#RRGGBB`), if any. */
export const brandPrimary = (brand: BrandKit | undefined): string | undefined => brand?.colors.find((c) => c.role === 'primary')?.hex;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/** `site.webmanifest` (Web App Manifest): name, the three icons (the 512 maskable one marked so), theme and background colour. */
export function webManifest(o: { name: string; themeColor: string; backgroundColor: string }): string {
  const name = o.name.trim() || 'App';
  return `${JSON.stringify({
    name,
    short_name: [...name].slice(0, 12).join(''),
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    theme_color: o.themeColor,
    background_color: o.backgroundColor,
    display: 'standalone',
  }, null, 2)}\n`;
}

/** The `<head>` lines that use the favicon set (files at the site root). */
export function headSnippet(o: { themeColor: string }): string {
  return [
    '<link rel="icon" href="/favicon.ico" sizes="48x48">',
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
    '<link rel="manifest" href="/site.webmanifest">',
    `<meta name="theme-color" content="${escapeHtml(o.themeColor)}">`,
    '',
  ].join('\n');
}

/** The iOS app icon set's `Contents.json`: one 1024 px universal image (Xcode 14+ single-size icon). */
export function iosContentsJson(): string {
  return `${JSON.stringify({
    images: [{ filename: 'AppIcon-1024.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }],
    info: { author: 'xcode', version: 1 },
  }, null, 2)}\n`;
}

/** The Android adaptive icon (`mipmap-anydpi-v26/ic_launcher.xml`): background and foreground layers. */
export function androidAdaptiveXml(): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">',
    '    <background android:drawable="@mipmap/ic_launcher_background"/>',
    '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>',
    '</adaptive-icon>',
    '',
  ].join('\n');
}

/** Which drawing a file of size `size` comes from (`IdentitySetFile.from`). */
export function sourceOf(f: Pick<IdentitySetFile, 'from'>, size: number, hasSmall: boolean): 'master' | 'small' {
  const from = f.from ?? 'master';
  if (from === 'small') return hasSmall ? 'small' : 'master';
  if (from === 'auto') return hasSmall && size <= 48 ? 'small' : 'master';
  return 'master';
}

async function writeAtomic(path: string, data: Buffer | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temp, data, { flag: 'wx', mode: 0o644 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

/**
 * Builds the set of `kind` into `input.outDir` (see the module comment). Throws `SvgRefusedError` for a refused SVG (nothing
 * is written then), a `RenderError` when Chrome fails, and an error when ffmpeg is needed and missing.
 */
export async function buildIdentitySet(kind: IdentityKind, input: IdentitySetInput): Promise<{ files: IdentityOutputFile[]; warnings: string[] }> {
  const set = IDENTITY_SETS[kind];
  const label = input.label ?? kind;
  const msg = t().render;
  // Both SVGs are checked before anything is rasterised or written.
  const master = await readCheckedSvg(input.master);
  const small = input.small !== undefined ? await readCheckedSvg(input.small) : null;
  const warnings: string[] = [];
  if (master.warnings.length > 0) warnings.push(msg.identitySvgText({ file: `${label}: ${kind === 'logo' ? 'logo.svg' : kind === 'favicon' ? 'favicon.svg' : 'master'}` }));
  if (small && small.warnings.length > 0) warnings.push(msg.identitySvgText({ file: `${label}: small` }));

  // What to rasterise, per drawing.
  const need = { master: new Set<number>(), small: new Set<number>() };
  for (const f of set.files) {
    if (f.path === 'favicon.ico') for (const s of FAVICON_ICO_SIZES) need[sourceOf(f, s, small !== null)].add(s);
    else if (f.size !== undefined && f.path !== 'ic_launcher_background.png') need[sourceOf(f, f.size, small !== null)].add(f.size);
  }
  const shape = kind === 'logo' ? 'long-side' : 'square';
  const raster = { ...input.raster, ...(input.signal ? { signal: input.signal } : {}), shape } as const;
  const rasterize = input.rasterize ?? rasterizeSvg;
  const masterPngs = need.master.size > 0 ? await rasterize(input.master, [...need.master], raster) : new Map<number, Buffer>();
  const smallPngs = need.small.size > 0 && input.small !== undefined ? await rasterize(input.small, [...need.small], raster) : new Map<number, Buffer>();
  const png = (f: Pick<IdentitySetFile, 'from'>, size: number) => {
    const b = (sourceOf(f, size, small !== null) === 'small' ? smallPngs : masterPngs).get(size);
    if (!b) throw new Error(`identity: no ${size} px raster`);
    return b;
  };

  const opaque = opaqueBackground(input.background, brandPrimary(input.brand));
  if (opaque.warning && kind !== 'logo') warnings.push(msg.identityOpaqueWhite({ format: label }));
  const theme = brandPrimary(input.brand)?.toLowerCase() ?? opaque.color;
  let ff: FfmpegInfo | null = null;
  const files: IdentityOutputFile[] = [];
  await mkdir(input.outDir, { recursive: true });
  for (const f of set.files) {
    const out = join(input.outDir, ...f.path.split('/'));
    let role = 'file';
    if (f.path.endsWith('.svg')) {
      await writeAtomic(out, master.text);
      files.push({ path: f.path, role: 'vector' });
      continue;
    }
    if (f.path === 'favicon.ico') {
      await writeAtomic(out, writeIco(FAVICON_ICO_SIZES.map((size) => ({ size, png: png(f, size) }))));
      files.push({ path: f.path, role: 'favicon' });
      continue;
    }
    if (f.path === 'site.webmanifest') { await writeAtomic(out, webManifest({ name: input.name, themeColor: theme, backgroundColor: opaque.color })); files.push({ path: f.path, role: 'manifest' }); continue; }
    if (f.path === 'head-snippet.html') { await writeAtomic(out, headSnippet({ themeColor: theme })); files.push({ path: f.path, role: 'snippet' }); continue; }
    if (f.path === 'Contents.json') { await writeAtomic(out, iosContentsJson()); files.push({ path: f.path, role: 'ios-contents' }); continue; }
    if (f.path === 'ic_launcher.xml') { await writeAtomic(out, androidAdaptiveXml()); files.push({ path: f.path, role: 'android-adaptive' }); continue; }
    if (f.size === undefined) throw new Error(`identity: no rule for ${f.path}`);
    if (f.path === 'ic_launcher_background.png') {
      await writeAtomic(out, solidPng(f.size, opaque.color.slice(1)));
      files.push({ path: f.path, width: f.size, height: f.size, alpha: false, role: 'android-background' });
      continue;
    }
    const buf = png(f, f.size);
    if (f.opaque) {
      ff ??= input.ffmpeg ?? await findFfmpeg();
      if (!ff) throw new Error('ffmpeg is needed to make the opaque icons');
      const dims = pngSize(buf)!;
      const src = join(input.outDir, `.${randomBytes(6).toString('hex')}.raster.tmp`);
      const dst = join(dirname(out), `.${randomBytes(6).toString('hex')}.flat.tmp`);
      try {
        await mkdir(dirname(out), { recursive: true });
        await writeFile(src, buf, { flag: 'wx', mode: 0o644 });
        await flattenPng(ff, src, dst, { width: dims.width, height: dims.height, background: opaque.color }, input.signal);
        await writeAtomic(out, await readFile(dst));
      } finally {
        await rm(src, { force: true }).catch(() => {});
        await rm(dst, { force: true }).catch(() => {});
      }
      role = 'opaque';
    } else {
      await writeAtomic(out, buf);
      role = f.path.startsWith('mipmap-') ? 'android-legacy' : kind === 'logo' ? 'raster' : 'icon';
    }
    if (f.path === 'icon-512-maskable.png' || f.path === 'ic_launcher_foreground.png') {
      role = f.path === 'icon-512-maskable.png' ? 'maskable' : 'android-foreground';
      const z = safeZoneCheck(buf, f.size, f.path === 'icon-512-maskable.png' ? 'maskable' : 'adaptive');
      if (!z.ok) warnings.push(msg.identitySafeZone({ file: f.path, pct: z.overflowPct }));
    }
    const written = pngSize(await readFile(out))!;
    files.push({ path: f.path, width: written.width, height: written.height, alpha: written.colorType === 4 || written.colorType === 6, role });
  }
  return { files, warnings };
}
