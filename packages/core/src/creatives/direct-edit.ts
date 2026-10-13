import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  COMPOSITION_LIMITS, compositionProblem, compositionProblemText, describeEdits, draftSizeProblem, editOpSchema, effectiveLinks, formatDisplayName, INSTANCE_ID_RE, isCompositionPath, MAX_INSTANCES, messages,
  nextInstanceId, normalizeComposition, presetOf, renderJobKey, validateComposition,
  type Brief, type CompositionProblem, type CreativeFile, type FormatPreset, type Locale, type StagedAsset, type VersionEntry,
} from '@motion-studio/shared';
import { hashConfinedFile } from '../brand/agent-guard.ts';
import { loadComposition, readCompositionFolder } from '../compositions/composition-files.ts';
import { findPreset } from '../formats/format-catalog.ts';
import type { Git } from '../git.ts';
import type { JobQueue } from '../jobs/job-queue.ts';
import { CodedError } from '../workspace-store.ts';
import { versionDirReady } from './carry-over.ts';
import { compositionDirOf } from './composition-contract.ts';
import { alignEditorCopies, carriableComposition, compositionDuration, copyComposition, type CarriedComposition } from './composition-turn.ts';
import { writeThroughTemp } from './core-files.ts';
import { CreativeStore } from './creative-store.ts';
import { withoutFormatState, type CreativeRef, type CreativeTurnService } from './creative-turns.ts';
import type { PreviewService, StagingView } from './previews.ts';

/**
 * Direct edits (Phase 10b, Task 4): `save` writes a new version from an editor draft, with no agent and no tokens (nothing
 * is launched, no usage-ledger line). Everything happens under the creative's lock, the one turns take:
 *
 * 1. **Refusals first.** 409 `editor-busy` while a turn or a render of the creative is queued or running; 409
 *    `editor-base-changed` when `baseHash` is not the latest version's composition of `format` (or `format` is no longer a
 *    primary of the brief): the draft is kept by the web, never overwritten. The editor's rules (the core enforces only
 *    these; the full editable list is the UI's `applyEdit`): every `src` of a clip or font is a file of the base version
 *    under `assets/` or a file staged for this draft in the SAME preview session (`token`, through the staging code, never a
 *    client path); an html clip keeps its `src` and no html clip is added; the html layer files stay byte-for-byte the
 *    base's. Then `validateComposition` against the format, as the agent's compositions: 422 with the translated problems.
 * 2. **The folder.** `outputs/v<n>/compositions/<format>/` is the base folder copied file by file and verified
 *    (`copyComposition`), the staged files the composition uses copied and verified (unused ones are not), and
 *    `composition.json` written normalised through a temp file and a rename; then `loadComposition` checks it again.
 * 3. **The rest of the version** as a targeted turn makes it (`CreativeTurnService.finishCompositions`): the other primaries
 *    carried from the latest version, followers of `format` re-checked with `canFollow` on the new duration and size (one
 *    that cannot follow is left out, told in the chat and unlinked), renders carried only for unchanged hashes, manifest v2.
 * 4. **Recorded**: a git commit, the version (`origin: 'editor'`, `request` = the edit summary, `basedOn` = `baseVersion`,
 *    no usage), a `version` chat entry, the creative's state; then the storyboards. Any failure before the version is
 *    recorded removes `outputs/v<n>/` (a crash leaves it to the next save, which clears it first).
 */

/** Most ops a save body may list: bound by the body size (8 MB of composition + ops at ~200 B each), not by what an editor session makes. */
export const OPS_MAX = 20_000;

/** `POST /api/projects/:slug/creatives/:c/edits`. */
export const directEditBodySchema = z.strictObject({
  baseVersion: z.number().int().positive(),
  format: z.string().min(1).max(200), // the primary format edited
  baseHash: z.string().regex(/^[0-9a-f]{64}$/), // composition hash of the base
  composition: z.unknown(), // validated in the core
  staged: z.array(z.string().min(1).max(512)).max(20), // staged paths used by the draft
  ops: z.array(editOpSchema).max(OPS_MAX), // for the summary and the log only; the composition is authoritative, so the count must never fail a save
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), // the preview session that owns the staging (as the stage and preview bodies)
});
export type DirectEditBody = z.infer<typeof directEditBodySchema>;

