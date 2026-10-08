import { randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureRunDir } from '../agent/launcher.ts';

const TOKEN_FILE = 'ui-token';
const SERVER_FILE = 'server.json';
const TOKEN_RE = /^[0-9a-f]{64}$/;

export interface ServerInfo { port: number; pid: number; startedAt: string }

const ownRegularFile = (st: { isFile(): boolean; isSymbolicLink(): boolean; uid: number }) =>
  st.isFile() && !st.isSymbolicLink() && (process.getuid === undefined || st.uid === process.getuid());

/** Reads a small private file without following a link; null when missing, not a regular file of ours, or unreadable. */
async function readPrivate(path: string): Promise<string | null> {
  const st = await lstat(path).catch(() => null);
  if (!st || !ownRegularFile(st) || st.size > 4096) return null;
  const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
  if (!fh) return null;
  try { return await fh.readFile('utf8'); } catch { return null; } finally { await fh.close().catch(() => {}); }
}

/** Writes a private (0600) file by atomic rename: a link left in its place is replaced, never followed. */
async function writePrivate(path: string, content: string): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, content, { mode: 0o600, flag: 'wx' });
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/** The UI token in `<configDir>/ui-token`, or null when missing or invalid (never followed through a link). */
export async function readUiToken(configDir: string): Promise<string | null> {
  const text = (await readPrivate(join(configDir, TOKEN_FILE)))?.trim() ?? null;
  return text && TOKEN_RE.test(text) ? text : null;
}

/** Loads the UI token, or creates a new one (32 random bytes, hex, file mode 0600) when it is missing or not trustworthy. */
export async function loadOrCreateUiToken(configDir: string): Promise<string> {
  const existing = await readUiToken(configDir);
  if (existing) return existing;
  await mkdir(configDir, { recursive: true });
  const path = join(configDir, TOKEN_FILE);
  // A link, a folder or someone else's file: removed (not followed) and replaced.
  await rm(path, { recursive: true, force: true });
  const token = randomBytes(32).toString('hex');
  await writePrivate(path, token);
  return token;
}

/** Constant-time comparison of a presented token with the expected one. */
export function tokenMatches(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string' || presented.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
}

/** Address of the UI with the token in the fragment (never sent to the server by the browser). */
export const uiUrl = (port: number, token: string) => `http://127.0.0.1:${port}/#t=${token}`;

/** `<configDir>/run/server.json`: lets `motion-studio --print-url` find the running server. */
export async function writeServerInfo(configDir: string, info: ServerInfo): Promise<void> {
  const dir = await ensureRunDir(configDir);
  await writePrivate(join(dir, SERVER_FILE), JSON.stringify(info));
}

export async function readServerInfo(configDir: string): Promise<ServerInfo | null> {
  const text = await readPrivate(join(configDir, 'run', SERVER_FILE));
  if (!text) return null;
  try {
    const v = JSON.parse(text) as Partial<ServerInfo>;
    if (Number.isInteger(v.port) && v.port! > 0 && v.port! < 65536 && Number.isInteger(v.pid) && v.pid! > 0 && typeof v.startedAt === 'string') {
      return { port: v.port!, pid: v.pid!, startedAt: v.startedAt };
    }
  } catch { /* invalid */ }
  return null;
}

/** Removes server.json only when it is this process's (a newer instance may have replaced it). */
export async function removeServerInfo(configDir: string, pid = process.pid): Promise<void> {
  const info = await readServerInfo(configDir);
  if (info?.pid === pid) await rm(join(configDir, 'run', SERVER_FILE), { force: true }).catch(() => {});
}

/** True when a process with that pid exists (EPERM: it exists but belongs to someone else). */
export function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}
