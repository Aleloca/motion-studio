import { createHash, randomBytes } from 'node:crypto';
import { mkdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { isSessionId, queuedRequestSchema, type CreativeFile, type QueuedRequest } from '@motion-studio/shared';
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
const recordSchema = z.object({
  schemaVersion: z.literal(1),
  queued: z.array(queuedRequestSchema).optional(),
  stoppedSession: stoppedSchema.optional(),
});
type SideRecord = z.infer<typeof recordSchema>;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** The item as the core keeps it: `bootId` is no longer stored (Ruling T is in memory now), a legacy one is dropped. */
const clean = (q: QueuedRequest): QueuedRequest => ({ clientId: q.clientId, text: q.text, pins: q.pins, at: q.at, ...(q.pinsVersion !== undefined ? { pinsVersion: q.pinsVersion } : {}) });
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
    if (!rec) {
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
      await this.save(key, next);
      return { ...(next.queued ? { queued: next.queued } : {}), ...(next.stoppedSession ? { stoppedSession: next.stoppedSession } : {}) };
    });
  }

  /** `creative` as the API shows it: the creative.json fields plus this state (the web reads `queued` there). */
  async merged(projectDir: string, slug: string, creative: CreativeFile): Promise<CreativeFile> {
    const { queued: _q, stoppedSession: _s, ...rest } = creative;
    const side = await this.read(projectDir, slug);
    return { ...rest, ...side };
  }
}
