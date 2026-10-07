import { appendFile, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { brandKitSchema, relativeFileSchema, webUrlSchema, type AssetEntry, type BrandKit, type BrandProposal, type JobSummary, type ServerMessage } from '@motion-studio/shared';
import { z } from 'zod';
import { AGENT_ALLOWED_TOOLS, BRAND_ALLOWED_TOOLS, type AgentRunner } from '../agent/runner.ts';
import type { Git } from '../git.ts';
import type { JobQueue } from '../jobs/job-queue.ts';
import { JsonFileError, readJsonFile } from '../json-file.ts';
import { KeyedMutex } from '../keyed-mutex.ts';
import { LibraryStore } from '../library/library-store.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { WorkspaceError } from '../workspace-store.ts';
import { applyBrandChanges, diffBrandKits } from './brand-diff.ts';
import { buildBrandPrompt, buildDescribePrompt } from './brand-prompt.ts';
import { BrandStore } from './brand-store.ts';

export interface ProjectRef { root: string; projectSlug: string; projectDir: string }
export const brandJobKey = (root: string, slug: string) => `brand:${root}:${slug}`;
export interface BrandServiceDeps { queue: JobQueue; runner: AgentRunner; git: Git; media: MediaTools; model: () => Promise<string | null>; broadcast: (m: ServerMessage) => void }

const listedAsset = z.object({ file: relativeFileSchema, sourceUrl: webUrlSchema.nullish(), description: z.string().max(2000).optional(), tags: z.array(z.string().min(1).max(40)).max(30).optional() });
const describedAsset = z.object({ file: relativeFileSchema, description: z.string().max(2000), tags: z.array(z.string().min(1).max(40)).max(30).optional() });

async function readLenient<T>(path: string, item: z.ZodType<T>): Promise<T[]> {
  const raw = await readFile(path, 'utf8').catch(() => '[]');
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return []; }
  return Array.isArray(data) ? data.flatMap((d) => { const r = item.safeParse(d); return r.success ? [r.data] : []; }) : [];
}
const isFile = async (p: string) => Boolean((await lstat(p).catch(() => null))?.isFile());
/** A regular file whose real path stays inside the project (no symlinked folders leading out). */
async function isFileInside(root: string, p: string): Promise<boolean> {
  if (!(await isFile(p))) return false;
  const [real, realRoot] = await Promise.all([realpath(p).catch(() => null), realpath(root).catch(() => null)]);
  return real !== null && realRoot !== null && real.startsWith(realRoot + sep);
}
const hidden = (file: string) => file.split('/').some((s) => s.startsWith('.'));

export class BrandService {
  private readonly locks = new KeyedMutex();
  constructor(private readonly deps: BrandServiceDeps) {}

  private isActive(key: string) { return this.deps.queue.list().some((j) => j.key === key && (j.state === 'queued' || j.state === 'running')); }
  private changed(ref: ProjectRef, ...types: Array<'brand' | 'library'>) { for (const type of types) this.deps.broadcast({ type, project: ref.projectSlug }); }

  analyze(ref: ProjectRef, sourceIds?: string[]): Promise<JobSummary> {
    const key = brandJobKey(ref.root, ref.projectSlug);
    return this.locks.run(key, async () => {
      if (this.isActive(key)) throw new WorkspaceError(409, "Un'analisi del brand o una descrizione degli asset è già in corso per questo progetto");
      const store = new BrandStore(ref.projectDir);
      const all = await store.readSources();
      const sources = sourceIds ? all.filter((s) => sourceIds.includes(s.id)) : all;
      if (sources.length === 0) throw new WorkspaceError(400, 'Aggiungi almeno un sito o un\'immagine da analizzare');
      return this.deps.queue.enqueue({ key, label: 'Analisi brand', run: (signal, jobId) => this.runAnalysis(ref, store, sources, signal, jobId) });
    });
  }

