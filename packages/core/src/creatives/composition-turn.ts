import { lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  anyManifestSchema, canFollow, isDurationOffBrief, messages, normalizeComposition, renderState,
  type FormatPreset, type Locale, type ManifestV2, type OutputFileInfo, type VersionComposition, type VersionEntry,
} from '@motion-studio/shared';
import { readCompositionFolder, readCompositionJson, type CompositionFile } from '../compositions/composition-files.ts';
import { findPreset } from '../formats/format-catalog.ts';
import { readJsonFile, writeJsonFileAtomic } from '../json-file.ts';
import { checkTargets, compositionDirOf, writeNormalized, type TargetsCheck } from './composition-contract.ts';
import { confinedSha, copyVerified, versionDirReady, type FollowFailure } from './carry-over.ts';
import { realDirChain, writeThroughTemp } from './core-files.ts';

/**
 * A turn under output contract v2 (Task 5b): what phase 9's carry-over and links become with composition folders.
 *
 * - **Carried primaries.** A primary the turn does not target is carried from the base version when the base has its own
 *   composition entry (not a follower's) and the folder, hashed before the agent starts, still has the recorded hash. Every
 *   file is copied with `COPYFILE_EXCL` and checked against the sha256 read then (never the source's bytes after the turn),
 *   and the copied folder must hash to the recorded hash. A legacy base (no compositions) carries nothing: every primary is
 *   a target (and the turn is a conversion: legacy-conversion.ts).
 * - **Followers.** A follower's entry is its primary's composition: `{ format, dir: <primary's dir>, hash, followsFormat,
 *   problems: <primary's> }`; no files are copied (the render job copies the primary's render to it). The link is checked
 *   with `canFollow` on the composition's duration (unknown when the composition is not valid: checked again at render).
 * - **Renders carried.** A render of the base is carried (byte copy, sha-verified, with its poster) when the format's entry
 *   in the new version has the same hash (and `followsFormat`) as in the base and the base render is current
 *   (`renderState` `rendered`): the user never renders the same composition twice.
 * - **Everything else the agent wrote** in `outputs/vN/` (media, a manifest, compositions of non-target formats) is removed.
 */

export interface CarriedComposition {
  entry: VersionComposition;
  files: CompositionFile[];
  /** The composition's duration in seconds when known (> 0); 0 for a still; null when it cannot be read. */
  duration: number | null;
}

/** The base's composition of `format`, carriable as it is now (hashed and matching the recorded hash), or null. */
export async function carriableComposition(creativeDir: string, base: VersionEntry, format: string): Promise<CarriedComposition | null> {
  const entry = base.compositions?.find((c) => c.format === format && c.followsFormat === undefined);
  if (!entry) return null;
  const compDir = join(creativeDir, 'outputs', `v${base.n}`, ...entry.dir.split('/'));
  const folder = await readCompositionFolder(compDir).catch(() => null);
  if (!folder || folder.hash !== entry.hash) return null;
  return { entry, files: folder.files, duration: await compositionDuration(compDir) };
}

/**
 * The durations off the brief that `base` has for `targets` and recorded with no problem (decisions log 262): a direct
 * edit's, since a direct save does not check the brief's duration. An agent turn that keeps such a duration is not told to
 * bring it back to the brief; one that changes it to another duration off the brief is, as before.
 */
export async function acceptedDurationsOf(creativeDir: string, base: VersionEntry | undefined, targets: readonly string[], presets: FormatPreset[], briefDurationSec: number | null): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!base || briefDurationSec === null) return out;
  for (const f of targets) {
    const entry = base.compositions?.find((c) => c.format === f && c.followsFormat === undefined);
    if (!entry || (entry.problems ?? []).length > 0 || findPreset(presets, f)?.kind !== 'video') continue;
    const d = await compositionDuration(join(creativeDir, 'outputs', `v${base.n}`, ...entry.dir.split('/')));
    if (d !== null && isDurationOffBrief(d, briefDurationSec)) out.set(f, d);
  }
  return out;
}

/** The (normalised) duration of a composition folder, or null when `composition.json` cannot be read. */
export async function compositionDuration(compDir: string): Promise<number | null> {
  const parsed = await readCompositionJson(compDir).catch(() => null);
  if (!parsed?.ok) return null;
  const d = (normalizeComposition(parsed.value) as { duration?: unknown }).duration;
  return typeof d === 'number' && Number.isFinite(d) && d >= 0 ? d : null;
}

export interface AssembledCompositions {
  compositions: VersionComposition[];
  /** Renders carried from the base (a format with the same composition and a current render). */
  outputs: OutputFileInfo[];
  problems: string[];
  /** Followers that cannot follow their primary any more (to unlink, with a chat message each). */
  notDelivered: Array<{ follower: string; primary: string; reason: FollowFailure; text: string }>;
  /** Entries the agent left that Motion Studio removed (names under `outputs/vN/`), for a chat note. */
  stray: string[];
  /** Non-target formats whose composition folder the agent wrote anyway (discarded, the core's copy kept). */
  touched: string[];
  /** The final check of the targets (warnings for the chat). */
  check: TargetsCheck | null;
}

