import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, sep } from 'node:path';
import { allocatePackInstances, messages, packSlotOf, STORE_PREVIEW_SECONDS, storePackFormats, type Brief, type FormatPreset, type Locale, type StorePack } from '@motion-studio/shared';
import { currentLocale } from '../i18n.ts';
import { LibraryStore } from '../library/library-store.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { CodedError } from '../workspace-store.ts';
import { t } from '../i18n.ts';

export { storePackPromptSection } from '../creatives/prompt.ts';

/**
 * The brief of an App store pack (Phase 12, spec §4.1), built by the core from the guided choices:
 * - `formats`, `formatLabels` ("N · caption", Ruling G) and `links` from `storePackFormats` (always `{}` with the shipped
 *   presets: the store devices differ in size, Ruling D; consistency comes from the series prompt);
 * - `assets`: the app screens (project paths under `assets/`), once each, in screenshot order;
 * - `message`: the app name and tagline, then the captions in order; `goal` names the app (UI language);
 * - `durationSec`: 20 s when a preview is asked (inside the App Store's 15–30 s with the brief tolerance on both sides).
 */
export { STORE_PREVIEW_SECONDS };

export function storePackBrief(p: StorePack, o: { locale: Locale; presets?: readonly Pick<FormatPreset, 'id' | 'width' | 'height'>[]; locales?: Brief['locales'] }): Brief {
  const { formats, formatLabels, links } = storePackFormats(p, o.presets);
  const assets = [...new Set(p.screenshots.flatMap((s) => (s.screen ? [s.screen] : [])))];
  const head = p.app.tagline ? `${p.app.name} — ${p.app.tagline}` : p.app.name;
  const message = [head, ...p.screenshots.flatMap((s, i) => (s.caption ? [`${i + 1}. ${s.caption}`] : []))].join('\n');
  return {
    goal: messages(o.locale).variants.storePack.goal({ app: p.app.name }),
    message, formats, formatLabels, links, assets, notes: '',
    durationSec: p.preview ? STORE_PREVIEW_SECONDS : null,
    ...(o.locales ? { locales: o.locales } : {}),
    storePack: p,
  };
}

/**
 * Sets, changes or takes out (`null`) the store pack of a brief (Phase 14, spec §3), touching only what the pack stands for:
 * - the pack owns exactly its `instances` (or, in a pack made before, `storePackFormats(pack).formats`): a hand-picked or
 *   "Add another" instance is never adopted. A new slot takes its own id when free, else the next free instance of its preset
 *   (an old pack grown over a hand-picked @4 gets @5); `store-pack-collision` only when a preset has no free instance left;
 * - the slots the new pack no longer needs go (`removed`) with their labels and links; the new ones come in (`added`), after
 *   the last pack instance that stays, or at the end; labels follow the captions, links are those of `storePackFormats`;
 * - the fields `storePackBrief` derives from the pack follow it: the app screens in `assets` (those of the old pack go, the new
 *   ones come), `durationSec` (20 s when the preview is turned on and there is no length, null again when it is turned off and
 *   the length is still the pack's), `goal` and `message` (replaced only while they are still what the old pack generated);
 *   a field the user changed is kept and named in `kept`;
 * - formats, labels and links outside the pack are left as they are. The versions of removed instances stay in the history.
 */
