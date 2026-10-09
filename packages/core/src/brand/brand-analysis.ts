import { appendFile, lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { brandProposalSchema, issuesText, messages, relativeFileSchema, webUrlSchema, type AssetEntry, type Locale, type BrandKit, type BrandProposal, type JobSummary, type ServerMessage, type UsageSummary } from '@motion-studio/shared';
import { z } from 'zod';
import type { AgentLauncher } from '../agent/launcher.ts';
import type { Git } from '../git.ts';
import type { JobQueue } from '../jobs/job-queue.ts';
import { KeyedMutex } from '../keyed-mutex.ts';
import { LibraryStore } from '../library/library-store.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { WorkspaceError } from '../workspace-store.ts';
import { guardedPaths, readAgentFile, restoreGuarded, skipText, snapshotGuarded, type SkipReason } from './agent-guard.ts';
import { applyBrandChanges, diffBrandKits } from './brand-diff.ts';
import { buildBrandPrompt, buildDescribePrompt } from './brand-prompt.ts';
import { BrandStore } from './brand-store.ts';
import { parseProposedKit } from './proposed-kit.ts';
import { currentLocale, t } from '../i18n.ts';
import { sumUsage } from '../usage/usage-tracker.ts';

export interface ProjectRef { root: string; projectSlug: string; projectDir: string }
export const brandJobKey = (root: string, slug: string) => `brand:${root}:${slug}`;
export interface BrandServiceDeps { queue: JobQueue; launcher: AgentLauncher; git: Git; media: MediaTools; model: () => Promise<string | null>; broadcast: (m: ServerMessage) => void }

const listedAsset = z.object({ file: relativeFileSchema, sourceUrl: webUrlSchema.nullish(), description: z.string().max(2000).optional(), tags: z.array(z.string().min(1).max(40)).max(30).optional() });
const describedAsset = z.object({ file: relativeFileSchema, description: z.string().max(2000), tags: z.array(z.string().min(1).max(40)).max(30).optional() });
const MAX_GUIDELINES = 200_000;
const MAX_DROPPED_SHOWN = 20;
const MAX_SUMMARY = 5000;


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
  private async runAgent(ref: ProjectRef, kind: 'brand-analysis' | 'describe', prompt: string, logFile: string | null, signal: AbortSignal, jobId: string, tampered: string[], locale: Locale, sandboxed: boolean): Promise<{ status: 'ok' | 'cancelled'; usage: UsageSummary | undefined }> {
    const guard = await snapshotGuarded(ref.projectDir);
    try {
      const run = await this.deps.launcher.start({
        kind, jobId, projectSlug: ref.projectSlug, projectDir: ref.projectDir, sandboxed,
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

  private async runAnalysis(ref: ProjectRef, store: BrandStore, sources: Awaited<ReturnType<BrandStore['readSources']>>, signal: AbortSignal, jobId: string): Promise<void | 'cancelled'> {
    // The job's language is fixed when it starts: the prompt and every line stored in the proposal use it, whatever
    // the setting becomes meanwhile. Errors that fail the job are shown live and use the current language.
    const locale = currentLocale();
    const m = messages(locale);
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
        sources: sources.map((s) => ({ id: s.id, kind: s.kind, url: s.url, file: s.file })),
      };
      const tampered: string[] = [];
      const sandboxed = await this.deps.launcher.sandboxed();
      const turn = await this.runAgent(ref, 'brand-analysis', buildBrandPrompt(block, locale, sandboxed), join(dir, 'log.jsonl'), signal, jobId, tampered, locale, sandboxed);
      if (turn.status === 'cancelled') {
        await rm(dir, { recursive: true, force: true });
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
      await this.locks.run(`apply:${ref.projectDir}`, async () => {
        for (const old of await store.listProposals()) if (old.status === 'open' && old.id !== id) await store.writeProposal({ ...old, status: 'discarded' });
        await store.writeProposal(proposal);
      });
      await store.markAnalyzed(proposal.sourceIds, proposal.createdAt);
      await this.deps.git.commitAll(ref.projectDir, t().brand.commitAnalysis({ id }));
      this.changed(ref, 'brand', 'library');
    } catch (err) {
      // A turn that completed but produced an unusable proposal still downloaded files: register them rather than leave them orphaned.
      if (pendingDownloads) {
        const downloads = await pendingDownloads().catch(() => null);
        if (downloads?.registered.length) await this.deps.git.commitAll(ref.projectDir, t().brand.commitAnalysisAssets({ id })).catch(() => null);
      }
      await rm(dir, { recursive: true, force: true }).catch(() => {});
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
    // Files download_file already registered keep their origin and source URL; the list only adds description and tags.
    const known = new Map((await library.listAssets()).map((a) => [a.file, a]));
    const registered: AssetEntry[] = [];
    for (const item of [
      ...existingListed.map((a) => {
        const k = known.get(a.file);
        return k ? { file: a.file, origin: k.origin, sourceUrl: k.sourceUrl, description: a.description, tags: a.tags }
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
    return this.locks.run(`apply:${ref.projectDir}`, async () => {
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
    return this.locks.run(`apply:${ref.projectDir}`, async () => {
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
