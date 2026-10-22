// Subtitle choices of an export (subtitles Task 21, spec §6.6, decision 1643, anti-goals 2 and 4). What each exported item
// becomes when the export asks for subtitles: the videos drawn with a language (`<stem>-sub-<lang>`), and the CLEAN video
// `<stem>` that the `.srt`/`.vtt` files and the soft `mov_text` tracks go with. A video with files or soft tracks never has
// subtitles drawn into it. An export without subtitles never comes here. Task 27 (U8): each drawn language goes on a video
// language of its own (a pair), and files and soft tracks go with every exported video language's clean video.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exportExtension, normalizeComposition, renderState, subtitlesFitVideo, toSrt, type Composition, type LocaleTag, type SubtitleSet, type VersionEntry } from '@motion-studio/shared';
import { copyConfinedFile } from '../brand/agent-guard.ts';
import { readCompositionJson } from '../compositions/composition-files.ts';
import { softRemuxArgs, spawnFfmpeg, type FfmpegInfo } from '../render/encode.ts';
import { drawsSubtitles } from '../subtitles/store.ts';
import { t } from '../i18n.ts';
import { VIDEO_EXTENSIONS, type ExportItem } from './export.ts';
import type { ExportRenderOptions } from './render-jobs.ts';

/** A drawn video (Task 27): the subtitles of `lang` on the video of `video` (null: the original video). */
export interface SubtitlePair { video: LocaleTag | null; lang: LocaleTag }

/** The subtitles an export asks for: `files` with their sets (read and checked by the route), `drawn` by pair, `soft` by language. */
export interface SubtitleChoice { drawn: SubtitlePair[]; files: SubtitleSet[]; soft: LocaleTag[]; durationMs?: number;
  /** Every set the request named, read once with it: the soft tracks are made from these, like the side files. */
  sets: Partial<Record<LocaleTag, SubtitleSet>> }

/**
 * One file of a subtitled export: `copy` the item as it is; `remux` the version's clean file with the `soft` tracks muxed into a
 * copy of it; `render` a render made for the export with `subtitles` (`key` groups the items rendered the same way).
 */
export type SubtitleEntry =
  | { kind: 'copy'; item: ExportItem }
  | { kind: 'remux'; item: ExportItem; soft: LocaleTag[] }
  | { kind: 'render'; item: ExportItem; key: string; subtitles: NonNullable<ExportRenderOptions['subtitles']> };

/** Containers a `mov_text` track goes into (the renderer's video containers). */
const SOFT_CONTAINERS: Record<string, string> = { '.mp4': 'mp4', '.mov': 'mov', '.m4v': 'mp4' };

/** The video of an item: its language for a translated render, null for the original. */
const videoOf = (it: ExportItem): LocaleTag | null => (it.localized && it.locale !== undefined ? it.locale as LocaleTag : null);

/**
 * What goes with the clean video of `video` (Task 27): the files and soft tracks whose sets fit it (`subtitlesFitVideo`: a set
 * timed on a localized voice only on that video; the route refuses one that fits no exported video).
 */
function cleanFor(choice: Pick<SubtitleChoice, 'files' | 'soft' | 'sets'>, video: LocaleTag | null): { files: SubtitleSet[]; soft: LocaleTag[] } {
  const fits = (set: SubtitleSet | undefined) => !set || (video === null ? set.timing.locale === undefined : subtitlesFitVideo(set.timing, video));
  return { files: choice.files.filter(fits), soft: choice.soft.filter((lang) => fits(choice.sets[lang])) };
}

/**
 * The composition of an item's format in its version, for what the export needs of it: a still (no time), and whether it draws
 * subtitles. Null for a legacy item (no compositions). A composition that cannot be read counts as one with the track, so the
 * clean video is rendered with the track off (anti-goal 2) rather than copied with subtitles it might have.
 */