/** `POST …/versions/:n/duplicate-format` (Phase 12): the instance to copy and the new instance's label. */
export const duplicateFormatBodySchema = z.strictObject({
  instanceId: z.string().max(200).regex(INSTANCE_ID_RE),
  label: z.string().min(1).max(60).optional(),
});
export type DuplicateFormatBody = z.infer<typeof duplicateFormatBodySchema>;

export interface DirectEditDeps {
  turns: CreativeTurnService;
  queue: JobQueue;
  git: Git;
  presets: () => Promise<FormatPreset[]>;
  /** The live preview sessions, whose staging holds the files a draft added; absent: no staged file can be used. */
  previews?: PreviewService;
}

const now = () => new Date().toISOString();
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

interface ClipRefs { id: string; type: unknown; src: unknown; hasSrc: boolean; imageParams: Map<string, unknown> }
/** Every clip of a (not yet validated) composition, with its id, type, `src` and image params when they are there. */
function clipsOf(c: unknown): ClipRefs[] {
  const out: ClipRefs[] = [];
  if (!isObject(c) || !Array.isArray(c.tracks)) return out;
  for (const track of c.tracks) {
    if (!isObject(track) || !Array.isArray(track.clips)) continue;
    for (const clip of track.clips) {
      if (!isObject(clip)) continue;
      const imageParams = new Map<string, unknown>();
      if (isObject(clip.params)) for (const [k, p] of Object.entries(clip.params)) if (isObject(p) && p.type === 'image') imageParams.set(k, p.value);
      out.push({ id: typeof clip.id === 'string' ? clip.id : '?', type: clip.type, src: clip.src, hasSrc: Object.hasOwn(clip, 'src'), imageParams });
    }
  }
  return out;
}
function fontsOf(c: unknown): Array<{ family: string; src: unknown }> {
  if (!isObject(c) || !Array.isArray(c.fonts)) return [];
  return c.fonts.filter(isObject).map((f) => ({ family: typeof f.family === 'string' ? f.family : '?', src: f.src }));
}

/** The editor's own refusals (see the module comment, step 1): translated texts, empty when none. */
export function editorRefusals(draft: unknown, base: unknown, available: (path: string) => boolean, locale: Locale): string[] {
  const e = messages(locale).editor;
  const out: string[] = [];
  const add = (text: string) => { if (!out.includes(text)) out.push(text); };
  const baseClips = clipsOf(base).filter((k) => k.type === 'html');
  const baseHtml = new Map(baseClips.map((k) => [k.id, k.src] as const));
  const baseParams = new Map(baseClips.map((k) => [k.id, k.imageParams] as const));
  const usable = (src: unknown): src is string => typeof src === 'string' && src.startsWith('assets/') && isCompositionPath(src) && available(src);
  for (const clip of clipsOf(draft)) {
    if (clip.type === 'html') {
      if (!baseHtml.has(clip.id)) add(e.htmlNew({ clip: clip.id }));
      else if (clip.src !== baseHtml.get(clip.id)) add(e.htmlChanged({ clip: clip.id }));
      // An image parameter is a file reference too: the base's value, or a usable file under assets/.
      for (const [k, value] of clip.imageParams) {
        if (value !== baseParams.get(clip.id)?.get(k) && !usable(value)) add(e.srcUnavailable({ clip: clip.id, path: String(value).slice(0, 300) }));
      }
      continue;
    }
    // An html clip of the base turned into another type is a change of its layer too.
    if (baseHtml.has(clip.id)) { add(e.htmlChanged({ clip: clip.id })); continue; }
    if (clip.hasSrc && !usable(clip.src)) add(e.srcUnavailable({ clip: clip.id, path: String(clip.src).slice(0, 300) }));
  }
  for (const f of fontsOf(draft)) {
    if (!usable(f.src)) add(e.fontUnavailable({ family: f.family.slice(0, 100), path: String(f.src).slice(0, 300) }));
  }
  return out;
}

