import { appendFile, lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { brandProposalSchema, issuesText, messages, relativeFileSchema, webUrlSchema, type AssetEntry, type BrandPhase, type Locale, type BrandKit, type BrandProposal, type JobSummary, type ServerMessage, type UsageSummary } from '@motion-studio/shared';
import { z } from 'zod';
import type { AgentLauncher } from '../agent/launcher.ts';
import type { Git } from '../git.ts';
import { JobFailedError, type JobQueue } from '../jobs/job-queue.ts';
import { changedCodebaseFiles, codebaseFileStates, codebaseProblemText, codebaseSnapshot, codebaseSpellings, resolveBrandCodebase, type BrandCodebase, type Snapshot } from '../codebases.ts';
import { KeyedMutex } from '../keyed-mutex.ts';
import { LibraryStore } from '../library/library-store.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { WorkspaceError } from '../workspace-store.ts';
import { guardedPaths, readAgentFile, restoreGuarded, skipText, snapshotGuarded, type SkipReason } from './agent-guard.ts';
import { applyBrandChanges, diffBrandKits } from './brand-diff.ts';
import { buildBrandPrompt, buildDescribePrompt } from './brand-prompt.ts';
import { applyLockKey, BrandStore, proposalLocks } from './brand-store.ts';
import { parseProposedKit } from './proposed-kit.ts';
import { currentLocale, t } from '../i18n.ts';
import { sumUsage } from '../usage/usage-tracker.ts';
import { noteCoreChange } from '../core-changes.ts';

export interface ProjectRef { root: string; projectSlug: string; projectDir: string }
export const brandJobKey = (root: string, slug: string) => `brand:${root}:${slug}`;
export interface BrandServiceDeps { queue: JobQueue; launcher: AgentLauncher; git: Git; media: MediaTools; model: () => Promise<string | null>; broadcast: (m: ServerMessage) => void;
  /** Motion Studio's config folder: never inside or around a codebase source (Phase 14). */
  configDir?: string;
}

const listedAsset = z.object({ file: relativeFileSchema, sourceUrl: webUrlSchema.nullish(), description: z.string().max(2000).optional(), tags: z.array(z.string().min(1).max(40)).max(30).optional() });
const describedAsset = z.object({ file: relativeFileSchema, description: z.string().max(2000), tags: z.array(z.string().min(1).max(40)).max(30).optional() });
const MAX_GUIDELINES = 200_000;
const MAX_DROPPED_SHOWN = 20;
const MAX_SUMMARY = 5000;
const MAX_SITE_NOTES = 40;
const SITE_NOTES_SHOWN = 3;
/** Changed files of a codebase named in the job's notes (the rest is counted). */
const CHANGED_FILES_SHOWN = 50;


/** Valid items of a JSON array the agent wrote; `skipped` explains a file that was not read (symlink, too large). */
async function readLenient<T>(path: string, item: z.ZodType<T>): Promise<{ items: T[]; skipped?: SkipReason }> {
  const file = await readAgentFile(path);
  if (file === null) return { items: [] };
  if ('skipped' in file) return { items: [], skipped: file.skipped };
  let data: unknown;
  try { data = JSON.parse(file.text); } catch { return { items: [] }; }
  return { items: Array.isArray(data) ? data.flatMap((d) => { const r = item.safeParse(d); return r.success ? [r.data] : []; }) : [] };
}
const isFile = async (p: string) => Boolean((await lstat(p).catch(() => null))?.isFile());
/** A regular file whose real path stays inside `root` (no symlinked folders leading out). */
async function isFileInside(root: string, p: string): Promise<boolean> {
  if (!(await isFile(p))) return false;
  const [real, realRoot] = await Promise.all([realpath(p).catch(() => null), realpath(root).catch(() => null)]);
  return real !== null && realRoot !== null && real.startsWith(realRoot + sep);
}
const hidden = (file: string) => file.split('/').some((s) => s.startsWith('.'));
const droppedText = (dropped: string[], locale: Locale) => {
  if (dropped.length === 0) return '';
  const extra = dropped.length - MAX_DROPPED_SHOWN;
  const m = messages(locale).brand;
  return m.droppedPrefix({ list: [...dropped.slice(0, MAX_DROPPED_SHOWN), ...(extra > 0 ? [m.droppedMore({ count: extra })] : [])].join('; ') });
};

export class BrandService {
  private readonly locks = new KeyedMutex();
  constructor(private readonly deps: BrandServiceDeps) {}

  private isActive(key: string) { return this.deps.queue.list().some((j) => j.key === key && (j.state === 'queued' || j.state === 'running')); }
  private changed(ref: ProjectRef, ...types: Array<'brand' | 'library'>) { for (const type of types) this.deps.broadcast({ type, project: ref.projectSlug }); }

  analyze(ref: ProjectRef, sourceIds?: string[]): Promise<JobSummary> {
    const key = brandJobKey(ref.root, ref.projectSlug);
    return this.locks.run(key, async () => {
      if (this.isActive(key)) throw new WorkspaceError(409, t().errors.analysisRunning);
      const store = new BrandStore(ref.projectDir);
      const all = await store.readSources();
      const sources = sourceIds ? all.filter((s) => sourceIds.includes(s.id)) : all;
      if (sources.length === 0) throw new WorkspaceError(400, t().errors.addSourceFirst);
      return this.deps.queue.enqueue({ key, kind: 'brand-analysis', label: t().jobs.brandAnalysisLabel, run: (signal, jobId) => this.runAnalysis(ref, store, sources, signal, jobId) });
    });
  }

  /**
   * Runs one agent turn with the live metadata files denied to the editing tools; whatever the outcome, files the agent
   * still managed to change (e.g. through an interpreter) are restored. `tampered` receives one note per file the agent changed, in `locale`.
   */
  private async runAgent(ref: ProjectRef, kind: 'brand-analysis' | 'describe', prompt: string, logFile: string | null, signal: AbortSignal, jobId: string, tampered: string[], locale: Locale, sandboxed: boolean, addNotes?: (lines: string[]) => void, codebases?: string[], brandWebsite = false): Promise<{ status: 'ok' | 'cancelled'; usage: UsageSummary | undefined }> {
    const guard = await snapshotGuarded(ref.projectDir);
    try {
      const run = await this.deps.launcher.start({
        kind, jobId, projectSlug: ref.projectSlug, projectDir: ref.projectDir, sandboxed, locale, ...(addNotes ? { addNotes } : {}),
        ...(codebases?.length ? { codebases, brandWebsite } : {}),
        // The running proposal's log is passed explicitly: it may not exist yet at launch (it is created by the first event), so the launcher's directory scan could miss it.
        protectedFiles: [...(await guardedPaths(ref.projectDir)), ...(logFile ? [logFile] : [])],
        request: { prompt, model: (await this.deps.model()) ?? undefined },
        onEvent: (event) => {
          this.deps.broadcast({ type: 'agent', jobId, event });
          // Live usage estimates are only for the UI: the log keeps the final usage event.
          if (event.kind === 'usage' && event.live) return;
          if (logFile) void appendFile(logFile, `${JSON.stringify({ at: new Date().toISOString(), event })}\n`).catch(() => {});
        },
      });
      const onAbort = () => run.cancel();
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      const outcome = await run.done.finally(() => signal.removeEventListener('abort', onAbort));
      if (outcome.status === 'cancelled') return { status: 'cancelled', usage: undefined };
      if (outcome.status === 'failed') throw new Error(outcome.error ?? t().errors.turnFailed);
      return { status: 'ok', usage: sumUsage([outcome.usage]) };
    } finally {
      tampered.push(...(await restoreGuarded(guard, ref.projectDir, locale)));
    }
  }

  /** A phase marker of the core (no text): the UI's stepper starts at `queued` and ends at `done`. */
  private phase(jobId: string, phase: BrandPhase) { this.deps.broadcast({ type: 'agent', jobId, event: { kind: 'progress', text: '', phase } }); }

  private async runAnalysis(ref: ProjectRef, store: BrandStore, allSources: Awaited<ReturnType<BrandStore['readSources']>>, signal: AbortSignal, jobId: string): Promise<void | 'cancelled'> {
    this.phase(jobId, 'queued');
    // The job's language is fixed when it starts: the prompt and every line stored in the proposal use it, whatever
    // the setting becomes meanwhile. Errors that fail the job are shown live and use the current language.
    const locale = currentLocale();
    const m = messages(locale);
    // Phase 14 (spec §2.2): codebase sources are validated again now (the folder may have moved or become a link) and used
    // by their normalised and real paths; a folder that no longer passes is left out with a note.
    const jobNotes: string[] = [];
    const note = (text: string) => { jobNotes.push(text); this.deps.queue.patch(jobId, { notes: [...jobNotes] }); };
    const codebases: Array<{ source: string; cb: BrandCodebase }> = [];
    const sources: typeof allSources = [];
    for (const s of allSources) {
      if (s.kind !== 'codebase') { sources.push(s); continue; }
      const cb = await resolveBrandCodebase(s.path ?? '', [ref.projectDir, ref.root], { ...(this.deps.configDir ? { configDir: this.deps.configDir } : {}), others: codebases.map((c) => c.cb.real) });
      if ('problem' in cb) { note(m.jobs.brandCodebaseSkipped({ path: s.path ?? '', reason: codebaseProblemText(cb.problem, s.path ?? '', locale) })); continue; }
      codebases.push({ source: s.id, cb });
      sources.push(s);
    }
    if (sources.length === 0) throw new Error(t().errors.noUsableCodebase);
    const library = new LibraryStore(ref.projectDir, this.deps.media);
    const id = await store.newProposalId();
    const dir = store.proposalDir(id);
    // Set once the agent turn is over and until its downloads are registered.
    let pendingDownloads: (() => ReturnType<BrandService['registerDownloads']>) | null = null;
    const rel = (p: string) => relative(ref.projectDir, p).split('\\').join('/');
    try {
      const currentKit = await store.readKit();
      const currentGuidelines = await store.readGuidelines();
      await writeFile(join(dir, 'brand-kit.json'), JSON.stringify(currentKit, null, 2));
      await writeFile(join(dir, 'guidelines.md'), currentGuidelines);
      // Every file of assets/ that existed before the turn (registered or not): the agent's list can neither rewrite nor claim them.
      const before = new Set([...(await library.unregisteredAssets()), ...(await library.listAssets()).map((a) => a.file)]);
      const block = {
        proposalDir: rel(dir), kitFile: rel(join(dir, 'brand-kit.json')), guidelinesFile: rel(join(dir, 'guidelines.md')),
        assetsListFile: rel(join(dir, 'assets.json')), summaryFile: rel(join(dir, 'summary.md')),
        sources: sources.map((s) => (s.kind === 'codebase'
          ? { id: s.id, kind: s.kind, url: null, file: null, path: codebases.find((c) => c.source === s.id)!.cb.path, ...(s.note ? { note: s.note } : {}) }
          : { id: s.id, kind: s.kind, url: s.url, file: s.file })),
      };
      const tampered: string[] = [];
      // Notes of the agent's tools (inspect_site_fonts: what it refused or cut), in the job's language, once each.
      const siteNotes = new Set<string>();
      const addNotes = (lines: string[]) => { for (const l of lines) if (siteNotes.size < MAX_SITE_NOTES) siteNotes.add(l); };
      const sandboxed = await this.deps.launcher.sandboxed();
      // Without the sandbox the secret files are kept from the agent by its tool rules only (spec §2.2): said in the job.
      if (codebases.length > 0 && !sandboxed) note(m.jobs.brandSecretsToolRulesOnly);
      // Read-only check (decision 722): a fingerprint of each codebase before and after the turn, and the changed entries
      // to name them. A folder git cannot check is analysed anyway, with a note.
      const snapsBefore: Array<{ snap: Snapshot; files: Map<string, string> | null }> = [];
      for (const { cb } of codebases) {
        const snap = await codebaseSnapshot(cb.real);
        snapsBefore.push({ snap, files: 'value' in snap ? await codebaseFileStates(cb.real) : null });
        if (!('value' in snap)) note(snap.unavailable === 'not-git' ? m.jobs.brandCodebaseNotCheckable({ path: cb.path }) : m.jobs.brandCodebaseCheckFailed({ path: cb.path }));
      }
      let turn: Awaited<ReturnType<BrandService['runAgent']>> | null = null;
      let turnError: unknown = null;
      try {
        turn = await this.runAgent(ref, 'brand-analysis', buildBrandPrompt(block, locale, sandboxed), join(dir, 'log.jsonl'), signal, jobId, tampered, locale, sandboxed, addNotes, codebases.flatMap((c) => codebaseSpellings(c.cb)), sources.some((s) => s.kind === 'website'));
      } catch (e) { turnError = e; }
      // Whatever the outcome (also a cancelled or failed turn), a changed codebase fails the job and discards the proposal.
      // Fail closed (fix round 1): a codebase that was checkable before and cannot be checked after counts as changed, and
      // so does any difference in the per-file states (which also hash the content of ignored files).
      const failures: string[] = [];
      for (const [k, { cb }] of codebases.entries()) {
        const b = snapsBefore[k]!;
        const after = await codebaseSnapshot(cb.real);
        if (!('value' in b.snap)) {
          if ('value' in after) {
            // A repository that appears during the turn (git init) is a change. A check that failed before and works after
            // cannot be compared: it fails closed too, worded as a failed check rather than a change (fix round 2).
            if (b.snap.unavailable === 'not-git') failures.push(t().jobs.brandCodebaseChanged({ path: cb.path }));
            else {
              note(m.jobs.brandCodebaseCheckFailedBefore({ path: cb.path }));
              failures.push(t().jobs.brandCodebaseCheckFailedBefore({ path: cb.path }));
            }
          }
          continue;
        }
        if (!('value' in after)) {
          note(m.jobs.brandCodebaseCheckFailedAfter({ path: cb.path }));
          failures.push(t().jobs.brandCodebaseCheckFailedAfter({ path: cb.path }));
          continue;
        }
        const afterFiles = await codebaseFileStates(cb.real);
        const files = changedCodebaseFiles(b.files, afterFiles);
        const statesLost = b.files !== null && afterFiles === null;
        if (after.value === b.snap.value && files.length === 0 && !statesLost) continue;
        const extra = files.length - CHANGED_FILES_SHOWN;
        note(files.length
          ? m.jobs.brandCodebaseChangedFiles({ path: cb.path, list: [...files.slice(0, CHANGED_FILES_SHOWN), ...(extra > 0 ? [m.brand.droppedMore({ count: extra })] : [])].join(', ') })
          : m.jobs.brandCodebaseChangedUnknown({ path: cb.path }));
        failures.push(t().jobs.brandCodebaseChanged({ path: cb.path }));
      }
      if (failures.length > 0) throw new JobFailedError(failures.join(' '));
      if (turnError !== null || turn === null) throw turnError;
      if (turn.status === 'cancelled') {
        await rm(dir, { recursive: true, force: true });
        await noteCoreChange(join(ref.projectDir, 'brand', 'proposals'));
        return 'cancelled';
      }
      pendingDownloads = () => this.registerDownloads(library, join(dir, 'assets.json'), before, locale);
      const dropped: string[] = [...tampered];
      const kitFile = await readAgentFile(join(dir, 'brand-kit.json'));
      if (kitFile === null || 'skipped' in kitFile) throw new Error(t().errors.proposalKitFile({ reason: kitFile ? skipText(kitFile.skipped) : t().errors.proposalMissing }));
      let json: unknown;
      try { json = JSON.parse(kitFile.text); } catch (e) { throw new Error(t().errors.proposalBadJson({ detail: (e as Error).message })); }
      const firstSite = sources.find((s) => s.kind === 'website' && s.url);
      const firstImage = sources.find((s) => s.kind === 'image' && s.file);
      const defaultSource = firstSite ? { kind: 'website' as const, ref: firstSite.url } : { kind: 'image' as const, ref: firstImage?.file ?? null };
      const parsedKit = parseProposedKit(json, currentKit, defaultSource, locale);
      dropped.push(...parsedKit.dropped);
      let proposed: BrandKit = parsedKit.kit;
      // Logos and fonts must point at an existing regular file inside assets/.
      const keepFile = async (file: string | null, label: string) => {
        if (file === null) return true;
        if (!file.startsWith('assets/')) { dropped.push(m.brand.droppedOutsideAssets({ label, file })); return false; }
        if (await isFileInside(library.dir('assets'), join(ref.projectDir, ...file.split('/')))) return true;
        dropped.push(m.brand.droppedNotFound({ label, file }));
        return false;
      };
      const logos: BrandKit['logos'] = [];
      for (const l of proposed.logos) if (await keepFile(l.file, l.id)) logos.push(l);
      const fonts: BrandKit['fonts'] = [];
      for (const f of proposed.fonts) if (await keepFile(f.file, f.id)) fonts.push(f);
      proposed = { ...proposed, logos, fonts };

      pendingDownloads = null;
      const downloads = await this.registerDownloads(library, join(dir, 'assets.json'), before, locale);
      dropped.push(...downloads.dropped);
      // Last, and as one line: the kit's own refusals stay visible whatever a site produced.
      if (siteNotes.size) {
        const notes = [...siteNotes];
        dropped.push(m.brand.siteFontsSummary({ count: notes.length, list: notes.slice(0, SITE_NOTES_SHOWN).join(' · '), more: notes.length > SITE_NOTES_SHOWN }));
      }
      const registered = downloads.registered;

      let proposedGuidelines = currentGuidelines;
      const guidelinesFile = await readAgentFile(join(dir, 'guidelines.md'));
      if (guidelinesFile && 'skipped' in guidelinesFile) {
        if (guidelinesFile.skipped === 'too-large') throw new Error(t().errors.proposedGuidelinesTooLong);
        dropped.push(m.brand.ignoredGuidelines({ reason: skipText(guidelinesFile.skipped, locale) }));
      } else if (guidelinesFile) {
        if (guidelinesFile.text.length > MAX_GUIDELINES) throw new Error(t().errors.proposedGuidelinesTooLong);
        proposedGuidelines = guidelinesFile.text;
      }
      const summaryFile = await readAgentFile(join(dir, 'summary.md'));
      if (summaryFile && 'skipped' in summaryFile) dropped.push(m.brand.ignoredSummary({ reason: skipText(summaryFile.skipped, locale) }));
      const summaryText = summaryFile && 'text' in summaryFile ? summaryFile.text.slice(0, 2000).trim() : '';
      const proposal: BrandProposal = {
        schemaVersion: 1, id, createdAt: new Date().toISOString(), sourceIds: sources.map((s) => s.id), status: 'open',
        summary: [summaryText, droppedText(dropped, locale)].filter(Boolean).join('\n\n').slice(0, MAX_SUMMARY),
        // Against the kit the agent was given: the proposal is what the agent changed, not a revert of later manual edits.
        changes: diffBrandKits(currentKit, proposed),
        guidelines: proposedGuidelines !== currentGuidelines ? { current: currentGuidelines, proposed: proposedGuidelines } : null,
        assetsAdded: registered.map((a) => a.file),
        ...(turn.usage ? { usage: turn.usage } : {}),
      };
      // Validated before anything is superseded: an invalid proposal leaves the open one in place.
      const valid = brandProposalSchema.safeParse(proposal);
      if (!valid.success) throw new Error(t().errors.proposalInvalid({ detail: issuesText(valid.error, currentLocale(), t().errors.rootPath) }));
      // Under the apply lock: a new proposal supersedes the open ones (they would diff against an outdated kit).
      await proposalLocks.run(applyLockKey(ref.projectDir), async () => {
        for (const old of await store.listProposals()) if (old.status === 'open' && old.id !== id) await store.writeProposal({ ...old, status: 'discarded' });
        await store.writeProposal(proposal);
      });
      await store.markAnalyzed(proposal.sourceIds, proposal.createdAt);
      await this.deps.git.commitAll(ref.projectDir, t().brand.commitAnalysis({ id }));
      this.phase(jobId, 'done');
      this.changed(ref, 'brand', 'library');
    } catch (err) {
      // A turn that completed but produced an unusable proposal still downloaded files: register them rather than leave them orphaned.
      if (pendingDownloads) {
        const downloads = await pendingDownloads().catch(() => null);
        if (downloads?.registered.length) await this.deps.git.commitAll(ref.projectDir, t().brand.commitAnalysisAssets({ id })).catch(() => null);
      }
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      await noteCoreChange(join(ref.projectDir, 'brand', 'proposals'));
      // Assets may already be registered when a late step fails.
      this.changed(ref, 'brand', 'library');
      throw err;
    }
  }

  /**
   * Registers what the agent downloaded under assets/: the files it listed (with their details) that pass the store's
   * checks, plus files that appeared during the turn without being listed. Files that existed before the turn (`before`)
   * are left as they are and never reported as added. `dropped` explains the entries left out, in `locale`.
   */
  private async registerDownloads(library: LibraryStore, listFile: string, before: Set<string>, locale: Locale): Promise<{ registered: AssetEntry[]; dropped: string[] }> {
    const dropped: string[] = [];
    const m = messages(locale);
    const listedRead = await readLenient(listFile, listedAsset);
    if (listedRead.skipped) dropped.push(m.brand.ignoredAssetList({ reason: skipText(listedRead.skipped, locale) }));
    const existingListed: typeof listedRead.items = [];
    for (const a of listedRead.items.filter((x) => !hidden(x.file) && !before.has(x.file))) {
      // resolve() refuses reserved names (assets.json): one bad entry must not sink the proposal.
      try { if (await isFile(library.resolve('assets', a.file))) existingListed.push(a); }
      catch (e) { if (!(e instanceof WorkspaceError)) throw e; dropped.push(m.brand.droppedNotRegistered({ file: a.file })); }
    }
    const appeared = (await library.unregisteredAssets()).filter((f) => !before.has(f) && !existingListed.some((a) => a.file === f));
    // Files download_file or import_codebase_file already registered keep their origin, source URL and tags (`brand`); the
    // list only adds a description and more tags (decision 783; 30 = the asset tag limit).
    const known = new Map((await library.listAssets()).map((a) => [a.file, a]));
    const registered: AssetEntry[] = [];
    for (const item of [
      ...existingListed.map((a) => {
        const k = known.get(a.file);
        return k ? { file: a.file, origin: k.origin, sourceUrl: k.sourceUrl, description: a.description, tags: [...new Set([...k.tags, ...(a.tags ?? [])])].slice(0, 30) }
          : { file: a.file, origin: 'website' as const, sourceUrl: a.sourceUrl ?? null, description: a.description, tags: a.tags };
      }),
      ...appeared.map((file) => ({ file, origin: 'website' as const, sourceUrl: null })),
    ]) {
      // The store confines paths; one unusable entry (e.g. a symlink out of assets/) must not sink the whole proposal.
      try { registered.push(...(await library.registerAssets([item]))); }
      catch (e) { if (!(e instanceof WorkspaceError)) throw e; dropped.push(m.brand.droppedNotRegistered({ file: item.file })); }
    }
    return { registered, dropped };
  }

  describeAssets(ref: ProjectRef, files?: string[]): Promise<JobSummary> {
    const key = brandJobKey(ref.root, ref.projectSlug);
    return this.locks.run(key, async () => {
      if (this.isActive(key)) throw new WorkspaceError(409, t().errors.analysisRunning);
      const library = new LibraryStore(ref.projectDir, this.deps.media);
      const assets = await library.listAssets();
      const targets = files ? assets.filter((a) => files.includes(a.file)) : assets.filter((a) => a.description.trim() === '');
      if (targets.length === 0) throw new WorkspaceError(400, t().errors.noAssetsToDescribe);
      return this.deps.queue.enqueue({
        key, kind: 'asset-description', label: t().jobs.assetDescriptionLabel,
        run: async (signal, jobId) => {
          const locale = currentLocale();
          const outRel = `assets/.describe/${jobId}.json`;
          const outAbs = join(ref.projectDir, 'assets', '.describe', `${jobId}.json`);
          const notes: string[] = [];
          try {
            await mkdir(join(ref.projectDir, 'assets', '.describe'), { recursive: true });
            const sandboxed = await this.deps.launcher.sandboxed();
            const prompt = buildDescribePrompt({ outFile: outRel, files: targets.map((t) => `assets/${t.file}`) }, locale, sandboxed);
            const tampered: string[] = [];
            const outcome = await this.runAgent(ref, 'describe', prompt, null, signal, jobId, tampered, locale, sandboxed).finally(() => notes.push(...tampered));
            if (outcome.status === 'cancelled') return 'cancelled';
            const wanted = new Set(targets.map((t) => t.file));
            const described = await readLenient(outAbs, describedAsset);
            if (described.skipped) notes.push(messages(locale).brand.ignoredDescriptions({ reason: skipText(described.skipped, locale) }));
            for (const d of described.items) {
              if (!wanted.has(d.file)) continue;
              try { await library.updateAsset(d.file, { description: d.description, ...(d.tags ? { tags: d.tags } : {}) }); }
              catch (e) { if (!(e instanceof WorkspaceError && e.status === 404)) throw e; notes.push(messages(locale).brand.assetRemovedWhileDescribing({ file: d.file })); }
            }
            await this.deps.git.commitAll(ref.projectDir, t().brand.commitDescribe);
            this.changed(ref, 'library');
          } finally {
            await rm(outAbs, { force: true }).catch(() => {});
            if (notes.length) this.deps.queue.patch(jobId, { notes });
          }
        },
      });
    });
  }

  applyProposal(ref: ProjectRef, id: string, acceptedIds: string[], applyGuidelines: boolean): Promise<{ kit: BrandKit; proposal: BrandProposal }> {
    return proposalLocks.run(applyLockKey(ref.projectDir), async () => {
      const store = new BrandStore(ref.projectDir);
      const proposal = await store.readProposal(id);
      if (proposal.status !== 'open') throw new WorkspaceError(409, t().errors.proposalClosed);
      const kit = await store.updateReadableKit((current) => applyBrandChanges(current, proposal.changes, acceptedIds));
      if (applyGuidelines && proposal.guidelines) await store.writeGuidelines(proposal.guidelines.proposed);
      const next: BrandProposal = { ...proposal, status: 'applied' };
      await store.writeProposal(next);
      await this.deps.git.commitAll(ref.projectDir, t().brand.commitApply({ id }));
      this.changed(ref, 'brand');
      return { kit, proposal: next };
    });
  }

  discardProposal(ref: ProjectRef, id: string): Promise<BrandProposal> {
    return proposalLocks.run(applyLockKey(ref.projectDir), async () => {
      const store = new BrandStore(ref.projectDir);
      const proposal = await store.readProposal(id);
      if (proposal.status !== 'open') throw new WorkspaceError(409, t().errors.proposalClosed);
      const next: BrandProposal = { ...proposal, status: 'discarded' };
      await store.writeProposal(next);
      await this.deps.git.commitAll(ref.projectDir, t().brand.commitDiscard({ id }));
      this.changed(ref, 'brand');
      return next;
    });
  }
}
