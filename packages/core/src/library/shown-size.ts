import { stat } from 'node:fs/promises';
import { displaySize, type MediaTools } from '../media/media-tools.ts';
import { LibraryStore } from './library-store.ts';

/** The most files whose shown size is remembered (oldest forgotten first). */
const SHOWN_SIZE_CACHE_MAX = 500;

/**
 * Round 2 of report 70 (N2): the size a library file (`assets/<file>`) is shown at, read with ffprobe once per file version
 * (its path, size and modification time) and remembered. `cachedOnly`: never waits for ffprobe (a live message must not be
 * held): a size not known yet is read in the background for the next time, and the answer is null (the library's size is
 * used). Null also when the file cannot be read or ffmpeg is not there.
 */
export function shownSizeReader(media: MediaTools, max = SHOWN_SIZE_CACHE_MAX) {
  const cache = new Map<string, Promise<{ width: number; height: number } | null>>();
  return async (projectDir: string, path: string, o: { cachedOnly?: boolean } = {}): Promise<{ width: number; height: number } | null> => {
    if (!media.available || !path.startsWith('assets/')) return null;
    const abs = await new LibraryStore(projectDir, media).existingFile('assets', path.slice('assets/'.length)).catch(() => null);
    const info = abs ? await stat(abs).catch(() => null) : null;
    if (!abs || !info) return null;
    const key = `${abs}\0${info.size}\0${info.mtimeMs}`;
    let read = cache.get(key);
    if (!read) {
      if (cache.size >= max) cache.delete(cache.keys().next().value!);
      read = media.probe(abs).then((p) => (p ? displaySize(p) : null), () => null);
      cache.set(key, read);
    }
    if (!o.cachedOnly) return read;
    // Already settled: its value; still reading: null now (the next message has it).
    return Promise.race([read, Promise.resolve(undefined)]).then((v) => v ?? null);
  };
}