  private async runAgent(ref: ProjectRef, prompt: string, allowedTools: readonly string[], logFile: string | null, signal: AbortSignal, jobId: string): Promise<'ok' | 'cancelled'> {
    const run = this.deps.runner.start({ cwd: ref.projectDir, prompt, model: (await this.deps.model()) ?? undefined, allowedTools: [...allowedTools] }, (event) => {
      this.deps.broadcast({ type: 'agent', jobId, event });
      if (logFile) void appendFile(logFile, `${JSON.stringify({ at: new Date().toISOString(), event })}\n`).catch(() => {});
    });
    const onAbort = () => run.cancel();
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    const outcome = await run.done.finally(() => signal.removeEventListener('abort', onAbort));
    if (outcome.status === 'cancelled') return 'cancelled';
    if (outcome.status === 'failed') throw new Error(outcome.error ?? 'Turno non riuscito');
    return 'ok';
  }

  private async runAnalysis(ref: ProjectRef, store: BrandStore, sources: Awaited<ReturnType<BrandStore['readSources']>>, signal: AbortSignal, jobId: string): Promise<void | 'cancelled'> {
    const library = new LibraryStore(ref.projectDir, this.deps.media);
    const id = await store.newProposalId();
    const dir = store.proposalDir(id);
    const rel = (p: string) => relative(ref.projectDir, p).split('\\').join('/');
    try {
      const currentKit = await store.readKit();
      const currentGuidelines = await store.readGuidelines();
      await writeFile(join(dir, 'brand-kit.json'), JSON.stringify(currentKit, null, 2));
      await writeFile(join(dir, 'guidelines.md'), currentGuidelines);
      const before = new Set(await library.unregisteredAssets());
      const block = {
        proposalDir: rel(dir), kitFile: rel(join(dir, 'brand-kit.json')), guidelinesFile: rel(join(dir, 'guidelines.md')),
        assetsListFile: rel(join(dir, 'assets.json')), summaryFile: rel(join(dir, 'summary.md')),
        sources: sources.map((s) => ({ id: s.id, kind: s.kind, url: s.url, file: s.file })),
      };
      if ((await this.runAgent(ref, buildBrandPrompt(block), BRAND_ALLOWED_TOOLS, join(dir, 'log.jsonl'), signal, jobId)) === 'cancelled') {
        await rm(dir, { recursive: true, force: true });
        return 'cancelled';
      }
      let proposed: BrandKit;
      try { proposed = await readJsonFile(join(dir, 'brand-kit.json'), brandKitSchema); }
      catch (e) { throw new Error(`Proposta non valida: ${e instanceof JsonFileError ? e.message.replace(/^.*?: /, '') : (e as Error).message}`); }
      const dropped: string[] = [];
      const keepFile = async (file: string | null, label: string) => {
        if (file === null || await isFileInside(ref.projectDir, join(ref.projectDir, ...file.split('/')))) return true;
        dropped.push(`${label} (${file} non trovato)`);
        return false;
      };
      proposed = { ...proposed,
        logos: (await Promise.all(proposed.logos.map(async (l) => ((await keepFile(l.file, l.id)) ? l : null)))).filter((l) => l !== null),
        fonts: (await Promise.all(proposed.fonts.map(async (f) => ((await keepFile(f.file, f.id)) ? f : null)))).filter((f) => f !== null) };

      const listed = (await readLenient(join(dir, 'assets.json'), listedAsset)).filter((a) => !hidden(a.file));
      const existingListed: typeof listed = [];
      for (const a of listed) if (await isFile(library.resolve('assets', a.file))) existingListed.push(a);
      const appeared = (await library.unregisteredAssets()).filter((f) => !before.has(f) && !existingListed.some((a) => a.file === f));
      const registered: AssetEntry[] = [];
      for (const item of [
        ...existingListed.map((a) => ({ file: a.file, origin: 'website' as const, sourceUrl: a.sourceUrl ?? null, description: a.description, tags: a.tags })),
        ...appeared.map((file) => ({ file, origin: 'website' as const, sourceUrl: null })),
      ]) {
        // The store confines paths; one unusable entry (e.g. a symlink out of assets/) must not sink the whole proposal.
        try { registered.push(...(await library.registerAssets([item]))); }
        catch (e) { if (!(e instanceof WorkspaceError)) throw e; dropped.push(`${item.file} (non registrato)`); }
      }

      const proposedGuidelines = await readFile(join(dir, 'guidelines.md'), 'utf8').catch(() => currentGuidelines);
      const summaryText = (await readFile(join(dir, 'summary.md'), 'utf8').catch(() => '')).slice(0, 2000).trim();
      const proposal: BrandProposal = {
        schemaVersion: 1, id, createdAt: new Date().toISOString(), sourceIds: sources.map((s) => s.id), status: 'open',
        summary: [summaryText, dropped.length ? `Voci scartate: ${dropped.join('; ')}` : ''].filter(Boolean).join('\n\n'),
        changes: diffBrandKits(await store.readKit(), proposed),
        guidelines: proposedGuidelines !== currentGuidelines ? { current: currentGuidelines, proposed: proposedGuidelines } : null,
        assetsAdded: registered.map((a) => a.file),
      };
      await store.writeProposal(proposal);
      await store.markAnalyzed(proposal.sourceIds, proposal.createdAt);
      await this.deps.git.commitAll(ref.projectDir, `Analisi brand ${id}`);
      this.changed(ref, 'brand', 'library');
    } catch (err) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      this.changed(ref, 'brand');
      throw err;
    }
  }

  describeAssets(ref: ProjectRef, files?: string[]): Promise<JobSummary> {
    const key = brandJobKey(ref.root, ref.projectSlug);
    return this.locks.run(key, async () => {
      if (this.isActive(key)) throw new WorkspaceError(409, "Un'analisi del brand o una descrizione degli asset è già in corso per questo progetto");
      const library = new LibraryStore(ref.projectDir, this.deps.media);
      const assets = await library.listAssets();
      const targets = files ? assets.filter((a) => files.includes(a.file)) : assets.filter((a) => a.description.trim() === '');
      if (targets.length === 0) throw new WorkspaceError(400, 'Nessun asset da descrivere');
      return this.deps.queue.enqueue({
        key, label: 'Descrizione asset',
        run: async (signal, jobId) => {
          const outRel = `assets/.describe/${jobId}.json`;
          const outAbs = join(ref.projectDir, 'assets', '.describe', `${jobId}.json`);
          await mkdir(join(ref.projectDir, 'assets', '.describe'), { recursive: true });
          const prompt = buildDescribePrompt({ outFile: outRel, files: targets.map((t) => `assets/${t.file}`) });
          if ((await this.runAgent(ref, prompt, AGENT_ALLOWED_TOOLS, null, signal, jobId)) === 'cancelled') return 'cancelled';
          const wanted = new Set(targets.map((t) => t.file));
          for (const d of await readLenient(outAbs, describedAsset)) {
            if (wanted.has(d.file)) await library.updateAsset(d.file, { description: d.description, ...(d.tags ? { tags: d.tags } : {}) });
          }
          await rm(outAbs, { force: true });
          await this.deps.git.commitAll(ref.projectDir, 'Descrizione asset');
          this.changed(ref, 'library');
        },
      });
    });
  }

  applyProposal(ref: ProjectRef, id: string, acceptedIds: string[], applyGuidelines: boolean): Promise<{ kit: BrandKit; proposal: BrandProposal }> {
    return this.locks.run(`apply:${ref.projectDir}`, async () => {
      const store = new BrandStore(ref.projectDir);
      const proposal = await store.readProposal(id);
      if (proposal.status !== 'open') throw new WorkspaceError(409, 'La proposta è già stata applicata o scartata');
      const kit = await store.writeKit(applyBrandChanges(await store.readKit(), proposal.changes, acceptedIds));
      if (applyGuidelines && proposal.guidelines) await store.writeGuidelines(proposal.guidelines.proposed);
      const next: BrandProposal = { ...proposal, status: 'applied' };
      await store.writeProposal(next);
      await this.deps.git.commitAll(ref.projectDir, `Applica proposta ${id}`);
      this.changed(ref, 'brand');
      return { kit, proposal: next };
    });
  }

  discardProposal(ref: ProjectRef, id: string): Promise<BrandProposal> {
    return this.locks.run(`apply:${ref.projectDir}`, async () => {
      const store = new BrandStore(ref.projectDir);
      const proposal = await store.readProposal(id);
      if (proposal.status !== 'open') throw new WorkspaceError(409, 'La proposta è già stata applicata o scartata');
      const next: BrandProposal = { ...proposal, status: 'discarded' };
      await store.writeProposal(next);
      await this.deps.git.commitAll(ref.projectDir, `Scarta proposta ${id}`);
      this.changed(ref, 'brand');
      return next;
    });
  }
}
