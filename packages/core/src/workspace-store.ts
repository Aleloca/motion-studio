import { assertNotRealUserData } from './app-config.ts';
import { randomBytes } from 'node:crypto';
import { access, chmod, constants, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { HELD_FIELDS, heldOf, SettingsHoldError, tightenHeld, type HeldSettings, type SettingsHoldStore } from './settings-hold.ts';
import { homedir } from 'node:os';
import * as platformPath from 'node:path';
import { posix, win32 } from 'node:path';
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import {
  type WorkspaceProblemCode,
  projectFileSchema,
  storedWorkspaceSettingsSchema,
  workspaceSettingsSchema,
  type ProjectFile,
  type LinkedCodebase, type ProjectIcon,
  type ProjectListItem,
  type WorkspaceSettings,
  type WorkspaceSettingsView,
} from '@motion-studio/shared';
import type { Git } from './git.ts';
import { JsonFileError, readJsonFile, writeJsonFileAtomic } from './json-file.ts';
import { KeyedMutex } from './keyed-mutex.ts';
import { noteCoreChange } from './core-changes.ts';
import { CLAUDE_MD, CONTEXT_MD, GITATTRIBUTES, GITIGNORE, PROJECT_DIRS } from './project-template.ts';
import { t } from './i18n.ts';

export class WorkspaceError extends Error {
  constructor(public readonly status: 400 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 503, message: string, public readonly code?: WorkspaceProblemCode) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

/**
 * A WorkspaceError whose response also carries a stable machine-readable `code` (e.g. `link-chain`), for the UI to branch on;
 * `retryAfterSec` adds a `Retry-After` header (503).
 */
export class CodedError extends WorkspaceError {
  /** `problems`: every translated problem behind a refusal (a draft that does not validate), sent as `problems`; for `attachment-invalid` (report 79), the refused paths themselves (untranslated). */
  problems?: string[];
  /** Task 25: subtitle lines removed before the refusal (`retranslateSubtitles`), sent as `dropped`. */
  dropped?: number;
  constructor(status: 400 | 403 | 404 | 409 | 413 | 422 | 429 | 503, message: string, public readonly apiCode: string, public readonly retryAfterSec?: number) {
    super(status, message);
    this.name = 'CodedError';
  }
}

/** `~` and `~/…` refer to the user's home folder. */
export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

/** The parts of a platform path module the codebase path checks need (injectable: tests pass `path.win32`). */
export type CodebasePathModule = Pick<typeof platformPath.win32, 'sep' | 'normalize' | 'isAbsolute' | 'parse'>;

/**
 * Decision 1978: `p` (absolute) without its trailing separators, '' for a disk root (`/`, `C:\`, `C:/`). On Windows both
 * `/` and `\` are separators; POSIX strips only `/` as before.
 */
export function trimTrailingSeparators(p: string, P: CodebasePathModule = platformPath): string {
  if (P.sep === '\\' && P.parse(p).root === p && P.isAbsolute(p)) return '';
  return P.sep === '\\' ? p.replace(/[\\/]+$/, '') : p.replace(/\/+$/, '');
}

/** Same folder name for the platform: Windows compares paths without case (as its file system does). */
export const samePathName = (a: string, b: string, P: Pick<CodebasePathModule, 'sep'> = platformPath) =>
  (P.sep === '\\' ? a.toLowerCase() === b.toLowerCase() : a === b);

export function normalizeCodebasePath(p: string, P: CodebasePathModule = platformPath, home: string = homedir()): string {
  const s = P.normalize(expandHome(p.trim()));
  if (!P.isAbsolute(s)) throw new WorkspaceError(400, t().errors.codebaseNotAbsolute({ path: p }));
  const stripped = trimTrailingSeparators(s, P);
  if (!stripped) throw new WorkspaceError(400, t().errors.codebaseDiskRoot);
  if (samePathName(stripped, trimTrailingSeparators(home, P), P)) throw new WorkspaceError(400, t().errors.codebaseHome);
  return stripped;
}

/** Normalizes paths, trims notes (blank dropped) and dedupes by path (the first wins). Throws on invalid paths. */
export function normalizeCodebaseList(list: LinkedCodebase[]): LinkedCodebase[] {
  const seen = new Set<string>();
  const out: LinkedCodebase[] = [];
  for (const c of list) {
    const path = normalizeCodebasePath(c.path);
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ path, ...(c.note?.trim() ? { note: c.note.trim() } : {}) });
  }
  return out;
}

