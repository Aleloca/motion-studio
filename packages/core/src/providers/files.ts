import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { claimName, sanitizeFileName } from '../library/upload.ts';

export type GeneratedDir = 'generated' | 'audio' | 'stock' | 'fonts';

export async function saveGeneratedFile(projectDir: string, dir: GeneratedDir, name: string, bytes: Buffer): Promise<string> {
  const target = join(projectDir, 'assets', dir);
  await mkdir(target, { recursive: true });
  const clean = sanitizeFileName(name);
  const tmp = join(target, `.${clean}.${randomBytes(4).toString('hex')}.part`);
  try {
    await writeFile(tmp, bytes, { flag: 'wx' });
    return `${dir}/${await claimName(target, tmp, clean)}`;
  } finally {
    await rm(tmp, { force: true });
  }
}
