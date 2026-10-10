import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  anyManifestSchema, compositionProblemText, effectiveLinks, formatLabel, messages,
  type Brief, type Composition, type FormatPreset, type JobProgress, type JobSummary, type Locale, type ManifestV2, type OutputFileInfo,
  type ServerMessage, type VersionComposition,
} from '@motion-studio/shared';
import { hashConfinedFile } from '../brand/agent-guard.ts';
import { loadComposition } from '../compositions/composition-files.ts';
import { noteCoreChange } from '../core-changes.ts';
import { noteCoreTemp } from '../core-temps.ts';
import { findPreset } from '../formats/format-catalog.ts';
import { currentLocale } from '../i18n.ts';
import { JobFailedError, type JobQueue } from '../jobs/job-queue.ts';
import { readJsonFile, writeJsonFileAtomic } from '../json-file.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { RenderError } from '../render/errors.ts';
import type { MediaNormalizer } from '../render/media-normalize.ts';
import type { RenderCompositionOptions, RenderEngine, RenderResult } from '../render/renderer.ts';
import { CodedError } from '../workspace-store.ts';
import { noteCoreOutputWrite } from './carry-over.ts';
import { CreativeStore } from './creative-store.ts';
import type { CreativeRef } from './creative-turns.ts';
import { largeFileWarning } from './output-contract.ts';

/**
 * Render jobs (spec §5.3, Task 5): `POST …/versions/:n/render` renders a v2 version's compositions into its folder.
 *
 * - **One job per request**, key `render:<root>:<project>:<creative>:v<n>` (a second request for the same version while one
 *   is queued or running is 409). Formats are rendered one after the other (each render runs its own parallel pages).
 *   Progress per format (`JobSummary.progress`): `media` ("Preparing media…", the video sources normalised), `frames`,
 *   `finishing`. Cancel: the queue's cancel aborts the normalisation and the render (process groups killed, temp removed).
 * - **Formats:** by default every primary of the version; a follower named in the request stands for its primary. Every
 *   follower of a rendered primary gets a copy of the primary's render (`COPYFILE_EXCL` into a temp file, then a rename:
 *   never a hard link) with the primary's `problems` and the follower's own composition hash as `fromComposition`.
 * - **Per format:** the composition folder is hashed and validated again (`loadComposition`); a hash that is no longer the
 *   version's recorded one is refused (`compositionChanged`). Then the media is normalised, the renderer writes
 *   `outputs/vN/<format>.<ext>` (temp file + rename, only on success; an earlier render of the same file is replaced, a
 *   render of any other version is never touched), and the file is checked like an agent's output was (ffprobe size and
 *   duration, the channel's size limit, the phase 8 bitrate warning) and gets its poster.
 * - **Recorded** in `versions.json` (`VersionEntry.outputs`, with `sha256` and `fromComposition`, so `renderState` is
 *   `rendered`) and in the manifest v2 `renders[]`, as each format finishes (a later failure keeps the earlier ones). A
 *   follower's composition entry gets `followsFormat` when it lacked it.
 * - **No tokens, no usage ledger row** (decision): a render spends no model tokens; its time shows in the job list.
 * - **Concurrency with turns** (decision): allowed. A render reads a recorded version `vN` and writes only into its folder;
 *   a turn writes `v(N+1)`. versions.json is written under one process-wide lock (`CreativeStore.updateVersion`), and the
 *   turn's check of earlier versions leaves out the core's own writes (`noteCoreOutputWrite`). `outputs/` is not in git.
 */

export const renderJobKey = (root: string, projectSlug: string, creativeSlug: string, n: number): string =>
  `render:${root}:${projectSlug}:${creativeSlug}:v${n}`;

