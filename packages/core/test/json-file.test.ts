import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { JsonFileError, readJsonFile, writeJsonFileAtomic } from '../src/json-file.ts';

const schema = z.object({ schemaVersion: z.literal(1), name: z.string() });
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ms-json-')); });

describe('readJsonFile', () => {
  it('returns parsed data', async () => {
    const p = join(dir, 'a.json');
    await writeFile(p, JSON.stringify({ schemaVersion: 1, name: 'x' }));
    await expect(readJsonFile(p, schema)).resolves.toEqual({ schemaVersion: 1, name: 'x' });
  });
  it('reports a missing file', async () => {
    const err = await readJsonFile(join(dir, 'nope.json'), schema).catch((e) => e);
    expect(err).toBeInstanceOf(JsonFileError);
    expect(err.reason).toBe('missing');
  });
  it('reports invalid JSON with the path in the message', async () => {
    const p = join(dir, 'bad.json');
    await writeFile(p, '{ not json');
    const err = await readJsonFile(p, schema).catch((e) => e);
    expect(err.reason).toBe('invalid-json');
    expect(err.message).toContain(p);
  });
  it('reports schema violations naming the field', async () => {
    const p = join(dir, 'schema.json');
    await writeFile(p, JSON.stringify({ schemaVersion: 1, name: 42 }));
    const err = await readJsonFile(p, schema).catch((e) => e);
    expect(err.reason).toBe('schema');
    expect(err.message).toContain('name');
  });
});

describe('writeJsonFileAtomic', () => {
  it('creates parent folders, writes pretty JSON and leaves no temp files', async () => {
    const p = join(dir, 'nested', 'deep', 'b.json');
    await writeJsonFileAtomic(p, { a: 1 });
    expect(await readFile(p, 'utf8')).toBe('{\n  "a": 1\n}\n');
    expect(await readdir(join(dir, 'nested', 'deep'))).toEqual(['b.json']);
  });
});
