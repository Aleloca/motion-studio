// Subtitle choices of an export (subtitles Task 21, spec §6.6, decision 1643, anti-goals 2 and 4). What each exported item
// becomes when the export asks for subtitles: the videos drawn with a language (`<stem>-sub-<lang>`), and the CLEAN video
// `<stem>` that the `.srt`/`.vtt` files and the soft `mov_text` tracks go with. A video with files or soft tracks never has
// subtitles drawn into it. An export without subtitles never comes here.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exportExtension, normalizeComposition, renderState, toSrt, type Composition, type LocaleTag, type SubtitleSet, type VersionEntry } from '@motion-studio/shared';
import { copyConfinedFile } from '../brand/agent-guard.ts';
import { readCompositionJson } from '../compositions/composition-files.ts';
import { softRemuxArgs, spawnFfmpeg, type FfmpegInfo } from '../render/encode.ts';
import { drawsSubtitles } from '../subtitles/store.ts';
import { t } from '../i18n.ts';
import { VIDEO_EXTENSIONS, type ExportItem } from './export.ts';
import type { ExportRenderOptions } from './render-jobs.ts';

/** The subtitles an export asks for: `files` with their sets (read and checked by the route), `drawn` and `soft` by language. */
export interface SubtitleChoice { drawn: LocaleTag[]; files: SubtitleSet[]; soft: LocaleTag[]; durationMs?: number }

/**
 * One file of a subtitled export: `copy` the item as it is; `remux` the version's clean file with the soft tracks muxed into a
 * copy of it; `render` a render made for the export with `subtitles` (`key` groups the items rendered the same way).
 */
export type SubtitleEntry =
  | { kind: 'copy'; item: ExportItem }
  | { kind: 'remux'; item: ExportItem }
  | { kind: 'render'; item: ExportItem; key: string; subtitles: NonNullable<ExportRenderOptions['subtitles']> };

/** Containers a `mov_text` track goes into (the renderer's video containers). */
const SOFT_CONTAINERS: Record<string, string> = { '.mp4': 'mp4', '.mov': 'mov', '.m4v': 'mp4' };

/**
 * The composition of an item's format in its version, for what the export needs of it: a still (no time), and whether it draws
 * subtitles. Null for a legacy item (no compositions). A composition that cannot be read counts as one with the track, so the
 * clean video is rendered with the track off (anti-goal 2) rather than copied with subtitles it might have.
 */
async function compositionFacts(creativeDir: string, v: VersionEntry | undefined, format: string): Promise<{ still: boolean; track: boolean } | null> {
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
 * What each item becomes (the order: per item, the clean video first, then one video per drawn language). `profiled`: the items
 * an export at another quality or size renders for itself (`profiledRenders`); `hashes`: the subtitle sets' current hashes.
 * Translated items (`localized`) are exported as they are: the pairing of subtitles with a translated video is phase 4.
 * Returns the entries and the notes for `skipped` (a still, a video with no subtitles track, a file that takes no tracks).
 */
export async function planSubtitleExport(o: { creativeDir: string; versions: VersionEntry[]; items: ExportItem[]; choice: SubtitleChoice;
  profiled: ReadonlyMap<number, string[]>; hashes: Readonly<Record<string, string>>; label: (format: string) => string }): Promise<{ entries: SubtitleEntry[]; notes: string[] }> {
  const { choice } = o;
  const entries: SubtitleEntry[] = [];
  const notes: string[] = [];
  const note = (text: string) => { if (!notes.includes(text)) notes.push(text); };
  const clean = choice.files.length > 0 || choice.soft.length > 0;
  const files = choice.files.length > 0 ? { subtitleFiles: { sets: choice.files, ...(choice.durationMs !== undefined ? { durationMs: choice.durationMs } : {}) } } : {};
  for (const it of o.items) {
    if (it.localized) { entries.push({ kind: 'copy', item: it }); continue; }
    const v = o.versions.find((x) => x.n === it.n);
    const facts = await compositionFacts(o.creativeDir, v, it.format);
    const ext = exportExtension(it.file);
    if (facts ? facts.still : !VIDEO_EXTENSIONS.has(ext)) {
      note(t().export.subtitlesStill({ format: o.label(it.format) }));
      entries.push({ kind: 'copy', item: it });
      continue;
    }
    const track = facts?.track ?? false;
    // A v2 item renders for the export when its video is not the one wanted: drawn with the track, or another quality or size.
    const profiled = facts !== null && (o.profiled.get(it.n) ?? []).includes(it.format);
    if (clean) {
      if (facts && (track || profiled)) {
        entries.push({ kind: 'render', item: { ...it, ...files }, key: 'clean', subtitles: { drawn: null, strip: track, soft: [...choice.soft] } });
      } else if (choice.soft.length > 0 && SOFT_CONTAINERS[ext] !== undefined) {
        entries.push({ kind: 'remux', item: { ...it, ...files } });
      } else {
        if (choice.soft.length > 0) note(t().export.subtitlesNoSoft({ format: o.label(it.format) }));
        entries.push({ kind: 'copy', item: { ...it, ...files } });
      }
    }
    for (const lang of choice.drawn) {
      if (!track || !facts) { note(t().export.subtitlesNoTrack({ format: o.label(it.format), lang })); continue; }
      // The version render is reused when it already draws that language's set as it is now (and is the profile asked for).
      const rec = v!.outputs.find((x) => x.format === it.format)?.subtitles;
      const reuse = !profiled && rec?.lang === lang && rec.hash !== null && rec.hash === o.hashes[lang] && renderState(v!, it.format, o.hashes) === 'rendered';
      if (reuse) entries.push({ kind: 'copy', item: { ...it, subtitled: lang } });
      else entries.push({ kind: 'render', item: { ...it, subtitled: lang }, key: `drawn:${lang}`, subtitles: { drawn: lang, strip: false, soft: [] } });
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
