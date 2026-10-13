import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  COMPOSITION_LIMITS, compositionProblem, compositionProblemText, describeEdits, editOpSchema, effectiveLinks, formatLabel, isCompositionPath, messages,
  normalizeComposition, renderJobKey, validateComposition,
  type CompositionProblem, type FormatPreset, type Locale, type StagedAsset, type VersionEntry,
} from '@motion-studio/shared';
import { hashConfinedFile } from '../brand/agent-guard.ts';
import { loadComposition } from '../compositions/composition-files.ts';
import { findPreset } from '../formats/format-catalog.ts';
import type { Git } from '../git.ts';
import type { JobQueue } from '../jobs/job-queue.ts';
import { CodedError } from '../workspace-store.ts';
import { versionDirReady } from './carry-over.ts';
import { compositionDirOf } from './composition-contract.ts';
import { carriableComposition, copyComposition, type CarriedComposition } from './composition-turn.ts';
import { writeThroughTemp } from './core-files.ts';
import { CreativeStore } from './creative-store.ts';
import type { CreativeRef, CreativeTurnService } from './creative-turns.ts';
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

/** `POST /api/projects/:slug/creatives/:c/edits`. */
export const directEditBodySchema = z.strictObject({
  baseVersion: z.number().int().positive(),
  format: z.string(), // the primary format edited
  baseHash: z.string(), // composition hash of the base
  composition: z.unknown(), // validated in the core
  staged: z.array(z.string()).max(20), // staged paths used by the draft
  ops: z.array(editOpSchema).max(500), // for the summary and the log only; the composition is authoritative
  token: z.string(), // the preview session that owns the staging
});
export type DirectEditBody = z.infer<typeof directEditBodySchema>;

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
    const label = (id: string) => { const p = findPreset(presets, id); return p ? formatLabel(p, locale) : id; };
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
    for (const p of formats.filter((f) => f !== format && !Object.hasOwn(links, f))) {
      if (!own(latest, p)) continue; // not in the latest version (an added format): the agent makes it
      const cc = await carriableComposition(creativeDir, latest, p);
      if (!cc) throw carryFailed(p);
      carried.push(p);
      carriedComps.set(p, cc);
    }

    const draft = normalizeComposition(body.composition);
    const text = `${JSON.stringify(draft, null, 2)}\n`;
    const invalid = (problems: string[]) => {
      const err = new CodedError(422, e.saveInvalid({ text: problems[0] ?? '' }), 'editor-invalid');
      err.problems = problems.slice(0, 50);
      return err;
    };
    const problemTexts = (ps: CompositionProblem[]) => ps.map((p) => compositionProblemText(p, locale));
    if (Buffer.byteLength(text) > COMPOSITION_LIMITS.jsonBytes) {
      throw invalid(problemTexts([compositionProblem('composition.jsonTooLarge', { sizeMB: Math.ceil(Buffer.byteLength(text) / (1024 * 1024)), maxMB: COMPOSITION_LIMITS.jsonBytes / (1024 * 1024) })]));
    }
    const baseFiles = new Map(baseComp.files.map((f) => [f.path, f] as const));
    const referenced = referencedAssets(draft);
    const declared = new Set(body.staged);
    // The session's staging is looked up only when the draft names a file it declares staged (one the base also has must
    // hold the same content: `stagedCollision`).
    const needsStaging = [...referenced].some((p) => declared.has(p));
    const withStaging = <T>(fn: (st: StagingView | null) => Promise<T>): Promise<T> => (needsStaging && this.deps.previews
      ? this.deps.previews.withStaging({ creativeDir, creativeSlug: slug, n: body.baseVersion }, body.token, format, fn)
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

        const saved = await this.deps.turns.finishCompositions(ref, store, { creative, targets: [format], carried, carriedComps, links }, presets, latest, n, label, locale);
        const { problems } = saved;
        const status = problems.length === 0 ? 'complete' : 'incomplete';
        const commit = await this.deps.git.commitAll(ref.projectDir, `${creative.title}: v${n}`);
        const request = body.ops.length > 0 ? describeEdits(body.ops, baseLoaded.composition, locale) : e.summaryNone;
        await store.appendVersion(slug, {
          n, commit, sessionId: creative.resumeFrom?.sessionId ?? latest.sessionId ?? null, status, createdAt: now(),
          request, outputs: saved.outputs, problems, tools: [], renderCommand: null, basedOn: body.baseVersion,
          compositions: saved.compositions, origin: 'editor',
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