export async function compositionFacts(creativeDir: string, v: VersionEntry | undefined, format: string): Promise<{ still: boolean; track: boolean } | null> {
  const entry = v?.compositions?.find((c) => c.format === format);
  if (!v || !entry) return null;
  const parsed = await readCompositionJson(join(creativeDir, 'outputs', `v${v.n}`, ...entry.dir.split('/'))).catch(() => null);
  try {
    if (parsed?.ok) {
      const c = normalizeComposition(parsed.value) as Composition;
      return { still: !(c.duration > 0), track: drawsSubtitles(c) };
    }
  } catch { /* unreadable: below */ }
  return { still: false, track: true };
}

/**
 * Whether an item's version render is of no use to a subtitled export (review round 1): the export renders everything it gives
 * from that item itself, so the version render a ★ without a current one would get first is skipped. True for a video with
 * the subtitles track unless a language drawn on the original video is the one the version render draws (`defaultLang`,
 * reused), and for a video without the track when only drawn languages are asked of it (it gives nothing). A still, a legacy
 * item and an original video asked for nothing (Task 27: exported as it is) always use their file.
 */
export async function skipsVersionRender(o: { creativeDir: string; versions: VersionEntry[]; item: ExportItem; choice: Pick<SubtitleChoice, 'drawn' | 'files' | 'soft' | 'sets'>; defaultLang: LocaleTag | null }): Promise<boolean> {
  if (o.item.localized) return false;
  const facts = await compositionFacts(o.creativeDir, o.versions.find((x) => x.n === o.item.n), o.item.format);
  if (!facts || facts.still) return false;
  const drawn = o.choice.drawn.filter((p) => p.video === null).map((p) => p.lang);
  const c = cleanFor(o.choice, null);
  const clean = c.files.length > 0 || c.soft.length > 0;
  if (!clean && drawn.length === 0) return false;
  if (facts.track) return o.defaultLang === null || !drawn.includes(o.defaultLang);
  return !clean;
}

/**
 * Whether a translated render is of no use to a subtitled export (Task 27): with the subtitles track, its clean video or a
 * language drawn on it is rendered for the export from the localized composition, so its row render is not made first.
 */
export async function skipsLocalizedRender(o: { creativeDir: string; versions: VersionEntry[]; item: ExportItem; locale: LocaleTag; choice: Pick<SubtitleChoice, 'drawn' | 'files' | 'soft' | 'sets'> }): Promise<boolean> {
  const facts = await compositionFacts(o.creativeDir, o.versions.find((x) => x.n === o.item.n), o.item.format);
  if (!facts || facts.still || !facts.track) return false;
  const c = cleanFor(o.choice, o.locale);
  return c.files.length > 0 || c.soft.length > 0 || o.choice.drawn.some((p) => p.video === o.locale);
}

/**
 * What each item becomes (the order: per item, the clean video first, then one video per language drawn on it). `items`: the
 * exported videos (the original's and each exported language's, `localized`); `pairOnly` (Task 27): videos named only by a
 * drawn pair, which give their drawn videos and nothing else. An exported video asked for nothing (no file or track fits it, no
 * language drawn on it) is copied as it is. `profiled`: the original items an export at another quality or size renders for
 * itself (`profiledRenders`); `hashes`: the subtitle sets' current hashes. Returns the entries and the notes for `skipped` (a
 * still, a video with no subtitles track, a file that takes no tracks).
 */
