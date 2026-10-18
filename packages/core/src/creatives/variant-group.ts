import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  activeMembers, canDiscard, sisterSlug, effectiveLinks, followerVersion, formatDisplayName, hasFormat, MAX_INSTANCES, hostOf, letterOfSlug, nextInstanceId, nextLetter, presetOf, starOf,
  VARIANT_ID_RE, variantGroupSchema, variantIdAt, variantIndex,
  type CreativeFile, type VariantGroup, type VariantId, type VariantMember, type VariantPick, type VersionEntry,
} from '@motion-studio/shared';
import { readCompositionFolder } from '../compositions/composition-files.ts';
import { parseConversation, PREMERGE_FILE } from './group-conversation.ts';
import { assertCodebasesOutside, normalizeCodebaseList } from '../codebases.ts';
import { currentLocale, t } from '../i18n.ts';
import { CodedError } from '../workspace-store.ts';
import { copyVerified, versionDirReady } from './carry-over.ts';
import { compositionDirOf } from './composition-contract.ts';
import { alignEditorCopies } from './composition-turn.ts';
import { CREATIVE_SLUG_RE, SISTER_SLUG_RE, creativeKind, groupTiedTo, isRealSister, memberPresent, type ChatMigration, type CreativeStore } from './creative-store.ts';
import type { BriefPatch, CreativeRef, CreativeTurnService, SharedBrief } from './creative-turns.ts';

/**
 * Phase 15 (spec §2, §5, §7): a creative's variant group. The group lives in the HOST's creative.json (`variantGroup`,
 * member `a`); each other variant is a sister creative `<host>~<letter>` with `variantOf`, a normal creative in every other
 * respect (turns, versions, editor, renders, queue, Stop). This service keeps the group: sisters, the shared brief, the ★ of
 * each format across variants, discard and restore, layout, directions.
 *
 * **Locks (decisions log 823).** Every group write runs under the host's creative lock (`CreativeTurnService.runLocked` of
 * the host, which IS member a's lock). A brief propagation keeps that lock and then takes each other member's lock, one at a
 * time, in letter order b→e; member a is written under the lock already held, never re-taken (the mutex is not reentrant).
 * The order is total (a before b … before e), so two writers cannot deadlock. The rule for every caller: never take the
 * host's lock while holding a sister's lock. A turn of a sister takes only its own lock (and, at its start, applies a pending
 * brief under it).
 *
 * **Working variants.** A variant whose turn is queued or running never gets the new brief mid-turn: it is kept as its
 * `pendingBrief` (the core's side state, out of the agent's reach and out of git) and applied at the start of its next turn.
 */
export interface VariantGroupDeps {
  store: CreativeStore;
  turns: CreativeTurnService;
}

/** What a new variant starts from (`POST …/variants`): a direction, and optionally a variant's version as its base. */
export interface VariantSpec { direction?: string | null; baseFrom?: { slug: string; version: number } }

/** One format of the group's final selection: whose version it exports and why. */
export interface GroupSelectionItem { slug: string; version: number; source: 'pick' | 'default' }

/** Directions are one line: at most this many characters (the same bound as the directions tool of Task 3). */
export const MAX_DIRECTION_CHARS = 140;

const now = () => new Date().toISOString();

/** The ref of the group member `slug`, in `host`'s project (the one helper of the variant services). */
export const memberRef = (host: CreativeRef, slug: string): CreativeRef => ({ root: host.root, projectSlug: host.projectSlug, projectDir: host.projectDir, creativeSlug: slug });
const byLetter = (a: VariantMember, b: VariantMember) => variantIndex(a.letter) - variantIndex(b.letter);
const upper = (l: VariantId) => l.toUpperCase();

export class VariantGroupService {
  constructor(private readonly deps: VariantGroupDeps) {}

  /**
   * Where `ref` stands. A host: its group (null for a creative outside any group, an old one included). A real sister
   * (`isRealSister`): its host and the group. Any other sister-shaped creative is an orphan (spec §7): it is its own host,
   * with no group. `missing`: members whose folder has no readable creative.json that names this host (shown "mancante"; the
   * list uses the same rule, `memberPresent`).
   */
  async resolve(ref: CreativeRef): Promise<{ host: CreativeRef; group: VariantGroup | null; missing: string[]; orphan: boolean }> {
    const { store } = this.deps;
    const slug = ref.creativeSlug;
    const own = await store.get(slug); // 404 for an unknown creative
    if (CREATIVE_SLUG_RE.test(slug)) {
      const g = own.variantGroup;
      if (!g || !groupTiedTo(slug, g)) return { host: ref, group: null, missing: [], orphan: false };
      return { host: ref, group: g, missing: await this.missingOf(ref, g), orphan: false };
    }
    if (!(await isRealSister(ref.projectDir, slug))) return { host: ref, group: null, missing: [], orphan: true };
    const hostRef = memberRef(ref, slug.slice(0, slug.indexOf('~')));
    const g = (await store.get(hostRef.creativeSlug)).variantGroup!;
    return { host: hostRef, group: g, missing: await this.missingOf(hostRef, g), orphan: false };
  }

