import { lstat, mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SUBTITLES_DIR, SUBTITLE_LIMITS, drawsSubtitles, followSourceTimes, parseSubtitleSet, sha256Hex, subtitleCuesHash, subtitleSetHash, subtitleSetSchema, subtitleSetText, type Brief, type Composition, type LocaleTag, type SubtitleSet,
} from '@motion-studio/shared';
import type { RuntimeCue, RuntimeSubtitles } from '@motion-studio/composition-runtime/page';
import { noteCoreChange } from '../core-changes.ts';
import { noteCoreOutputWrite } from '../creatives/carry-over.ts';
import { realDirChain, writeThroughTemp } from '../creatives/core-files.ts';
import type { Git } from '../git.ts';
import { writeJsonFileAtomic } from '../json-file.ts';
import { KeyedMutex } from '../keyed-mutex.ts';
import { mixClips } from '../render/audio-mix.ts';
import { readRegularFile } from '../safe-read.ts';
import type { CreativeRef } from '../creatives/creative-turns.ts';

/**
 * The subtitle sets of a creative (decision 1636): `<creativeDir>/subtitles/<lang>.json`, one per language. The agent never
 * writes this folder (it is protected in creative turns); every write goes through here, atomically.
 */
export const subtitlesDir = (creativeDir: string): string => join(creativeDir, SUBTITLES_DIR);
export const subtitlePath = (creativeDir: string, lang: LocaleTag): string => join(subtitlesDir(creativeDir), `${lang}.json`);

/**
 * Decision 1654: every read-modify-write of a creative's sets (the editor's save, the job's final re-read + merge + write)
 * runs under this lock, keyed by the creative's folder, so neither loses the other's change. One per process: the server
 * and the job share it by importing it from here. A plain read needs no lock (writes are atomic).
 */
export const subtitleSetLocks = new KeyedMutex();

/**
 * The set of `lang`, the hash of its file (save conflicts) and of its lines (`subtitleCuesHash`: renders, final review M3), or
 * null when there is none or it is not a valid set (too large, bad schema).
 */
export async function readSubtitleSet(creativeDir: string, lang: LocaleTag): Promise<{ set: SubtitleSet; hash: string; cuesHash: string } | null> {
  const f = await readRegularFile(subtitlePath(creativeDir, lang), SUBTITLE_LIMITS.fileBytes);
  if (f.kind !== 'file') return null;
  const set = parseSubtitleSet(f.data.toString('utf8'));
  // A file named for another language is not that language's set.
  if (!set || set.lang !== lang) return null;
  return { set, hash: subtitleSetHash(set), cuesHash: subtitleCuesHash(set) };
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
  // The first set creates `subtitles/`, an entry of the creative folder: noted so the post-run tripwire does not read it as a
  // move (as `appendConversation`'s FP3).
  const dir = subtitlesDir(creativeDir);
  if (!(await lstat(dir).then(() => true, () => false))) {
    await mkdir(dir, { recursive: true });
    await noteCoreChange(creativeDir);
  }
  // Through the schema first (review M1): its keys in the schema's order, so the hash written is the one every read gives.
  const clean = subtitleSetSchema.parse(set);
  // `writeJsonFileAtomic` writes exactly `subtitleSetText` (2-space JSON, final newline), so the hash is the file's.
  await writeJsonFileAtomic(subtitlePath(creativeDir, clean.lang), clean);
  return subtitleSetHash(clean);
}

export async function removeSubtitleSet(creativeDir: string, lang: LocaleTag): Promise<void> {
  await unlink(subtitlePath(creativeDir, lang)).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
}

/** Every valid set's lines hash by language (`renderState`'s map, `subtitleCuesHash`): `{}` when the creative has none. */
export async function subtitleHashes(creativeDir: string): Promise<Record<string, string>> {
  const names = await readdir(subtitlesDir(creativeDir)).catch(() => [] as string[]);
  const out: Record<string, string> = {};
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    const r = await readSubtitleSet(creativeDir, name.slice(0, -'.json'.length) as LocaleTag);
    if (r) out[r.set.lang] = r.cuesHash;
  }
  return out;
}

/** Whether the composition draws subtitles (shared with the subtitle editor, Task 22). */
export { drawsSubtitles };

/**
 * The set made from the speech of the original video (Task 24): the first by language made from speech whose timing is not a
 * language's own localized video (`timing.locale`). The only source of the translations and of the original video's default
 * subtitles: a set of a localized voice is timed on another audio. Undefined when there is none.
 */
export function speechSourceSet(sets: readonly SubtitleSet[]): SubtitleSet | undefined {
  return sets.find((s) => s.origin === 'speech' && s.timing.locale === undefined);
}

/**
 * Task 25: the translations of the original speech set follow it when it is written again (`after`; `before`: the set as it
 * was, read under the same lock, null when there was none): each translation of its language gets `followSourceTimes` and,
 * when every uncorrected line found its source line, the source's timing (else its own stays: `timingChanged` keeps saying
 * so, review round 2). Written when that changed. To be called under the creative's set lock, by the writer of the source.
 * The languages written (to commit and tell the clients).
 */
