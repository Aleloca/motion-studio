import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import {
  instanceIndex, presetOf, STORE_DEVICE_PRESET, STORE_LIMITS, STORE_SCREENSHOTS, STORE_PREVIEW_PRESET, type FormatPreset, type StoreId, type StorePack,
} from '@motion-studio/shared';
import { copyConfinedFile } from '../brand/agent-guard.ts';
import { copyUnique, ensureDestination, reasonOf } from '../creatives/export.ts';
import type { MediaInfo } from '../media/media-tools.ts';
import { t } from '../i18n.ts';
import { WorkspaceError } from '../workspace-store.ts';
import { checkStoreFile, type StoreFileKind } from './requirements.ts';

/**
 * The store pack on disk (Phase 12, spec §4.3):
 *
 *   <title>-store-pack/
 *     AppStore/[<locale>/]<device>/NN-<caption>.png …    AppStore/[<locale>/]preview.mp4
 *     GooglePlay/[<locale>/]<device>/NN-<caption>.png …  GooglePlay/[<locale>/]feature-graphic.png, promo-video.mp4
 *     README.txt
 *
 * The language level exists when the creative has languages (`brief.locales`); without them there is no language to name.
 * Every name is built from fixed parts and slugs (`[a-z0-9-]`), so a caption or a title can never add a folder or leave the
 * pack. Each file is copied with the confined read (never overwriting), then checked on the copy written (size, PNG/JPEG,
 * alpha, preview duration/fps/codec/audio): a copy that fails is removed and listed with its reason, the rest goes on.
 */

const DEVICE_FOLDER: Record<string, { store: StoreId; folder: string }> = {
  [STORE_DEVICE_PRESET.appstore['iphone-69']]: { store: 'appstore', folder: 'iPhone-6.9' },
  [STORE_DEVICE_PRESET.appstore['ipad-13']]: { store: 'appstore', folder: 'iPad-13' },
  [STORE_DEVICE_PRESET.playstore.phone]: { store: 'playstore', folder: 'Phone' },
  [STORE_DEVICE_PRESET.playstore.tablet]: { store: 'playstore', folder: 'Tablet' },
};
const STORE_FOLDER: Record<StoreId, string> = { appstore: 'AppStore', playstore: 'GooglePlay' };

/** `[a-z0-9-]`, at most `max` characters, accents folded; `fallback` when nothing is left. */
export function packSlug(s: string, fallback: string, max = 60): string {
  const slug = s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
  return slug || fallback;
}

export interface PackEntry {
  /** Path inside the pack, `/`-separated, without extension. */
  stem: string;
  kind: StoreFileKind; store: StoreId;
}

/**
 * Where format instance `format` goes in the pack, for `locale` (none: no language level); null for a format that is not part
 * of a pack (left out). Screenshot k is `NN-<slug(caption k)>`: k picks the caption (the instance's own), `position` the number NN
 * (its place among the brief's instances of the device, the upload order; absent: k).
 */
export function packEntry(p: StorePack, format: string, locale: string | undefined, position?: number): PackEntry | null {
  const preset = presetOf(format);
  const loc = locale ? [locale] : [];
  const device = DEVICE_FOLDER[preset];
  if (device) {
    const k = instanceIndex(format);
    const caption = p.screenshots[k - 1]?.caption ?? '';
    return { stem: [STORE_FOLDER[device.store], ...loc, device.folder, `${String(position ?? k).padStart(2, '0')}-${packSlug(caption, 'screenshot')}`].join('/'), kind: 'screenshot', store: device.store };
  }
  if (format === STORE_DEVICE_PRESET.playstore.feature) return { stem: [STORE_FOLDER.playstore, ...loc, 'feature-graphic'].join('/'), kind: 'feature', store: 'playstore' };
  if (format === STORE_PREVIEW_PRESET.appstore) return { stem: [STORE_FOLDER.appstore, ...loc, 'preview'].join('/'), kind: 'preview', store: 'appstore' };
  if (format === STORE_PREVIEW_PRESET.playstore) return { stem: [STORE_FOLDER.playstore, ...loc, 'promo-video'].join('/'), kind: 'preview', store: 'playstore' };
  return null;
}

