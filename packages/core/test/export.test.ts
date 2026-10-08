import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VersionEntry } from '@motion-studio/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { exportVersion } from '../src/creatives/export.ts';

let base: string;
let creativeDir: string;
let dest: string;
const version: VersionEntry = {
  n: 2, commit: 'c', sessionId: 's', status: 'complete', createdAt: '2026-10-08T10:00:00.000Z', request: 'r', problems: [], tools: [], renderCommand: null, basedOn: null,
  outputs: [
    { format: 'instagram-reel-9x16', file: 'instagram-reel-9x16.mp4', width: 1080, height: 1920, durationSec: 6, verified: true, preview: null },
    { format: 'web-banner-300x250', file: 'web-banner-300x250.png', width: 300, height: 250, durationSec: null, verified: true, preview: null },
  ],
};
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ms-exp è '));
  creativeDir = join(base, 'creative');
  dest = join(base, 'Consegna cliente');
  await mkdir(join(creativeDir, 'outputs', 'v2'), { recursive: true });
  await writeFile(join(creativeDir, 'outputs', 'v2', 'instagram-reel-9x16.mp4'), 'video');
  await writeFile(join(creativeDir, 'outputs', 'v2', 'web-banner-300x250.png'), 'png');
});

describe('exportVersion', () => {
  it('copies outputs with channel names and never overwrites', async () => {
    const a = await exportVersion({ creativeDir, version, destination: dest, slug: 'lancio' });
    expect(a.files.map((f) => f.to.split('/').pop())).toEqual(['lancio-instagram-reel-9x16-v2.mp4', 'lancio-web-banner-300x250-v2.png']);
    const b = await exportVersion({ creativeDir, version, destination: dest, slug: 'lancio' });
    expect(b.files[0]!.to.endsWith('lancio-instagram-reel-9x16-v2-2.mp4')).toBe(true);
    expect((await readdir(dest)).length).toBe(4);
    expect(await readFile(join(dest, 'lancio-web-banner-300x250-v2.png'), 'utf8')).toBe('png');
  });
  it('exports only the selected formats, de-duplicated', async () => {
    const r = await exportVersion({ creativeDir, version, destination: dest, slug: 'x', formats: ['web-banner-300x250', 'web-banner-300x250'] });
    expect(r.files.map((f) => f.to.split('/').pop())).toEqual(['x-web-banner-300x250-v2.png']);
  });
  it('rejects unknown, absent and empty format selections with 400', async () => {
    for (const formats of [['instagram-post-1x1'], ['nope'], []]) {
      const e = await exportVersion({ creativeDir, version, destination: dest, slug: 'x', formats }).catch((x) => x);
      expect(e.status).toBe(400);
    }
    expect(await readdir(base)).toEqual(['creative']);
  });
  it('names files from the creative title slug, limited to 40 characters', async () => {
    const v3 = { ...version, n: 3 };
    await mkdir(join(creativeDir, 'outputs', 'v3'), { recursive: true });
    await writeFile(join(creativeDir, 'outputs', 'v3', 'instagram-reel-9x16.mp4'), 'video');
    const r = await exportVersion({ creativeDir, version: { ...v3, outputs: [version.outputs[0]!] }, destination: dest, slug: 'folder', title: 'A crime a week' });
    expect(r.files[0]!.to.split('/').pop()).toBe('a-crime-a-week-instagram-reel-9x16-v3.mp4');
    const long = await exportVersion({ creativeDir, version: { ...v3, outputs: [version.outputs[0]!] }, destination: dest, slug: 'folder', title: `${'abcd '.repeat(12)}end` });
    const name = long.files[0]!.to.split('/').pop()!;
    expect(name.startsWith('abcd-'.repeat(8).slice(0, 39))).toBe(true);
    expect(name).not.toContain('--');
    expect(name.endsWith('-instagram-reel-9x16-v3.mp4')).toBe(true);
    expect(name.length).toBeLessThanOrEqual(40 + '-instagram-reel-9x16-v3.mp4'.length);
  });
  it('falls back to the folder slug when the title has no usable characters', async () => {
    const r = await exportVersion({ creativeDir, version, destination: dest, slug: 'folder', title: '  !!! ' });
    expect(r.files[0]!.to.split('/').pop()).toBe('folder-instagram-reel-9x16-v2.mp4');
  });
  it('rejects relative destinations and files', async () => {
    expect((await exportVersion({ creativeDir, version, destination: 'rel/dir', slug: 'x' }).catch((e) => e)).status).toBe(400);
    await writeFile(dest, 'x');
    expect((await exportVersion({ creativeDir, version, destination: dest, slug: 'x' }).catch((e) => e)).status).toBe(400);
  });
  it('skips symlinked outputs and fails when nothing is exportable', async () => {
    const lonely = { ...version, outputs: [{ ...version.outputs[0]!, file: 'leak.mp4' }] };
    await symlink('/etc/hosts', join(creativeDir, 'outputs', 'v2', 'leak.mp4'));
    expect((await exportVersion({ creativeDir, version: lonely, destination: dest, slug: 'x' }).catch((e) => e)).status).toBe(404);
  });
  it('keeps target names inside the destination whatever the format or slug', async () => {
    const evil = { ...version, outputs: [{ ...version.outputs[0]!, format: 'x/../../y' }, { ...version.outputs[0]!, format: '../..' }] };
    const r = await exportVersion({ creativeDir, version: evil, destination: dest, slug: '../s/..' });
    for (const f of r.files) expect(join(f.to, '..')).toBe(dest);
    expect(await readdir(base)).toEqual(['Consegna cliente', 'creative']);
    expect((await readdir(dest)).length).toBe(2);
  });
  it('reports skipped outputs by name', async () => {
    const more = { ...version, outputs: [...version.outputs, { ...version.outputs[0]!, file: 'missing.mp4' }, { ...version.outputs[0]!, file: '../x.mp4' }] };
    const r = await exportVersion({ creativeDir, version: more, destination: dest, slug: 'x' });
    expect(r.files).toHaveLength(2);
    expect(r.skipped).toEqual(['missing.mp4', '../x.mp4']);
  });
  it('turns a mid-way copy failure into a readable error and removes the partial target', async () => {
    const { copyFile } = await import('node:fs/promises');
    let calls = 0;
    const copy = async (f: string, t: string, m: number) => {
      if (++calls === 2) { await writeFile(t, 'par'); throw Object.assign(new Error(`ENOSPC: no space left, copyfile '${f}' -> '${t}'`), { code: 'ENOSPC' }); }
      await copyFile(f, t, m);
    };
    const err = await exportVersion({ creativeDir, version, destination: dest, slug: 'x', copy }).catch((e) => e);
    expect(err.status).toBe(500);
    expect(err.message).toBe(`Esportazione interrotta: spazio su disco esaurito. File già copiati: 1 in ${dest}`);
    expect(err.message).not.toContain(creativeDir);
    expect(await readdir(dest)).toEqual(['x-instagram-reel-9x16-v2.mp4']);
  });
  it('skips output names that are not plain file names', async () => {
    await writeFile(join(creativeDir, 'secret.mp4'), 'secret');
    const evil = { ...version, outputs: [{ ...version.outputs[0]!, file: '../../secret.mp4' }, { ...version.outputs[0]!, file: 'sub/x.mp4' }, { ...version.outputs[0]!, file: '..' }] };
    expect((await exportVersion({ creativeDir, version: evil, destination: dest, slug: 'x' }).catch((e) => e)).status).toBe(404);
  });
  it('skips files whose real path escapes the version outputs folder', async () => {
    const outside = join(base, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'instagram-reel-9x16.mp4'), 'stolen');
    await rm(join(creativeDir, 'outputs', 'v2'), { recursive: true });
    await symlink(outside, join(creativeDir, 'outputs', 'v2'));
    expect((await exportVersion({ creativeDir, version, destination: dest, slug: 'x' }).catch((e) => e)).status).toBe(404);
  });
  it('refuses a destination inside the forbidden root, also through symlinks', async () => {
    const ws = join(base, 'ws');
    await mkdir(ws);
    const link = join(base, 'link');
    await symlink(ws, link);
    for (const d of [join(ws, 'nuova'), ws, join(link, 'nuova')]) {
      const err = await exportVersion({ creativeDir, version, destination: d, slug: 'x', forbiddenRoot: ws }).catch((e) => e);
      expect(err.status).toBe(400);
      expect(err.message).toBe('Scegli una cartella fuori dal workspace di Motion Studio');
    }
    expect(await readdir(ws)).toEqual([]);
  });
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports a non-writable destination', async () => {
    await mkdir(dest);
    await chmod(dest, 0o500);
    const err = await exportVersion({ creativeDir, version, destination: dest, slug: 'x' }).catch((e) => e);
    await chmod(dest, 0o700);
    expect(err.status).toBe(400);
  });
});