export const codebaseOverlapMessage = (): string => t().errors.codebaseOverlap;
/** The refusal of a new overlapping path: names it (decision 792). */
export const codebaseOverlapNamedMessage = (path: string): string => t().errors.codebaseOverlapNamed({ path });

const isWithin = (inner: string, outer: string) => inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);
/** The normalised path, plus its real path when it exists and differs (symlinks). */
const pathForms = async (p: string) => {
  const n = resolve(p);
  const real = await realpath(n).catch(() => null);
  return real && real !== n ? [n, real] : [n];
};

/** True when `path` is one of `protectedDirs`, an ancestor of one, or inside one (normalised and real paths compared). */
export async function codebaseOverlaps(path: string, protectedDirs: string[]): Promise<boolean> {
  const mine = await pathForms(path);
  for (const dir of protectedDirs) {
    for (const b of await pathForms(dir)) if (mine.some((a) => isWithin(a, b) || isWithin(b, a))) return true;
  }
  return false;
}

/**
 * Glob metacharacters a codebase path may not hold (Phase 14 final wave, decision 781). With Claude Code 2.1.300 a path that
 * mixes `( )` with `[ ]` or `{ }` stops every permission rule on it from matching (decision 780), whatever the escaping; the
 * backslash is in the set because its escaping was never verified live. POSIX only: never test a path against it directly,
 * use `pathHasGlobChars` (on Windows `\` is the separator, decision 791). Re-exported by codebases.ts.
 */
export const GLOB_PATH_CHARS = /[()[\]{}*?\\]/;
/** Decision 791: the same set without the backslash, checked on each name of a Windows path. */
const WIN_GLOB_NAME_CHARS = /[()[\]{}*?]/;

/** The parts of a platform path module the glob check needs (injectable: tests pass `path.win32`). */
export type GlobPathModule = Pick<typeof platformPath.win32, 'sep' | 'parse'>;

/**
 * Decision 791: whether `p` holds a glob metacharacter, for the platform of `pathModule` (default: this platform's).
 * POSIX: `GLOB_PATH_CHARS` on the whole path, `\` included. Windows (`path.win32`): `( ) [ ] { } * ?` in any name; the `\`
 * and `/` separators, the drive colon (`C:`) and the prefixes `\\?\`, `\\.\` and `\\?\UNC\` are syntax, not names. The
 * server and share names of a UNC path are names (checked).
 */
export function pathHasGlobChars(p: string, pathModule: GlobPathModule = platformPath): boolean {
  if (pathModule.sep !== '\\') return GLOB_PATH_CHARS.test(p);
  const { root } = pathModule.parse(p);
  const rootNames = root.replace(/^[\\/]{2}[?.][\\/](?:UNC[\\/])?/i, '').split(/[\\/]+/).filter((n) => n !== '' && !/^[A-Za-z]:$/.test(n));
  return [...rootNames, ...p.slice(root.length).split(/[\\/]+/)].some((n) => WIN_GLOB_NAME_CHARS.test(n));
}

/** True when the path, or its real path (a link), holds a glob metacharacter (`pathHasGlobChars`). */
export async function codebaseHasGlobChars(path: string): Promise<boolean> {
  if (pathHasGlobChars(path)) return true;
  const real = await realpath(path).catch(() => null);
  return real !== null && pathHasGlobChars(real);
}

export const codebaseGlobCharsMessage = (path: string): string => t().errors.codebaseGlobChars({ path });

/**
 * The real path of `path`, or, when it does not exist yet, the real path of its nearest existing ancestor joined with the
 * rest (a workspace folder chosen before it exists, under a link). Null when nothing on the way resolves.
 */
async function realpathOrAncestor(path: string): Promise<string | null> {
  let head = resolve(path);
  const rest: string[] = [];
  for (;;) {
    const real = await realpath(head).catch(() => null);
    if (real !== null) return rest.length ? join(real, ...rest.reverse()) : real;
    const up = dirname(head);
    if (up === head) return null;
    rest.push(basename(head));
    head = up;
  }
}