  private async missingOf(host: CreativeRef, g: VariantGroup): Promise<string[]> {
    const out: string[] = [];
    for (const m of g.members) {
      if (m.letter === 'a') continue;
      if (!(await this.present(host, m))) out.push(m.slug);
    }
    return out;
  }

  /** The group's formats now: the host's pending brief when it has one, else its own (the same source as `groupSelection`). */
  async groupFormats(ref: CreativeRef): Promise<string[]> {
    const r = await this.resolve(ref);
    if (!r.group) throw new CodedError(409, r.orphan ? t().errors.variantOrphan : t().errors.variantNoGroup, r.orphan ? 'variant-orphan' : 'variant-no-group');
    return (await this.canonical(r.host, await this.deps.store.get(r.host.creativeSlug))).brief.formats;
  }

  /**
   * Decision 982: merges the group's conversations into the host's, once (`CreativeStore.migrateConversation`), when no
   * member has a turn running or queued; 'busy' otherwise (the readers keep merging in memory until a later call). Called on
   * a group read (the conversation route): lazily, the first time the group is idle. Commits the logs (best effort).
   */
  async mergeChat(ref: CreativeRef): Promise<ChatMigration> {
    // Decision 1167: a merged group with nothing to do takes no lock (the conversation route calls this on every read).
    if (!(await this.deps.store.chatNeedsMerge(ref.creativeSlug))) return 'done';
    const r = await this.resolve(ref);
    if (r.orphan || !r.group) return 'none';
    const { store, turns } = this.deps;
    const host = r.host;
    return turns.runLocked(host, async () => {
      const taken: string[] = [];
      const result = await store.migrateConversation(host.creativeSlug, async (g) => {
        for (const m of g.members) {
          const mref = memberRef(host, m.slug);
          if (turns.turnActive(mref)) return false;
          const side = await turns.side.read(host.projectDir, m.slug).catch(() => null);
          if (side?.queued?.length) return false;
        }
        return true;
      }, { copies: async (files) => { taken.push(...files); } });
      if (result !== 'migrated') return result;
      const g = (await store.get(host.creativeSlug)).variantGroup!;
      // Decision 1168: only the files this merge wrote or changed: the host's log and creative.json, the copies it took.
      const retired = g.members.filter((m) => m.slug !== host.creativeSlug).map((m) => join(store.dir(m.slug), 'conversation.jsonl'));
      const message = t().jobs.groupChatMergedCommit({ title: (await store.get(host.creativeSlug)).title });
      const files = [join(store.dir(host.creativeSlug), 'creative.json'), join(store.dir(host.creativeSlug), 'conversation.jsonl'), ...taken].filter((p) => existsSync(p));
      // The sisters' logs are gone (renamed): committed as removals when git has them; a log git never had is left out.
      await turns.commitFolder(host, [...files, ...retired], message).catch(() => turns.commitFolder(host, files, message)).catch(() => null);
      turns.changed(host);
      return result;
    });
  }

  /** Runs `fn` under the host's lock with the group as stored now (re-read under the lock). 409 outside a group. */
  private async withGroup<T>(ref: CreativeRef, fn: (host: CreativeRef, hostFile: CreativeFile, g: VariantGroup) => Promise<T>): Promise<T> {
    const e = t().errors;
    const r = await this.resolve(ref);
    if (r.orphan) throw new CodedError(409, e.variantOrphan, 'variant-orphan');
    if (!r.group) throw new CodedError(409, e.variantNoGroup, 'variant-no-group');
    return this.deps.turns.runLocked(r.host, async () => {
      const hostFile = await this.deps.store.get(r.host.creativeSlug);
      const g = hostFile.variantGroup;
      if (!g || !groupTiedTo(r.host.creativeSlug, g)) throw new CodedError(409, e.variantNoGroup, 'variant-no-group');
      return fn(r.host, hostFile, g);
    });
  }

  /** Writes the group on the host (the caller holds the host's lock); every member slug is tied to its letter (ruling R2). */
  private async writeGroup(host: CreativeRef, g: VariantGroup, commit = true): Promise<VariantGroup> {
    const parsed = variantGroupSchema.parse(g);
    if (!groupTiedTo(host.creativeSlug, parsed)) throw new Error('variant group: a member slug is not its letter\'s');
    const updated = await this.deps.store.update(host.creativeSlug, { variantGroup: parsed });
    if (commit) await this.deps.turns.commitCreativeFiles(host, [host.creativeSlug], t().jobs.variantGroupCommit({ title: updated.title }));
    this.deps.turns.changed(host);
    return parsed;
  }

  /** The group's brief now: the one waiting for the host's next turn when the host was working, else the host's own. */
  private async canonical(host: CreativeRef, hostFile: CreativeFile): Promise<Required<SharedBrief>> {
    const pending = await this.deps.turns.side.pendingBrief(host.projectDir, host.creativeSlug);
    return {
      brief: pending?.brief ?? hostFile.brief,
      title: pending?.title ?? hostFile.title,
      linkedCodebases: pending?.linkedCodebases ?? hostFile.linkedCodebases ?? [],
    };
  }

