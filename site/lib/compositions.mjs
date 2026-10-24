// The site's compositions: hand-written Motion Studio compositions under site/compositions/<id>/, each with a meta.json
// ({ format, posterTime, label }). They are checked with the product's own validator and inlined into the product's own
// runtime page, so what the page plays is exactly what Motion Studio would play.
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { validateComposition } from '../../packages/shared/src/composition/validate.ts';
import { normalizeComposition } from '../../packages/shared/src/composition/normalize.ts';
import { DEFAULT_FORMATS } from '../../packages/shared/src/formats.ts';
import { instancePreset } from '../../packages/shared/src/format-instance.ts';
import { renderRuntimePage } from '../../packages/composition-runtime/src/page.ts';

/** Files of a composition folder that belong to the site, not to the composition. */
export const SITE_ONLY_FILES = new Set(['meta.json', 'poster.webp', 'subtitles.json']);

/**
 * The site's own fonts (site/src/assets/fonts/*.woff2) are shared by every composition: the build copies them into each
 * composition's assets/fonts/, so a composition references them as `assets/fonts/<file>` and the repo keeps one copy.
 */
export const SHARED_FONTS_DIR = new URL('../src/assets/fonts/', import.meta.url).pathname;

export async function sharedFonts(fontsDir = SHARED_FONTS_DIR) {
  const out = new Map();
  for (const name of (await readdir(fontsDir)).filter((n) => n.endsWith('.woff2'))) {
    out.set(`assets/fonts/${name}`, { size: (await stat(join(fontsDir, name))).size, src: join(fontsDir, name) });
  }
  return out;
}

async function filesOf(dir, base = dir, out = new Map()) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) await filesOf(p, base, out);
    else if (entry.isFile() && entry.name !== '.DS_Store') out.set(p.slice(base.length + 1), { size: (await stat(p)).size });
  }
  return out;
}

export async function loadCompositions(dir) {
  const ids = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  return Promise.all(ids.map(async (id) => {
    const folder = join(dir, id);
    const composition = JSON.parse(await readFile(join(folder, 'composition.json'), 'utf8'));
    const meta = JSON.parse(await readFile(join(folder, 'meta.json'), 'utf8'));
    // A creative's subtitle set (times in ms), for a composition with a subtitles clip: inlined in its runtime page.
    const subtitles = await readFile(join(folder, 'subtitles.json'), 'utf8').then(JSON.parse, () => undefined);
    return { id, dir: folder, composition, meta, ...(subtitles ? { subtitles } : {}) };
  }));
}

export const presetOf = (item) => instancePreset(DEFAULT_FORMATS, item.meta.format);

export async function validateAll(items, { fontsDir = SHARED_FONTS_DIR } = {}) {
  const fonts = await sharedFonts(fontsDir);
  return Promise.all(items.map(async (item) => {
    const format = presetOf(item);
    if (!format) return { id: item.id, problems: [{ key: 'site.unknownFormat', params: { format: item.meta.format } }], warnings: [] };
    const files = new Map([...fonts, ...[...(await filesOf(item.dir))].filter(([p]) => !SITE_ONLY_FILES.has(p))]);
    const { problems, warnings } = validateComposition(item.composition, { format, files });
    const t = item.meta.posterTime;
    if (typeof t !== 'number' || t < 0 || t > item.composition.duration) problems.push({ key: 'site.badPosterTime', params: { posterTime: t } });
    if (typeof item.meta.label !== 'string' || !item.meta.label.trim()) problems.push({ key: 'site.missingLabel', params: {} });
    return { id: item.id, problems, warnings };
  }));
}

export function runtimePageFor(item, indexHtml) {
  const safeZone = presetOf(item)?.safeZone;
  return renderRuntimePage(indexHtml, {
    base: `../compositions/${item.id}/`,
    composition: normalizeComposition(item.composition),
    ...(safeZone ? { safeZone } : {}),
    ...(item.subtitles ? { subtitles: item.subtitles } : {}),
  });
}
