import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { workspaceSettingsSchema, type WorkspaceSettings } from '@motion-studio/shared';
import { assertNotRealUserData } from './app-config.ts';

/**
 * Final wave P9 (fix rounds 1–2, Ruling AA): the workspace settings fields that matter for safety or spending. While a
 * change an unsandboxed agent made cannot be undone, each of them is the STRICTER of the trusted value and the file's; the
 * other fields (theme, expert mode, export pattern) are cosmetic and come from the file.
 */
export const HELD_FIELDS = ['sandboxMode', 'autoApproveSandboxed', 'confirmPaidProviders', 'agentLiveInput', 'agentInterrupt', 'extraAllowedDomains', 'model', 'maxConcurrentJobs'] as const;
export type HeldSettings = Pick<WorkspaceSettings, (typeof HELD_FIELDS)[number]>;

export const heldOf = (s: WorkspaceSettings): HeldSettings => ({
  sandboxMode: s.sandboxMode, autoApproveSandboxed: s.autoApproveSandboxed, confirmPaidProviders: s.confirmPaidProviders,
  agentLiveInput: s.agentLiveInput, agentInterrupt: s.agentInterrupt, extraAllowedDomains: [...s.extraAllowedDomains],
  model: s.model, maxConcurrentJobs: s.maxConcurrentJobs,
});

/**
 * The stricter of two held sets, field by field: the sandbox on, approvals asked, paid calls confirmed, opt-ins off, only
 * the domains both allow, the fewer concurrent jobs, and the model only when both agree (else the CLI default). Whatever
 * either side says, the result is never looser than the other: a forged hold record can only restrict.
 */
export function tightenHeld(a: HeldSettings, b: HeldSettings): HeldSettings {
  return {
    sandboxMode: a.sandboxMode === 'auto' || b.sandboxMode === 'auto' ? 'auto' : 'off',
    autoApproveSandboxed: a.autoApproveSandboxed && b.autoApproveSandboxed,
    confirmPaidProviders: a.confirmPaidProviders || b.confirmPaidProviders,
    agentLiveInput: a.agentLiveInput && b.agentLiveInput,
    agentInterrupt: a.agentInterrupt && b.agentInterrupt,
    extraAllowedDomains: a.extraAllowedDomains.filter((d) => b.extraAllowedDomains.includes(d)),
    model: a.model === b.model ? a.model : null,
    maxConcurrentJobs: Math.min(a.maxConcurrentJobs, b.maxConcurrentJobs),
  };
}

const heldSchema = workspaceSettingsSchema.pick({
  sandboxMode: true, autoApproveSandboxed: true, confirmPaidProviders: true, agentLiveInput: true, agentInterrupt: true,
  extraAllowedDomains: true, model: true, maxConcurrentJobs: true,
});
const recordSchema = z.object({ schemaVersion: z.literal(2), root: z.string(), held: heldSchema, at: z.string() });

/** The hold record could not be read or written: the hold is not reliable (loud: doctor row, unsandboxed runs refused). */
export class SettingsHoldError extends Error {}

/** A folder or file of ours, made private again (a mode the agent changed); BSD flags such as `uchg` are not cleared. */
export async function ownMode(path: string, mode: number): Promise<void> {
  const st = await lstat(path).catch(() => null);
  if (!st || st.isSymbolicLink() || (process.getuid !== undefined && st.uid !== process.getuid())) return;
  if ((st.mode & 0o777) !== mode) await chmod(path, mode).catch(() => {});
}

/**
 * Final wave P9 (Ruling AA): the held values of a workspace's settings while an agent change to `.studio/settings.json`
 * could not be undone. Kept in the core's config folder so the hold survives a restart. With the sandbox off the agent
 * runs with the user's file access and can reach this folder too: the hold is best-effort DETECTION, not a boundary. It is
 * tighten-only (never written into settings.json as such, only used to keep the stricter value), and a failure to read or
 * write it throws `SettingsHoldError` (the caller makes it loud). `configDir` null: in memory only (tests, tools).
 */
export class SettingsHoldStore {
  private readonly memory = new Map<string, HeldSettings>();
  constructor(private readonly configDir: string | null) { if (configDir !== null) assertNotRealUserData(configDir); }

  private async key(root: string): Promise<string> { return realpath(root).catch(() => resolve(root)); }
  private dir(): string | null { return this.configDir === null ? null : join(this.configDir, 'settings-hold'); }
  private file(key: string): string | null {
    const dir = this.dir();
    return dir === null ? null : join(dir, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`);
  }

  /** The held values, or null when nothing is held. Throws `SettingsHoldError` when a record exists but cannot be read. */
  async load(root: string): Promise<HeldSettings | null> {
    const key = await this.key(root);
    const mem = this.memory.get(key);
    if (mem) return mem;
    const file = this.file(key);
    if (file === null) return null;
    await ownMode(this.dir()!, 0o700);
    await ownMode(file, 0o600);
    let text: string;
    try { text = await readFile(file, 'utf8'); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new SettingsHoldError(`settings hold unreadable: ${(e as Error).message}`);
    }
    let data: unknown = null;
    try { data = JSON.parse(text); } catch { /* corrupt */ }
    const parsed = recordSchema.safeParse(data);
    if (!parsed.success) throw new SettingsHoldError('settings hold record is corrupt');
    this.memory.set(key, parsed.data.held);
    return parsed.data.held;
  }

  /** Throws `SettingsHoldError` when it cannot be written (the hold then lives in memory only, and the caller says so). */
  async save(root: string, held: HeldSettings): Promise<void> {
    const key = await this.key(root);
    this.memory.set(key, held);
    const file = this.file(key);
    if (file === null) return;
    const dir = this.dir()!;
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await ownMode(dir, 0o700);
      await writeFile(tmp, `${JSON.stringify({ schemaVersion: 2, root: key, held, at: new Date().toISOString() })}\n`, { mode: 0o600 });
      await rename(tmp, file);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw new SettingsHoldError(`settings hold not saved: ${(err as Error).message}`);
    }
  }

  async clear(root: string): Promise<void> {
    const key = await this.key(root);
    this.memory.delete(key);
    const file = this.file(key);
    if (file === null) return;
    await ownMode(this.dir()!, 0o700);
    try { await rm(file, { force: true }); } catch (err) { throw new SettingsHoldError(`settings hold not cleared: ${(err as Error).message}`); }
  }

  /**
   * Whether the hold folder can be used: missing, or a folder of ours we can write (its mode is restored first). A folder
   * the agent locked (e.g. `chflags uchg`) or replaced cannot hold anything: the caller makes that loud.
   */
  async usable(): Promise<boolean> {
    const dir = this.dir();
    if (dir === null) return true;
    const st = await lstat(dir).catch(() => null);
    if (!st) return true;
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
    await ownMode(dir, 0o700);
    const probe = join(dir, `.probe-${randomBytes(6).toString('hex')}`);
    try { await writeFile(probe, ''); await rm(probe, { force: true }); return true; } catch { return false; }
  }
}