/**
 * Decision 790: the first spelling, among `paths` and their real paths, that holds a glob metacharacter (`pathHasGlobChars`),
 * or null. The plain paths are checked first; a real path is returned as is (it is where the characters are).
 */
export async function folderWithGlobChars(paths: string[]): Promise<string | null> {
  for (const p of paths) if (pathHasGlobChars(p)) return p;
  for (const p of paths) {
    const real = await realpathOrAncestor(p);
    if (real !== null && pathHasGlobChars(real)) return real;
  }
  return null;
}

/** The stable code of a workspace or project folder whose path (or real path) has glob characters (decision 790). */
export const FOLDER_GLOB_CHARS_CODE = 'folder-glob-chars';
export const folderGlobCharsError = (path: string): CodedError => new CodedError(400, t().errors.folderGlobChars({ path }), FOLDER_GLOB_CHARS_CODE);

/**
 * Decision 790: refuses (400, `folder-glob-chars`, naming the path) when the project folder or the workspace folder, plain or
 * real, holds a glob metacharacter. With such a path the agent's protected-file rules (CLAUDE.md, .mcp.json, .claude, .studio,
 * the logs) stop matching (decision 780), so no agent may run there and no such workspace or project may be created.
 * `workspaceRoot` defaults to the project folder's parent (projects live directly in the workspace).
 */
export async function assertAgentFolders(projectDir: string | null, workspaceRoot?: string): Promise<void> {
  const root = workspaceRoot ?? (projectDir ? dirname(projectDir) : null);
  const hit = await folderWithGlobChars([...(root ? [root] : []), ...(projectDir ? [projectDir] : [])]);
  if (hit !== null) throw folderGlobCharsError(hit);
}

/** The stored codebase paths in their normalised form (an invalid stored entry is not a pass). */
function storedKnown(stored: LinkedCodebase[]): Set<string> {
  const known = new Set<string>();
  for (const c of stored) { try { known.add(normalizeCodebasePath(c.path)); } catch { /* not a pass */ } }
  return known;
}

/**
 * Refuses (400, `codebase-glob-chars`, naming the path) a linked folder whose path or real path holds a glob metacharacter.
 * `stored`: the list already saved; its paths (normalised) pass unchanged (decision 788): a creative or project that holds
 * a legacy one can still save its other edits, and the folder stays left out at run time with a note.
 */
export async function assertCodebasesLiteral(list: LinkedCodebase[], stored: LinkedCodebase[] = []): Promise<void> {
  const known = storedKnown(stored);
  for (const c of list) {
    if (known.has(c.path)) continue;
    if (await codebaseHasGlobChars(c.path)) throw new CodedError(400, codebaseGlobCharsMessage(c.path), 'codebase-glob-chars');
  }
}

/**
 * Refuses (400) linked folders the agent's rules cannot hold: a path with glob metacharacters (`codebase-glob-chars`, first),
 * and folders overlapping the project or the workspace (they would hand the project to --add-dir). Every route that links a
 * creative or project codebase goes through here.
 */
export async function assertCodebasesOutside(list: LinkedCodebase[], protectedDirs: string[], stored: LinkedCodebase[] = []): Promise<void> {
  await assertCodebasesLiteral(list, stored);
  // Decision 792: like the glob check, only paths new or changed (normalised) are tested; a stored overlapping one stays and is skipped at run time with a note.
  const known = storedKnown(stored);
  for (const c of list) {
    if (known.has(c.path)) continue;
    if (await codebaseOverlaps(c.path, protectedDirs)) throw new WorkspaceError(400, codebaseOverlapNamedMessage(c.path));
  }
}

/** A project folder's name (its slug); exported for the doctor's scan of the workspace. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
  return s || 'project';
}

/** What an unsandboxed agent run did to the workspace settings (final wave P9). */
/** `holdBroken`: the change could not be undone and its hold could not be saved either (loud, Ruling AA). */
export interface SettingsCheck { changed: boolean; reverted: boolean; holdBroken?: boolean }

/** Puts back exactly `text` at `path`, through a temp file and a rename (never a half-written settings file). */
async function writeThroughAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

const defaultView = (): WorkspaceSettingsView => workspaceSettingsSchema.parse({ schemaVersion: 1 });