export interface RenderJobDeps {
  queue: JobQueue;
  /** The renderer; absent: renders are refused (503 `no-renderer`). */
  engine: RenderEngine | undefined;
  media: MediaTools;
  normalizer: MediaNormalizer;
  presets: () => Promise<FormatPreset[]>;
  broadcast: (msg: ServerMessage) => void;
  /** Passed to every render (tests: the built runtime, a temp folder, fewer pages, the encoder). */
  renderOptions?: Partial<Pick<RenderCompositionOptions, 'distDir' | 'tempDir' | 'parallel' | 'encoder' | 'x264Preset' | 'timeLimitMs' | 'jpegQuality'>>;
  /** Least time between two progress updates of a job, ms (default 250); phase changes always go out. */
  progressIntervalMs?: number;
}

export interface RenderPlan {
  /** Primary formats to render, in the version's order. */
  primaries: string[];
  /** Followers to copy, follower → primary (only of primaries being rendered). */
  followers: Record<string, string>;
  /** Followers whose composition entry lacks `followsFormat` (recognised from the brief's links): written when recorded. */
  fixFollows: Record<string, string>;
  /** Requested formats this version has no composition for. */
  unknown: string[];
}

/**
 * What a render request covers. A follower is a composition entry with `followsFormat`, or (an entry written without it)
 * a brief link follower → primary whose entry has the primary's very composition (same `dir` and `hash`).
 */
export function renderPlan(comps: VersionComposition[], brief: Pick<Brief, 'links' | 'formats'>, requested?: readonly string[]): RenderPlan {
  const byFormat = new Map(comps.map((c) => [c.format, c]));
  const links = effectiveLinks(brief.links, brief.formats);
  const follows = new Map<string, string>();
  const fixFollows: Record<string, string> = {};
  for (const c of comps) {
    if (c.followsFormat && byFormat.has(c.followsFormat) && !byFormat.get(c.followsFormat)!.followsFormat) { follows.set(c.format, c.followsFormat); continue; }
    const p = links[c.format];
    const pc = p ? byFormat.get(p) : undefined;
    if (p && pc && !pc.followsFormat && pc.dir === c.dir && pc.hash === c.hash) { follows.set(c.format, p); fixFollows[c.format] = p; }
  }
  const allPrimaries = comps.map((c) => c.format).filter((f) => !follows.has(f));
  const unknown: string[] = [];
  let primaries = allPrimaries;
  if (requested && requested.length > 0) {
    const wanted = new Set<string>();
    for (const f of requested) {
      if (!byFormat.has(f)) { if (!unknown.includes(f)) unknown.push(f); continue; }
      wanted.add(follows.get(f) ?? f);
    }
    primaries = allPrimaries.filter((f) => wanted.has(f));
  }
  const followers: Record<string, string> = {};
  for (const [f, p] of follows) if (primaries.includes(p)) followers[f] = p;
  return { primaries, followers, fixFollows, unknown };
}

/** The file extension of a render: the preset's first H.264 container (video) or image type (still), else mp4 / png. */
export function renderExtension(preset: FormatPreset, still: boolean): string {
  const prefer = still ? ['png', 'jpg', 'jpeg', 'webp'] : ['mp4', 'mov', 'm4v'];
  return prefer.find((e) => preset.extensions.includes(e)) ?? prefer[0]!;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);
const tempName = (name: string) => `.${name}.render-${randomBytes(6).toString('hex')}.tmp`;

/**
 * Copies `from` to `dir/name` through a fresh temp file (`COPYFILE_EXCL`, never a link), then renames it into place;
 * `beforeRename(temp)` runs just before the rename (to note the stamp first).
 */
