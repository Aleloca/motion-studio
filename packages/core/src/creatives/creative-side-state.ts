import { createHash, randomBytes } from 'node:crypto';
import { mkdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { briefSchema, isSessionId, linkedCodebaseSchema, queuedRequestSchema, type CreativeFile, type QueuedRequest } from '@motion-studio/shared';
import { assertNotRealUserData } from '../app-config.ts';
import { KeyedMutex } from '../keyed-mutex.ts';
import { readRegularFile } from '../safe-read.ts';
import { CreativeStore } from './creative-store.ts';

export type StoppedSession = NonNullable<CreativeFile['stoppedSession']>;

/**
 * Phase 13, final review I1: the parts of a creative's state that are the user's and the core's, never the agent's: the
 * requests queued for after the current turn and the remembered session of a stopped turn. They used to live in
 * `creative.json`, which the agent can read (and, with the sandbox off, write) and which is committed to the project's
 * history. They now live in the core's config folder, which the agent is denied (sandbox `denyRead` and the Read/Grep/Glob
 * deny rules, policy.ts), keyed by the project's real path and the creative's slug, and never in git.
 */
export interface CreativeSideState { queued?: QueuedRequest[]; stoppedSession?: StoppedSession }

const stoppedSchema = z.object({ sessionId: z.string().min(1), at: z.iso.datetime(), jobId: z.string().min(1) });
/**
 * Phase 15 (spec §2, "Brief comune"): the group's brief a variant could not take because it was working (queued or running)
 * when the brief changed. It is applied at the start of that variant's next turn, never mid-turn
 * (`CreativeTurnService.applyPendingBrief`). The shared fields only; the variant's own links stay its own.
 */
const pendingBriefSchema = z.object({
  brief: briefSchema,
  title: z.string().trim().min(1).optional(),
  linkedCodebases: z.array(linkedCodebaseSchema).optional(),
  at: z.iso.datetime(),
});
export type PendingBrief = z.infer<typeof pendingBriefSchema>;
/**
 * Phase 3 of the single agent, on a group's HOST only: the group's own state. `session`: the coordinator's Claude session
 * (spec §4.2: resumed at each group turn; out of the agent's reach and out of git, like `stoppedSession`); `turn`: the group
 * turn running now (cleared when it settles: one found at startup was cut by a restart); `queued`: the group's requests
 * for after the current group turn (spec §8, the one composer's queue).
 */
const groupStateSchema = z.object({
  session: z.object({ sessionId: z.string().min(1), at: z.iso.datetime() }).optional(),
  /**
   * Review minor 2: `request` is the turn's message until its run starts (`started`): a turn cut before (taken from the queue,
   * or waiting for its lane) puts it back at the top of the queue at startup.
   */
  turn: z.object({ jobId: z.string().min(1), at: z.iso.datetime(), started: z.boolean().optional(), request: queuedRequestSchema.optional() }).optional(),
  queued: z.array(queuedRequestSchema).optional(),
});
export type GroupSideState = z.infer<typeof groupStateSchema>;
/**
 * Decision 1423: the brief session the creative was made from (Genera / Salva bozza). `sessionId`: the brief agent's Claude
 * session, which the creative's first turn (or its group's coordinator) resumes as a fork; `summary`: the brief chat's digest,
 * the fallback when that session can no longer be resumed. Cleared once used. Not `creative.resumeFrom`: that one needs a
 * version and lives in the agent-readable creative.json.
 */
const briefSessionSchema = z.object({ sessionId: z.string().min(1), at: z.iso.datetime(), summary: z.string().max(50_000) });
export type BriefSessionLink = z.infer<typeof briefSessionSchema>;
const recordSchema = z.object({
  schemaVersion: z.literal(1),
  queued: z.array(queuedRequestSchema).optional(),
  stoppedSession: stoppedSchema.optional(),
  /**
   * Fix round 2: the creative's creative.json could not be read when the record was made (a corrupt file at startup). Its
   * legacy fields are migrated on the first successful open, then the flag is dropped.
   */
  pendingMigration: z.literal(true).optional(),
  /** Phase 15: see `pendingBriefSchema`. */
  pendingBrief: pendingBriefSchema.optional(),
  /** Phase 3 of the single agent: see `groupStateSchema`. */
  group: groupStateSchema.optional(),
  /** Decision 1423: see `briefSessionSchema`. */
  briefSession: briefSessionSchema.optional(),
});
type SideRecord = z.infer<typeof recordSchema>;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** The item as the core keeps it: `bootId` is no longer stored (Ruling T is in memory now), a legacy one is dropped. */
const clean = (q: QueuedRequest): QueuedRequest => ({ clientId: q.clientId, text: q.text, pins: q.pins, at: q.at, ...(q.pinsVersion !== undefined ? { pinsVersion: q.pinsVersion } : {}), ...(q.fanout ? { fanout: { id: q.fanout.id, lead: q.fanout.lead } } : {}), ...(q.variants?.length ? { variants: [...q.variants] } : {}), ...(q.attachments?.length ? { attachments: [...q.attachments] } : {}) });
/** A remembered session is kept only when its id could be resumed (the same check as where the command line is built). */
const validStopped = (s: StoppedSession | undefined): StoppedSession | undefined => (s && isSessionId(s.sessionId) ? s : undefined);

export class CreativeSideStateStore {
  private readonly lock = new KeyedMutex();
  private readonly memory = new Map<string, SideRecord>();
  /** `configDir` null: in memory only (tests, tools without an explicit config folder never write the user's real one). */
  constructor(private readonly configDir: string | null) { if (configDir !== null) assertNotRealUserData(configDir); }

  private async key(projectDir: string, slug: string): Promise<string> {
    const real = await realpath(projectDir).catch(() => resolve(projectDir));
    return `${real}\0${slug}`;
  }

  private file(key: string): string | null {
    if (this.configDir === null) return null;
    const [project, slug] = key.split('\0') as [string, string];
    return join(this.configDir, 'creative-state', sha(project).slice(0, 32), `${sha(slug).slice(0, 32)}.json`);
  }

  /** Where the creative's record is kept (inside the config folder), or null in memory-only mode. */
  async fileFor(projectDir: string, slug: string): Promise<string | null> { return this.file(await this.key(projectDir, slug)); }

  /** The stored record, or null when none was written yet (the legacy fields, if any, have not been moved). */
  private async load(key: string): Promise<SideRecord | null> {
    const mem = this.memory.get(key);
    if (mem) return mem;
    const file = this.file(key);
    if (file === null) return null;
    const r = await readRegularFile(file, 4 * 1024 * 1024);
    if (r.kind === 'missing') return null;
    if (r.kind !== 'file') throw new Error(`creative state is not a regular file (${r.kind})`);
    const rec = recordSchema.parse(JSON.parse(r.data.toString('utf8')));
    this.memory.set(key, rec);
    return rec;
  }

  private async save(key: string, rec: SideRecord): Promise<void> {
    const file = this.file(key);
    if (file !== null) {
      const dir = join(file, '..');
      await mkdir(join(this.configDir!, 'creative-state'), { recursive: true, mode: 0o700 });
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await writeFile(tmp, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
        await rename(tmp, file);
      } catch (err) {
        await unlink(tmp).catch(() => {});
        throw err;
      }
    }
    this.memory.set(key, rec);
  }

  /**
   * The record, made on first use. Migration: the first time a creative is seen, `queued`/`stoppedSession` still in its
   * `creative.json` (written before this change) move here and leave the file. Once the record exists, those fields in the
   * file are never read again (anything written there later is not the user's): they are only removed.
   */
  private async ensure(projectDir: string, slug: string, key: string): Promise<SideRecord> {
    const existing = await this.load(key);
    const store = new CreativeStore(projectDir);
    const legacy = await store.get(slug);
    let rec = existing;
    if (!rec || rec.pendingMigration) {
      rec = { schemaVersion: 1 };
      const queued = (legacy.queued ?? []).map(clean);
      if (queued.length > 0) rec.queued = queued;
      const stopped = validStopped(legacy.stoppedSession);
      if (stopped) rec.stoppedSession = stopped;
      await this.save(key, rec);
    }
    if (legacy.queued !== undefined || legacy.stoppedSession !== undefined) {
      await store.update(slug, { queued: undefined, stoppedSession: undefined });
    }
    return rec;
  }

  /**
   * Fix round 2: a creative whose creative.json is unreadable at startup gets a record saying "migrate on the first
   * successful open" (its legacy fields, if it is repaired, are the user's pre-upgrade ones and are migrated then).
   */
  async markPendingMigration(projectDir: string, slug: string): Promise<void> {
    const key = await this.key(projectDir, slug);
    await this.lock.run(key, async () => {
      if (await this.load(key)) return;
      await this.save(key, { schemaVersion: 1, pendingMigration: true });
    });
  }

  /** The creative's queue and remembered session (both absent when none). */
  async read(projectDir: string, slug: string): Promise<CreativeSideState> {
    const key = await this.key(projectDir, slug);
    return this.lock.run(key, async () => {
      const rec = await this.ensure(projectDir, slug, key);
      const stopped = validStopped(rec.stoppedSession);
      return { ...(rec.queued?.length ? { queued: rec.queued } : {}), ...(stopped ? { stoppedSession: stopped } : {}) };
    });
  }

  /** Read-modify-write under this creative's lock; `fn` returns the fields to change (`undefined` clears one). */
  async update(projectDir: string, slug: string, fn: (s: CreativeSideState) => Partial<CreativeSideState> | Promise<Partial<CreativeSideState>>): Promise<CreativeSideState> {
    const key = await this.key(projectDir, slug);
    return this.lock.run(key, async () => {
      const rec = await this.ensure(projectDir, slug, key);
      const cur: CreativeSideState = { ...(rec.queued?.length ? { queued: rec.queued } : {}), ...(validStopped(rec.stoppedSession) ? { stoppedSession: rec.stoppedSession } : {}) };
      const patch = await fn(cur);
      const next: SideRecord = { schemaVersion: 1 };
      const queued = Object.hasOwn(patch, 'queued') ? patch.queued : cur.queued;
      const stopped = Object.hasOwn(patch, 'stoppedSession') ? patch.stoppedSession : cur.stoppedSession;
      if (queued?.length) next.queued = queued.map(clean);
      if (validStopped(stopped)) next.stoppedSession = stopped;
      if (rec.pendingBrief) next.pendingBrief = rec.pendingBrief;
      if (rec.group) next.group = rec.group;
      if (rec.briefSession) next.briefSession = rec.briefSession;
      await this.save(key, next);
      return { ...(next.queued ? { queued: next.queued } : {}), ...(next.stoppedSession ? { stoppedSession: next.stoppedSession } : {}) };
    });
  }

  /** Phase 15: the brief waiting for this variant's next turn, or null. */
  async pendingBrief(projectDir: string, slug: string): Promise<PendingBrief | null> {
    const key = await this.key(projectDir, slug);
    return this.lock.run(key, async () => (await this.ensure(projectDir, slug, key)).pendingBrief ?? null);
  }

  /** Phase 15: sets (a newer one replaces it) or clears (`null`) the brief waiting for this variant's next turn. */
  async setPendingBrief(projectDir: string, slug: string, pending: PendingBrief | null): Promise<void> {
    const key = await this.key(projectDir, slug);
    await this.lock.run(key, async () => {
      const rec = await this.ensure(projectDir, slug, key);
      const next: SideRecord = { ...rec };
      if (pending) next.pendingBrief = pendingBriefSchema.parse(pending); else delete next.pendingBrief;
      if (!pending && rec.pendingBrief === undefined) return;
      await this.save(key, next);
    });
  }

  /** Decision 1423: the brief session this creative may resume, or null (none, or not a resumable id). */
  async briefResume(projectDir: string, slug: string): Promise<BriefSessionLink | null> {
    const key = await this.key(projectDir, slug);
    return this.lock.run(key, async () => {
      const b = (await this.ensure(projectDir, slug, key)).briefSession;
      return b && isSessionId(b.sessionId) ? b : null;
    });
  }

  /** Decision 1423: records (the create route's handoff) or clears (`null`: used, or gone) the brief session to resume. */
  async setBriefSession(projectDir: string, slug: string, link: BriefSessionLink | null): Promise<void> {
    const key = await this.key(projectDir, slug);
    await this.lock.run(key, async () => {
      const rec = await this.ensure(projectDir, slug, key);
      if (!link && rec.briefSession === undefined) return;
      const next: SideRecord = { ...rec };
      if (link) next.briefSession = briefSessionSchema.parse(link); else delete next.briefSession;
      await this.save(key, next);
    });
  }

  /** Phase 3 of the single agent: the group's own state, on its host (empty when none). */
  async group(projectDir: string, host: string): Promise<GroupSideState> {
    const key = await this.key(projectDir, host);
    return this.lock.run(key, async () => {
      const g = (await this.ensure(projectDir, host, key)).group ?? {};
      return { ...g, ...(g.session && !isSessionId(g.session.sessionId) ? { session: undefined } : {}) };
    });
  }

  /** Phase 3: read-modify-write of the group's state under the host's lock; `fn` returns the fields to change (`undefined` clears one). */
  async updateGroup(projectDir: string, host: string, fn: (g: GroupSideState) => Partial<GroupSideState> | Promise<Partial<GroupSideState>>): Promise<GroupSideState> {
    const key = await this.key(projectDir, host);
    return this.lock.run(key, async () => {
      const rec = await this.ensure(projectDir, host, key);
      const cur = rec.group ?? {};
      const patch = await fn(cur);
      const merged: GroupSideState = { ...cur };
      for (const k of Object.keys(patch) as Array<keyof GroupSideState>) {
        if (patch[k] === undefined) delete merged[k];
        else (merged as Record<string, unknown>)[k] = patch[k];
      }
      if (merged.queued) merged.queued = merged.queued.length > 0 ? merged.queued.map(clean) : undefined;
      if (merged.queued === undefined) delete merged.queued;
      const next: SideRecord = { ...rec };
      const parsed = groupStateSchema.parse(merged);
      if (Object.keys(parsed).length > 0) next.group = parsed; else delete next.group;
      await this.save(key, next);
      return parsed;
    });
  }

  /**
   * Decision 915: forgets the record of a creative moved to the Trash, so a new creative that takes its slug later starts
   * clean (no queue, no remembered session, no pending brief of the old one).
   */
  async forget(projectDir: string, slug: string): Promise<void> {
    const key = await this.key(projectDir, slug);
    await this.lock.run(key, async () => {
      this.memory.delete(key);
      const file = this.file(key);
      if (file !== null) await unlink(file).catch((err: NodeJS.ErrnoException) => { if (err.code !== 'ENOENT') throw err; });
    });
  }

  /** `creative` as the API shows it: the creative.json fields plus this state (the web reads `queued` there). */
  async merged(projectDir: string, slug: string, creative: CreativeFile): Promise<CreativeFile> {
    const { queued: _q, stoppedSession: _s, ...rest } = creative;
    const side = await this.read(projectDir, slug);
    return { ...rest, ...side };
  }
}