export function mergeStorePack(brief: Brief, next: StorePack | null, presets?: readonly Pick<FormatPreset, 'id' | 'width' | 'height'>[], locale: Locale = currentLocale()):
  { brief: Brief; added: string[]; removed: string[]; kept: Array<'goal' | 'message' | 'durationSec'> } {
  const prev = brief.storePack;
  const prevSlot = prev ? packSlotOf(prev, presets) : new Map<string, string>();
  const nextSlots = next ? new Set(storePackFormats(next, presets).formats) : new Set<string>();
  const removed = brief.formats.filter((f) => prevSlot.has(f) && !nextSlots.has(prevSlot.get(f)!));
  const kept0 = brief.formats.filter((f) => !removed.includes(f));
  let instances: string[] = [];
  let added: string[] = [];
  let wantLabels: Record<string, string> = {};
  let wantLinks: Record<string, string> = {};
  if (next) {
    const current = new Map<string, string>();
    for (const [id, slot] of prevSlot) if (kept0.includes(id)) current.set(slot, id);
    const a = allocatePackInstances(next, current, kept0, presets);
    if ('full' in a) throw new CodedError(409, t().variants.storePack.collision({ list: a.full }), 'store-pack-collision');
    ({ instances, added, formatLabels: wantLabels, links: wantLinks } = a);
  }
  const owned = new Set(instances);
  const formats = [...kept0];
  if (formats.length + added.length === 0) throw new CodedError(409, t().variants.storePack.lastFormats, 'store-pack-last-format');
  const lastKept = formats.reduce((k, f, i) => (owned.has(f) ? i : k), -1);
  formats.splice(lastKept >= 0 ? lastKept + 1 : formats.length, 0, ...added);

  const { storePack: _old, formatLabels: oldLabels, links: oldLinks, ...rest } = brief;
  const labels = Object.fromEntries(Object.entries(oldLabels ?? {}).filter(([k]) => !removed.includes(k)));
  for (const [k, v] of Object.entries(wantLabels)) labels[k] = v;
  let links: Record<string, string> | undefined = oldLinks === undefined ? undefined : Object.fromEntries(Object.entries(oldLinks).filter(([f, p]) => !removed.includes(f) && !removed.includes(p)));
  for (const [f, p] of Object.entries(wantLinks)) if (added.includes(f) && formats.includes(p)) (links ??= {})[f] = p;

  // What the pack generated into the brief fields (`storePackBrief`): replaced only while the field still equals it.
  const kept: Array<'goal' | 'message' | 'durationSec'> = [];
  const generatedBy = (p: StorePack) => ({
    goals: (['it', 'en'] as const).map((l) => storePackBrief(p, { locale: l, ...(presets ? { presets } : {}) }).goal),
    message: storePackBrief(p, { locale, ...(presets ? { presets } : {}) }).message,
  });
  let { goal, message, durationSec } = rest;
  if (prev && next) {
    const was = generatedBy(prev);
    const now = storePackBrief(next, { locale, ...(presets ? { presets } : {}) });
    if (was.goals.includes(goal)) goal = now.goal; else if (!now.goal || !generatedBy(next).goals.includes(goal)) kept.push('goal');
    if (message === was.message) message = now.message; else kept.push('message');
  } else if (prev && !next) {
    const was = generatedBy(prev);
    if (message === was.message) message = '';
  } else if (!prev && next) {
    // A pack set on a creative that has none: the user's own goal and message stay.
  }
  const wasPreview = prev?.preview === true;
  const nowPreview = next?.preview === true;
  if (nowPreview && !wasPreview) { if (durationSec === null) durationSec = STORE_PREVIEW_SECONDS; else if (durationSec !== STORE_PREVIEW_SECONDS) kept.push('durationSec'); }
  else if (!nowPreview && wasPreview) { if (durationSec === STORE_PREVIEW_SECONDS) durationSec = null; }
  const oldScreens = new Set(prev ? prev.screenshots.flatMap((x) => (x.screen ? [x.screen] : [])) : []);
  const newScreens = [...new Set(next ? next.screenshots.flatMap((x) => (x.screen ? [x.screen] : [])) : [])];
  const assets = [...rest.assets.filter((a) => !oldScreens.has(a)), ...newScreens].filter((a, i, all) => all.indexOf(a) === i);

  const merged: Brief = {
    ...rest, goal, message, durationSec, assets, formats,
    ...(Object.keys(labels).length > 0 ? { formatLabels: labels } : {}),
    ...(links ? { links } : {}),
    ...(next ? { storePack: { ...next, instances } } : {}),
  };
  return { brief: merged, added, removed, kept };
}

const IMAGE_MAGIC: Array<(b: Buffer) => boolean> = [
  (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  (b) => b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
];

/**
 * Checks every app screen of the pack (Phase 12, spec §4.1): a regular file under the project's `assets/` (no symbolic link,
 * real path inside the library, no hard link), listed in the library as an image, whose bytes are a PNG, JPEG or WebP. The schema already
 * confines the path to `assets/` (Task 0). Throws 400 `store-pack-screen` naming the first screen that fails.
 */
export async function verifyScreens(projectDir: string, media: MediaTools, p: StorePack): Promise<void> {
  const lib = new LibraryStore(projectDir, media);
  const listed = new Map((await lib.listAssets().catch(() => [])).map((a) => [a.file, a.kind]));
  const refuse = (file: string) => new CodedError(400, t().variants.storePack.screenNotImage({ file }), 'store-pack-screen');
  const realLib = await realpath(lib.dir('assets')).catch(() => null);
  for (const screen of new Set(p.screenshots.flatMap((s) => (s.screen ? [s.screen] : [])))) {
    const rel = screen.slice('assets/'.length);
    if (listed.get(rel) !== 'image' || !realLib) throw refuse(screen);
    const abs = join(projectDir, ...screen.split('/'));
    const st = await lstat(abs).catch(() => null);
    const real = st?.isFile() ? await realpath(abs).catch(() => null) : null;
    if (!real || !real.startsWith(realLib + sep)) throw refuse(screen);
    // Non-blocking open and fstat: only a regular file is read, 16 bytes.
    const fh = await open(abs, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW).catch(() => null);
    if (!fh) throw refuse(screen);
    try {
      // A regular file with a single name: a hard link to a file elsewhere is refused like a symbolic link.
      const st = await fh.stat();
      if (!st.isFile() || st.nlink > 1) throw refuse(screen);
      const b = Buffer.alloc(16);
      const { bytesRead } = await fh.read(b, 0, 16, 0);
      if (!IMAGE_MAGIC.some((ok) => ok(b.subarray(0, bytesRead)))) throw refuse(screen);
    } finally {
      await fh.close().catch(() => {});
    }
  }
}