  private memberOf(g: VariantGroup, letter: VariantId): VariantMember {
    const m = g.members.find((x) => x.letter === letter);
    if (!m) throw new CodedError(404, t().errors.variantUnknown({ letter: upper(letter) }), 'variant-unknown');
    return m;
  }

  /**
   * Creates the sisters for `ref`'s group (made now when `ref` has none: `ref` becomes member a, with `hostDirection`), one
   * per spec, in the next free letters. Each sister copies the group's brief (the host's links as its start), title and
   * codebases; with `baseFrom` its v1 is that version's compositions (`seed`). No turn starts here. There is no cap on the
   * number of variants (decision 978); nothing is left behind on a failure.
   */
  async addVariants(ref: CreativeRef, request: VariantSpec[] | ((existing: VariantGroup | null) => { specs: VariantSpec[]; hostDirection?: string | null }), opts: { hostDirection?: string | null } = {}): Promise<VariantGroup> {
    const e = t().errors;
    const r = await this.resolve(ref);
    if (r.orphan) throw new CodedError(409, e.variantOrphan, 'variant-orphan');
    const host = r.host;
    const { store, turns } = this.deps;
    return turns.runLocked(host, async () => {
      const hostFile = await store.get(host.creativeSlug);
      const existing = hostFile.variantGroup && groupTiedTo(host.creativeSlug, hostFile.variantGroup) ? hostFile.variantGroup : null;
      // A caller that must decide on the group as it is NOW (the route's count) gives a function, called under the lock.
      const { specs, hostDirection: asked } = typeof request === 'function' ? request(existing) : { specs: request, hostDirection: opts.hostDirection };
      const at = now();
      const direction = (d: string | null | undefined) => {
        const v = d?.trim() ?? '';
        if (v.length > MAX_DIRECTION_CHARS) throw new CodedError(400, e.variantDirections, 'variant-directions');
        return v || null;
      };
      const hostDirection = direction(asked);
      let g: VariantGroup = existing ?? {
        members: [{ slug: host.creativeSlug, letter: 'a', direction: hostDirection, directionSource: hostDirection ? 'user' : null, status: 'active', createdAt: at }],
        picks: {}, layout: 'variant',
      };
      if (specs.length === 0) throw new CodedError(400, e.invalidRequest, 'invalid-request');
      for (const s of specs) {
        direction(s.direction);
        if (s.baseFrom && !g.members.some((m) => m.slug === s.baseFrom!.slug && m.status === 'active')) {
          throw new CodedError(422, e.variantBaseInvalid({ detail: e.variantPickNotMember({ slug: s.baseFrom.slug }) }), 'variant-base-invalid');
        }
      }
      const shared = await this.canonical(host, hostFile);
      // Minor (Task 2): a host with a pending brief (it is working) has not applied it yet. A new sister starts as the HOST is now
      // (its links go with its formats) and then takes the pending brief like any member, so its links follow the new formats.
      const hostPending = await turns.side.pendingBrief(host.projectDir, host.creativeSlug);
      const created: string[] = [];
      const committed: string[] = [];
      // Decision 1162: never below the host's high-water mark, nor any id its chat or a former sister's folder names.
      let floor = await this.idFloor(host, g, hostFile);
      try {
        for (const s of specs) {
          const letter = await this.freeLetter(host, floor);
          floor = variantIndex(letter) + 1;
          const sister: CreativeFile = {
            schemaVersion: 1, title: hostFile.title, brief: hostFile.brief, status: 'draft', error: null,
            createdAt: at, updatedAt: at, resumeFrom: null, linkedCodebases: hostFile.linkedCodebases ?? [], variantOf: host.creativeSlug,
          };
          const slug = await store.createSister(host.creativeSlug, letter, sister);
          created.push(slug);
          // Fix round 1 (M2) of phase 13: its side record exists from the start (nothing written into its creative.json later is trusted).
          await turns.side.read(host.projectDir, slug);
          const d = direction(s.direction);
          g = { ...g, members: [...g.members, { slug, letter, direction: d, directionSource: d ? 'user' : null, status: 'active', createdAt: at }] };
          const sisterRef = memberRef(host, slug);
          // Lock order (decisions log 823): the host's, held, then this sister's.
          if (hostPending) await turns.runLocked(sisterRef, () => turns.applySharedBrief(sisterRef, shared));
          if (s.baseFrom) {
            const baseLetter = g.members.find((m) => m.slug === s.baseFrom!.slug)!.letter;
            // Recorded BEFORE the seed: it commits the sister's folder first and then does more (version, conversation), any of which can fail.
            committed.push(slug);
            await turns.runLocked(sisterRef, () => this.seed(sisterRef, s.baseFrom!, baseLetter));
          }
        }
        await this.writeGroup(host, g, false);
        await store.update(host.creativeSlug, { variantNext: floor });
      } catch (err) {
        for (const slug of created.reverse()) await store.removeSisterFolder(slug).catch(() => {});
        // Minor (Task 2): a seeded sister's folder is already in git; its removal is committed too, not left as a deletion.
        // One by one: a sister whose seed failed before its commit has nothing to commit (git refuses the path), and must not hold back the others.
        for (const slug of committed) await turns.commitFolder(host, [store.dir(slug)], t().jobs.variantsRolledBackCommit({ title: hostFile.title })).catch(() => null);
        throw err;
      }
      await turns.commitCreativeFiles(host, [host.creativeSlug], t().jobs.variantsAddedCommit({ title: hostFile.title, letters: created.map((s) => upper(letterOfSlug(s))).join(', ') }),
        created.map((s) => store.dir(s)));
      return g;
    });
  }