/** One file of the pack: its rendered source (`outputs/v<n>/<file>`), or why there is none. */
export interface PackFile {
  format: string; locale?: string; width: number; height: number;
  /** The rendered file (a plain name in `outputs/v<n>/`); absent with `failure`. */
  file?: string;
  /** Why this file cannot be in the pack (no translation, render failed or with problems): listed, never copied. */
  failure?: string;
}

export interface PackExportOptions {
  creativeDir: string; n: number;
  /** The checked destination (`checkDestination`). */
  destination: string;
  title: string; storePack: StorePack; presets: readonly FormatPreset[];
  files: PackFile[];
  /** The brief's formats in order: screenshots are numbered by their place among those of the same device (the upload order). */
  order?: readonly string[];
  probe: (file: string) => Promise<MediaInfo | null>;
  /** The export day (README), `YYYY-MM-DD`. */
  date: string;
}
export interface PackExportResult { folder: string; written: string[]; failed: Array<{ file: string; reason: string }> }

const extOf = (file: string) => /\.([a-z0-9]{2,5})$/i.exec(file)?.[1]?.toLowerCase() ?? 'bin';

/** A new pack folder in `dest` (`<slug>-store-pack`, then `-2`, `-3`…): never an existing one. */
async function newPackFolder(dest: string, base: string): Promise<string> {
  for (let i = 1; i < 1000; i++) {
    const dir = join(dest, i === 1 ? base : `${base}-${i}`);
    try { await mkdir(dir); return dir; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  }
  throw new Error('no free pack folder name');
}

/** Copies and checks the pack's files, then writes the README (see the module comment). */
export async function exportStorePack(o: PackExportOptions): Promise<PackExportResult> {
  await ensureDestination(o.destination);
  let folder: string;
  try { folder = await newPackFolder(o.destination, `${packSlug(o.title, 'app')}-store-pack`); }
  catch { throw new WorkspaceError(400, t().export.cannotWrite({ path: o.destination })); }
  const c = t().variants.storePack.check;
  const written: string[] = [];
  const failed: PackExportResult['failed'] = [];
  const positionOf = (format: string): number | undefined => {
    const same = (o.order ?? []).filter((x) => presetOf(x) === presetOf(format));
    const at = same.indexOf(format);
    return at < 0 ? undefined : at + 1;
  };
  // The store's screenshot count per device: the instances of the brief, beyond the maximum are left out, below the minimum is said.
  const limits = (format: string) => {
    const device = DEVICE_FOLDER[presetOf(format)];
    return device && device.store ? { device, ...STORE_SCREENSHOTS[device.store] } : null;
  };
  if (o.order) {
    const seen = new Set<string>();
    for (const f of o.order) {
      const lim = limits(f);
      const preset = presetOf(f);
      if (!lim || seen.has(preset)) continue;
      seen.add(preset);
      const count = o.order.filter((x) => presetOf(x) === preset).length;
      if (count < lim.min) {
        for (const loc of [...new Set(o.files.map((x) => x.locale))]) failed.push({ file: [STORE_FOLDER[lim.device.store], ...(loc ? [loc] : []), lim.device.folder].join('/'), reason: c.tooFewScreenshots({ count, min: lim.min }) });
      }
    }
  }
  for (const f of o.files) {
    const position = positionOf(f.format);
    const entry = packEntry(o.storePack, f.format, f.locale, position);
    if (!entry) continue;
    const planned = `${entry.stem}.${f.file ? extOf(f.file) : entry.kind === 'preview' ? 'mp4' : 'png'}`;
    const lim = limits(f.format);
    if (entry.kind === 'screenshot' && lim && position !== undefined && position > lim.max) { failed.push({ file: planned, reason: c.tooManyScreenshots({ count: position, max: lim.max }) }); continue; }
    if (f.failure || !f.file) { failed.push({ file: planned, reason: f.failure ?? c.notRendered }); continue; }
    const parts = entry.stem.split('/');
    const dir = join(folder, ...parts.slice(0, -1));
    let to: string | null = null;
    try {
      await mkdir(dir, { recursive: true });
      const from = join(o.creativeDir, 'outputs', `v${o.n}`, f.file);
      to = await copyUnique((src, dst) => copyConfinedFile(o.creativeDir, relative(o.creativeDir, src).split(sep).join('/'), dst), from, dir, parts.at(-1)!, `.${extOf(f.file)}`);
    } catch (e) {
      const target = (e as { target?: string }).target;
      if (target) await rm(target, { force: true }).catch(() => {});
      failed.push({ file: planned, reason: c.copyFailed({ reason: (e as NodeJS.ErrnoException).code === 'ECONFINED' ? c.unreadable : reasonOf(e) }) });
      continue;
    }
    if (!to) { failed.push({ file: planned, reason: c.copyFailed({ reason: t().export.writeError }) }); continue; }
    const rel = relative(folder, to).split(sep).join('/');
    const check = await checkStoreFile(entry.kind, entry.store, to, { width: f.width, height: f.height, probe: o.probe });
    if (!check.ok) {
      await rm(to, { force: true }).catch(() => {});
      failed.push({ file: rel, reason: check.reason });
      continue;
    }
    written.push(rel);
  }
  await writeFile(join(folder, 'README.txt'), readmeText({ storePack: o.storePack, presets: o.presets, date: o.date, n: o.n, failed }), { flag: 'wx', mode: 0o644 })
    .catch(async (e: unknown) => { failed.push({ file: 'README.txt', reason: c.copyFailed({ reason: reasonOf(e) }) }); });
  return { folder, written, failed };
}

/** The pack's README (UI language): the verified limits and their date, the sources, the upload order, the Play video note. */
export function readmeText(o: { storePack: StorePack; presets: readonly FormatPreset[]; date: string; n: number; failed: PackExportResult['failed'] }): string {
  const r = t().variants.storePack.readme;
  const p = o.storePack;
  const sizeOf = (id: string) => { const f = o.presets.find((x) => x.id === id); return f ? `${f.width}×${f.height}` : null; };
  const named = (pairs: Array<[string, string]>) => pairs.flatMap(([label, id]) => { const s = sizeOf(id); return s ? [`${label} ${s}`] : []; }).join(', ');
  const has = (store: StoreId, device: string) => p.stores.includes(store) && (p.devices[store] as readonly string[] | undefined)?.includes(device) === true;
  const lim = STORE_LIMITS;
  const lines = [r.title({ app: p.app.name }), r.made({ date: o.date, version: o.n }), '', r.limits({ date: lim.checkedOn })];
  if (p.stores.includes('appstore')) {
    lines.push(`- ${r.appStoreShots({ ...lim.appstore.screenshots, sizes: named([['iPhone 6.9"', 'appstore-iphone-69'], ['iPad 13"', 'appstore-ipad-13']]) })}`);
    if (p.preview) lines.push(`- ${r.appStorePreview({ min: lim.appstore.preview.minSec, max: lim.appstore.preview.maxSec, fps: lim.appstore.preview.fps, maxMB: lim.appstore.preview.maxFileMB, perDevice: lim.appstore.preview.maxPerDevice })}`);
  }
  if (p.stores.includes('playstore')) {
    const s = lim.playstore.screenshots;
    lines.push(`- ${r.playShots({ min: s.min, max: s.max, minSide: s.minSide, maxSide: s.maxSide, sizes: named([['Phone', 'playstore-phone-9x16'], ['Tablet', 'playstore-tablet']]) })}`);
    if (has('playstore', 'feature')) lines.push(`- ${r.playFeature({ size: sizeOf('playstore-feature') ?? `${lim.playstore.feature.width}×${lim.playstore.feature.height}` })}`);
  }
  lines.push('', r.sources, ...lim.sources.map((u) => `- ${u}`), '', r.order);
  const order: string[] = [];
  if (p.stores.includes('appstore')) { order.push(r.orderAppStore); if (p.preview) order.push(r.orderPreview); }
  if (p.stores.includes('playstore')) order.push(r.orderPlay);
  lines.push(...order.map((x, i) => `${i + 1}. ${x}`));
  if (p.stores.includes('playstore') && p.preview) lines.push('', r.playVideoTitle, r.playVideo);
  if (o.failed.length > 0) lines.push('', r.failedTitle, ...o.failed.map((f) => `- ${f.file}: ${f.reason}`));
  return lines.join('\n') + '\n';
}