/** Completes `outputs/v<n>` of a composition turn after the agent is gone (see the module comment). */
export async function assembleCompositions(o: {
  projectDir: string; creativeSlug: string; creativeDir: string; n: number; base: VersionEntry | undefined; formats: readonly string[]; targets: readonly string[];
  carried: readonly string[]; carriedComps: ReadonlyMap<string, CarriedComposition>; links: Readonly<Record<string, string>>;
  presets: FormatPreset[]; briefDurationSec: number | null; locale: Locale; label: (id: string) => string;
  /** Durations of the base kept without a problem (see `checkComposition`). */
  acceptedDurations?: ReadonlyMap<string, number>;
}): Promise<AssembledCompositions> {
  const m = messages(o.locale);
  const j = m.jobs;
  const { creativeDir, n, base } = o;
  try { await versionDirReady(creativeDir, n); } catch { throw new Error(j.versionFolderUnsafe({ n })); }
  const vRel = `outputs/v${n}`;
  const vdir = join(creativeDir, 'outputs', `v${n}`);
  const problems: string[] = [];
  const problem = (text: string) => { if (!problems.includes(text)) problems.push(text); };

  // 1. Only `compositions/<target>/` folders stay from the agent.
  const stray: string[] = [];
  const touched: string[] = [];
  for (const name of (await readdir(vdir).catch(() => [] as string[])).sort()) {
    const st = await lstat(join(vdir, name)).catch(() => null);
    if (name === 'compositions' && st?.isDirectory()) continue;
    stray.push(name);
    await rm(join(vdir, name), { recursive: true, force: true });
  }
  const compsDir = join(vdir, 'compositions');
  await mkdir(compsDir, { recursive: true });
  for (const name of (await readdir(compsDir).catch(() => [] as string[])).sort()) {
    const st = await lstat(join(compsDir, name)).catch(() => null);
    if (o.targets.includes(name) && st?.isDirectory()) continue;
    if (o.carried.includes(name) || Object.hasOwn(o.links, name)) touched.push(name);
    else stray.push(`compositions/${name}`);
    await rm(join(compsDir, name), { recursive: true, force: true });
  }

  // 2. Targets: normalised on disk, then checked and hashed by the core.
  const entries = new Map<string, VersionComposition>();
  const durations = new Map<string, number | undefined>();
  let check: TargetsCheck | null = null;
  if (o.targets.length > 0) {
    // The agent's own composition.json is kept before it is normalised: `.studio/cache/agent-originals/<creative>/v<n>/<format>.json`
    // (protected, not in the version), so what the agent wrote can still be audited (fix minor 4).
    for (const t of o.targets) {
      await writeNormalized(join(compsDir, t), async (bytes) => {
        const dir = await realDirChain(o.projectDir, ['.studio', 'cache', 'agent-originals', o.creativeSlug, `v${n}`]);
        if (dir) await writeThroughTemp(dir, `${t}.json`, async (temp) => { await writeFile(temp, bytes, { flag: 'wx' }); return true; });
      }).catch(() => {});
    }
    check = await checkTargets({ versionDir: vdir, targets: o.targets, presets: o.presets, briefDurationSec: o.briefDurationSec, locale: o.locale, acceptedDurations: o.acceptedDurations });
    for (const p of check.problems) problem(p);
    for (const c of check.checks) {
      const own = check.byFormat.get(c.format) ?? [];
      const present = c.hash !== null && c.folder !== null && c.folder.files.some((f) => f.path === 'composition.json');
      if (!present) continue;
      entries.set(c.format, { format: c.format, dir: compositionDirOf(c.format), hash: c.hash!, problems: own });
      durations.set(c.format, c.composition ? c.composition.duration : undefined);
    }
  }

  // 3. Carried primaries: every file copied and verified against the hashes read before the agent ran.
  for (const p of o.carried) {
    const cc = o.carriedComps.get(p);
    if (!cc || !base) continue;
    const r = await copyComposition(creativeDir, base.n, cc, `${vRel}/${compositionDirOf(p)}`);
    if (r !== 'ok') {
      problem(r === 'changedAfter' ? j.copyChangedAfter({ format: o.label(p) }) : r === 'changed' ? j.carriedChanged({ format: o.label(p), n: base.n }) : j.copyFailed({ format: o.label(p) }));
      continue;
    }
    const inherited = cc.entry.problems ?? [];
    for (const x of inherited) problem(x);
    entries.set(p, { format: p, dir: compositionDirOf(p), hash: cc.entry.hash, problems: [...inherited] });
    durations.set(p, cc.duration ?? undefined);
  }

  // 4. Followers: the primary's composition, if the link still holds on its duration.
  const notDelivered: AssembledCompositions['notDelivered'] = [];
  for (const [f, p] of Object.entries(o.links)) {
    const pe = entries.get(p);
    if (!pe || pe.followsFormat !== undefined) continue; // the primary has no composition: its own problem says so
    const pp = findPreset(o.presets, p);
    const fp = findPreset(o.presets, f);
    const d = durations.get(p);
    const c = pp && fp ? canFollow(pp, fp, d === undefined ? undefined : d > 0 ? d : null) : { ok: false as const, reason: 'unknown' as const };
    if (!c.ok) {
      const reason = c.reason as FollowFailure;
      const text = j.followerNotDelivered({ follower: o.label(f), primary: o.label(p), reason: m.errors.followReason[reason] });
      notDelivered.push({ follower: f, primary: p, reason, text });
      problem(text);
      continue;
    }
    entries.set(f, { format: f, dir: pe.dir, hash: pe.hash, followsFormat: p, problems: [...(pe.problems ?? [])] });
  }

  // 5. Renders carried: same composition, current render in the base.
  const outputs: OutputFileInfo[] = [];
  const previousRenders = base ? await baseRenders(creativeDir, base.n) : new Map<string, string>();
  for (const e of o.formats.map((f) => entries.get(f)).filter((x): x is VersionComposition => x !== undefined)) {
    if (!base || renderState(base, e.format) !== 'rendered') continue;
    const be = base.compositions?.find((c) => c.format === e.format);
    const out = base.outputs.find((x) => x.format === e.format);
    if (!be || !out?.sha256 || be.hash !== e.hash || be.followsFormat !== e.followsFormat) continue;
    const sha = await copyVerified(creativeDir, `outputs/v${base.n}/${out.file}`, `${vRel}/${out.file}`, out.sha256);
    if (sha === null) continue;
    let preview: string | null = null;
    if (out.preview) {
      // Confined and verified like the render itself (never through a link; the copy must have the source's bytes).
      const from = `outputs/v${base.n}/${out.preview}`;
      const sha = await confinedSha(creativeDir, from);
      await mkdir(join(vdir, '.previews'), { recursive: true }).catch(() => {});
      if (sha !== null && (await copyVerified(creativeDir, from, `${vRel}/${out.preview}`, sha)) !== null) preview = out.preview;
    }
    outputs.push({ ...out, preview });
  }

  // 6. The manifest v2, written by the core.
  const compositions = o.formats.map((f) => entries.get(f)).filter((x): x is VersionComposition => x !== undefined);
  const at = new Date().toISOString();
  const manifest: ManifestV2 = {
    schemaVersion: 2, compositions,
    renders: outputs.filter((x) => x.sha256 !== undefined).map((x) => ({
      format: x.format, file: x.file, width: x.width, height: x.height,
      durationSec: x.durationSec !== null && x.durationSec > 0 ? x.durationSec : null,
      sha256: x.sha256!, renderedAt: previousRenders.get(`${x.format}:${x.sha256}`) ?? at, ...(x.fromComposition ? { fromComposition: x.fromComposition } : {}),
    })),
  };
  await writeJsonFileAtomic(join(vdir, 'manifest.json'), manifest);
  return { compositions, outputs, problems, notDelivered, stray, touched, check };
}

