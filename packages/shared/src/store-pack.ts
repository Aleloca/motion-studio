// App Store / Google Play pack (Phase 12, spec §4.1): the choices of the guided flow, kept in `brief.storePack`, and the
// formats (one instance per screenshot and device) they stand for.
import { z } from 'zod';
import { DEFAULT_FORMATS, type FormatPreset } from './formats.ts';
import { INSTANCE_ID_RE, instanceIdOf, nextInstanceId, presetOf } from './format-instance.ts';
import { assetFilePath } from './localization/schema.ts';

export type StoreId = 'appstore' | 'playstore';
export const STORE_IDS = ['appstore', 'playstore'] as const;
export const APPSTORE_DEVICES = ['iphone-69', 'ipad-13'] as const;
export const PLAYSTORE_DEVICES = ['phone', 'tablet', 'feature'] as const;
/** Screenshots per store (spec §4.1); when both stores are chosen, the narrower range applies. */
export const STORE_SCREENSHOTS = { appstore: { min: 1, max: 10 }, playstore: { min: 2, max: 8 } } as const;

/** Length of the pack's preview video, in seconds: inside the App Store's 15–30 s with the brief tolerance on both sides. */
export const STORE_PREVIEW_SECONDS = 20;

/** Catalog preset of each device. */
export const STORE_DEVICE_PRESET = {
  appstore: { 'iphone-69': 'appstore-iphone-69', 'ipad-13': 'appstore-ipad-13' },
  playstore: { phone: 'playstore-phone-9x16', tablet: 'playstore-tablet', feature: 'playstore-feature' },
} as const;
/** Catalog preset of each store's preview video. */
export const STORE_PREVIEW_PRESET = { appstore: 'appstore-preview', playstore: 'playstore-promo-16x9' } as const;

/** Whether a format instance is one of a store pack's (a device screenshot, the Play feature graphic or a store preview video). */
export function isStorePackFormat(format: string): boolean {
  const preset = presetOf(format);
  return Object.values(STORE_DEVICE_PRESET).some((m) => (Object.values(m) as string[]).includes(preset)) || (Object.values(STORE_PREVIEW_PRESET) as string[]).includes(preset);
}

/** The longest caption of a pack screenshot (decision 1221: no longer 80; the agent shortens a caption that does not fit). */
export const STORE_CAPTION_MAX = 2000;
/** The longest format label (`briefSchema.formatLabels`). */
const LABEL_MAX = 60;

/**
 * Screenshot N's label: "N · caption", cut with "…" to the 60 characters of a label (decision 1221: a caption of more than
 * 56 characters made the whole pack invalid), or "N" for an empty caption.
 */
export function screenshotLabel(n: number, caption: string): string {
  const c = caption.replace(/\s+/g, ' ').trim();
  if (!c) return String(n);
  const full = `${n} · ${c}`;
  return full.length <= LABEL_MAX ? full : `${[...full].slice(0, LABEL_MAX - 1).join('').trimEnd()}…`;
}

export const storePackSchema = z.object({
  app: z.object({ name: z.string().trim().min(1).max(60), tagline: z.string().trim().max(120) }).strict(),
  stores: z.array(z.enum(STORE_IDS)).min(1).max(2).refine((s) => new Set(s).size === s.length, 'issue.duplicateStores'),
  devices: z.object({
    appstore: z.array(z.enum(APPSTORE_DEVICES)).max(2).optional(),
    playstore: z.array(z.enum(PLAYSTORE_DEVICES)).max(3).optional(),
  }).strict(),
  /**
   * One per screenshot, in order: its caption and the app screen (a file under `assets/` of the project) it shows, or null.
   * The caption may be empty (the agent takes it from the brief) and long (the agent shortens it to fit): decision 1221.
   */
  screenshots: z.array(z.object({ caption: z.string().trim().max(STORE_CAPTION_MAX), screen: assetFilePath.nullable() }).strict()).min(1).max(10),
  preview: z.boolean(),
  /**
   * The format instances this pack created, in the order of `storePackFormats` (Phase 14): the core sets it. The pack owns exactly
   * these; a hand-picked instance of the same preset is never taken over, so a new slot gets the next free id. Absent in packs
   * made before: then the pack owns `storePackFormats(pack).formats`.
   */
  instances: z.array(z.string().regex(INSTANCE_ID_RE)).max(80).optional(),
}).strict().superRefine((p, ctx) => {
  const issue = (message: string, path: (string | number)[]) => ctx.addIssue({ code: 'custom', message, path });
  const has = (s: StoreId) => p.stores.includes(s);
  if (has('appstore') && !p.devices.appstore?.includes('iphone-69')) issue('issue.storePackIphone', ['devices', 'appstore']);
  if (has('playstore') && !p.devices.playstore?.includes('phone')) issue('issue.storePackPhone', ['devices', 'playstore']);
  const n = p.screenshots.length;
  const min = Math.max(...p.stores.map((s) => STORE_SCREENSHOTS[s].min));
  const max = Math.min(...p.stores.map((s) => STORE_SCREENSHOTS[s].max));
  if (n < min || n > max) issue('issue.storePackScreenshots', ['screenshots']);
});
export type StorePack = z.infer<typeof storePackSchema>;

type SizedPreset = Pick<FormatPreset, 'id' | 'width' | 'height'>;