export async function followSource(creativeDir: string, before: SubtitleSet | null, after: SubtitleSet): Promise<LocaleTag[]> {
  const sets = await listSubtitleSets(creativeDir);
  if (speechSourceSet(sets)?.lang !== after.lang) return [];
  const out: LocaleTag[] = [];
  for (const s of sets) {
    if (s.origin !== 'translation' || s.sourceLang !== after.lang) continue;
    const r = followSourceTimes(s.cues, (before ?? after).cues, after.cues);
    const next: SubtitleSet = { ...s, timing: r.complete ? after.timing : s.timing, cues: r.cues };
    if (subtitleSetHash(next) === subtitleSetHash(s)) continue;
    await writeSubtitleSet(creativeDir, next);
    out.push(s.lang);
  }
  return out;
}

/**
 * The default subtitle language of a render (U8, spec §6.6): a localized render (`localized`) draws its own language's set,
 * else none; a version render draws the brief's primary language when it has a set, else the set made from the speech of the
 * original video (`speechSourceSet`). Null: none.
 */
export async function defaultSubtitleLang(creativeDir: string, brief: Pick<Brief, 'locales'>, localized?: LocaleTag): Promise<LocaleTag | null> {
  if (localized !== undefined) return (await readSubtitleSet(creativeDir, localized)) ? localized : null;
  const primary = brief.locales?.primary;
  if (primary && await readSubtitleSet(creativeDir, primary)) return primary;
  return speechSourceSet(await listSubtitleSets(creativeDir))?.lang ?? null;
}

/**
 * The set of `lang` as the runtime draws it (spec §6.1 "Versions"): inlined in the page's data (`CompositionData.subtitles`),
 * never a file the renderer reads. Its cues are clamped to the composition (`durationMs`): a cue starting at or after the end
 * is dropped, one running past it is cut there (its words too). Null when the composition draws no subtitles
 * (`drawsSubtitles`), when there is no language, or no valid set in it; `hash` is its lines' (`subtitleCuesHash`, final
 * review M3), the one a render records.
 */
export async function stageSubtitles(o: { creativeDir: string; composition: Composition; lang: LocaleTag | null; durationMs: number }):
  Promise<{ data: RuntimeSubtitles; hash: string; set: SubtitleSet } | null> {
  if (o.lang === null || !(o.durationMs > 0) || !drawsSubtitles(o.composition)) return null;
  const r = await readSubtitleSet(o.creativeDir, o.lang);
  if (!r) return null;
  const end = o.durationMs;
  const cues: RuntimeCue[] = [];
  for (const c of r.set.cues) {
    if (c.start >= end) continue;
    const words = c.words?.filter((w) => w.start < end).map((w) => ({ start: w.start, end: Math.min(w.end, end), text: w.text }));
    cues.push({ start: c.start, end: Math.min(c.end, end), text: c.text, ...(words ? { words } : {}) });
  }
  return { data: { lang: r.set.lang, cues }, hash: r.cuesHash, set: r.set };
}

/**
 * The set a render or preview of `composition` draws by default (`defaultSubtitleLang`, then `stageSubtitles` up to its
 * duration). Nothing is read for a composition that draws no subtitles (anti-goal 4).
 */
export async function stageDefaultSubtitles(creativeDir: string, brief: Pick<Brief, 'locales'>, composition: Composition, localized?: LocaleTag):
  Promise<{ data: RuntimeSubtitles; hash: string; set: SubtitleSet } | null> {
  if (!drawsSubtitles(composition)) return null;
  const lang = await defaultSubtitleLang(creativeDir, brief, localized);
  return stageSubtitles({ creativeDir, composition, lang, durationMs: Math.round(composition.duration * 1000) });
}

/**
 * Keeps the set a render of version `n` draws next to its output (spec §6.1 "Versions"):
 * `outputs/v<n>/subtitles/<lang>.<hash first 12>.json`, the set file's exact text, so a past render can be told apart and
 * re-exported as it was. Written before the render through a temp file noted as the core's own write (a turn's check of
 * earlier versions never reads it as the agent's); a snapshot already there with that content is kept. Returns its path
 * relative to the creative folder.
 */
export async function writeSubtitleSnapshot(creativeDir: string, n: number, set: SubtitleSet, hash: string): Promise<string> {
  const name = `${set.lang}.${hash.slice(0, 12)}.json`;
  const dirRel = `outputs/v${n}/${SUBTITLES_DIR}`;
  const rel = `${dirRel}/${name}`;
  const text = subtitleSetText(set);
  const have = await readRegularFile(join(creativeDir, ...rel.split('/')), SUBTITLE_LIMITS.fileBytes);
  if (have.kind === 'file' && have.data.toString('utf8') === text) return rel;
  const dir = await realDirChain(creativeDir, ['outputs', `v${n}`, SUBTITLES_DIR]);
  if (!dir) throw new Error(`${dirRel} is not a folder of the creative`);
  const written = await writeThroughTemp(dir, name, async (temp) => {
    await writeFile(temp, text, { flag: 'wx', mode: 0o644 });
    await noteCoreOutputWrite(creativeDir, rel, temp);
    return true;
  });
  if (!written) throw new Error(`${rel} could not be written`);
  await noteCoreOutputWrite(creativeDir, dirRel);
  return rel;
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
