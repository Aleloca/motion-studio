import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFile, mkdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { briefContextSchema, briefFieldSchema, briefFormSchema, briefQueuedSchema, type BriefContext, type BriefField, type BriefForm, type ConversationEntry } from '@motion-studio/shared';
import { assertNotRealUserData } from '../app-config.ts';
import { KeyedMutex } from '../keyed-mutex.ts';
import { readRegularFile } from '../safe-read.ts';
import { parseConversation } from '../creatives/group-conversation.ts';
import { t } from '../i18n.ts';
import { CodedError } from '../workspace-store.ts';

/**
 * Decision 1421: a project's brief session, kept in the core's config folder (`<config>/brief-sessions/<hash of the
 * project's real path>/`), out of the agent's reach (the config folder is denied to every job) and out of the project's git
 * (`git add -A` would commit absolute folder paths). `session.json` holds the session; `conversation.jsonl` its chat, in the
 * creative conversation's format, so the same chat component renders it.
 */
const sessionSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  context: briefContextSchema,
  form: briefFormSchema,
  userEdited: z.array(briefFieldSchema),
  agentFields: z.array(briefFieldSchema),
  /** The Claude session of the latest brief run: the next turn resumes it, the creative's first turn forks it. */
  claudeSessionId: z.string().min(1).optional(),
  queued: z.array(briefQueuedSchema),
  /** The form's revision (decision 1422): +1 at every change of the form or of who owns a field. */
  revision: z.number().int().min(0).default(0),
  /** Per field the agent took back on the user's request (`reclaim`), the revision it happened at. */
  reclaimedAt: z.record(z.string(), z.number().int().min(0)).default({}),
  /** A creative the session was moved into when the move did not finish: no message or new move is taken. */
  handedOffTo: z.string().min(1).optional(),
});
export type BriefSessionFile = z.infer<typeof sessionSchema>;

const SESSION_FILE = 'session.json';
const LOG_FILE = 'conversation.jsonl';
const MAX_SESSION_BYTES = 4 * 1024 * 1024;
/** A brief chat is short; the cap only bounds a read of a file someone grew by hand. */
const MAX_LOG_BYTES = 64 * 1024 * 1024;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const gone = () => new CodedError(409, t().errors.briefSessionGone, 'brief-session-gone');
/**
 * The session's files hold what cannot be a session: JSON or schema errors, or a file over the size cap (422
 * `brief-session-unreadable`; discarding the session removes them). Any other I/O error (EACCES, EMFILE…) is not this: it
 * stays an ordinary error, and nothing is removed because of it.
 */
export const unreadable = () => new CodedError(422, t().errors.briefSessionUnreadable, 'brief-session-unreadable');
export const isUnreadable = (err: unknown): boolean => err instanceof CodedError && err.apiCode === 'brief-session-unreadable';

export class BriefSessionStore {
  private readonly lock = new KeyedMutex();
  /** Memory-only mode (`configDir` null): the sessions and their chats, by project key. */
  private readonly memory = new Map<string, { session: BriefSessionFile; entries: ConversationEntry[] }>();
  /** `configDir` null: in memory only (tests, tools without an explicit config folder never write the user's real one). */
  constructor(private readonly configDir: string | null) { if (configDir !== null) assertNotRealUserData(configDir); }

  private async key(projectDir: string): Promise<string> {
    return realpath(projectDir).catch(() => resolve(projectDir));
  }

  private dir(key: string): string | null {
    return this.configDir === null ? null : join(this.configDir, 'brief-sessions', sha(key).slice(0, 32));
  }

  /** The folder of the project's session (inside the config folder), or null in memory-only mode. */
  async dirFor(projectDir: string): Promise<string | null> { return this.dir(await this.key(projectDir)); }

  private async load(key: string): Promise<BriefSessionFile | null> {
    const dir = this.dir(key);
    if (dir === null) return this.memory.get(key)?.session ?? null;
    const r = await readRegularFile(join(dir, SESSION_FILE), MAX_SESSION_BYTES);
    if (r.kind === 'missing') return null;
    if (r.kind === 'too-large') throw unreadable();
    if (r.kind !== 'file') throw new Error(`brief session is not a regular file (${r.kind})`);
    // A corrupt file is an error, never silently a new session: the user's chat and form would be lost.
    let json: unknown;
    try { json = JSON.parse(r.data.toString('utf8')); } catch { throw unreadable(); }
    const parsed = sessionSchema.safeParse(json);
    if (!parsed.success) throw unreadable();
    return parsed.data;
  }