export async function planSubtitleExport(o: { creativeDir: string; versions: VersionEntry[]; items: ExportItem[]; pairOnly?: ExportItem[]; choice: SubtitleChoice;
  profiled: ReadonlyMap<number, string[]>; hashes: Readonly<Record<string, string>>; label: (format: string) => string }): Promise<{ entries: SubtitleEntry[]; notes: string[] }> {
  const { choice } = o;
  const entries: SubtitleEntry[] = [];
  const notes: string[] = [];
  const note = (text: string) => { if (!notes.includes(text)) notes.push(text); };
  for (const [it, exported] of [...o.items.map((x) => [x, true] as const), ...(o.pairOnly ?? []).map((x) => [x, false] as const)]) {
    const video = videoOf(it);
    const drawn = choice.drawn.filter((p) => p.video === video).map((p) => p.lang);
    const own = exported ? cleanFor(choice, video) : { files: [], soft: [] };
    const clean = own.files.length > 0 || own.soft.length > 0;
    if (!clean && drawn.length === 0) { if (exported) entries.push({ kind: 'copy', item: it }); continue; }
    const v = o.versions.find((x) => x.n === it.n);
    const facts = await compositionFacts(o.creativeDir, v, it.format);
    const ext = exportExtension(it.file);
    if (facts ? facts.still : !VIDEO_EXTENSIONS.has(ext)) {
      note(t().export.subtitlesStill({ format: o.label(it.format) }));
      if (exported) entries.push({ kind: 'copy', item: it });
      continue;
    }
    const track = facts?.track ?? false;
    // A v2 item renders for the export when its video is not the one wanted: drawn with the track, or another quality or size.
    const profiled = video === null && facts !== null && (o.profiled.get(it.n) ?? []).includes(it.format);
    const files = own.files.length > 0 ? { subtitleFiles: { sets: own.files, ...(choice.durationMs !== undefined ? { durationMs: choice.durationMs } : {}) } } : {};
    const at = video !== null ? { video } : {};
    if (clean) {
      if (facts && (track || profiled)) {
        entries.push({ kind: 'render', item: { ...it, ...files }, key: `clean:${video ?? ''}`, subtitles: { ...at, drawn: null, strip: track, soft: [...own.soft], sets: choice.sets } });
      } else if (own.soft.length > 0 && SOFT_CONTAINERS[ext] !== undefined) {
        entries.push({ kind: 'remux', item: { ...it, ...files }, soft: [...own.soft] });
      } else {
        if (own.soft.length > 0) note(t().export.subtitlesNoSoft({ format: o.label(it.format) }));
        entries.push({ kind: 'copy', item: { ...it, ...files } });
      }
    }
    for (const lang of drawn) {
      if (!track || !facts) { note(t().export.subtitlesNoTrack({ format: o.label(it.format), lang })); continue; }
      // The version render (or the translated render) is reused when it already draws that language's set as it is now (and
      // is the profile asked for). A translated item has a file only when its render is current (`resolveLocalizedItems`).
      const rec = v!.outputs.find((x) => x.format === it.format)?.subtitles;
      const reuse = video !== null ? it.file !== '' && it.draws === lang
        : !profiled && rec?.lang === lang && rec.hash !== null && rec.hash === o.hashes[lang] && renderState(v!, it.format, o.hashes) === 'rendered';
      if (reuse) entries.push({ kind: 'copy', item: { ...it, subtitled: lang } });
      else entries.push({ kind: 'render', item: { ...it, subtitled: lang }, key: `drawn:${video ?? ''}:${lang}`, subtitles: { ...at, drawn: lang, strip: false, soft: [] } });
    }
  }
  return { entries, notes };
}

/**
 * The soft tracks muxed into a copy of an item's version file (no render, `-c copy`): the file copied by the confined read into
 * `work`, the SRT files written there (cut at `durationMs`), then muxed into `work/<format><ext>`. Returns that path.
 */
export async function remuxSoft(o: { ff: FfmpegInfo; creativeDir: string; item: ExportItem; sets: SubtitleSet[]; durationMs: number; work: string; signal?: AbortSignal }): Promise<string> {
  const ext = exportExtension(o.item.file);
  const dir = await mkdtemp(join(o.work, 'soft-'));
  const input = join(dir, `in${ext}`);
  await copyConfinedFile(o.creativeDir, `outputs/v${o.item.n}/${o.item.file}`, input);
  const soft: Array<{ lang: LocaleTag; srt: string }> = [];
  for (const set of o.sets) {
    const srt = join(dir, `${set.lang}.srt`);
    await writeFile(srt, toSrt(set.cues, { durationMs: o.durationMs }));
    soft.push({ lang: set.lang, srt });
  }
  const out = join(dir, `${o.item.format}${ext}`);
  try {
    await spawnFfmpeg(o.ff, softRemuxArgs({ input, soft, format: SOFT_CONTAINERS[ext]!, out }), o.signal ? { signal: o.signal } : {}).done;
  } finally {
    await rm(input, { force: true }).catch(() => {});
  }
  return out;
}