export class WorkspaceStore {
  private readonly createLock = new KeyedMutex();
  private readonly projectLock = new KeyedMutex();
  /**
   * Final wave P9: `.studio/settings.json` is protected by the sandbox only; an agent run with the sandbox off can write it
   * (e.g. through `Bash(node:*)`). While such runs are going (`guardSettings`), the settings are served from the content
   * they had when the first one started, and after each one any change is undone. If undoing fails, the trusted content
   * keeps being served (no changed sandbox mode, opt-in or paid-provider field applies) until the user saves the settings.
   */
  private guarded = 0;
  /** The settings when the first of the current unsandboxed runs started: what each release puts back. */
  private snapshot: { raw: string | null; settings: WorkspaceSettingsView } | null = null;
  /**
   * Ruling AA: the held values while a change could not be undone (tighten-only: each held field is the stricter of these
   * and the file's). Null: nothing held.
   */
  private held: HeldSettings | null = null;
  /** The hold could not be saved or read: loud (doctor row) and unsandboxed agent runs are refused until the user saves. */
  private holdBroken = false;
  /** Fix round 3 (R2-2): held fields this process made stricter in the file (said in the doctor until the user saves). */
  private adjusted: string[] = [];
  /** Fix round 3 (R2-3): a record path the core could not clear (the user is told to remove it). */
  private stuckRecord: string | null = null;
  /** Where a hold that must survive a restart is kept (the core's config folder); absent: memory only. */
  private hold: SettingsHoldStore | null = null;
  private readonly settingsLock = new KeyedMutex();
  private constructor(public readonly root: string, private readonly git: Git) {}

  /** `create: false` (used at startup) refuses to recreate a workspace folder that disappeared. */
  static async open(root: string, git: Git, opts: { create?: boolean } = {}): Promise<WorkspaceStore> {
    assertNotRealUserData(root);
    const info = await stat(root).catch(() => null);
    if (info && !info.isDirectory()) throw new WorkspaceError(400, t().errors.pathIsFile({ path: root }), 'not-found');
    if (!info && opts.create === false) throw new WorkspaceError(404, t().errors.workspaceNotFound({ path: root }), 'not-found');
    try {
      await mkdir(join(root, '.studio'), { recursive: true });
      await access(root, constants.W_OK);
    } catch {
      throw new WorkspaceError(400, t().errors.notWritable({ path: root }), 'not-writable');
    }
    const store = new WorkspaceStore(root, git);
    const settingsPath = store.settingsPath();
    if (!(await stat(settingsPath).catch(() => null))) {
      await writeJsonFileAtomic(settingsPath, workspaceSettingsSchema.parse({ schemaVersion: 1, agentLiveDefaults: 804 }));
    }
    return store;
  }

  private settingsPath() { return join(this.root, '.studio', 'settings.json'); }

  /**
   * Final wave P9 (fix rounds 1–2, Ruling AA): attaches the persisted hold (config folder). A hold left by an earlier run of
   * the app is honoured from now on and the revert is retried at once. A hold that cannot be read, or a hold folder the
   * core cannot write, makes the hold unreliable: loud, and unsandboxed runs are refused until the user saves the settings.
   */
  async attachSettingsHold(hold: SettingsHoldStore): Promise<void> {
    this.hold = hold;
    await this.settingsLock.run('settings', async () => {
      if (!(await hold.usable())) { this.holdBroken = true; return; }
      let rec: HeldSettings | null;
      try { rec = await hold.load(this.root); } catch (err) { this.clearFailed(err); return; }
      if (!rec) return;
      this.held = rec;
      await this.retryRevert();
    });
  }

  /** Whether some settings fields are held (a change the core could not undo) or the hold itself is unreliable (doctor). */
  settingsHeld(): boolean { return this.held !== null || this.holdBroken; }

