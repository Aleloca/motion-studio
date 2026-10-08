import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { z } from 'zod';
import { t } from './i18n.ts';

export type JsonFileErrorReason = 'missing' | 'invalid-json' | 'schema';

export class JsonFileError extends Error {
  constructor(public readonly path: string, public readonly reason: JsonFileErrorReason, detail: string) {
    super(`${path}: ${detail}`);
    this.name = 'JsonFileError';
  }
}

export async function readJsonFile<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new JsonFileError(path, 'missing', t().errors.fileNotFound);
    throw e;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new JsonFileError(path, 'invalid-json', t().errors.invalidJson({ detail: (e as Error).message }));
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || t().errors.rootPath}: ${i.message}`)
      .join('; ');
    throw new JsonFileError(path, 'schema', t().errors.invalidContent({ detail }));
  }
  return parsed.data;
}

export async function writeJsonFileAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => { /* never created or already gone */ });
    throw err;
  }
}
