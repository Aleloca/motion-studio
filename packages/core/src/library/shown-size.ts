import { stat } from 'node:fs/promises';
import { displaySize, type MediaTools } from '../media/media-tools.ts';
import { LibraryStore } from './library-store.ts';

/** The most files whose shown size is remembered (oldest forgotten first). */
const SHOWN_SIZE_CACHE_MAX = 500;
/** Round 3 (R2-3): the most ffprobe runs at once. */
const SHOWN_SIZE_PARALLEL = 4;

/**
 * Round 2 of report 70 (N2): the size a library file (`assets/<file>`) is shown at, read with ffprobe once per file version
 * (its path, size and modification time) and remembered. `cachedOnly`: never waits for ffprobe (a live message must not be
 * held): a size not known yet is read in the background for the next time, and the answer is null (the library's size is
 * used). Null also when the file cannot be read or ffmpeg is not there.
 */
export function shownSizeReader(media: MediaTools, max = SHOWN_SIZE_CACHE_MAX, parallel = SHOWN_SIZE_PARALLEL) {
  const cache = new Map<string, Promise<{ width: number; height: number } | null>>();
  let running = 0;
  const queue: Array<() => void> = [];
  /** One ffprobe run, waiting for a free slot (at most `parallel` at once). */
  const limited = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (running >= parallel) await new Promise<void>((r) => queue.push(r));
    running++;
    try { return await fn(); } finally { running--; queue.shift()?.(); }
  };
  return async (projectDir: string, path: string, o: { cachedOnly?: boolean } = {}): Promise<{ width: number; height: number } | null> => {
    if (!media.available || !path.startsWith('assets/')) return null;
    const abs = await new LibraryStore(projectDir, media).existingFile('assets', path.slice('assets/'.length)).catch(() => null);
    const info = abs ? await stat(abs).catch(() => null) : null;
    if (!abs || !info) return null;
    const key = `${abs}\0${info.size}\0${info.mtimeMs}`;
    let read = cache.get(key);
    if (!read) {
      if (cache.size >= max) cache.delete(cache.keys().next().value!);
      read = limited(() => media.probe(abs)).then((p) => (p ? displaySize(p) : null), () => null);
      cache.set(key, read);
      // Round 3 (R2-2): a read that failed is not remembered: the next message tries again.
      const mine = read;
      void mine.then((v) => { if (v === null && cache.get(key) === mine) cache.delete(key); });
    }
    if (!o.cachedOnly) return read;
    // Already settled: its value; still reading: null now (the next message has it).
    return Promise.race([read, Promise.resolve(undefined)]).then((v) => v ?? null);
  };
}