  /**
   * Fix round 3: what the doctor says about the settings. `broken`: the hold is unreliable (and `stuck`, a record path to
   * remove by hand); `held`: a change is held; `adjusted`: fields were made stricter in the file. `fields`: the held fields
   * whose value in use differs from the file's, or that were made stricter (never a silent change). Null: nothing to say.
   */
  async settingsNotice(): Promise<{ kind: 'broken' | 'held' | 'adjusted'; fields: string[]; stuck: string | null } | null> {
    const hold = this.effectiveHold();
    if (!hold && this.adjusted.length === 0) return null;
    const fields = new Set(this.adjusted);
    if (hold) {
      const file = await this.fileSettings();
      const inFile = file ? heldOf(file) : null;
      const used = inFile ? tightenHeld(hold, inFile) : hold;
      for (const k of HELD_FIELDS) if (!inFile || JSON.stringify(inFile[k]) !== JSON.stringify(used[k])) fields.add(k);
    }
    return { kind: this.holdBroken ? 'broken' : hold ? 'held' : 'adjusted', fields: HELD_FIELDS.filter((k) => fields.has(k)), stuck: this.stuckRecord };
  }

  /**
   * The values held now: the hold record's; with the hold unreliable and no record (fix round 3, R2-1), the defaults, so
   * every run (sandboxed ones too) uses safe values until the user saves.
   */
  private effectiveHold(): HeldSettings | null {
    return this.held ?? (this.holdBroken ? heldOf(defaultView()) : null);
  }

  /** A failed clear of the record: loud, and the path is remembered for the doctor when known. */
  private clearFailed(err: unknown): void {
    this.holdBroken = true;
    this.stuckRecord = err instanceof SettingsHoldError && err.path ? err.path : this.stuckRecord;
  }
  /** The hold could not be saved or read: unsandboxed agent runs are refused until the user saves the settings. */
  settingsHoldBroken(): boolean { return this.holdBroken; }

  /** The settings file as it is, parsed; null when missing or unreadable. */
  private async fileSettings(): Promise<WorkspaceSettingsView | null> {
    return readJsonFile<WorkspaceSettingsView>(this.settingsPath(), storedWorkspaceSettingsSchema).catch(() => null);
  }

  /** `.studio` and the settings file made writable by their owner again (a mode the agent changed; BSD flags stay). */
  private async restoreModes(): Promise<void> {
    const dir = join(this.root, '.studio');
    for (const [path, bits] of [[dir, 0o700], [this.settingsPath(), 0o600]] as const) {
      const st = await lstat(path).catch(() => null);
      if (!st || st.isSymbolicLink() || (process.getuid !== undefined && st.uid !== process.getuid())) continue;
      if ((st.mode & bits) !== bits) await chmod(path, (st.mode & 0o777) | bits).catch(() => {});
    }
  }

  /**
   * Under `settingsLock`, while held: makes the file at least as strict as the hold (modes restored first). The held record
   * is never copied into the file: only its stricter values are written, so a forged record can only restrict. On success
   * the hold ends.
   */
  private async retryRevert(): Promise<boolean> {
    if (!this.held) return true;
    await this.restoreModes();
    const file = await this.fileSettings();
    const { droppedDomains: _d, ...base } = file ?? defaultView();
    const strict = tightenHeld(this.held, heldOf(base));
    const changed = HELD_FIELDS.filter((k) => JSON.stringify(heldOf(base)[k]) !== JSON.stringify(strict[k]));
    try {
      if (!file || changed.length > 0) await writeJsonFileAtomic(this.settingsPath(), { ...base, ...strict });
    } catch { return false; }
    // Never silent (R2-2): the fields made stricter are named in the doctor until the user saves.
    for (const k of changed) if (!this.adjusted.includes(k)) this.adjusted.push(k);
    this.held = null;
    try { await this.hold?.clear(this.root); } catch (err) { this.clearFailed(err); }
    return true;
  }

  /**
   * Never rewrites the file: invalid stored domains are skipped and listed in `droppedDomains`. During an unsandboxed run
   * the settings are those it started with. While something is held, each held field is the stricter of the hold and the
   * file; only the cosmetic fields come from the file alone.
   */
  async readSettings(): Promise<WorkspaceSettingsView> {
    const hold = this.effectiveHold();
    if (hold) {
      const file = (await this.fileSettings()) ?? this.snapshot?.settings ?? defaultView();
      return { ...structuredClone(file), ...tightenHeld(hold, heldOf(file)) };
    }
    if (this.snapshot && this.guarded > 0) return structuredClone(this.snapshot.settings);
    return readJsonFile<WorkspaceSettingsView>(this.settingsPath(), storedWorkspaceSettingsSchema);
  }

