import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, sep } from 'node:path';
import { messages, storePackFormats, type Brief, type FormatPreset, type Locale, type StorePack } from '@motion-studio/shared';
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
export const STORE_PREVIEW_SECONDS = 20;

export function storePackBrief(p: StorePack, o: { locale: Locale; presets?: readonly Pick<FormatPreset, 'id' | 'width' | 'height'>[]; locales?: Brief['locales'] }): Brief {
  const { formats, formatLabels, links } = storePackFormats(p, o.presets);
  const assets = [...new Set(p.screenshots.flatMap((s) => (s.screen ? [s.screen] : [])))];
  const head = p.app.tagline ? `${p.app.name} — ${p.app.tagline}` : p.app.name;
  const message = [head, ...p.screenshots.map((s, i) => `${i + 1}. ${s.caption}`)].join('\n');
  return {
    goal: messages(o.locale).variants.storePack.goal({ app: p.app.name }),
    message, formats, formatLabels, links, assets, notes: '',
    durationSec: p.preview ? STORE_PREVIEW_SECONDS : null,
    ...(o.locales ? { locales: o.locales } : {}),
    storePack: p,
  };
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