  /**
   * The new sister's v1 is version `base.version` of member `base.slug` (decisions log 263, as an editor save): each of that
   * version's own compositions of a primary the sister's brief has is copied file by file and verified against the hashes the
   * base version recorded (`copyVerified`, never through a link), then completed as a direct save (`finishCompositions`,
   * no agent): followers materialized, manifest v2, `origin: 'editor'`. Its `work/editor/` gets the copies, so the sister's
   * next agent turn builds on v1 with the "Direct edits by the user" section, as after an editor save. The caller holds the
   * sister's lock; no turn of the brand-new sister can run.
   */
  private async seed(sister: CreativeRef, base: { slug: string; version: number }, baseLetter: VariantId): Promise<void> {
    const { store, turns } = this.deps;
    const e = t().errors;
    const locale = currentLocale();
    const invalid = (detail: string) => new CodedError(422, e.variantBaseInvalid({ detail }), 'variant-base-invalid');
    const v = (await store.readVersions(base.slug)).find((x) => x.n === base.version);
    if (!v) throw invalid(e.versionNNotFound({ n: base.version }));
    const creative = await store.get(sister.creativeSlug);
    const presets = await turns.presetList();
    const label = (id: string) => formatDisplayName(presets, id, locale, creative.brief.formatLabels);
    const links = effectiveLinks(creative.brief.links, creative.brief.formats);
    const root = join(sister.projectDir, 'creatives');
    const sisterDir = store.dir(sister.creativeSlug);
    await versionDirReady(sisterDir, 1);
    const targets: string[] = [];
    for (const f of creative.brief.formats.filter((x) => !Object.hasOwn(links, x))) {
      const entry = v.compositions?.find((c) => c.format === f && c.followsFormat === undefined);
      if (!entry) continue;
      const srcRel = `${base.slug}/outputs/v${v.n}/${entry.dir}`;
      const folder = await readCompositionFolder(join(root, ...srcRel.split('/'))).catch(() => null);
      if (!folder || folder.hash !== entry.hash) throw new CodedError(409, e.variantBaseChanged({ format: label(f), n: v.n }), 'variant-base-changed');
      const destRel = `${sister.creativeSlug}/outputs/v1/${compositionDirOf(f)}`;
      for (const file of folder.files) {
        await mkdir(dirname(join(root, ...destRel.split('/'), ...file.path.split('/'))), { recursive: true });
        if ((await copyVerified(root, `${srcRel}/${file.path}`, `${destRel}/${file.path}`, file.sha256)) === null) {
          throw new CodedError(409, e.variantBaseChanged({ format: label(f), n: v.n }), 'variant-base-changed');
        }
      }
      targets.push(f);
    }
    if (targets.length === 0) throw invalid(e.compositionUnusable({ format: creative.brief.formats.map(label).join(', '), n: v.n }));
    const saved = await turns.finishCompositions(sister, store, { creative, targets, carried: [], carriedComps: new Map(), links }, presets, undefined, 1, label, locale, { direct: true });
    const status = saved.problems.length === 0 ? 'complete' : 'incomplete';
    const entry: VersionEntry = {
      n: 1, commit: null, sessionId: null, status, createdAt: now(), request: t().jobs.variantSeedRequest({ letter: upper(baseLetter), n: v.n }),
      outputs: saved.outputs, problems: saved.problems, tools: [], renderCommand: null, basedOn: null, compositions: saved.compositions, origin: 'editor',
    };
    await alignEditorCopies(sisterDir, entry).catch(() => []);
    // The sister's folder only (the agents of the other variants may be writing elsewhere in the project).
    entry.commit = await turns.commitFolder(sister, [sisterDir], `${creative.title}: v1`, { headWhenClean: true }).catch(() => null);
    await store.appendVersion(sister.creativeSlug, entry);
    await store.appendConversation(sister.creativeSlug, { type: 'version', at: now(), n: 1, status });
    await store.update(sister.creativeSlug, { status: status === 'complete' ? 'ready' : 'incomplete', error: null });
    turns.storyboardsLater(sister, store, 1);
  }

