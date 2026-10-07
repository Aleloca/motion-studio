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
    const width = probed?.width ?? entry.width;
    const height = probed?.height ?? entry.height;
    const durationSec = probed ? probed.durationSec : entry.durationSec ?? null;
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

    let preview: string | null = null;
    if (preset.kind === 'video' && media.available) {
      const rel = `.previews/${basename(entry.file, extname(entry.file))}.jpg`;
      if (await media.poster(path, join(dir, rel))) preview = rel;
    }
    outputs.push({ format: id, file: entry.file, width, height, durationSec, verified: probed !== null, preview });
  }
  return { outputs, problems, tools: manifest.tools, renderCommand: manifest.renderCommand ?? null };
}

const empty = (problems: string[]): ValidationResult => ({ outputs: [], problems, tools: [], renderCommand: null });