async function copyInto(from: string, dir: string, name: string, beforeRename?: (temp: string) => Promise<void>): Promise<void> {
  const temp = join(dir, tempName(name));
  noteCoreTemp(temp);
  try {
    await copyFile(from, temp, constants.COPYFILE_EXCL);
    await beforeRename?.(temp);
    await rename(temp, join(dir, name));
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

export class RenderJobService {
  constructor(private readonly deps: RenderJobDeps) {}

  /** Validates the request and enqueues the job (see the module comment). */
  async start(ref: CreativeRef, n: number, requested?: string[]): Promise<JobSummary> {
    const locale = currentLocale();
    const m = messages(locale);
    const store = new CreativeStore(ref.projectDir);
    const creative = await store.get(ref.creativeSlug);
    const version = (await store.readVersions(ref.creativeSlug)).find((v) => v.n === n);
    if (!version) throw new CodedError(404, m.errors.versionNNotFound({ n }), 'version-not-found');
    const comps = version.compositions ?? [];
    if (comps.length === 0) throw new CodedError(400, m.render.notV2({ n }), 'version-not-v2');
    const plan = renderPlan(comps, creative.brief, requested);
    if (plan.unknown.length > 0) throw new CodedError(400, m.render.formatsNotInVersion({ list: plan.unknown.join(', ') }), 'formats-not-in-version');
    if (!this.deps.engine) throw new CodedError(503, m.render.noRenderer, 'no-renderer');
    if ((await this.deps.engine.info()).kind === null) throw new CodedError(409, m.render.noBrowser, 'no-browser');
    return this.deps.queue.enqueue({
      key: renderJobKey(ref.root, ref.projectSlug, ref.creativeSlug, n),
      kind: 'render',
      // Its own lane (one render at a time): renders never take the slots of agent turns (M3).
      lane: 'render',
      label: m.render.jobLabel({ title: creative.title, n }),
      formats: [...plan.primaries, ...Object.keys(plan.followers)],
      run: (signal, jobId) => this.run(ref, n, plan, comps, locale, signal, jobId),
    });
  }

  private async run(ref: CreativeRef, n: number, plan: RenderPlan, comps: VersionComposition[], locale: Locale, signal: AbortSignal, jobId: string): Promise<void> {
    const m = messages(locale);
    const presets = await this.deps.presets();
    const label = (id: string) => { const p = findPreset(presets, id); return p ? formatLabel(p, locale) : id; };
    const store = new CreativeStore(ref.projectDir);
    const notes: string[] = [];
    const note = async (text: string) => {
      notes.push(text);
      this.deps.queue.patch(jobId, { notes: [...notes] });
      await store.appendConversation(ref.creativeSlug, { type: 'system', at: new Date().toISOString(), level: 'warning', text }).catch(() => {});
    };
    let last = 0;
    let lastPhase = '';
    const progress = (p: JobProgress) => {
      const now = Date.now();
      const key = `${p.format}:${p.phase}`;
      if (key === lastPhase && p.done < p.total && now - last < (this.deps.progressIntervalMs ?? 250)) return;
      last = now;
      lastPhase = key;
      this.deps.queue.patch(jobId, { progress: p });
    };
    const failures: string[] = [];
    try {
      for (const format of plan.primaries) {
        if (signal.aborted) throw new RenderError('cancelled', 'cancelled');
        const followers = Object.keys(plan.followers).filter((f) => plan.followers[f] === format);
        try {
          await this.renderFormat({ ref, n, format, followers, plan, comps, presets, locale, signal, progress, note, label });
        } catch (e) {
          if (signal.aborted || (e instanceof RenderError && e.code === 'cancelled')) throw e;
          failures.push(m.render.formatFailed({ format: label(format), reason: errorText(e) }));
        }
      }
    } finally {
      this.deps.queue.patch(jobId, { progress: undefined });
    }
    if (failures.length > 0) throw new JobFailedError(m.render.someFailed({ list: failures.join('; ') }));
  }

  private async renderFormat(o: {
    ref: CreativeRef; n: number; format: string; followers: string[]; plan: RenderPlan; comps: VersionComposition[]; presets: FormatPreset[]; locale: Locale;
    signal: AbortSignal; progress: (p: JobProgress) => void; note: (text: string) => Promise<void>; label: (id: string) => string;
  }): Promise<void> {
    const { ref, n, format, signal } = o;
    const m = messages(o.locale);
    const store = new CreativeStore(ref.projectDir);
    const creativeDir = store.dir(ref.creativeSlug);
    const versionDir = store.outputsDir(ref.creativeSlug, n);
    const entry = o.comps.find((c) => c.format === format)!;
    const preset = findPreset(o.presets, format);
    if (!preset) throw new Error(m.validation.unknownPreset({ id: format }));
    o.progress({ format, phase: 'media', done: 0, total: 0 });
    const compDir = join(versionDir, ...entry.dir.split('/'));
    const loaded = await loadComposition(compDir, preset);
    if (!loaded.ok) {
      const list = loaded.problems.slice(0, 5).map((p) => compositionProblemText(p, o.locale)).join('; ');
      throw new Error(m.render.compositionProblems({ format: o.label(format), list }));
    }
    if (loaded.hash !== entry.hash) throw new Error(m.render.compositionChanged({ format: o.label(format) }));
    const composition = loaded.composition;
    const prepared = await this.deps.normalizer.prepare({
      projectDir: ref.projectDir, compDir, composition, signal,
      onProgress: (p) => o.progress({ format, phase: 'media', done: p.done, total: p.total }),
    });
    let result: RenderResult;
    const still = !(composition.duration > 0);
    const ext = renderExtension(preset, still);
    const file = `${format}.${ext}`;
    try {
      for (const w of prepared.warnings) {
        await o.note(w.kind === 'hdrApproximate' ? m.render.hdrApproximate({ format: o.label(format), src: w.src }) : m.render.mediaNotNormalised({ format: o.label(format), src: w.src }));
      }
      result = await this.deps.engine!.render({
        ...this.deps.renderOptions,
        dir: creativeDir, versionDir: `outputs/v${n}`, composition, format: preset, out: join(versionDir, file), signal, media: prepared.media,
        onProgress: (p) => o.progress({ format, phase: 'frames', done: p.frames, total: p.total }),
        // The stamp is noted before the rename (M1): a turn's check in between sees the core's own write.
        beforeRename: (temp) => noteCoreOutputWrite(creativeDir, `outputs/v${n}/${file}`, temp),
      });
    } finally {
      prepared.release();
    }
    // From here the new file is in place: the record is always written, with what is on disk (I3), whatever happens next
    // (a cancel waits for these few steps; a failing follower is left out and reported).
    const infos: OutputFileInfo[] = [];
    let failure: unknown = null;
    try {
      o.progress({ format, phase: 'finishing', done: 0, total: 1 + o.followers.length });
      await noteCoreChange(versionDir);
      if (result.warnings.length > 0) await o.note(m.render.frameWarnings({ format: o.label(format), count: result.warnings.length })).catch(() => {});
      const info = await this.describe({ creativeDir, versionDir, n, preset, file, composition, sha256: result.sha256, hash: loaded.hash, locale: o.locale, poster: true })
        .catch((e: unknown) => {
          failure = e;
          return { format, file, width: result.width, height: result.height, durationSec: result.durationSec, verified: false, preview: null, sha256: result.sha256, problems: [], fromComposition: loaded.hash } satisfies OutputFileInfo;
        });
      infos.push(info);
      for (const [i, f] of o.followers.entries()) {
        try {
          infos.push(await this.follower({ creativeDir, versionDir, n, f, ext, primary: info, composition, presets: o.presets, comps: o.comps, locale: o.locale, fallback: preset }));
        } catch (e) {
          failure ??= e;
        }
        o.progress({ format, phase: 'finishing', done: i + 1, total: 1 + o.followers.length });
      }
    } finally {
      await this.record(store, ref, n, infos, o.plan.fixFollows, o.comps);
      await noteCoreChange(versionDir);
      this.deps.broadcast({ type: 'creative', project: ref.projectSlug, creative: ref.creativeSlug });
    }
    if (failure) throw failure;
  }

  /**
   * A follower's copy of its primary's render (`COPYFILE_EXCL` into a temp file, then a rename), checked against the
   * follower's OWN preset (extension, size and duration limits, bitrate warning; M4) and carrying the primary's problems.
   */
  private async follower(o: { creativeDir: string; versionDir: string; n: number; f: string; ext: string; primary: OutputFileInfo; composition: Composition;
    presets: FormatPreset[]; comps: VersionComposition[]; locale: Locale; fallback: FormatPreset }): Promise<OutputFileInfo> {
    const v = messages(o.locale).validation;
    const fPreset = findPreset(o.presets, o.f) ?? { ...o.fallback, id: o.f };
    const fFile = `${o.f}.${o.ext}`;
    await copyInto(join(o.versionDir, o.primary.file), o.versionDir, fFile, (temp) => noteCoreOutputWrite(o.creativeDir, `outputs/v${o.n}/${fFile}`, temp));
    const h = await hashConfinedFile(o.creativeDir, `outputs/v${o.n}/${fFile}`);
    const sha256 = h && 'sha256' in h ? h.sha256 : undefined;
    const own = await this.describe({ creativeDir: o.creativeDir, versionDir: o.versionDir, n: o.n, preset: fPreset, file: fFile, composition: o.composition, sha256, hash: '', locale: o.locale, poster: false });
    const problems = [...(o.primary.problems ?? [])];
    for (const p of own.problems ?? []) if (!problems.includes(p)) problems.push(p);
    if (!fPreset.extensions.includes(o.ext)) problems.push(v.badExtension({ file: fFile, ext: o.ext, id: o.f, allowed: fPreset.extensions.join(', ') }));
    let preview: string | null = null;
    if (o.primary.preview) {
      const pv = `.previews/${fFile}.jpg`;
      const ok = await copyInto(join(o.versionDir, o.primary.preview), join(o.versionDir, '.previews'), `${fFile}.jpg`,
        (temp) => noteCoreOutputWrite(o.creativeDir, `outputs/v${o.n}/${pv}`, temp)).then(() => true, () => false);
      if (ok) { preview = pv; await noteCoreOutputWrite(o.creativeDir, `outputs/v${o.n}/.previews`); }
    }
    const fEntry = o.comps.find((c) => c.format === o.f);
    const { sha256: _drop, fromComposition: _fc, ...rest } = own;
    return {
      ...rest, preview, problems,
      ...(sha256 ? { sha256 } : {}),
      ...(fEntry ? { fromComposition: fEntry.hash } : o.primary.fromComposition ? { fromComposition: o.primary.fromComposition } : {}),
    };
  }

  /** The output entry of a render: checked like an agent's file (ffprobe size and duration, limits, bitrate), with its poster. */
  private async describe(o: { creativeDir: string; versionDir: string; n: number; preset: FormatPreset; file: string; composition: Composition; sha256: string | undefined; hash: string; locale: Locale; poster: boolean }): Promise<OutputFileInfo> {
    const v = messages(o.locale).validation;
    const { preset, file } = o;
    const path = join(o.versionDir, file);
    const st = await lstat(path);
    const media = this.deps.media;
    const probed = media.available ? await media.probe(path).catch(() => null) : null;
    const problems: string[] = [];
    const width = probed?.width ?? o.composition.width;
    const height = probed?.height ?? o.composition.height;
    const video = o.composition.duration > 0;
    const durationSec = video ? (probed?.durationSec ?? o.composition.duration) : null;
    if (media.available && !probed) problems.push(v.notReadable({ file }));
    if (width !== preset.width || height !== preset.height) problems.push(v.badResolution({ file, width, height, expectedWidth: preset.width, expectedHeight: preset.height }));
    if (video && durationSec !== null) {
      // The renderer counted the frames exactly; the container may add up to an AAC frame of padding.
      if (Math.abs(durationSec - o.composition.duration) > Math.max(0.1, 2 / o.composition.fps)) problems.push(v.durationOffTarget({ file, duration: durationSec.toFixed(1), target: o.composition.duration }));
      if (preset.maxDurationSec !== undefined && durationSec > preset.maxDurationSec + 1e-3) problems.push(v.durationOverMax({ file, duration: durationSec.toFixed(1), max: preset.maxDurationSec }));
    }
    if (preset.maxFileMB !== undefined && st.size / 1e6 > preset.maxFileMB) problems.push(v.tooLarge({ file, size: (st.size / 1e6).toFixed(1), max: preset.maxFileMB }));
    const large = largeFileWarning(preset, file.slice(file.lastIndexOf('.') + 1), st.size, durationSec, o.composition.fps);
    let preview: string | null = null;
    if (o.poster && video && media.available && probed) {
      const dir = join(o.versionDir, '.previews');
      const target = join(dir, `${file}.jpg`);
      const d = await lstat(dir).catch(() => null);
      const t = await lstat(target).catch(() => null);
      if ((d === null || d.isDirectory()) && (t === null || t.isFile())) {
        const made = await media.poster(path, target).catch(() => false);
        if (made) {
          preview = `.previews/${file}.jpg`;
          await noteCoreOutputWrite(o.creativeDir, `outputs/v${o.n}/.previews`);
          await noteCoreOutputWrite(o.creativeDir, `outputs/v${o.n}/${preview}`);
        }
      }
    }
    return {
      format: preset.id, file, width, height, durationSec, verified: probed !== null, preview,
      ...(large ? { warnings: [large] } : {}), ...(o.sha256 ? { sha256: o.sha256 } : {}), problems, ...(o.hash ? { fromComposition: o.hash } : {}),
    };
  }

  /** Records renders in versions.json (outputs) and the manifest v2 (`renders[]`), and the followers' `followsFormat`. */
  private async record(store: CreativeStore, ref: CreativeRef, n: number, infos: OutputFileInfo[], fixFollows: Record<string, string>, comps: VersionComposition[]): Promise<void> {
    const fixed = (list: VersionComposition[]) => list.map((c) => (fixFollows[c.format] && !c.followsFormat ? { ...c, followsFormat: fixFollows[c.format] } : c));
    const formats = new Set(infos.map((i) => i.format));
    const updated = await store.updateVersion(ref.creativeSlug, n, (v) => ({
      ...v,
      outputs: [...v.outputs.filter((o) => !formats.has(o.format)), ...infos],
      ...(v.compositions ? { compositions: fixed(v.compositions) } : {}),
    }));
    const versionDir = store.outputsDir(ref.creativeSlug, n);
    const path = join(versionDir, 'manifest.json');
    const current = await readJsonFile(path, anyManifestSchema).catch(() => null);
    const base: ManifestV2 = current?.schemaVersion === 2 ? current : { schemaVersion: 2, compositions: updated.compositions ?? comps, renders: [] };
    const at = new Date().toISOString();
    const manifest: ManifestV2 = {
      schemaVersion: 2,
      compositions: fixed(base.compositions),
      renders: [
        ...base.renders.filter((r) => !formats.has(r.format)),
        ...infos.filter((i) => i.sha256 !== undefined).map((i) => ({
          format: i.format, file: i.file, width: i.width, height: i.height,
          durationSec: i.durationSec !== null && i.durationSec > 0 ? i.durationSec : null,
          sha256: i.sha256!, renderedAt: at, ...(i.fromComposition ? { fromComposition: i.fromComposition } : {}),
        })),
      ],
    };
    await writeJsonFileAtomic(path, manifest, { beforeRename: (tmp) => noteCoreOutputWrite(store.dir(ref.creativeSlug), `outputs/v${n}/manifest.json`, tmp) });
  }
}
