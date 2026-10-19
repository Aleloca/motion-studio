import type { BrandKit } from './brand.ts';
import type { AssetEntry } from './library.ts';

/**
 * Report 44: the icon a project gets by itself, as a path relative to the project (served by the project's files route), or
 * null (the initials). In order:
 * 1. the brand kit's logo of variant `icon` (an image or SVG);
 * 2. an app icon or favicon of the library (`apple-touch-icon`, `app-icon`, `AppIcon`, `ic_launcher`, `favicon`, `icon` in its
 *    name), the largest first, square-ish when its size is known;
 * 3. a square-ish logo of the kit (its size known from the library).
 * Only images and SVGs, never a wide picture (a banner named "icon").
 */
export function autoProjectIcon(kit: Pick<BrandKit, 'logos'>, assets: readonly AssetEntry[]): string | null {
  const byPath = new Map(assets.map((a) => [`assets/${a.file}`, a]));
  const picture = (a: AssetEntry | undefined) => a !== undefined && (a.kind === 'image' || a.kind === 'svg');
  const square = (a: AssetEntry) => a.width === null || a.height === null || (a.width / a.height >= 0.8 && a.width / a.height <= 1.25);
  const known = (a: AssetEntry) => a.width !== null && a.height !== null;
  const icon = kit.logos.find((l) => l.variant === 'icon' && (picture(byPath.get(l.file)) || /\.(svg|png|jpe?g|webp|gif|avif|ico)$/i.test(l.file)));
  if (icon) return icon.file;
  const named = assets
    .filter((a) => picture(a) && ICON_NAME.test(a.file.split('/').pop() ?? '') && square(a))
    .sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  if (named[0]) return `assets/${named[0].file}`;
  const logo = kit.logos.find((l) => { const a = byPath.get(l.file); return picture(a) && known(a!) && square(a!); });
  return logo ? logo.file : null;
}

const ICON_NAME = /(apple-touch-icon|app[-_ ]?icon|ic_launcher|favicon|(^|[-_. ])icon([-_. @]|$))/i;
