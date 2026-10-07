import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
// Side-effect-free import that loads the plugin's type augmentation (`req.files()`), also for packages that typecheck core's sources.
import type {} from '@fastify/multipart';
import type { FastifyRequest } from 'fastify';
import { WorkspaceError } from '../workspace-store.ts';

export const UPLOAD_LIMITS = { fileSize: 200 * 1024 * 1024, files: 50 };

const MAX_NAME = 120;
const MAX_EXT = 16;

const clean = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^[.-]+/, '');

export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  let s = clean(base);
  const dot = base.lastIndexOf('.');
  // Stripping left only the extension ('.png', 'è.png'): keep it under a placeholder stem.
  if (dot >= 0 && !base.slice(0, dot).includes('.') && clean(base.slice(0, dot)) === '') s = `file.${clean(base.slice(dot + 1))}`;
  let ext = extname(s);
  if (ext.length > MAX_EXT) {
    s = s.slice(0, s.length - ext.length);
    ext = '';
  }
  if (s.length > MAX_NAME) s = s.slice(0, MAX_NAME - ext.length) + ext;
  return s.replace(/\.$/, '') || 'file';
}

function candidates(name: string): (i: number) => string {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  return (i) => (i === 1 ? name : `${stem}-${i}${ext}`);
}

/** Atomically claims a free name by hard-linking the finished temp file to it (EEXIST = taken, try the next). */
async function claimName(dir: string, tmp: string, name: string): Promise<string> {
  const nth = candidates(name);
  for (let i = 1; ; i++) {
    const candidate = nth(i);
    try {
      await link(tmp, join(dir, candidate));
      return candidate;
    } catch (err) {
      if ((err as { code?: string }).code !== 'EEXIST') throw err;
    }
  }
}

export async function saveUploads(req: FastifyRequest, targetDir: string): Promise<string[]> {
  const saved: string[] = [];
  let tmp: string | null = null;
  try {
    for await (const part of req.files()) {
      tmp = join(targetDir, `.${randomBytes(6).toString('hex')}.part`);
      await pipeline(part.file, createWriteStream(tmp, { flags: 'wx' }));
      if (part.file.truncated) throw new WorkspaceError(413, `File troppo grande: ${part.filename}`);
      const name = await claimName(targetDir, tmp, sanitizeFileName(part.filename));
      saved.push(name);
      await rm(tmp, { force: true });
      tmp = null;
    }
  } catch (err) {
    if (tmp) await rm(tmp, { force: true });
    await Promise.all(saved.map((n) => rm(join(targetDir, n), { force: true })));
    if (err instanceof WorkspaceError) throw err;
    const code = (err as { code?: string }).code;
    if (code === 'FST_FILES_LIMIT' || code === 'FST_REQ_FILE_TOO_LARGE') throw new WorkspaceError(413, 'Troppi file o file troppo grandi in un solo caricamento');
    throw err;
  }
  if (saved.length === 0) throw new WorkspaceError(400, 'Nessun file ricevuto');
  return saved;
}
