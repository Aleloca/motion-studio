import { join } from 'node:path';
import { fallbackFontFor, type LocaleTag } from '@motion-studio/shared';
import { probeConfinedFile } from '../brand/agent-guard.ts';
import { KeyedMutex } from '../keyed-mutex.ts';
import { LibraryStore } from '../library/library-store.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { installGoogleFont, type InstallIo } from '../providers/google-fonts.ts';
import type { HttpDeps } from '../providers/http.ts';

/**
 * Fallback fonts (Phase 12, spec §3.4): a language whose script is not Latin, Cyrillic or Greek gets the Noto Sans family of
 * its script (`FALLBACK_FONT_BY_SCRIPT`), downloaded ONCE per project through the phase 11 Google Fonts add path
 * (`installGoogleFont`: safe download, byte caps, the library entry with origin `google-fonts`). A family already in the
 * library (registered with that origin and tag, its files still regular files of `assets/`) is reused without any request.
 */

export interface ProjectRef {
  projectDir: string;
  /** The Google Fonts network (tests: a fake fetch). */
  http: HttpDeps;
  media: MediaTools;
  io?: InstallIo;
}

/** The fallback family could not be had (offline, refused, a failed save): the caller records "fallback font unavailable". */
export class FallbackFontUnavailable extends Error {
  constructor(readonly family: string, cause?: unknown) {
    super(`fallback font ${family} unavailable${cause instanceof Error ? `: ${cause.message}` : ''}`);
    this.name = 'FallbackFontUnavailable';
  }
}

/** The weights downloaded: regular and bold, the two a text clip most often uses. */
export const FALLBACK_WEIGHTS = [400, 700];

/** One download per project and family at a time: a second caller waits and then finds the files in the library. */
const installs = new KeyedMutex();

/** The family's files already in the project library (origin `google-fonts`, tagged with the family), as `assets/…` paths. */
async function inLibrary(projectDir: string, media: MediaTools, family: string): Promise<string[]> {
  const entries = await new LibraryStore(projectDir, media).listAssets().catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    if (e.origin !== 'google-fonts' || !e.tags?.includes(family) || !e.file.startsWith('fonts/')) continue;
    if ((await probeConfinedFile(join(projectDir, 'assets'), e.file)) === true) out.push(`assets/${e.file}`);
  }
  return out.sort().slice(0, 8);
}

/**
 * The fallback font of `locale` for the project: null when its script needs none; else the family and its files
 * (`assets/fonts/…`, paths relative to the project, which are also the paths a composition folder gets them under). Throws
 * `FallbackFontUnavailable` when it is not in the library and cannot be downloaded. `installed`: the core downloaded and wrote
 * it now (and registered it in the library); absent when the library already had it.
 */
export async function ensureFallbackFont(project: ProjectRef, locale: LocaleTag, signal: AbortSignal): Promise<{ family: string; files: string[]; installed?: true } | null> {
  const family = fallbackFontFor(locale);
  if (family === null) return null;
  return installs.run(`${project.projectDir}\0${family}`, async () => {
    const have = await inLibrary(project.projectDir, project.media, family);
    if (have.length > 0) return { family, files: have };
    try {
      const { files } = await installGoogleFont({
        http: project.http, projectDir: project.projectDir, media: project.media, family, weights: FALLBACK_WEIGHTS, italic: false, signal,
        ...(project.io ? { io: project.io } : {}),
      });
      return { family, files: files.map((f) => `assets/${f}`).slice(0, 8), installed: true };
    } catch (e) {
      throw new FallbackFontUnavailable(family, e);
    }
  });
}