  /**
   * Decision 1162: the lowest position a new id may take. Ids are never given twice: not below the group's highest member
   * (`nextLetter`), the host's high-water mark `variantNext` (kept when sisters leave and when the group dissolves), any id the
   * host's chat or its first copy from before a merge names (a host older than the mark), nor a real former sister (an orphan
   * folder). Decision 1168: only files the agent cannot write count, and an id at the very end of the range is ignored, so
   * nothing planted can block or skip ids.
   */
  private async idFloor(host: CreativeRef, g: VariantGroup, hostFile: CreativeFile): Promise<number> {
    const { store } = this.deps;
    let floor = Math.max(variantIndex(nextLetter(g)), hostFile.variantNext ?? 0);
    const seen = (id: unknown) => {
      const i = typeof id === 'string' ? variantIndex(id) : -1;
      if (i >= 0 && variantIdAt(i + 1).length <= 3) floor = Math.max(floor, i + 1);
    };
    const hostDir = store.dir(host.creativeSlug);
    for (const name of ['conversation.jsonl', PREMERGE_FILE]) {
      for (const e of parseConversation(await readFile(join(hostDir, name), 'utf8').catch(() => ''))) seen(e.variant);
    }
    for (const name of await readdir(dirname(hostDir)).catch(() => [] as string[])) {
      if (SISTER_SLUG_RE.test(name) && hostOf(name) === host.creativeSlug && (await creativeKind(host.projectDir, name)) === 'orphan') seen(letterOfSlug(name));
    }
    return floor;
  }

  /**
   * The id for a new sister: the first from `floor` (decision 1162), skipping the folder of a former sister of this host (an
   * orphan: decision 947, a sister archived on its own leaves the group and keeps its folder). Any other folder in the way
   * is refused by `createSister` (409 `variant-folder-exists`), as before.
   */
  private async freeLetter(host: CreativeRef, floor: number): Promise<VariantId> {
    for (let i = floor; ; i++) {
      const l = variantIdAt(i);
      if (!VARIANT_ID_RE.test(l)) throw new CodedError(409, t().errors.invalidRequest, 'invalid-request');
      const slug = sisterSlug(host.creativeSlug, l);
      if (!existsSync(this.deps.store.dir(slug))) return l;
      // Decision 1169: a folder in the way (a former sister, or anything named like one) keeps its id out of use.
      console.warn(`Motion Studio: the folder creatives/${slug} is in the way of a new variant: its id is skipped.`);
    }
  }

  /**
   * Decision 947: takes sister `slug` out of the host's group (it is archived or deleted on its own): its ★s go back to the
   * default rule; a group left with variant A alone is no group any more (the host is a single creative again). 409
   * `variant-last-active` for the group's last active variant. The CALLER holds the host's lock (and the sister's) and
   * passes the group as stored then. Returns the group written, or null when it was dropped.
   */
  async detachLocked(host: CreativeRef, g: VariantGroup, slug: string): Promise<VariantGroup | null> {
    // Decision 1169: a merge of the chats left past its commit point is finished first (its record goes with the group).
    await this.deps.store.settleChat(host.creativeSlug);
    const m = g.members.find((x) => x.slug === slug && x.letter !== 'a');
    if (!m) return g;
    if (m.status === 'active' && activeMembers(g).length === 1) throw new CodedError(409, t().errors.variantLastActive({ letter: upper(m.letter) }), 'variant-last-active');
    const members = g.members.filter((x) => x.slug !== slug);
    const picks = Object.fromEntries(Object.entries(g.picks).filter(([, p]) => p.slug !== slug));
    if (members.length === 1) {
      const updated = await this.deps.store.update(host.creativeSlug, { variantGroup: undefined });
      await this.deps.turns.commitCreativeFiles(host, [host.creativeSlug], t().jobs.variantGroupCommit({ title: updated.title }));
      this.deps.turns.changed(host);
      return null;
    }
    return this.writeGroup(host, { ...g, members, picks });
  }

  /**
   * Discards member `letter` (spec §5): hidden, nothing deleted, its ★s gone (back to the default rule). 404 unknown letter,
   * 409 `variant-running` while one of its turns is queued or running, 409 `variant-last-active`. Discarding a discarded
   * member is a no-op.
   */
  discard(ref: CreativeRef, letter: VariantId): Promise<VariantGroup> {
    return this.withGroup(ref, async (host, _f, g) => {
      const e = t().errors;
      const m = this.memberOf(g, letter);
      const mref = memberRef(host, m.slug);
      // Final wave M3: the check and the write hold the member's own lock too (lock order: the host's, held, then this
      // member's; member a's IS the host's), the lock a turn's start holds until its job is enqueued. A start and a discard
      // of the same variant are thus serialized: the turn is queued and the discard refused, or the discard is written and
      // the start sees it.
      const locked = <T>(fn: () => Promise<T>) => (m.letter === 'a' ? fn() : this.deps.turns.runLocked(mref, fn));
      return locked(async () => {
        const c = canDiscard(g, letter, this.deps.turns.turnActive(mref));
        if (!c.ok) {
          if (c.reason === 'running') throw new CodedError(409, e.variantRunning({ letter: upper(letter) }), 'variant-running');
          if (c.reason === 'last-active') throw new CodedError(409, e.variantLastActive({ letter: upper(letter) }), 'variant-last-active');
          throw new CodedError(404, e.variantUnknown({ letter: upper(letter) }), 'variant-unknown');
        }
        if (m.status === 'discarded') return g;
        const picks = Object.fromEntries(Object.entries(g.picks).filter(([, p]) => p.slug !== m.slug));
        return this.writeGroup(host, { ...g, members: g.members.map((x) => (x.letter === letter ? { ...x, status: 'discarded' } : x)), picks });
      });
    });
  }