/** Every `assets/…` path the draft names (clips and fonts). */
function referencedAssets(draft: unknown): Set<string> {
  const out = new Set<string>();
  for (const k of clipsOf(draft)) {
    if (typeof k.src === 'string' && k.src.startsWith('assets/')) out.add(k.src);
    for (const v of k.imageParams.values()) if (typeof v === 'string' && v.startsWith('assets/')) out.add(v);
  }
  for (const f of fontsOf(draft)) if (typeof f.src === 'string' && f.src.startsWith('assets/')) out.add(f.src);
  return out;
}

/** The bytes of `composition.json` for a (normalised) draft: indented when that fits the limit, else compact (final review M5). */
export function compositionFileText(draft: unknown): string {
  const pretty = `${JSON.stringify(draft, null, 2)}\n`;
  return Buffer.byteLength(pretty) <= COMPOSITION_LIMITS.jsonBytes ? pretty : JSON.stringify(draft);
}

export class DirectEditService {
  constructor(private readonly deps: DirectEditDeps) {}

  /** Saves the draft as a new version (see the module comment). Throws translated `CodedError`s. */
  async save(ref: CreativeRef, body: DirectEditBody, locale: Locale): Promise<{ version: number }> {
    const parsed = directEditBodySchema.safeParse(body);
    if (!parsed.success) throw new CodedError(400, messages(locale).errors.invalidRequestDetail({ detail: parsed.error.issues[0]?.message ?? '' }), 'editor-invalid-body');
    return this.deps.turns.runLocked(ref, () => this.saveLocked(ref, parsed.data, locale));
  }

  private renderActive(ref: CreativeRef): boolean {
    const prefix = `${renderJobKey(ref.root, ref.projectSlug, ref.creativeSlug, 0).slice(0, -1)}`; // `render:…:<creative>:v`
    return this.deps.queue.list().some((j) => j.key.startsWith(prefix) && (j.state === 'queued' || j.state === 'running'));
  }

  /**
   * Duplicate format (Phase 12, spec §2): copies `instanceId`'s composition of version `n` (a follower's is the one it shows,
   * its primary's) into the next free instance of the same preset, saved as a new editor version with no agent (request
   * "Duplicated <label>"). The new instance enters the brief right after its source, a primary of its own, with `label` when
   * given; every other format is carried from the latest version as in a direct edit (`finishCompositions`). Under the
   * creative's lock. Refused: 400 a bad body or a source not in the brief, 404 an unknown version, 409 `duplicate-busy`
   * while a turn or a render runs, `format-not-in-version`, `format-instances-full` (20 instances), `duplicate-carry-failed`
   * (a source folder no longer the recorded one). A failure before the version is recorded leaves the brief and the versions as
   * they were.
   */
  async duplicate(ref: CreativeRef, n: number, body: unknown, locale: Locale): Promise<{ version: VersionEntry; instanceId: string }> {
    const parsed = duplicateFormatBodySchema.safeParse(body ?? {});
    if (!parsed.success) throw new CodedError(400, messages(locale).errors.invalidRequestDetail({ detail: parsed.error.issues[0]?.message ?? '' }), 'duplicate-invalid-body');
    return this.deps.turns.runLocked(ref, () => this.duplicateLocked(ref, n, parsed.data, locale));
  }

