import { lstat, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastifyMultipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimName, sanitizeFileName, saveUploads } from '../src/library/upload.ts';
import { WorkspaceError } from '../src/workspace-store.ts';
import { multipart } from './helpers/multipart.ts';

let app: FastifyInstance;
let dir: string;
beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), 'ms-up è ')), 'assets');
  await mkdir(dir);
  app = Fastify();
  await app.register(fastifyMultipart, { limits: { fileSize: 1024, files: 3 } });
  app.setErrorHandler((err, _r, reply) => reply.status(err instanceof WorkspaceError ? err.status : 500).send({ error: (err as Error).message }));
  app.post('/up', async (req) => ({ saved: await saveUploads(req, dir) }));
});
afterEach(() => app.close());

describe('sanitizeFileName', () => {
  it.each([
    ['../../etc/passwd', 'passwd'],
    ['Logo Acme (finale).PNG', 'Logo-Acme-finale-.PNG'],
    ['..hidden', 'hidden'],
    ['', 'file'],
    ['a'.repeat(200) + '.png', 'a'.repeat(116) + '.png'],
    ['C:\\Users\\x\\logo.svg', 'logo.svg'],
    ['.png', 'file.png'],
    ['è.png', 'file.png'],
    ['日本語.svg', 'file.svg'],
    ['a.' + 'x'.repeat(200), 'a'],
    ['.' + 'x'.repeat(200), 'file'],
  ])('%s → %s', (input, out) => { expect(sanitizeFileName(input)).toBe(out); });
});

describe('saveUploads', () => {
  it('saves files with safe, unique names', async () => {
    const r = await app.inject({ method: 'POST', url: '/up', ...multipart([{ name: 'logo.png', content: 'a' }, { name: 'logo.png', content: 'b' }, { name: '../x.svg', content: 'c' }]) });
    expect(r.json().saved).toEqual(['logo.png', 'logo-2.png', 'x.svg']);
    expect(await readFile(join(dir, 'logo-2.png'), 'utf8')).toBe('b');
    expect((await readdir(dir)).sort()).toEqual(['logo-2.png', 'logo.png', 'x.svg']);
  });
  it('never writes through an existing symlink name', async () => {
    const target = join(dir, '..', 'target.txt');
    await writeFile(target, 'untouched');
    await symlink(target, join(dir, 'a.png'));
    const r = await app.inject({ method: 'POST', url: '/up', ...multipart([{ name: 'a.png', content: 'x' }]) });
    expect(r.json().saved).toEqual(['a-2.png']);
    expect(await readFile(target, 'utf8')).toBe('untouched');
    expect((await lstat(join(dir, 'a.png'))).isSymbolicLink()).toBe(true);
  });
  it('gives concurrent uploads of the same name distinct files', async () => {
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: '/up', ...multipart([{ name: 'logo.png', content: 'AAA' }]) }),
      app.inject({ method: 'POST', url: '/up', ...multipart([{ name: 'logo.png', content: 'BBB' }]) }),
    ]);
    const names = [a.json().saved[0], b.json().saved[0]];
    expect([...names].sort()).toEqual(['logo-2.png', 'logo.png']);
    expect(await readFile(join(dir, names[0]), 'utf8')).toBe('AAA');
    expect(await readFile(join(dir, names[1]), 'utf8')).toBe('BBB');
    expect((await readdir(dir)).sort()).toEqual(['logo-2.png', 'logo.png']);
  });
  it('rejects oversize files with 413 and leaves nothing behind', async () => {
    const r = await app.inject({ method: 'POST', url: '/up', ...multipart([{ name: 'ok.png', content: 'a' }, { name: 'big.png', content: Buffer.alloc(4096) }]) });
    expect(r.statusCode).toBe(413);
    expect(await readdir(dir)).toEqual([]);
  });
  it('rejects too many files with 413 and an empty request with 400', async () => {
    const many = await app.inject({ method: 'POST', url: '/up', ...multipart([1, 2, 3, 4].map((i) => ({ name: `${i}.png`, content: 'a' }))) });
    expect(many.statusCode).toBe(413);
    expect(await readdir(dir)).toEqual([]);
    const none = await app.inject({ method: 'POST', url: '/up', ...multipart([]) });
    expect(none.statusCode).toBe(400);
  });
});

describe('reserved metadata names', () => {
  it('treats assets.json / references.json (any case) as taken', async () => {
    const r = await app.inject({ method: 'POST', url: '/up', ...multipart([{ name: 'assets.json', content: 'a' }, { name: 'REFERENCES.JSON', content: 'b' }]) });
    expect(r.json().saved).toEqual(['assets-2.json', 'REFERENCES-2.JSON']);
    expect((await readdir(dir)).sort()).toEqual(['REFERENCES-2.JSON', 'assets-2.json']);
  });
});

describe('claimName without hard links', () => {
  it.each(['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS'])('falls back to an exclusive copy on %s', async (code) => {
    const tmp = join(dir, '.t.part');
    await writeFile(tmp, 'data');
    await writeFile(join(dir, 'logo.png'), 'old');
    const fail = async () => { throw Object.assign(new Error(code), { code }); };
    expect(await claimName(dir, tmp, 'logo.png', { link: fail })).toBe('logo-2.png');
    expect(await readFile(join(dir, 'logo-2.png'), 'utf8')).toBe('data');
    expect(await readFile(join(dir, 'logo.png'), 'utf8')).toBe('old');
  });
  it('rethrows other link errors', async () => {
    const tmp = join(dir, '.t.part');
    await writeFile(tmp, 'data');
    const fail = async () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); };
    await expect(claimName(dir, tmp, 'x.png', { link: fail })).rejects.toMatchObject({ code: 'EIO' });
  });
});
