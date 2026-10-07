import { lstat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { manifestSchema, type FormatPreset, type OutputFileInfo } from '@motion-studio/shared';
import { findPreset } from '../formats/format-catalog.ts';
import { JsonFileError, readJsonFile } from '../json-file.ts';
import type { MediaTools } from '../media/media-tools.ts';

export interface ValidationResult { outputs: OutputFileInfo[]; problems: string[]; tools: string[]; renderCommand: string | null }

export async function validateOutputs(opts: {
  dir: string; requested: string[]; presets: FormatPreset[]; durationSec: number | null; media: MediaTools;
}): Promise<ValidationResult> {
  const { dir, media } = opts;
  let manifest;
  try {
    manifest = await readJsonFile(join(dir, 'manifest.json'), manifestSchema);
  } catch (err) {
    if (err instanceof JsonFileError && err.reason === 'missing') return empty([`manifest.json mancante in ${basename(dir)}`]);
    if (err instanceof JsonFileError) return empty([`manifest.json non valido: ${err.message.replace(/^.*?: /, '')}`]);
    // e.g. a directory (EISDIR) or no read permission (EACCES): the agent can fix it like any other problem.
    if ((err as NodeJS.ErrnoException).code) return empty([`manifest.json non valido: ${(err as Error).message}`]);
    throw err;
  }

  const problems: string[] = [];
  const outputs: OutputFileInfo[] = [];
  for (const id of opts.requested) {
    const preset = findPreset(opts.presets, id);
    if (!preset) { problems.push(`Preset sconosciuto: ${id} (non è nel catalogo formati)`); continue; }
    const entry = manifest.files.find((f) => f.format === id);
    if (!entry) { problems.push(`Manca il formato ${preset.channel} · ${preset.name} (${id})`); continue; }
    const path = join(dir, entry.file);
    const info = await lstat(path).catch(() => null);
    if (!info || !info.isFile()) { problems.push(`File non trovato per ${id}: ${entry.file}`); continue; }

    const ext = extname(entry.file).slice(1).toLowerCase();
    if (!preset.extensions.includes(ext)) {
      problems.push(`${entry.file}: estensione .${ext} non ammessa per ${id} (ammesse: ${preset.extensions.join(', ')})`);
    }
    const sizeMB = info.size / (1024 * 1024);
    if (preset.maxFileMB !== undefined && sizeMB > preset.maxFileMB) {
      problems.push(`${entry.file}: ${sizeMB.toFixed(1)} MB, massimo ${preset.maxFileMB} MB`);
    }

    const probed = media.available ? await media.probe(path) : null;
    let verified = probed !== null;
    let width = probed?.width ?? entry.width;
    let height = probed?.height ?? entry.height;
    // Images have no duration, whatever the manifest says.
    let durationSec = preset.kind === 'image' ? null : probed ? probed.durationSec : entry.durationSec ?? null;

    // If media tools were used but failed to read the file, report it and skip validation
    if (media.available && probed === null) {
      problems.push(`${entry.file}: file non leggibile come media`);
      verified = false;
    } else {
      // Only validate resolution/duration when we have valid probe data or manifest fallback
      if (width !== preset.width || height !== preset.height) {
        problems.push(`${entry.file}: risoluzione ${width}×${height}, attesa ${preset.width}×${preset.height}`);
      }
      if (preset.kind === 'video') {
        if (probed && durationSec === null) problems.push(`${entry.file}: non sembra un video`);
        if (durationSec !== null) {
          if (preset.maxDurationSec !== undefined && durationSec > preset.maxDurationSec) {
            problems.push(`${entry.file}: durata ${durationSec.toFixed(1)}s oltre il massimo di ${preset.maxDurationSec}s`);
          }
          const target = opts.durationSec;
          if (target !== null && Math.abs(durationSec - target) > Math.max(1, target * 0.1)) {
            problems.push(`${entry.file}: durata ${durationSec.toFixed(1)}s, richiesta circa ${target}s`);
          }
        }
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
    outputs.push({ format: id, file: entry.file, width, height, durationSec, verified, preview });
  }
  return { outputs, problems, tools: manifest.tools, renderCommand: manifest.renderCommand ?? null };
}

const empty = (problems: string[]): ValidationResult => ({ outputs: [], problems, tools: [], renderCommand: null });