  /**
   * Restores member `letter` (spec §5): active again, without its old ★s (they were cleared by the discard). It catches up
   * with the group's brief at once (or at its next turn when it is working), since a discarded variant is not propagated to.
   */
  restore(ref: CreativeRef, letter: VariantId): Promise<VariantGroup> {
    return this.withGroup(ref, async (host, hostFile, g) => {
      const m = this.memberOf(g, letter);
      if (m.status === 'active') return g;
      const next = await this.writeGroup(host, { ...g, members: g.members.map((x) => (x.letter === letter ? { ...x, status: 'active' } : x)) });
      const target = await this.canonical(host, hostFile);
      const applied: string[] = [];
      const deferred: string[] = [];
      if (await this.present(host, m)) {
        const mref = memberRef(host, m.slug);
        if (m.letter === 'a') await this.syncLocked(mref, target, applied, deferred);
        else await this.deps.turns.runLocked(mref, () => this.syncLocked(mref, target, applied, deferred));
      }
      if (applied.length > 0) await this.deps.turns.commitCreativeFiles(host, applied, t().jobs.briefUpdatedCommit({ title: target.title }));
      return next;
    });
  }

  /**
   * Sets (`pick`) or clears (`null`) the group's ★ of `formatId` (spec §5): the variant and version exported for it. 422
   * `variant-pick-invalid` for a format not in the brief, a slug that is not an active member, a follower of that member, or
   * a version without the format.
   */
  setPick(ref: CreativeRef, formatId: string, pick: VariantPick | null): Promise<VariantGroup> {
    return this.withGroup(ref, async (host, hostFile, g) => {
      const e = t().errors;
      const shared = await this.canonical(host, hostFile);
      const presets = await this.deps.turns.presetList();
      const label = (id: string) => formatDisplayName(presets, id, currentLocale(), shared.brief.formatLabels);
      const invalid = (detail: string) => new CodedError(422, e.variantPickInvalid({ detail }), 'variant-pick-invalid');
      if (!shared.brief.formats.includes(formatId)) throw invalid(e.formatNotInBrief({ format: label(formatId) }));
      const picks = { ...g.picks };
      if (pick === null) delete picks[formatId];
      else {
        const m = g.members.find((x) => x.slug === pick.slug && x.status === 'active');
        if (!m) throw invalid(e.variantPickNotMember({ slug: pick.slug }));
        const data = await this.memberData(m.slug);
        if (!data) throw invalid(e.variantPickNotMember({ slug: pick.slug }));
        if (Object.hasOwn(data.links, formatId)) throw invalid(e.pickFollower({ format: label(formatId), primary: label(data.links[formatId]!) }));
        const v = data.versions.find((x) => x.n === pick.version);
        if (!v || !hasFormat(v, formatId)) throw invalid(e.variantPickNoFormat({ format: label(formatId), n: pick.version }));
        picks[formatId] = { slug: m.slug, version: pick.version };
      }
      return this.writeGroup(host, { ...g, picks });
    });
  }

  /** "Usa questa variante per tutti i formati" (spec §5): ★ = that variant's default-rule version of each format it has. */
  useVariantForAll(ref: CreativeRef, letter: VariantId): Promise<VariantGroup> {
    return this.withGroup(ref, async (host, hostFile, g) => {
      const m = this.memberOf(g, letter);
      if (m.status !== 'active') throw new CodedError(409, t().errors.variantDiscarded({ letter: upper(letter) }), 'variant-discarded');
      const data = await this.memberData(m.slug);
      if (!data) throw new CodedError(409, t().errors.variantUnknown({ letter: upper(letter) }), 'variant-missing');
      const shared = await this.canonical(host, hostFile);
      const picks = { ...g.picks };
      for (const f of shared.brief.formats) {
        if (Object.hasOwn(data.links, f)) continue; // a follower uses its primary's ★
        const star = starOf(data.versions, f, undefined, data.links);
        if (star.version !== null) picks[f] = { slug: m.slug, version: star.version };
      }
      return this.writeGroup(host, { ...g, picks });
    });
  }

  setLayout(ref: CreativeRef, layout: 'variant' | 'format'): Promise<VariantGroup> {
    return this.withGroup(ref, async (host, _f, g) => (g.layout === layout ? g : this.writeGroup(host, { ...g, layout })));
  }

  /** A variant's direction (spec §3): it applies from that variant's next turn. Empty clears it (the agent may propose one). */
  setDirection(ref: CreativeRef, letter: VariantId, direction: string, source: 'user' | 'agent'): Promise<VariantGroup> {
    return this.withGroup(ref, async (host, _f, g) => {
      this.memberOf(g, letter);
      const d = direction.trim();
      if (d.length > MAX_DIRECTION_CHARS) throw new CodedError(400, t().errors.variantDirections, 'variant-directions');
      const members = g.members.map((x) => (x.letter === letter ? { ...x, direction: d || null, directionSource: d ? source : null } : x));
      return this.writeGroup(host, { ...g, members });
    });
  }