  private async duplicateLocked(ref: CreativeRef, n: number, body: DuplicateFormatBody, locale: Locale): Promise<{ version: VersionEntry; instanceId: string }> {
    const m = messages(locale);
    const v = m.variants;
    if (this.deps.turns.turnActive(ref) || this.renderActive(ref)) throw new CodedError(409, v.duplicateBusy, 'duplicate-busy');
    const slug = ref.creativeSlug;
    const store = new CreativeStore(ref.projectDir);
    const creativeDir = store.dir(slug);
    const creative = await store.get(slug);
    const versions = await store.readVersions(slug);
    const latest = versions.at(-1);
    const presets = await this.deps.presets();
    const { formats } = creative.brief;
    const source = body.instanceId;
    const label = (id: string, labels = creative.brief.formatLabels) => formatDisplayName(presets, id, locale, labels);
    if (!formats.includes(source)) throw new CodedError(400, m.errors.formatNotInBrief({ format: label(source) }), 'format-not-in-brief');
    const version = versions.find((x) => x.n === n);
    if (!version || !latest) throw new CodedError(404, m.errors.versionNNotFound({ n }), 'version-not-found');
    const srcEntry = version.compositions?.find((c) => c.format === source);
    if (!srcEntry) throw new CodedError(409, v.formatNotInVersion({ format: label(source), n }), 'format-not-in-version');
    if (!findPreset(presets, source)) throw new CodedError(409, m.errors.compositionUnusable({ format: source, n }), 'composition-unusable');
    const instanceId = nextInstanceId(presetOf(source), formats);
    if (instanceId === null) throw new CodedError(409, v.instancesFull({ format: label(presetOf(source)), max: MAX_INSTANCES }), 'format-instances-full');
    const carryFailed = (f: string, at: number) => new CodedError(409, m.editor.carryFailed({ format: label(f), n: at }), 'duplicate-carry-failed');
    // The source folder as it is now: still the recorded composition (a follower's entry names its primary's folder).
    const srcDir = join(creativeDir, 'outputs', `v${n}`, ...srcEntry.dir.split('/'));
    const folder = await readCompositionFolder(srcDir).catch(() => null);
    if (!folder || folder.hash !== srcEntry.hash) throw carryFailed(source, n);
    const cc: CarriedComposition = { entry: srcEntry, files: folder.files, duration: await compositionDuration(srcDir) };
    // Every other primary of the latest version, carried as in a direct edit.
    const links = effectiveLinks(creative.brief.links, formats);
    const own = (x: VersionEntry, f: string) => x.compositions?.find((c) => c.format === f && c.followsFormat === undefined);
    const carried: string[] = [];
    const carriedComps = new Map<string, CarriedComposition>();
    for (const p of formats.filter((f) => !Object.hasOwn(links, f))) {
      const followed = latest.compositions?.find((c) => c.format === p && c.followsFormat !== undefined)?.followsFormat;
      const from = own(latest, p) ? p : followed !== undefined && own(latest, followed) ? followed : null;
      if (from === null) continue; // not in the latest version
      const carriable = await carriableComposition(creativeDir, latest, from);
      if (!carriable) throw carryFailed(p, latest.n);
      carried.push(p);
      carriedComps.set(p, carriable);
    }
    const nextFormats = [...formats];
    nextFormats.splice(formats.indexOf(source) + 1, 0, instanceId);
    const labels = body.label !== undefined ? { ...creative.brief.formatLabels, [instanceId]: body.label } : creative.brief.formatLabels;
    // A freed id taken again (a gap) starts clean: no stored link at either end, no manual pick (Phase 12).
    const fresh = (c: CreativeFile) => {
      const pruned = withoutFormatState(c.brief.links, c.exportPicks, new Set([instanceId]));
      const brief: Brief = { ...c.brief, formats: nextFormats, ...(labels ? { formatLabels: labels } : {}), ...(pruned.links ? { links: pruned.links } : {}) };
      return { brief, exportPicks: pruned.exportPicks };
    };
    const newLabel = (id: string) => label(id, labels);

    const newN = await store.nextVersionNumber(slug);
    await this.deps.turns.clearStaleOutputs(store, slug, newN, versions);
    await versionDirReady(creativeDir, newN);
    const vdir = store.outputsDir(slug, newN);
    let recorded = false;
    let before: { brief: Brief; exportPicks: CreativeFile['exportPicks'] } | null = null;
    try {
      if ((await copyComposition(creativeDir, n, cc, `outputs/v${newN}/${compositionDirOf(instanceId)}`)) !== 'ok') throw carryFailed(source, n);
      const plan = { creative: { ...creative, brief: fresh(creative).brief }, targets: [instanceId], carried, carriedComps, links };
      const saved = await this.deps.turns.finishCompositions(ref, store, plan, presets, latest, newN, newLabel, locale,
        { direct: true, base: { durationSec: cc.duration, ...(srcEntry.userDuration ? { userDuration: srcEntry.userDuration } : {}) } });
      const status = saved.problems.length === 0 ? 'complete' : 'incomplete';
      // The brief as stored now (a follower unlinked by the save above stays unlinked), with the new instance.
      const stored = await store.get(slug);
      before = { brief: stored.brief, exportPicks: stored.exportPicks };
      await store.update(slug, fresh(stored));
      await alignEditorCopies(creativeDir, { n: newN, origin: 'editor', compositions: saved.compositions } as VersionEntry).catch(() => []);
      const commit = await this.deps.git.commitAll(ref.projectDir, `${creative.title}: v${newN}`);
      await store.appendVersion(slug, {
        n: newN, commit, sessionId: creative.resumeFrom?.sessionId ?? latest.sessionId ?? null, status, createdAt: now(),
        request: v.duplicatedRequest({ label: newLabel(instanceId) }), outputs: saved.outputs, problems: saved.problems, tools: [], renderCommand: null,
        basedOn: latest.n, compositions: saved.compositions, origin: 'editor', ...(saved.localizations ? { localizations: saved.localizations } : {}),
      });
      recorded = true;
      await store.appendConversation(slug, { type: 'version', at: now(), n: newN, status });
      const resumeFrom = creative.resumeFrom ? { version: newN, sessionId: creative.resumeFrom.sessionId } : null;
      await store.update(slug, { status: status === 'complete' ? 'ready' : 'incomplete', error: null, resumeFrom });
      await this.deps.turns.commitState(ref, m.jobs.versionStateCommit({ title: creative.title, n: newN }));
      this.deps.turns.changed(ref);
      this.deps.turns.storyboardsLater(ref, store, newN);
      const entry = (await store.readVersions(slug)).find((x) => x.n === newN)!;
      return { version: entry, instanceId };
    } catch (err) {
      if (!recorded) {
        if (before) await store.update(slug, before).catch(() => {});
        const st = await lstat(vdir).catch(() => null);
        if (st) await rm(vdir, st.isDirectory() ? { recursive: true, force: true } : { force: true }).catch(() => {});
      }
      throw err;
    }
  }