  async updateSettings(patch: Partial<Omit<WorkspaceSettings, 'schemaVersion'>>): Promise<WorkspaceSettings> {
    return this.settingsLock.run('settings', async () => {
      const { droppedDomains: _dropped, ...current } = await this.readSettings();
      const parsed = workspaceSettingsSchema.safeParse({ ...current, ...patch, schemaVersion: 1 });
      if (!parsed.success) throw new WorkspaceError(400, t().errors.invalidSettings({ fields: parsed.error.issues.map((i) => i.path.join('.')).join(', ') }));
      // Fix round 2 (N3): a file or folder an agent made read-only is made writable again first; if it still cannot be
      // written, the user gets a translated reason and what to do, not a raw EPERM.
      await this.restoreModes();
      try {
        await writeJsonFileAtomic(this.settingsPath(), parsed.data);
      } catch {
        throw new CodedError(409, t().errors.settingsNotWritable({ path: this.settingsPath() }), 'settings-not-writable');
      }
      // The user's own save: it is the trusted content from now on (and confirms it after a change that could not be
      // undone). Taken from what was written, never re-read from the file (M1).
      if (this.guarded > 0) this.snapshot = { raw: `${JSON.stringify(parsed.data, null, 2)}\n`, settings: structuredClone(parsed.data) };
      this.adjusted = [];
      if (this.held || this.holdBroken) {
        this.held = null;
        this.holdBroken = false;
        this.stuckRecord = null;
        // A record left behind would tighten the user's own choice at the next start: its removal failing is loud too.
        try { await this.hold?.clear(this.root); } catch (err) { this.clearFailed(err); }
      }
      return parsed.data;
    });
  }

  /**
   * Final wave P9: call before an agent run without the sandbox; call the returned function once the run is over. It says
   * whether the settings file changed meanwhile, whether the change was undone, and whether its hold could be kept.
   * Refused (409 `settings-hold-broken`) while the hold is unreliable, until the user saves the settings (Ruling AA).
   */
  async guardSettings(): Promise<() => Promise<SettingsCheck>> {
    await this.settingsLock.run('settings', async () => {
      if (this.holdBroken) throw new CodedError(409, t().jobs.settingsHoldBroken, 'settings-hold-broken');
      if (this.held) await this.retryRevert();
      if (this.guarded === 0) {
        const raw = await readFile(this.settingsPath(), 'utf8').catch(() => null);
        this.snapshot = { raw, settings: await this.readSettings().catch(() => defaultView()) };
      }
      this.guarded++;
    });
    let released = false;
    return () => this.settingsLock.run('settings', async (): Promise<SettingsCheck> => {
      if (released) return { changed: false, reverted: false };
      released = true;
      this.guarded--;
      const want = this.snapshot;
      const now = await readFile(this.settingsPath(), 'utf8').catch(() => null);
      let out: SettingsCheck = { changed: false, reverted: false };
      if (want && now !== want.raw) {
        try {
          if (want.raw === null) await rm(this.settingsPath(), { force: true });
          else await writeThroughAtomic(this.settingsPath(), want.raw);
          out = { changed: true, reverted: true };
        } catch {
          // Not undone: the run's starting values are held (tighten-only), also across a restart (config folder), until the
          // revert succeeds (retried at startup and at the next guard) or the user saves. A hold that cannot be saved is loud.
          const start = heldOf(want.settings);
          this.held = this.held ? tightenHeld(this.held, start) : start;
          out = { changed: true, reverted: false };
          try { await this.hold?.save(this.root, this.held); } catch { this.holdBroken = true; out = { ...out, holdBroken: true }; }
        }
      }
      if (this.guarded === 0) this.snapshot = null;
      return out;
    });
  }

  projectDir(slug: string): string {
    if (!SLUG_RE.test(slug)) throw new WorkspaceError(400, t().errors.invalidProjectId({ slug }));
    return join(this.root, slug);
  }