/**
 * The brief's formats for a pack, in display order: for each chosen store and device one instance per screenshot (the first is
 * the bare preset id), the feature graphic once, then the preview video. `formatLabels`: "N · caption" for a screenshot
 * (language-neutral: the caption is the user's text, and the UI names the preset); the feature graphic and the video have none
 * (the UI shows the preset name). `links` (follower → primary): the same screenshot on a device of the same pixel size as an
 * earlier one. The shipped store devices all have different sizes, so for the shipped presets `links` is always empty (Ruling D):
 * consistency across devices comes from the series prompt. `presets` only exists so the branch can be tested with equal sizes.
 */
export function storePackFormats(p: StorePack, presets: readonly SizedPreset[] = DEFAULT_FORMATS): { formats: string[]; formatLabels: Record<string, string>; links: Record<string, string> } {
  const sizeOf = (presetId: string) => {
    const f = presets.find((x) => x.id === presetId);
    return f ? `${f.width}x${f.height}` : presetId;
  };
  const formats: string[] = [];
  const formatLabels: Record<string, string> = {};
  const links: Record<string, string> = {};
  const firstOfSize = new Map<string, string[]>(); // size → instance ids of the first device with that size, by screenshot index
  const addVideo = (store: StoreId) => {
    if (!p.preview) return;
    const id = STORE_PREVIEW_PRESET[store];
    formats.push(id);
  };
  for (const store of p.stores) {
    const chosen: readonly string[] = p.devices[store] ?? [];
    const order: readonly string[] = store === 'appstore' ? APPSTORE_DEVICES : PLAYSTORE_DEVICES;
    for (const device of order.filter((d) => chosen.includes(d))) {
      const preset = (STORE_DEVICE_PRESET[store] as Record<string, string>)[device]!;
      if (device === 'feature') { formats.push(preset); continue; }
      const size = sizeOf(preset);
      const primaries = firstOfSize.get(size);
      const mine: string[] = [];
      p.screenshots.forEach((shot, i) => {
        const id = instanceIdOf(preset, i + 1);
        formats.push(id);
        mine.push(id);
        formatLabels[id] = screenshotLabel(i + 1, shot.caption);
        if (primaries?.[i]) links[id] = primaries[i]!;
      });
      if (!primaries) firstOfSize.set(size, mine);
    }
    addVideo(store);
  }
  return { formats, formatLabels, links };
}

/** The ids of the pack's slots (`storePackFormats`) and the instances that stand for them: `instances`, else the same ids. */
export function packInstancesOf(p: StorePack, presets: readonly SizedPreset[] = DEFAULT_FORMATS): string[] {
  const slots = storePackFormats(p, presets).formats;
  return p.instances && p.instances.length === slots.length ? [...p.instances] : slots;
}

/** Instance → its slot (the canonical id `storePackFormats` gives; captions, labels and export numbers follow the slot). */
export function packSlotOf(p: StorePack, presets: readonly SizedPreset[] = DEFAULT_FORMATS): Map<string, string> {
  const slots = storePackFormats(p, presets).formats;
  return new Map(packInstancesOf(p, presets).map((id, i) => [id, slots[i]!]));
}

/**
 * Decision 1338: the files of a brief's store pack, in the brief's order: the pack's own instances (`packSlotOf`) whose slot has a
 * place in the pack. The pack export (core) and its dialog (web) both take their list from here, so they never differ.
 */
export function packFileFormats(brief: { formats: readonly string[]; storePack?: StorePack | null }, presets: readonly SizedPreset[] = DEFAULT_FORMATS): string[] {
  if (!brief.storePack) return [];
  const slotOf = packSlotOf(brief.storePack, presets);
  return brief.formats.filter((f) => slotOf.has(f) && isStorePackFormat(slotOf.get(f)!));
}

/**
 * The instances for `next`'s slots (Phase 14): a slot the pack already had (`current`: slot → instance) keeps its instance; a
 * new one takes its own id when free, else the next free instance of its preset (never an id in `taken`). `taken`: every id the
 * brief has now, without the ones being removed. `full`: the preset with no free instance left (20 are the most).
 */
export function allocatePackInstances(next: StorePack, current: ReadonlyMap<string, string>, taken: readonly string[], presets: readonly SizedPreset[] = DEFAULT_FORMATS):
  { instances: string[]; added: string[]; formatLabels: Record<string, string>; links: Record<string, string> } | { full: string } {
  const f = storePackFormats(next, presets);
  const used = [...taken];
  const instances: string[] = [];
  const added: string[] = [];
  const actual = new Map<string, string>();
  for (const slot of f.formats) {
    let id = current.get(slot);
    if (id === undefined) {
      id = used.includes(slot) ? nextInstanceId(presetOf(slot), used) ?? undefined : slot;
      if (id === undefined) return { full: presetOf(slot) };
      used.push(id);
      added.push(id);
    }
    actual.set(slot, id);
    instances.push(id);
  }
  const formatLabels: Record<string, string> = {};
  for (const [slot, label] of Object.entries(f.formatLabels)) formatLabels[actual.get(slot)!] = label;
  const links: Record<string, string> = {};
  for (const [a, b] of Object.entries(f.links)) links[actual.get(a)!] = actual.get(b)!;
  return { instances, added, formatLabels, links };
}
