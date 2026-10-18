import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { activeMembers, compareVariantIds, creativeJobKey, letterOfSlug, renderJobKey, type CreativeFile, type CreativeRemovalInfo, type JobSummary, type VariantGroup, type VariantId } from '@motion-studio/shared';
import { noteCoreChange } from '../core-changes.ts';
import { t } from '../i18n.ts';
import type { TrashFn } from '../trash.ts';
import { CodedError, WorkspaceError } from '../workspace-store.ts';
import { CreativeStore } from './creative-store.ts';
import type { CreativeRef, CreativeTurnService } from './creative-turns.ts';
import { memberRef, VariantGroupService } from './variant-group.ts';

/**
 * Decision 915: archive and delete of a creative (decisions 945-954).
 *
 * - **Archive** writes `archivedAt` in creative.json (committed like any creative.json change): the creative leaves the
 *   project's lists and is listed under "Archiviate", where `unarchive` brings it back. Nothing else changes.
 * - **Delete** moves the creative's folder to the Trash (`TrashFn`) and commits its removal in the project's repository, so
 *   the history keeps every version; the core's side state of it (queue, remembered session) is forgotten.
 * - Both are refused (409 `creative-busy`, with the reason) while a turn, a queued request or a render of the creative, or
 *   of any variant acted on with it, is queued or running.
 * - **Variants (decision 947):** a sister (B..E) is acted on alone and leaves the group (`detachLocked`); variant A of a
 *   group with other members is acted on only as the whole group (`all`, else 409 `creative-group`).
 *
 * Archive and delete are the user's actions only: the agent's tools never reach them (decision 917).
 */
/** Sister slugs in variant id order (`~b` before `~aa`). */
const bySisterId = (x: string, y: string) => compareVariantIds(letterOfSlug(x), letterOfSlug(y));

export interface CreativeRemovalDeps {
  turns: CreativeTurnService;
  /** The job queue now (queued, running and ended jobs). */
  jobs: () => JobSummary[];
  trash: TrashFn;
}

/** What blocks the creative `slug` now in the job queue: one of its turns (or its group's directions turn), or a render of it. */
export function creativeBusy(jobs: readonly JobSummary[], ref: CreativeRef): 'turn' | 'render' | null {
  const key = creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug);
  const renders = renderJobKey(ref.root, ref.projectSlug, ref.creativeSlug, 0).slice(0, -1);
  for (const j of jobs) {
    if (j.state !== 'queued' && j.state !== 'running') continue;
    if (j.key === key || j.key === `variant-directions:${key}`) return 'turn';
    if (j.key.startsWith(renders)) return 'render';
  }
  return null;
}

interface Plan {
  role: CreativeRemovalInfo['role'];
  title: string;
  creative: CreativeFile | null;
  host: CreativeRef;
  group: VariantGroup | null;
  letter: VariantId | null;
  /** The creatives the action applies to: the creative itself, or (`host`) every member of its group, A last. */
  targets: string[];
}

const now = () => new Date().toISOString();

export class CreativeRemoval {
  constructor(private readonly deps: CreativeRemovalDeps) {}

  /** Whether `ref` can be archived or deleted now, and as what (`GET …/removal`). */
  async info(ref: CreativeRef): Promise<CreativeRemovalInfo> {
    const p = await this.plan(ref);
    return {
      role: p.role, members: p.group?.members.length ?? 1, letter: p.letter, title: p.title, archived: Boolean(p.creative?.archivedAt),
      blocked: await this.blocked(ref, p.role === 'host' ? p.targets : [ref.creativeSlug]),
    };
  }

  /** Archives `ref` (the whole group with `all`, for variant A of a group). Returns the slugs archived. */
  async archive(ref: CreativeRef, all: boolean): Promise<string[]> {
    return this.locked(ref, all, async (p) => {
      const store = new CreativeStore(ref.projectDir);
      if (p.role === 'sister') await new VariantGroupService({ store, turns: this.deps.turns }).detachLocked(p.host, p.group!, ref.creativeSlug);
      const at = now();
      const done: string[] = [];
      for (const slug of p.targets) {
        // A member whose folder is missing (or whose creative.json does not read) is left as it is.
        const c = await store.get(slug).catch(() => null);
        if (!c || c.archivedAt) continue;
        await store.update(slug, { archivedAt: at });
        done.push(slug);
      }
      if (done.length > 0) await this.deps.turns.commitCreativeFiles(ref, done, t().jobs.creativeArchivedCommit({ title: p.title }));
      for (const slug of done) this.deps.turns.changed(memberRef(ref, slug));
      return done;
    });
  }

  /**
   * Restores an archived creative: variant A brings back its group with it (the members archived with it); a sister that
   * was archived on its own left its group, and comes back as a single creative (decision 947). Returns the slugs restored.
   */
  async unarchive(ref: CreativeRef): Promise<string[]> {
    const store = new CreativeStore(ref.projectDir);
    return this.deps.turns.runLocked(ref, async () => {
      const own = await store.get(ref.creativeSlug);
      const members = own.variantGroup?.members.filter((m) => m.letter !== 'a').map((m) => m.slug) ?? [];
      const done: string[] = [];
      for (const slug of [...members, ref.creativeSlug]) {
        const write = async () => {
          const c = await store.get(slug).catch(() => null);
          if (!c?.archivedAt || (slug !== ref.creativeSlug && c.variantOf !== ref.creativeSlug)) return;
          await store.update(slug, { archivedAt: undefined });
          done.push(slug);
        };
        // Lock order (decisions log 823): the host's, held, then each sister's.
        await (slug === ref.creativeSlug ? write() : this.deps.turns.runLocked(memberRef(ref, slug), write));
      }
      if (done.length > 0) await this.deps.turns.commitCreativeFiles(ref, done, t().jobs.creativeUnarchivedCommit({ title: own.title }));
      for (const slug of done) this.deps.turns.changed(memberRef(ref, slug));
      return done;
    });
  }