  private async save(key: string, s: BriefSessionFile): Promise<void> {
    const dir = this.dir(key);
    if (dir === null) {
      const mem = this.memory.get(key);
      this.memory.set(key, { session: s, entries: mem?.session.id === s.id ? mem.entries : [] });
      return;
    }
    await this.ensureDir(dir);
    const file = join(dir, SESSION_FILE);
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(s)}\n`, { mode: 0o600 });
      await rename(tmp, file);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }

  private async ensureDir(dir: string): Promise<void> {
    await mkdir(join(this.configDir!, 'brief-sessions'), { recursive: true, mode: 0o700 });
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }

  /** The project's open session, or null. */
  async open(projectDir: string): Promise<BriefSessionFile | null> {
    const key = await this.key(projectDir);
    return this.lock.run(key, () => this.load(key));
  }

  /** A new session with the form as the user has it now; the open one when there is one (one per project). */
  async create(projectDir: string, init: { form: BriefForm; userEdited: BriefField[]; context?: BriefContext }): Promise<BriefSessionFile> {
    const key = await this.key(projectDir);
    return this.lock.run(key, async () => {
      const open = await this.load(key);
      if (open) return open;
      const now = new Date().toISOString();
      const s: BriefSessionFile = {
        schemaVersion: 1, id: randomUUID(), createdAt: now, updatedAt: now,
        context: init.context ?? { codebases: [], assets: [] }, form: init.form, userEdited: [...new Set(init.userEdited)], agentFields: [], queued: [],
        revision: 0, reclaimedAt: {},
      };
      await this.save(key, s);
      const dir = this.dir(key);
      if (dir) await writeFile(join(dir, LOG_FILE), '', { mode: 0o600, flag: 'w' });
      return s;
    });
  }

  /** Read-modify-write of the open session `id` (409 `brief-session-gone` when it is not the open one). */
  async update(projectDir: string, id: string, fn: (s: BriefSessionFile) => Partial<BriefSessionFile> | Promise<Partial<BriefSessionFile>>): Promise<BriefSessionFile> {
    const key = await this.key(projectDir);
    return this.lock.run(key, async () => {
      const cur = await this.load(key);
      if (!cur || cur.id !== id) throw gone();
      const patch = await fn(cur);
      const next = sessionSchema.parse({ ...cur, ...patch, schemaVersion: 1, id: cur.id, createdAt: cur.createdAt, updatedAt: new Date().toISOString() });
      // `undefined` in the patch clears an optional field (zod drops it, the spread kept the key).
      for (const k of Object.keys(patch) as Array<keyof BriefSessionFile>) if (patch[k] === undefined) delete (next as Record<string, unknown>)[k];
      await this.save(key, next);
      return next;
    });
  }

  /** Appends an entry to session `id`'s chat. */
  async append(projectDir: string, id: string, entry: ConversationEntry): Promise<void> {
    const key = await this.key(projectDir);
    await this.lock.run(key, async () => {
      const cur = await this.load(key);
      if (!cur || cur.id !== id) throw gone();
      const dir = this.dir(key);
      if (dir === null) { this.memory.get(key)!.entries.push(entry); return; }
      await this.ensureDir(dir);
      await appendFile(join(dir, LOG_FILE), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    });
  }

  /** Session `id`'s chat, oldest first. */
  async conversation(projectDir: string, id: string): Promise<ConversationEntry[]> {
    const key = await this.key(projectDir);
    return this.lock.run(key, async () => {
      const cur = await this.load(key);
      if (!cur || cur.id !== id) throw gone();
      const dir = this.dir(key);
      if (dir === null) return [...this.memory.get(key)!.entries];
      const r = await readRegularFile(join(dir, LOG_FILE), MAX_LOG_BYTES);
      if (r.kind === 'missing') return [];
      if (r.kind === 'too-large') throw unreadable();
      if (r.kind !== 'file') throw new Error(`brief conversation is not a regular file (${r.kind})`);
      return parseConversation(r.data.toString('utf8'));
    });
  }

  /** Removes the project's session folder whatever it holds (a session that cannot be read any more is discarded so). */
  async removeAny(projectDir: string): Promise<void> {
    const key = await this.key(projectDir);
    await this.lock.run(key, async () => {
      const dir = this.dir(key);
      if (dir === null) { this.memory.delete(key); return; }
      await rm(dir, { recursive: true, force: true });
    });
  }

  /** Removes session `id` and its folder (discarded, or handed to a creative). */
  async remove(projectDir: string, id: string): Promise<void> {
    const key = await this.key(projectDir);
    await this.lock.run(key, async () => {
      const cur = await this.load(key);
      if (!cur || cur.id !== id) throw gone();
      const dir = this.dir(key);
      if (dir === null) { this.memory.delete(key); return; }
      await rm(dir, { recursive: true, force: true });
    });
  }
}