  /**
   * A brief edit (PUT …/creatives/:c) on a creative of a group: computed on the group's brief now (`canonical`) with the
   * same rules as a single creative's save, then propagated. Answers the edited creative as stored. 409 `variant-discarded`
   * from a discarded sister (never from A, see below). `patch` may be a function of the group's brief now (decision 917: the
   * agent's edits are computed on it under the host's lock).
   */
  updateGroupBrief(hostRef: CreativeRef, patchOrBuild: BriefPatch | ((current: CreativeFile['brief']) => BriefPatch), edited: CreativeRef): Promise<CreativeFile> {
    return this.withGroup(hostRef, async (host, hostFile, g) => {
      // Final wave I2 (decisions log 837 extended): a discarded sister is inert; its brief is not propagated to, so its save
      // would roll the group's back. A discarded A is not refused: the host always carries the group's brief (decisions log
      // 830), so an edit from it is computed on the current one.
      const self = g.members.find((m) => m.slug === edited.creativeSlug);
      if (self && self.letter !== 'a' && self.status === 'discarded') throw new CodedError(409, t().errors.variantDiscardedTurn, 'variant-discarded');
      const shared = await this.canonical(host, hostFile);
      const patch = typeof patchOrBuild === 'function' ? patchOrBuild(shared.brief) : patchOrBuild;
      const linkedCodebases = patch.linkedCodebases ? normalizeCodebaseList(patch.linkedCodebases) : null;
      if (linkedCodebases) await assertCodebasesOutside(linkedCodebases, [host.projectDir, host.root], shared.linkedCodebases);
      const change = await this.deps.turns.briefChange(this.deps.store, host.creativeSlug, { ...hostFile, ...shared }, patch);
      await this.propagateLocked(host, g, {
        brief: change.brief ?? shared.brief, title: patch.title ?? shared.title, linkedCodebases: linkedCodebases ?? shared.linkedCodebases,
      });
      return this.deps.store.get(edited.creativeSlug);
    });
  }

  /**
   * "Duplica formato" in a group (decisions log 831): the new instance id is allocated ONCE for the group, over the format ids
   * of every member (and the group's brief), so it means the same instance everywhere. The duplicating member makes its
   * version (`run`, under its lock, taken after the host's); then the group's brief gets the instance, with its label,
   * right after its source, and is propagated like any brief edit: the other variants fill it at their next turn, a working
   * one gets it then, a discarded one when it is restored.
   */
  duplicateInGroup<T>(ref: CreativeRef, source: string, label: string | undefined, run: (instanceId: string) => Promise<T>): Promise<T> {
    return this.withGroup(ref, async (host, hostFile, g) => {
      const shared = await this.canonical(host, hostFile);
      const ids = new Set(shared.brief.formats);
      for (const m of g.members) {
        const c = m.letter === 'a' ? hostFile : await this.deps.store.get(m.slug).catch(() => null);
        for (const f of c?.brief.formats ?? []) ids.add(f);
        const pending = await this.deps.turns.side.pendingBrief(host.projectDir, m.slug).catch(() => null);
        for (const f of pending?.brief.formats ?? []) ids.add(f);
      }
      const instanceId = nextInstanceId(presetOf(source), [...ids]);
      if (instanceId === null) {
        const presets = await this.deps.turns.presetList();
        throw new CodedError(409, t().variants.instancesFull({ format: formatDisplayName(presets, presetOf(source), currentLocale()), max: MAX_INSTANCES }), 'format-instances-full');
      }
      const member = memberRef(host, ref.creativeSlug);
      const result = member.creativeSlug === host.creativeSlug ? await run(instanceId) : await this.deps.turns.runLocked(member, () => run(instanceId));
      const formats = [...shared.brief.formats];
      const at = formats.indexOf(source);
      formats.splice(at < 0 ? formats.length : at + 1, 0, instanceId);
      const formatLabels = label !== undefined ? { ...shared.brief.formatLabels, [instanceId]: label } : shared.brief.formatLabels;
      await this.propagateLocked(host, g, { ...shared, brief: { ...shared.brief, formats, ...(formatLabels ? { formatLabels } : {}) } });
      return result;
    });
  }

  /** The caller holds the host's lock. See the class comment for the lock order. */
  private async propagateLocked(host: CreativeRef, g: VariantGroup, target: Required<SharedBrief>): Promise<{ applied: string[]; deferred: string[] }> {
    const applied: string[] = [];
    const deferred: string[] = [];
    // Member a always takes the brief, discarded or not (decisions log 830): the host carries the group's shared brief, and
    // a discard hides a variant without freezing the brief the group computes on.
    for (const m of g.members.filter((x) => x.status === 'active' || x.letter === 'a').sort(byLetter)) {
      if (!(await this.present(host, m))) continue; // "mancante": nothing to write
      const mref = memberRef(host, m.slug);
      if (m.letter === 'a') await this.syncLocked(mref, target, applied, deferred);
      else await this.deps.turns.runLocked(mref, () => this.syncLocked(mref, target, applied, deferred));
    }
    // A format the brief no longer has loses its ★ (spec §7); the versions of each variant keep their history.
    const picks = Object.fromEntries(Object.entries(g.picks).filter(([f]) => target.brief.formats.includes(f)));
    if (Object.keys(picks).length !== Object.keys(g.picks).length) await this.writeGroup(host, { ...g, picks }, false);
    const slugs = [...new Set([host.creativeSlug, ...applied])];
    await this.deps.turns.commitCreativeFiles(host, slugs, t().jobs.briefUpdatedCommit({ title: target.title }));
    return { applied, deferred };
  }

