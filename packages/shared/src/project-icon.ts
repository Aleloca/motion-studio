import type { BrandKit } from './brand.ts';
import type { AssetEntry } from './library.ts';

/**
 * Report 44: the icons a project may get by itself, best first, as paths relative to the project (served by the project's
 * files route, so only under `assets/`):
 * 1. the brand kit's logos of variant `icon` (an image or SVG);
 * 2. the app icons and favicons of the library (`apple-touch-icon`, `app-icon`, `AppIcon`, `ic_launcher`, `favicon`, `icon` in
 *    the name), the largest first, square-ish when the size is known;
 * 3. the square-ish logos of the kit (size known from the library).
 * Only images and SVGs, never a wide picture (a banner named "icon"). The core takes the first whose file is usable
 * (review 4: a kit logo whose file is gone does not hide the next ones).
 */
export function projectIconCandidates(kit: Pick<BrandKit, 'logos'>, assets: readonly AssetEntry[]): string[] {
  const byPath = new Map(assets.map((a) => [`assets/${a.file}`, a]));
  const picture = (a: AssetEntry | undefined) => a !== undefined && (a.kind === 'image' || a.kind === 'svg');
  const square = (a: AssetEntry) => a.width === null || a.height === null || (a.width / a.height >= 0.8 && a.width / a.height <= 1.25);
  const known = (a: AssetEntry) => a.width !== null && a.height !== null;
  const icons = kit.logos.filter((l) => l.variant === 'icon' && (picture(byPath.get(l.file)) || PICTURE_EXT.test(l.file))).map((l) => l.file);
  const named = assets
    .filter((a) => picture(a) && ICON_NAME.test(a.file.split('/').pop() ?? '') && square(a))
    .sort((a, b) => (b.width ?? 0) - (a.width ?? 0))
    .map((a) => `assets/${a.file}`);
  const logos = kit.logos.filter((l) => { const a = byPath.get(l.file); return picture(a) && known(a!) && square(a!); }).map((l) => l.file);
  return [...new Set([...icons, ...named, ...logos])].filter((f) => f.startsWith('assets/'));
}

/** The first candidate (`projectIconCandidates`), or null for the initials. */
export function autoProjectIcon(kit: Pick<BrandKit, 'logos'>, assets: readonly AssetEntry[]): string | null {
  return projectIconCandidates(kit, assets)[0] ?? null;
}

const PICTURE_EXT = /\.(svg|png|jpe?g|webp|gif|avif|ico)$/i;
const ICON_NAME = /(apple-touch-icon|app[-_ ]?icon|ic_launcher|favicon|(^|[-_. ])icon([-_. @]|$))/i;
