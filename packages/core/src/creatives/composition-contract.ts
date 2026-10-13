import { rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import {
  COMPOSITION_LIMITS, compositionHash, compositionProblem, compositionProblemText, formatLabel, isDurationOffBrief, messages, normalizeComposition, staticLayerCheck,
  type Composition, type CompositionProblem, type FormatPreset, type Locale,
} from '@motion-studio/shared';
import { readConfinedFile, withConfinedFile } from '../brand/agent-guard.ts';
import { loadComposition, readCompositionFolder, readCompositionJson, type CompositionFolder } from '../compositions/composition-files.ts';
import { noteCoreTemp } from '../core-temps.ts';
import { findPreset } from '../formats/format-catalog.ts';
import { isRealDirChain } from './core-files.ts';

/**
 * Output contract v2 (spec §4, Task 5b): the agent delivers one composition folder per target format,
 * `outputs/vN/compositions/<format>/` (`composition.json`, `layers/*.html`, `assets/…`), and no media and no manifest:
 * Motion Studio validates, hashes, writes the manifest v2 and renders on demand.
 *
 * - **Problems** (they drive the fix loop and the version's status): the folder cannot be read safely (links, hard links,
 *   special files, limits, names equal after NFC), `composition.json` missing or invalid (`validateComposition` against the
 *   format, after `normalizeComposition`), and a video duration far from the brief's (the phase 8 rule: more than the
 *   greater of 1 s and 10%).
 * - **Warnings** (advisory, never blocking): the static checks of every `layers/*.html` (`staticLayerCheck`: network,
 *   workers, audio, autoplay), and the validator's own warnings (e.g. a still's ignored animations). The runtime isolation
 *   is the boundary; these only help the agent.
 * - The **hash** is the core's own (`readCompositionFolder` → `compositionHash`), computed from the files after the agent is
 *   gone; nothing the agent writes is trusted for it.
 */

export interface CompositionCheck {
  format: string;
  /** `compositions/<format>`. */
  dir: string;
  /** No problems. */
  ok: boolean;
  /** The folder's composition hash; null when the folder is missing or cannot be read safely. */
  hash: string | null;
  /**
   * The hash the folder will have once `composition.json` is normalised on disk after the turn (`writeNormalized`): what
   * `validate_composition` reports during the turn, so it matches the recorded hash (fix minor 4).
   */
  finalHash: string | null;
  problems: CompositionProblem[];
  warnings: CompositionProblem[];
  /** The normalised composition when it is valid. */
  composition: Composition | null;
  folder: CompositionFolder | null;
}

export const compositionDirOf = (format: string) => `compositions/${format}`;

/** Most bytes of one html layer read for the static checks (the composition server's own layer limit). */
const MAX_LAYER_BYTES = 5 * 1024 * 1024;

/** The static checks of every `layers/**.html` of a readable folder (warnings). */
async function layerWarnings(compDir: string, folder: CompositionFolder): Promise<CompositionProblem[]> {
  const out: CompositionProblem[] = [];
  for (const f of folder.files) {
    if (!f.path.startsWith('layers/') || !/\.html?$/i.test(f.path)) continue;
    const r = await readConfinedFile(compDir, f.path, MAX_LAYER_BYTES).catch(() => null);
    if (r && 'text' in r) out.push(...staticLayerCheck(r.text, f.path));
    if (out.length >= 50) break;
  }
  return out.slice(0, 50);
}

/**
 * Checks one format's composition folder (see the module comment). `briefDurationSec`: the brief's target, if any (null:
 * not checked, as for a direct edit, decisions log 262). `acceptedDuration`: a duration the version being built on already
 * had for this format and recorded without a problem (a direct edit's): kept as it is, it is not off the brief again.
 */
export async function checkComposition(compDir: string, format: string, preset: FormatPreset, briefDurationSec: number | null, acceptedDuration?: number): Promise<CompositionCheck> {
  const dir = compositionDirOf(format);
  const loaded = await loadComposition(compDir, preset);
  let folder: CompositionFolder | null = loaded.ok ? loaded.folder : null;
  if (!loaded.ok && loaded.hash !== null) folder = await readCompositionFolder(compDir).catch(() => null);
  const warnings = [...(loaded.ok ? loaded.warnings : []), ...(folder ? await layerWarnings(compDir, folder) : [])];
  const finalHash = folder ? await normalizedHash(compDir, folder) : null;
  if (!loaded.ok) return { format, dir, ok: false, hash: loaded.hash, finalHash, problems: loaded.problems, warnings, composition: null, folder };
  const problems: CompositionProblem[] = [];
  const c = loaded.composition;
  const kept = acceptedDuration !== undefined && Math.abs(c.duration - acceptedDuration) < 0.0005;
  if (preset.kind === 'video' && briefDurationSec !== null && !kept && isDurationOffBrief(c.duration, briefDurationSec)) {
    problems.push(compositionProblem('composition.durationOffBrief', { duration: Math.round(c.duration * 10) / 10, target: briefDurationSec }));
  }
  return { format, dir, ok: problems.length === 0, hash: loaded.hash, finalHash, problems, warnings, composition: c, folder };
}

export interface TargetsCheck {
  checks: CompositionCheck[];
  /** Every problem, as text (`compositions/<id>: …`), in the targets' order: what the agent receives and the version records. */
  problems: string[];
  /** The problems of each format, as text. */
  byFormat: Map<string, string[]>;
  /** Warnings, as text (`compositions/<id>: …`). */
  warnings: string[];
  /** Requested ids missing from the format catalog: the agent cannot fix those (never a reason for another attempt). */
  unknownPresets: string[];
}

/** Checks the target formats' compositions in `versionDir` (`…/outputs/vN`). A missing folder is a problem of its format. */
export async function checkTargets(o: {
  versionDir: string; targets: readonly string[]; presets: FormatPreset[]; briefDurationSec: number | null; locale: Locale;
  /** Per format: the accepted duration of the base (see `checkComposition`). */
  acceptedDurations?: ReadonlyMap<string, number>;
}): Promise<TargetsCheck> {
  const v = messages(o.locale).validation;
  const out: TargetsCheck = { checks: [], problems: [], byFormat: new Map(), warnings: [], unknownPresets: [] };
  const add = (format: string, text: string) => {
    out.byFormat.set(format, [...(out.byFormat.get(format) ?? []), text]);
    if (!out.problems.includes(text)) out.problems.push(text);
  };
  for (const id of o.targets) {
    const preset = findPreset(o.presets, id);
    if (!preset) { add(id, v.unknownPreset({ id })); out.unknownPresets.push(id); continue; }
    const dir = compositionDirOf(id);
    // Every folder of the path must be a real folder of the creative: a link (planted by the agent) is never followed, and
    // nothing about where it points is reported (fix minor 1).
    const creativeDir = dirname(dirname(o.versionDir));
    const chain = await isRealDirChain(creativeDir, ['outputs', basename(o.versionDir), 'compositions', id]);
    if (chain === 'missing') { add(id, v.compositionMissing({ label: formatLabel(preset, 'en'), id, dir })); continue; }
    if (chain === 'unsafe') { add(id, v.compositionProblem({ dir, text: compositionProblemText(compositionProblem('composition.folderUnreadable', { path: dir }), o.locale) })); continue; }
    const check = await checkComposition(join(o.versionDir, 'compositions', id), id, preset, o.briefDurationSec, o.acceptedDurations?.get(id));
    out.checks.push(check);
    const missing = check.hash !== null && check.folder !== null && check.folder.files.length === 0;
    if (check.problems.some((p) => p.key === 'composition.jsonMissing') && (check.hash === null || missing)) {
      // Nothing there (or an empty folder): one clear problem instead of "composition.json is missing or cannot be read".
      add(id, v.compositionMissing({ label: formatLabel(preset, 'en'), id, dir: `${dir}` }));
      continue;
    }
    if (check.hash === null && check.problems.length === 1 && check.problems[0]!.key === 'composition.folderUnreadable' && check.problems[0]!.params.path === '') {
      add(id, v.compositionMissing({ label: formatLabel(preset, 'en'), id, dir }));
      continue;
    }
    for (const p of check.problems) add(id, v.compositionProblem({ dir, text: compositionProblemText(p, o.locale) }));
    for (const w of check.warnings) out.warnings.push(v.compositionProblem({ dir, text: compositionProblemText(w, o.locale) }));
  }
  return out;
}

/** The text `writeNormalized` writes for `value`, or null when the file is already normalised. */
function normalizedText(value: unknown): string | null {
  const normalized = normalizeComposition(value);
  return JSON.stringify(normalized) === JSON.stringify(value) ? null : `${JSON.stringify(normalized, null, 2)}\n`;
}

/** The folder's hash with `composition.json` as `writeNormalized` would leave it. */
async function normalizedHash(compDir: string, folder: CompositionFolder): Promise<string> {
  const parsed = await readCompositionJson(compDir).catch(() => null);
  const text = parsed?.ok ? normalizedText(parsed.value) : null;
  if (text === null) return folder.hash;
  const sha = createHash('sha256').update(text).digest('hex');
  return compositionHash(folder.files.map((f) => (f.path === 'composition.json' ? { path: f.path, sha256: sha } : f)));
}

/**
 * Rewrites `composition.json` in its normalised form (`normalizeComposition`) when that differs from what the agent wrote,
 * so the stored file is exactly what renders (and what is hashed). Only after the agent is gone, never while it may still
 * write. A file that cannot be read or parsed is left as it is (its own problem says why). The agent's original bytes are
 * kept first through `keepOriginal(bytes)` (an audit copy in the protected cache, fix minor 4).
 */
export async function writeNormalized(compDir: string, keepOriginal?: (bytes: Buffer) => Promise<void>): Promise<void> {
  const raw = await withConfinedFile(compDir, 'composition.json', true, async (fh, info) => (info.size > COMPOSITION_LIMITS.jsonBytes ? null : fh.readFile())).catch(() => null);
  if (!raw || !Buffer.isBuffer(raw)) return;
  const parsed = await readCompositionJson(compDir).catch(() => null);
  if (!parsed?.ok) return;
  const text = normalizedText(parsed.value);
  if (text === null) return;
  await keepOriginal?.(raw);
  const path = join(compDir, 'composition.json');
  const temp = join(compDir, `.composition.json.${randomBytes(6).toString('hex')}.tmp`);
  noteCoreTemp(temp);
  try {
    await writeFile(temp, text, { flag: 'wx' });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}