/**
 * Copies the composition `cc` of version `baseN` to `destRel` (under `creativeDir`, a folder that must not hold those
 * files yet): every file with `copyVerified` against the sha256 read when `cc` was taken (never the source's bytes now),
 * then the copied folder must hash to the recorded hash. Anything short of that removes the copy: `changed` (a source file
 * is no longer the one read), `changedAfter` (the copy does not hash to the recorded hash), `failed`. Shared by carried
 * primaries and by a direct edit's base folder (`DirectEditService.save`).
 */
export async function copyComposition(creativeDir: string, baseN: number, cc: CarriedComposition, destRel: string): Promise<'ok' | 'changed' | 'changedAfter' | 'failed'> {
  const dest = join(creativeDir, ...destRel.split('/'));
  let result: 'ok' | 'changed' | 'changedAfter' | 'failed' = 'ok';
  await mkdir(dest, { recursive: true });
  for (const f of cc.files) {
    const fromRel = `outputs/v${baseN}/${cc.entry.dir}/${f.path}`;
    await mkdir(dirname(join(dest, ...f.path.split('/'))), { recursive: true });
    const sha = await copyVerified(creativeDir, fromRel, `${destRel}/${f.path}`, f.sha256);
    if (sha === null) {
      const now = await confinedSha(creativeDir, fromRel);
      result = now !== null && now !== f.sha256 ? 'changed' : 'failed';
      break;
    }
  }
  if (result === 'ok') {
    const copy = await readCompositionFolder(dest).catch(() => null);
    if (!copy || copy.hash !== cc.entry.hash) result = 'changedAfter';
  }
  if (result !== 'ok') await rm(dest, { recursive: true, force: true });
  return result;
}

/** `format:sha256` → `renderedAt` of the base's manifest v2 renders (a carried render keeps its date). */
async function baseRenders(creativeDir: string, n: number): Promise<Map<string, string>> {
  const m = await readJsonFile(join(creativeDir, 'outputs', `v${n}`, 'manifest.json'), anyManifestSchema).catch(() => null);
  return new Map(m?.schemaVersion === 2 ? m.renders.map((r) => [`${r.format}:${r.sha256}`, r.renderedAt] as const) : []);
}
