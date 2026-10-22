import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SUBTITLES_DIR, SUBTITLE_LIMITS, parseSubtitleSet, sha256Hex, subtitleSetHash, type Composition, type LocaleTag, type SubtitleSet,
} from '@motion-studio/shared';
import type { Git } from '../git.ts';
import { writeJsonFileAtomic } from '../json-file.ts';
import { mixClips } from '../render/audio-mix.ts';
import { readRegularFile } from '../safe-read.ts';
import type { CreativeRef } from '../creatives/creative-turns.ts';

/**
 * The subtitle sets of a creative (decision 1636): `<creativeDir>/subtitles/<lang>.json`, one per language. The agent never
 * writes this folder (it is protected in creative turns); every write goes through here, atomically.
 */
export const subtitlesDir = (creativeDir: string): string => join(creativeDir, SUBTITLES_DIR);
export const subtitlePath = (creativeDir: string, lang: LocaleTag): string => join(subtitlesDir(creativeDir), `${lang}.json`);

/** The set of `lang` and the hash of its file, or null when there is none or it is not a valid set (too large, bad schema). */
export async function readSubtitleSet(creativeDir: string, lang: LocaleTag): Promise<{ set: SubtitleSet; hash: string } | null> {
  const f = await readRegularFile(subtitlePath(creativeDir, lang), SUBTITLE_LIMITS.fileBytes);
  if (f.kind !== 'file') return null;
  const set = parseSubtitleSet(f.data.toString('utf8'));
  // A file named for another language is not that language's set.
  if (!set || set.lang !== lang) return null;
  return { set, hash: subtitleSetHash(set) };
}

/** Every valid set of the creative; a file that cannot be read as a set is skipped with a warning. */
export async function listSubtitleSets(creativeDir: string): Promise<SubtitleSet[]> {
  const names = await readdir(subtitlesDir(creativeDir)).catch(() => [] as string[]);
  const out: SubtitleSet[] = [];
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const lang = name.slice(0, -'.json'.length) as LocaleTag;
    const r = await readSubtitleSet(creativeDir, lang);
    if (r) out.push(r.set);
    else console.warn(`[subtitles] skipped ${join(subtitlesDir(creativeDir), name)}: not a valid subtitle set`);
  }
  return out;
}

/** Writes the set atomically (its exact text) and returns its hash. */
export async function writeSubtitleSet(creativeDir: string, set: SubtitleSet): Promise<string> {
  // `writeJsonFileAtomic` writes exactly `subtitleSetText` (2-space JSON, final newline), so the hash is the file's.
  await writeJsonFileAtomic(subtitlePath(creativeDir, set.lang), set);
  return subtitleSetHash(set);
}

export async function removeSubtitleSet(creativeDir: string, lang: LocaleTag): Promise<void> {
  await unlink(subtitlePath(creativeDir, lang)).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
}

/**
 * What the subtitles' timing depends on (spec §6.2): the composition's duration and the audio it mixes, in a fixed order.
 * Visual edits (text, images, layout) leave it unchanged; a moved, trimmed or re-levelled audio clip changes it.
 */
export function audioFingerprint(c: Composition): string {
  const clips = mixClips(c)
    .sort((a, b) => a.start - b.start || (a.src < b.src ? -1 : a.src > b.src ? 1 : 0))
    .map((m) => ({ src: m.src, start: m.start, duration: m.duration, trimStart: m.trimStart, volume: m.volume, fadeIn: m.fadeIn, fadeOut: m.fadeOut }));
  return sha256Hex(new TextEncoder().encode(JSON.stringify({ duration: c.duration, clips })));
}

/**
 * Batches the commits of the user's subtitle edits (decision 1646): one `commitPaths` of the creative's `subtitles` folder
 * once `quietMs` pass without a new edit of it, with the last edit's message. `flush` commits now (before a render or an
 * export reads the sets). A failed commit is left to the next one.
 */
export class SubtitleCommits {
  private readonly git: Git;
  private readonly quietMs: number;
  private readonly pending = new Map<string, { ref: CreativeRef; message: string; timer: ReturnType<typeof setTimeout> }>();
  /** The commit running now per creative (`pending` is cleared before git is awaited). */
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(o: { git: Git; quietMs?: number }) {
    this.git = o.git;
    this.quietMs = o.quietMs ?? 30_000;
  }

  touch(ref: CreativeRef, message: string): void {
    const key = keyOf(ref);
    const prev = this.pending.get(key);
    if (prev) clearTimeout(prev.timer);
    const timer = setTimeout(() => { void this.commit(key); }, this.quietMs);
    timer.unref?.();
    this.pending.set(key, { ref, message, timer });
  }

  /** Commits now the pending edits of `ref`, or of every creative; a commit the timer already started is waited for. */
  async flush(ref?: CreativeRef): Promise<void> {
    const keys = ref ? [keyOf(ref)] : [...new Set([...this.pending.keys(), ...this.inFlight.keys()])];
    await Promise.all(keys.map((k) => this.commit(k)));
  }

  private commit(key: string): Promise<void> {
    const p = this.pending.get(key);
    const before = this.inFlight.get(key);
    if (!p) return before ?? Promise.resolve();
    clearTimeout(p.timer);
    this.pending.delete(key);
    // After the commit already running for this creative (if any): a flush then waits for both.
    const run: Promise<void> = (async () => {
      await before;
      try {
        await this.git.commitPaths(p.ref.projectDir, [`creatives/${p.ref.creativeSlug}/${SUBTITLES_DIR}`], p.message);
      } catch { /* picked up by the next commit */ }
    })().finally(() => { if (this.inFlight.get(key) === run) this.inFlight.delete(key); });
    this.inFlight.set(key, run);
    return run;
  }
}

const keyOf = (ref: CreativeRef): string => `${ref.projectDir}\0${ref.creativeSlug}`;