  /** One member, under its lock: written now, or kept for its next turn when a turn of it is queued or running. */
  private async syncLocked(mref: CreativeRef, target: Required<SharedBrief>, applied: string[], deferred: string[]): Promise<void> {
    const { turns } = this.deps;
    if (turns.turnActive(mref)) {
      const had = await turns.side.pendingBrief(mref.projectDir, mref.creativeSlug);
      await turns.side.setPendingBrief(mref.projectDir, mref.creativeSlug, { ...target, at: now() });
      turns.pendingBriefSet(mref, target.brief.durationSec);
      // Any job of this creative that ends applies it (`briefAfterJob`), a translation included.
      turns.rememberRef(mref);
      if (!had) await this.deps.store.appendConversation(mref.creativeSlug, { type: 'system', at: now(), level: 'info', text: t().jobs.variantBriefDeferred }).catch(() => {});
      deferred.push(mref.creativeSlug);
      return;
    }
    await turns.applySharedBrief(mref, target);
    applied.push(mref.creativeSlug);
  }

  /** Whether member `m`'s folder is there (member a always is: it is the host). */
  private async present(host: CreativeRef, m: VariantMember): Promise<boolean> {
    if (m.letter === 'a') return true;
    return this.deps.store.get(m.slug).then((c) => memberPresent(host.creativeSlug, c), () => false);
  }

  private async memberData(slug: string): Promise<{ creative: CreativeFile; versions: VersionEntry[]; links: Record<string, string> } | null> {
    const creative = await this.deps.store.get(slug).catch(() => null);
    if (!creative) return null;
    const versions = await this.deps.store.readVersions(slug).catch(() => [] as VersionEntry[]);
    return { creative, versions, links: effectiveLinks(creative.brief.links, creative.brief.formats) };
  }

  /**
   * The group's final selection (spec §5, §6; Task 6 exports it), per format of the group's brief: the ★ when it is valid
   * (an active member that is still there, a version with the format, not a follower there), else the default rule
   * (`starOf` without manual picks) applied to variant A, or to the first active variant when A is discarded or missing. A
   * follower takes its primary's variant, in the version that variant's follower rule gives. A format with nothing to export
   * is absent; a discarded member is never used. Pure: nothing is written.
   */
  async groupSelection(ref: CreativeRef): Promise<Record<string, GroupSelectionItem>> {
    const r = await this.resolve(ref);
    if (!r.group) throw new CodedError(409, r.orphan ? t().errors.variantOrphan : t().errors.variantNoGroup, r.orphan ? 'variant-orphan' : 'variant-no-group');
    const g = r.group;
    const hostFile = await this.deps.store.get(r.host.creativeSlug);
    const { brief } = await this.canonical(r.host, hostFile);
    const cache = new Map<string, Awaited<ReturnType<VariantGroupService['memberData']>>>();
    const data = async (slug: string) => {
      if (!cache.has(slug)) cache.set(slug, await this.memberData(slug));
      return cache.get(slug)!;
    };
    const active = activeMembers(g).sort(byLetter);
    let fallback: VariantMember | undefined;
    for (const m of active) if (!fallback && (m.letter === 'a' || await this.present(r.host, m))) fallback = m;
    const own = async (f: string): Promise<GroupSelectionItem | null> => {
      const pick = g.picks[f];
      const picked = pick ? active.find((m) => m.slug === pick.slug) : undefined;
      if (pick && picked && await this.present(r.host, picked)) {
        const d = await data(pick.slug);
        const v = d?.versions.find((x) => x.n === pick.version);
        if (d && v && hasFormat(v, f) && !Object.hasOwn(d.links, f)) return { slug: pick.slug, version: pick.version, source: 'pick' };
      }
      if (!fallback) return null;
      const d = await data(fallback.slug);
      if (!d) return null;
      const star = starOf(d.versions, f, undefined, d.links);
      if (star.follows !== null) {
        const p = await own(star.follows);
        if (!p) return null;
        const pd = await data(p.slug);
        if (!pd) return null;
        const n = pd.links[f] === star.follows ? followerVersion(pd.versions, f, p.version, pd.links) : starOf(pd.versions, f, undefined, pd.links).version;
        return n === null ? null : { slug: p.slug, version: n, source: p.source };
      }
      return star.version === null ? null : { slug: fallback.slug, version: star.version, source: 'default' };
    };
    const out: Record<string, GroupSelectionItem> = {};
    for (const f of brief.formats) {
      const s = await own(f);
      if (s) out[f] = s;
    }
    return out;
  }
}
