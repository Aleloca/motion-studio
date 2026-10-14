import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { assertNotRealUserData } from './app-config.ts';

const recordSchema = z.object({ schemaVersion: z.literal(1), root: z.string(), raw: z.string().nullable(), at: z.string() });

/**
 * Final wave P9, fix round 1 (I-A): the trusted content of a workspace's `.studio/settings.json` when an agent run without
 * the sandbox changed it and the core could not put it back. Kept in the core's config folder (denied to the agent), like
 * the integrity records, so the hold survives a restart: until the revert succeeds or the user saves the settings, the
 * sandbox, approval, paid-confirmation and opt-in fields come from here. `configDir` null: in memory only (tests, tools).
 */
export class SettingsHoldStore {
  private readonly memory = new Map<string, string | null>();
  constructor(private readonly configDir: string | null) { if (configDir !== null) assertNotRealUserData(configDir); }

  private async key(root: string): Promise<string> { return realpath(root).catch(() => resolve(root)); }
  private file(key: string): string | null {
    return this.configDir === null ? null : join(this.configDir, 'settings-hold', `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`);
  }

  /** The held content (`raw` null: the file did not exist), or null when nothing is held. A corrupt record holds nothing. */
  async load(root: string): Promise<{ raw: string | null } | null> {
    const key = await this.key(root);
    if (this.memory.has(key)) return { raw: this.memory.get(key)! };
    const file = this.file(key);
    if (file === null) return null;
    const text = await readFile(file, 'utf8').catch(() => null);
    if (text === null) return null;
    try {
      const rec = recordSchema.parse(JSON.parse(text));
      this.memory.set(key, rec.raw);
      return { raw: rec.raw };
    } catch { return null; }
  }

  async save(root: string, raw: string | null): Promise<void> {
    const key = await this.key(root);
    this.memory.set(key, raw);
    const file = this.file(key);
    if (file === null) return;
    await mkdir(join(this.configDir!, 'settings-hold'), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify({ schemaVersion: 1, root: key, raw, at: new Date().toISOString() })}\n`, { mode: 0o600 });
      await rename(tmp, file);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  async clear(root: string): Promise<void> {
    const key = await this.key(root);
    this.memory.delete(key);
    const file = this.file(key);
    if (file !== null) await rm(file, { force: true });
  }
}
