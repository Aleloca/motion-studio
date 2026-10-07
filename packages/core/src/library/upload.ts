import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, rename, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type {} from '@fastify/multipart';
import type { FastifyRequest } from 'fastify';
import { WorkspaceError } from '../workspace-store.ts';

export const UPLOAD_LIMITS = { fileSize: 200 * 1024 * 1024, files: 50 };

export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  let s = base.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^[.-]+/, '');
  if (s.length > 120) {
    const ext = extname(s);
    s = s.slice(0, 120 - ext.length) + ext;
  }
  return s || 'file';
}

async function uniqueName(dir: string, name: string, taken: Set<string>): Promise<string> {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? name : `${stem}-${i}${ext}`;
    if (taken.has(candidate)) continue;
    if (!(await lstat(join(dir, candidate)).catch(() => null))) return candidate;
  }
}

export async function saveUploads(req: FastifyRequest, targetDir: string): Promise<string[]> {
  const saved: string[] = [];
  const taken = new Set<string>();
  let tmp: string | null = null;
  try {
    for await (const part of req.files()) {
      const name = await uniqueName(targetDir, sanitizeFileName(part.filename), taken);
      taken.add(name);
      tmp = join(targetDir, `.${name}.${randomBytes(4).toString('hex')}.part`);
      await pipeline(part.file, createWriteStream(tmp, { flags: 'wx' }));
      if (part.file.truncated) throw new WorkspaceError(413, `File troppo grande: ${part.filename}`);
      await rename(tmp, join(targetDir, name));
      tmp = null;
      saved.push(name);
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
