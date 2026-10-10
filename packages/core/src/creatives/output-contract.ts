import { lstat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { formatLabel, videoTargetBitrateKbps, manifestSchema, messages, type Locale, type FormatPreset, type OutputFileInfo, type OutputWarning } from '@motion-studio/shared';
import { findPreset } from '../formats/format-catalog.ts';
import { JsonFileError, readJsonFile } from '../json-file.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { currentLocale } from '../i18n.ts';

export interface ValidationResult { outputs: OutputFileInfo[]; problems: string[]; tools: string[]; renderCommand: string | null;
  /** Requested ids missing from the format catalog: the agent cannot fix those, so they never justify another attempt. */
  unknownPresets: string[];
}

const H264_EXTENSIONS = new Set(['mp4', 'mov', 'm4v']);

/** The preset's own target when it has one (the catalog derives it at 30 fps), else derived from its size; fps above 45 gets +50%. */
function videoTargetKbps(preset: FormatPreset, fps: number | undefined): number {
  const base = preset.targetBitrateKbps ?? videoTargetBitrateKbps(preset.width, preset.height);
  return fps !== undefined && fps > 45 ? base * 1.5 : base;
}

export async function validateOutputs(opts: {
  dir: string; requested: string[]; presets: FormatPreset[]; durationSec: number | null; media: MediaTools;
  /** Language of the problems: the job's, captured at start (default: the current one). */
  locale?: Locale;
  /**
   * Formats the core carried over unchanged from an earlier version (spec §2.5): only presence and dimensions are checked
   * (their problems stay `[]` otherwise); the agent never made them, so it is never asked to fix them.
   */
  carried?: readonly string[];
  /**
   * Followers materialized by the core, follower → primary (spec §2.3): checked like carried files, and each gets a copy of
   * its primary's own problems (the bytes are the same). Those copies are not added again to the version's `problems`.
   */
  followers?: Readonly<Record<string, string>>;
  /**
   * Problems a carried file brings from the version it was carried from (spec §2.5 ruling): they stay its own `problems`
   * and count for the version's status, but they are never sent to the agent (carried files are not in its checks).
   */
  inherited?: Readonly<Record<string, readonly string[]>>;
  /**
   * File names the core owns this turn (carried files, `<follower>.<ext>`): the owning format for `file`, if any. A
   * delivered (non-carried) file with such a name is a problem the agent can fix by renaming it.
   */
  reservedOwner?: (file: string) => string | undefined;
}): Promise<ValidationResult> {
  const { dir, media } = opts;
  const locale = opts.locale ?? currentLocale();
  const v = messages(locale).validation;
  let manifest;
  try {
    manifest = await readJsonFile(join(dir, 'manifest.json'), manifestSchema);
  } catch (err) {
    if (err instanceof JsonFileError && err.reason === 'missing') return empty([v.manifestMissing({ dir: basename(dir) })]);
    if (err instanceof JsonFileError) return empty([v.manifestInvalid({ detail: err.message.replace(/^.*?: /, '') })]);
    // e.g. a directory (EISDIR) or no read permission (EACCES): the agent can fix it like any other problem.
    if ((err as NodeJS.ErrnoException).code) return empty([v.manifestInvalid({ detail: (err as Error).message })]);
    throw err;
  }

  const problems: string[] = [];
  const outputs: OutputFileInfo[] = [];
  const unknownPresets: string[] = [];
  const followers = opts.followers ?? {};
  const isFollower = (id: string) => Object.hasOwn(followers, id);
  const carried = new Set(opts.carried ?? []);
  // Followers last: each copies its primary's problems, so the primary must be checked first.
  const order = [...opts.requested.filter((id) => !isFollower(id)), ...opts.requested.filter(isFollower)];
  for (const id of order) {
    // Per-format problems (`OutputFileInfo.problems`): each one also goes into the version's `problems`.
    const own: string[] = [];
    const problem = (text: string) => { own.push(text); if (!problems.includes(text)) problems.push(text); };
    for (const text of carried.has(id) ? opts.inherited?.[id] ?? [] : []) problem(text);
    const preset = findPreset(opts.presets, id);
    if (!preset) { problem(v.unknownPreset({ id })); unknownPresets.push(id); continue; }
    const entry = manifest.files.find((f) => f.format === id);
    if (!entry) { problem(v.missingFormat({ label: formatLabel(preset, locale), id })); continue; }
    const path = join(dir, entry.file);
    const info = await lstat(path).catch(() => null);
    if (!info || !info.isFile()) { problem(v.fileNotFound({ id, file: entry.file })); continue; }
    // Carried and followed files: presence and dimensions only.
    const strict = !carried.has(id) && !isFollower(id);
    const owner = strict ? opts.reservedOwner?.(entry.file) : undefined;
    if (owner !== undefined && owner !== id) problem(v.reservedName({ file: entry.file, format: owner }));

    const ext = extname(entry.file).slice(1).toLowerCase();
    if (strict && !preset.extensions.includes(ext)) {
      problem(v.badExtension({ file: entry.file, ext, id, allowed: preset.extensions.join(', ') }));
    }
    const sizeMB = info.size / 1e6; // decimal MB, like the large-file warning and what file managers show
    const warnings: OutputWarning[] = [];
    // maxFileMB is a real, documented upload limit of the channel: a problem for any kind of file.
    if (strict && preset.maxFileMB !== undefined && sizeMB > preset.maxFileMB) {
      problem(v.tooLarge({ file: entry.file, size: sizeMB.toFixed(1), max: preset.maxFileMB }));
    }

    const probed = media.available ? await media.probe(path) : null;
    let verified = probed !== null;
    let width = probed?.width ?? entry.width;
    let height = probed?.height ?? entry.height;
    // Images have no duration, whatever the manifest says.
    let durationSec = preset.kind === 'image' ? null : probed ? probed.durationSec : entry.durationSec ?? null;

    // If media tools were used but failed to read the file, report it and skip validation
    if (media.available && probed === null) {
      if (strict) problem(v.notReadable({ file: entry.file }));
      verified = false;
    } else {
      // Only validate resolution/duration when we have valid probe data or manifest fallback
      if (width !== preset.width || height !== preset.height) {
        problem(v.badResolution({ file: entry.file, width, height, expectedWidth: preset.width, expectedHeight: preset.height }));
      }
      if (strict && preset.kind === 'video') {
        if (probed && durationSec === null) problem(v.notAVideo({ file: entry.file }));
        if (durationSec !== null) {
          if (preset.maxDurationSec !== undefined && durationSec > preset.maxDurationSec) {
            problem(v.durationOverMax({ file: entry.file, duration: durationSec.toFixed(1), max: preset.maxDurationSec }));
          }
          const target = opts.durationSec;
          if (target !== null && Math.abs(durationSec - target) > Math.max(1, target * 0.1)) {
            problem(v.durationOffTarget({ file: entry.file, duration: durationSec.toFixed(1), target }));
          }
        }
      }
    }

    // Bitrate-based warning (never a problem): effective bitrate above 1.5x the target. Needs a known duration.
    // The target is an H.264 one: GIF and WebM outputs have none, so they never get this warning.
    if (preset.kind === 'video' && H264_EXTENSIONS.has(ext) && durationSec !== null && durationSec > 0) {
      const target = videoTargetKbps(preset, probed?.fps);
      const mbps = (info.size * 8) / durationSec / 1e6;
      if (mbps > (target / 1000) * 1.5) {
        warnings.push({ key: 'outputs.largeFile', params: {
          sizeMB: Math.round(info.size / 1e5) / 10, mbps: mbps >= 10 ? Math.round(mbps) : Math.round(mbps * 10) / 10,
          targetMbps: Math.round(target / 100) / 10, channel: preset.channel,
        } });
      }
    }

    let preview: string | null = null;
    if (preset.kind === 'video' && media.available && probed !== null) {
      // Full file name: sq.mp4 and sq.webm must not share a poster.
      const rel = `.previews/${entry.file}.jpg`;
      const previewDir = join(dir, '.previews');
      const targetPath = join(dir, rel);

      // Check if .previews exists and is safe
      let canExtractPoster = true;
      const previewDirInfo = await lstat(previewDir).catch(() => null);
      if (previewDirInfo !== null && !previewDirInfo.isDirectory()) {
        // .previews exists but is not a directory (e.g., symlink, regular file)
        canExtractPoster = false;
      }

      // Check if target jpg path is safe
      if (canExtractPoster) {
        const targetInfo = await lstat(targetPath).catch(() => null);
        if (targetInfo !== null && !targetInfo.isFile()) {
          // Target exists but is not a regular file (e.g., symlink, directory)
          canExtractPoster = false;
        }
      }

      if (canExtractPoster) {
        try {
          if (await media.poster(path, targetPath)) preview = rel;
        } catch {
          // poster() rejected (e.g., mkdir failed because .previews is a file), skip preview
          preview = null;
        }
      }
    }
    // A follower's file is its primary's bytes: it carries the primary's problems too (already in the version's list).
    const inherited = isFollower(id) ? outputs.find((o) => o.format === followers[id])?.problems ?? [] : [];
    outputs.push({ format: id, file: entry.file, width, height, durationSec, verified, preview, ...(warnings.length ? { warnings } : {}), problems: [...inherited, ...own] });
  }
  // In the requested order, whatever the checking order was.
  outputs.sort((a, b) => opts.requested.indexOf(a.format) - opts.requested.indexOf(b.format));
  return { outputs, problems, tools: manifest.tools, renderCommand: manifest.renderCommand ?? null, unknownPresets };
}

const empty = (problems: string[]): ValidationResult => ({ outputs: [], problems, tools: [], renderCommand: null, unknownPresets: [] });