  private async saveLocked(ref: CreativeRef, body: DirectEditBody, locale: Locale): Promise<{ version: number }> {
    const m = messages(locale);
    const e = m.editor;
    if (this.deps.turns.turnActive(ref) || this.renderActive(ref)) throw new CodedError(409, e.busy, 'editor-busy');
    const slug = ref.creativeSlug;
    const store = new CreativeStore(ref.projectDir);
    const creativeDir = store.dir(slug);
    const creative = await store.get(slug);
    const versions = await store.readVersions(slug);
    const latest = versions.at(-1);
    const presets = await this.deps.presets();
    const label = (id: string) => formatDisplayName(presets, id, locale, creative.brief.formatLabels);
    const { formats } = creative.brief;
    const links = effectiveLinks(creative.brief.links, formats);
    const format = body.format;
    const own = (v: VersionEntry | undefined, f: string) => v?.compositions?.find((c) => c.format === f && c.followsFormat === undefined);
    const latestEntry = own(latest, format);
    const baseEntry = own(versions.find((v) => v.n === body.baseVersion), format);
    // Only a format of the brief, still a primary, whose latest composition is the draft's base.
    if (!latest || !formats.includes(format) || Object.hasOwn(links, format) || !latestEntry || !baseEntry || latestEntry.hash !== body.baseHash || baseEntry.hash !== body.baseHash) {
      throw new CodedError(409, e.baseChanged({ format: formats.includes(format) ? label(format) : format.slice(0, 100), n: latest?.n ?? body.baseVersion }), 'editor-base-changed');
    }
    const preset = findPreset(presets, format);
    if (!preset) throw new CodedError(409, m.errors.compositionUnusable({ format, n: latest.n }), 'composition-unusable');
    const carryFailed = (f: string) => new CodedError(409, e.carryFailed({ format: label(f), n: latest.n }), 'editor-carry-failed');
    // The base folder, hashed now (still the recorded one) and valid; and every other primary the latest version has.
    const baseComp = await carriableComposition(creativeDir, latest, format);
    const baseDir = join(creativeDir, 'outputs', `v${latest.n}`, ...latestEntry.dir.split('/'));
    const baseLoaded = baseComp ? await loadComposition(baseDir, preset) : null;
    if (!baseComp || !baseLoaded?.ok || baseLoaded.hash !== latestEntry.hash) throw carryFailed(format);
    const carried: string[] = [];
    const carriedComps = new Map<string, CarriedComposition>();
    // The CURRENT links decide (they may have changed since the base was taken): a primary now is carried; one that was a
    // follower in the latest version keeps the composition it showed there (its former primary's, before this edit) as its
    // own folder; a format linked since then follows through `finishCompositions`.
    for (const p of formats.filter((f) => f !== format && !Object.hasOwn(links, f))) {
      const followed = latest.compositions?.find((c) => c.format === p && c.followsFormat !== undefined)?.followsFormat;
      const from = own(latest, p) ? p : followed !== undefined && own(latest, followed) ? followed : null;
      if (from === null) continue; // not in the latest version (an added format): the agent makes it
      const cc = await carriableComposition(creativeDir, latest, from);
      if (!cc) throw carryFailed(p);
      carried.push(p);
      carriedComps.set(p, cc);
    }

    const draft = normalizeComposition(body.composition);
    // One size rule with the editor and the runtime (final review M5): the compact JSON is measured (`draftSizeProblem`);
    // the file is written indented when that still fits, else compact.
    const text = compositionFileText(draft);
    const invalid = (problems: string[]) => {
      const err = new CodedError(422, e.saveInvalid({ text: problems[0] ?? '' }), 'editor-invalid');
      err.problems = problems.slice(0, 50);
      return err;
    };
    const problemTexts = (ps: CompositionProblem[]) => ps.map((p) => compositionProblemText(p, locale));
    const tooLarge = draftSizeProblem(draft);
    if (tooLarge) throw invalid(problemTexts([tooLarge]));
    const baseFiles = new Map(baseComp.files.map((f) => [f.path, f] as const));
    const referenced = referencedAssets(draft);
    const declared = new Set(body.staged);
    // The session's staging is looked up only when the draft names a file it declares staged (one the base also has must
    // hold the same content: `stagedCollision`).
    const needsStaging = [...referenced].some((p) => declared.has(p));
    const withStaging = <T>(fn: (st: StagingView | null) => Promise<T>): Promise<T> => (needsStaging && this.deps.previews
      ? this.deps.previews.withStaging({ creativeDir, creativeSlug: slug, n: body.baseVersion }, body.token, format, fn, locale)
      : fn(null));

    return withStaging(async (staging) => {
      const stagedOf = (p: string): StagedAsset | undefined => (declared.has(p) ? staging?.assets.get(p) : undefined);
      // A path the draft names that the base has is the base's file, unless it was staged with other content (below).
      const available = (p: string) => baseFiles.has(p) || stagedOf(p) !== undefined;
      const refusals = editorRefusals(draft, baseLoaded.composition, available, locale);
      if (refusals.length > 0) throw invalid(refusals);
      const used = [...referenced].filter((p) => stagedOf(p) !== undefined);
      const sizes = new Map(baseLoaded.folder.sizes);
      for (const p of used) if (!baseFiles.has(p)) sizes.set(p.normalize('NFC'), { size: stagedOf(p)!.size });
      const v = validateComposition(draft, { format: preset, files: sizes });
      if (!v.ok) throw invalid(problemTexts(v.problems));

      const n = await store.nextVersionNumber(slug);
      await this.deps.turns.clearStaleOutputs(store, slug, n, versions);
      await versionDirReady(creativeDir, n);
      const vdir = store.outputsDir(slug, n);
      let recorded = false;
      try {
        const compRel = `outputs/v${n}/${compositionDirOf(format)}`;
        const compDir = join(creativeDir, ...compRel.split('/'));
        if ((await copyComposition(creativeDir, latest.n, baseComp, compRel)) !== 'ok') throw carryFailed(format);
        for (const p of used) {
          const st = await hashConfinedFile(staging!.root, p);
          if (!st || 'skipped' in st) throw invalid([e.srcUnavailable({ clip: '-', path: p })]);
          const inBase = baseFiles.get(p);
          if (inBase) {
            if (inBase.sha256 !== st.sha256) throw new CodedError(409, e.stagedCollision({ path: p }), 'editor-staged-collision');
            continue; // the same content: the base's copy is the file
          }
          const dest = join(compDir, ...p.split('/'));
          await mkdir(dirname(dest), { recursive: true });
          await copyFile(join(staging!.root, ...p.split('/')), dest, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
          const copy = await hashConfinedFile(compDir, p);
          if (!copy || 'skipped' in copy || copy.sha256 !== st.sha256) throw invalid([e.srcUnavailable({ clip: '-', path: p })]);
        }
        await writeThroughTemp(compDir, 'composition.json', async (temp) => { await writeFile(temp, text, { flag: 'wx' }); return true; });
        const loaded = await loadComposition(compDir, preset);
        if (!loaded.ok) throw invalid(problemTexts(loaded.problems));
        // The folder is the base's files (html layers byte for byte), the staged files used, and the new composition.json.
        const stagedUsed = new Set(used);
        const files = new Map(loaded.folder.files.map((f) => [f.path, f] as const));
        for (const f of baseComp.files) {
          if (f.path === 'composition.json') continue;
          if (files.get(f.path)?.sha256 !== f.sha256) throw invalid([f.path.startsWith('layers/') ? e.layersChanged : e.srcUnavailable({ clip: '-', path: f.path })]);
        }
        for (const f of loaded.folder.files) {
          if (f.path === 'composition.json' || baseFiles.has(f.path) || stagedUsed.has(f.path)) continue;
          throw invalid([f.path.startsWith('layers/') ? e.layersChanged : e.srcUnavailable({ clip: '-', path: f.path })]);
        }

        const saved = await this.deps.turns.finishCompositions(ref, store, { creative, targets: [format], carried, carriedComps, links }, presets, latest, n, label, locale, { direct: true, base: { durationSec: baseComp.duration, ...(latestEntry.userDuration ? { userDuration: latestEntry.userDuration } : {}) } });
        const { problems } = saved;
        const status = problems.length === 0 ? 'complete' : 'incomplete';
        // The agent's workspace gets an exact copy of this version's compositions (decisions log 263), committed with it so a
        // restart from this version finds it too. Best effort: the next prompt names the version's folders anyway.
        await alignEditorCopies(creativeDir, { n, origin: 'editor', compositions: saved.compositions } as VersionEntry).catch(() => []);
        const commit = await this.deps.git.commitAll(ref.projectDir, `${creative.title}: v${n}`);
        const request = body.ops.length > 0 ? describeEdits(body.ops, baseLoaded.composition, locale) : e.summaryNone;
        await store.appendVersion(slug, {
          n, commit, sessionId: creative.resumeFrom?.sessionId ?? latest.sessionId ?? null, status, createdAt: now(),
          request, outputs: saved.outputs, problems, tools: [], renderCommand: null, basedOn: body.baseVersion,
          compositions: saved.compositions, origin: 'editor', ...(saved.localizations ? { localizations: saved.localizations } : {}),
        });
        recorded = true;
        await store.appendConversation(slug, { type: 'version', at: now(), n, status });
        // As a version made without the agent after a restart: the next agent turn still forks the restored session.
        const resumeFrom = creative.resumeFrom ? { version: n, sessionId: creative.resumeFrom.sessionId } : null;
        await store.update(slug, { status: status === 'complete' ? 'ready' : 'incomplete', error: null, resumeFrom });
        await this.deps.turns.commitState(ref, m.jobs.versionStateCommit({ title: creative.title, n }));
        this.deps.turns.changed(ref);
        this.deps.turns.storyboardsLater(ref, store, n);
        return { version: n };
      } catch (err) {
        if (!recorded) {
          const st = await lstat(vdir).catch(() => null);
          if (st) await rm(vdir, st.isDirectory() ? { recursive: true, force: true } : { force: true }).catch(() => {});
        }
        throw err;
      }
    });
  }
}