  /**
   * Moves `ref`'s folder (every member's with `all`, for variant A of a group) to the Trash and commits the removal.
   * Returns the slugs moved. A failure of the Trash stops at that folder: the ones moved before it stay moved and committed.
   */
  async delete(ref: CreativeRef, all: boolean): Promise<string[]> {
    return this.locked(ref, all, async (p) => {
      const store = new CreativeStore(ref.projectDir);
      // Refused before anything moves: the group's last active variant cannot leave it (decision 947).
      if (p.role === 'sister') {
        const m = p.group!.members.find((x) => x.slug === ref.creativeSlug);
        if (m?.status === 'active' && activeMembers(p.group!).length === 1) {
          throw new CodedError(409, t().errors.variantLastActive({ letter: m.letter.toUpperCase() }), 'variant-last-active');
        }
      }
      const moved: string[] = [];
      let failure: unknown = null;
      for (const slug of p.targets) {
        const dir = store.dir(slug);
        if (!(await lstat(dir).catch(() => null))) continue;
        try { await this.deps.trash(dir); } catch (err) { failure = err; break; }
        moved.push(slug);
        await noteCoreChange(join(ref.projectDir, 'creatives'));
        await this.deps.turns.side.forget(ref.projectDir, slug).catch(() => {});
      }
      if (p.role === 'sister' && moved.length > 0) {
        await new VariantGroupService({ store, turns: this.deps.turns }).detachLocked(p.host, p.group!, ref.creativeSlug);
      }
      await this.commitRemoval(ref, moved.map((s) => store.dir(s)), p.title);
      for (const slug of moved) this.deps.turns.changed(memberRef(ref, slug));
      if (failure) throw failure;
      return moved;
    });
  }

  /** The removal of `dirs` in one commit; a folder git never had (a creative never committed) is left out. Best effort. */
  private async commitRemoval(ref: CreativeRef, dirs: string[], title: string): Promise<void> {
    if (dirs.length === 0) return;
    const message = t().jobs.creativeDeletedCommit({ title });
    try { await this.deps.turns.commitFolder(ref, dirs, message); } catch {
      for (const d of dirs) await this.deps.turns.commitFolder(ref, [d], message).catch(() => null);
    }
  }

  /**
   * Runs `fn` with the plan read under the locks it needs: the host's (variant A's, which is the creative's own outside a
   * group), then each other creative acted on, in letter order (decisions log 823). Refuses a group's variant A without
   * `all`, and anything busy.
   */
  private async locked<T>(ref: CreativeRef, all: boolean, fn: (p: Plan) => Promise<T>): Promise<T> {
    const first = await this.plan(ref);
    const { turns } = this.deps;
    return turns.runLocked(first.host, async () => {
      const p = await this.plan(ref);
      if (p.host.creativeSlug !== first.host.creativeSlug) throw new WorkspaceError(409, t().jobs.conflict);
      if (p.role === 'host' && !all) throw new CodedError(409, t().errors.creativeGroupAll({ count: p.group!.members.length }), 'creative-group');
      // In id order (`b` before `aa`), the one order every multi-member lock takes.
      const others = p.targets.filter((s) => s !== p.host.creativeSlug).sort(bySisterId);
      const run = async (i: number): Promise<T> => {
        if (i < others.length) return turns.runLocked(memberRef(ref, others[i]!), () => run(i + 1));
        const busy = await this.blocked(ref, p.targets);
        if (busy) throw new CodedError(409, busy.message, busy.code);
        return fn(p);
      };
      return run(0);
    });
  }

  private async plan(ref: CreativeRef): Promise<Plan> {
    const store = new CreativeStore(ref.projectDir);
    const slug = ref.creativeSlug;
    // A creative whose creative.json does not read can still be deleted (as a single creative named by its folder).
    const creative = await store.get(slug).catch((err: unknown) => { if ((err as { status?: unknown }).status === 404) throw err; return null; });
    const single: Plan = { role: 'single', title: creative?.title ?? slug, creative, host: ref, group: null, letter: null, targets: [slug] };
    if (!creative) return single;
    const r = await new VariantGroupService({ store, turns: this.deps.turns }).resolve(ref);
    if (!r.group) return single;
    const self = r.group.members.find((m) => m.slug === slug);
    if (r.host.creativeSlug !== slug) return { ...single, role: 'sister', host: r.host, group: r.group, letter: self?.letter ?? null };
    if (r.group.members.length < 2) return { ...single, group: r.group, letter: 'a' };
    // Variant A last: a failure in the middle never leaves sisters without their host.
    const sisters = r.group.members.filter((m) => m.letter !== 'a').map((m) => m.slug).sort(bySisterId);
    return { ...single, role: 'host', group: r.group, letter: 'a', targets: [...sisters, slug] };
  }

  /** Why the creatives `slugs` cannot be removed now (the first reason found), or null. */
  private async blocked(ref: CreativeRef, slugs: readonly string[]): Promise<{ code: string; message: string } | null> {
    const e = t().errors;
    const jobs = this.deps.jobs();
    for (const slug of slugs) {
      const mref = memberRef(ref, slug);
      const busy = creativeBusy(jobs, mref);
      if (busy === 'turn') return { code: 'creative-busy', message: e.creativeBusyTurn };
      if (busy === 'render') return { code: 'creative-busy', message: e.creativeBusyRender };
      const side = await this.deps.turns.side.read(ref.projectDir, slug).catch(() => null);
      if (side?.queued?.length) return { code: 'creative-busy', message: e.creativeBusyQueued };
    }
    return null;
  }
}