  async listProjects(): Promise<ProjectListItem[]> {
    const entries = await readdir(this.root, { withFileTypes: true });
    const items: ProjectListItem[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || !SLUG_RE.test(e.name)) continue;
      try {
        items.push({ slug: e.name, ok: true, project: await readJsonFile(join(this.root, e.name, 'project.json'), projectFileSchema) });
      } catch (err) {
        if (err instanceof JsonFileError && err.reason === 'missing') continue;
        items.push({ slug: e.name, ok: false, error: (err as Error).message });
      }
    }
    return items.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  async getProject(slug: string): Promise<ProjectFile> {
    const dir = this.projectDir(slug);
    try {
      return await readJsonFile(join(dir, 'project.json'), projectFileSchema);
    } catch (err) {
      if (err instanceof JsonFileError && err.reason === 'missing') throw new WorkspaceError(404, t().errors.projectNotFound({ slug }));
      throw err;
    }
  }

  async createProject(input: { name: string; description?: string }): Promise<{ slug: string; project: ProjectFile }> {
    const name = input.name.trim();
    if (!name) throw new WorkspaceError(400, t().errors.projectNameRequired);
    // Decision 790: a project in a workspace whose path (or real path) has glob characters could never run the agent safely.
    await assertAgentFolders(null, this.root);
    const { slug, dir } = await this.createLock.run('create', async () => {
      const base = slugify(name);
      for (let n = 1; ; n++) {
        const candidate = n === 1 ? base : `${base}-${n}`;
        const candidateDir = join(this.root, candidate);
        try {
          await mkdir(candidateDir);
          return { slug: candidate, dir: candidateDir };
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        }
      }
    });
    const now = new Date().toISOString();
    const project: ProjectFile = { schemaVersion: 1, name, description: input.description?.trim() ?? '', createdAt: now, updatedAt: now, linkedCodebases: [] };
    try {
      for (const d of PROJECT_DIRS) {
        await mkdir(join(dir, d), { recursive: true });
        await writeFile(join(dir, d, '.gitkeep'), '');
      }
      await mkdir(join(dir, '.studio'), { recursive: true });
      await writeFile(join(dir, '.studio', 'context.md'), CONTEXT_MD);
      await writeFile(join(dir, 'CLAUDE.md'), CLAUDE_MD);
      await writeFile(join(dir, '.gitignore'), GITIGNORE);
      await writeFile(join(dir, '.gitattributes'), GITATTRIBUTES);
      await writeJsonFileAtomic(join(dir, 'project.json'), project);
      await this.git.init(dir);
      await this.git.commitAll(dir, t().jobs.createProjectCommit({ name }));
      // The new project folder and the workspace root both gained an entry: a later tripwire must not read this as a move.
      await noteCoreChange(this.root);
      await noteCoreChange(dir);
    } catch (err) {
      // Only the folder created above: never leave a half-built project behind.
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    return { slug, project };
  }

  /** `icon` (report 44): a choice, or null to go back to the automatic icon (the field is removed). */
  updateProject(slug: string, patch: { name?: string; description?: string; linkedCodebases?: LinkedCodebase[]; icon?: ProjectIcon | null }): Promise<ProjectFile> {
    return this.projectLock.run(slug, async () => {
      const current = await this.getProject(slug);
      const linkedCodebases = patch.linkedCodebases
        ? normalizeCodebaseList(patch.linkedCodebases)
        : current.linkedCodebases;
      if (patch.linkedCodebases) await assertCodebasesOutside(linkedCodebases, [this.projectDir(slug), this.root], current.linkedCodebases);
      const merged: Record<string, unknown> = { ...current, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), linkedCodebases, updatedAt: new Date().toISOString() };
      if (patch.icon === null) delete merged.icon;
      const parsed = projectFileSchema.safeParse(merged);
      if (!parsed.success) throw new WorkspaceError(400, t().errors.invalidProject({ fields: parsed.error.issues.map((i) => i.path.join('.')).join(', ') }));
      const dir = this.projectDir(slug);
      await writeJsonFileAtomic(join(dir, 'project.json'), parsed.data);
      await this.git.commitAll(dir, t().jobs.updateProjectCommit);
      return parsed.data;
    });
  }
}

/**
 * The folder the first-run setup suggests for the workspace: `MotionStudio` in the user's home, written with the
 * platform's own separator (Windows `C:\Users\<name>\MotionStudio`). Decision 1962.
 */
export function defaultWorkspacePath(home: string = homedir(), platform: NodeJS.Platform = process.platform): string {
  return (platform === 'win32' ? win32 : posix).join(home, 'MotionStudio');
}
