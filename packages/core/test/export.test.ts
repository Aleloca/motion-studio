import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VersionEntry } from '@motion-studio/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { exportPicks, exportVersion } from '../src/creatives/export.ts';

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
      if (++calls === 2) { await writeFile(t, 'par'); throw Object.assign(new Error(`ENOSPC: no space left, copyfile '${f}' -> '${t}'`), { code: 'ENOSPC', targetCreated: true }); }
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

describe('exportPicks', () => {
  const reel = 'instagram-reel-9x16';
  const tiktok = 'tiktok-9x16';
  const post = 'instagram-post-1x1';
  const presets = [
    { id: reel, channel: 'Instagram', name: 'Reel', width: 1080, height: 1920, kind: 'video' as const, extensions: ['mp4'] },
    { id: tiktok, channel: 'TikTok', name: 'Video', width: 1080, height: 1920, kind: 'video' as const, extensions: ['mp4'] },
    { id: post, channel: 'Instagram', name: 'Post', width: 1080, height: 1080, kind: 'image' as const, extensions: ['png'] },
  ];
  const out = (format: string, ext: string) => ({ format, file: `${format}.${ext}`, width: 1080, height: 1920, durationSec: 6, verified: true, preview: null });
  const ver = (n: number, outputs: VersionEntry['outputs']): VersionEntry => ({ ...version, n, outputs });
  let versions: VersionEntry[];
  const date = new Date(2026, 9, 10, 12);
  const files = (r: { files: Array<{ to: string }> }) => r.files.map((f) => f.to.split('/').pop());
  beforeEach(async () => {
    versions = [ver(3, [out(reel, 'mp4'), out(tiktok, 'mp4'), out(post, 'png')]), ver(5, [out(reel, 'mp4'), out(tiktok, 'mp4'), out(post, 'png')])];
    for (const v of versions) {
      await mkdir(join(creativeDir, 'outputs', `v${v.n}`), { recursive: true });
      for (const o of v.outputs) await writeFile(join(creativeDir, 'outputs', `v${v.n}`, o.file), `${o.format}@v${v.n}`);
    }
  });
  const base0 = () => ({ creativeDir, versions, presets, title: 'Autumn Launch', slug: 'autumn', destination: dest, now: date, pattern: '{title}-{format}-v{v}' });

  it('exports each format at its picked version with the pattern', async () => {
    const r = await exportPicks({ ...base0(), picks: { [reel]: 3, [post]: 5 }, pattern: '{title}_{channel}_{ratio}_v{v}_{date}' });
    expect(files(r)).toEqual(['autumn-launch_instagram_9x16_v3_2026-10-10.mp4', 'autumn-launch_instagram_1x1_v5_2026-10-10.png']);
    expect(await readFile(join(dest, 'autumn-launch_instagram_9x16_v3_2026-10-10.mp4'), 'utf8')).toBe(`${reel}@v3`);
  });
  it('names a follower after itself with its own file in the primary\'s picked version', async () => {
    const r = await exportPicks({ ...base0(), picks: { [reel]: 3 }, follow: [tiktok], links: { [tiktok]: reel } });
    expect(files(r)).toEqual(['autumn-launch-instagram-reel-9x16-v3.mp4', 'autumn-launch-tiktok-9x16-v3.mp4']);
    expect(await readFile(join(dest, 'autumn-launch-tiktok-9x16-v3.mp4'), 'utf8')).toBe(`${tiktok}@v3`);
  });
  it('a follower without its primary in the picks takes the primary\'s ★ (manual pick or default rule)', async () => {
    const r = await exportPicks({ ...base0(), picks: {}, follow: [tiktok], links: { [tiktok]: reel }, storedPicks: { [reel]: 3 } });
    expect(files(r)).toEqual(['autumn-launch-tiktok-9x16-v3.mp4']);
    const d = await exportPicks({ ...base0(), picks: {}, follow: [tiktok], links: { [tiktok]: reel } });
    expect(files(d)).toEqual(['autumn-launch-tiktok-9x16-v5.mp4']);
  });
  it('refuses an explicit pick for a follower (pick-follower)', async () => {
    const e = await exportPicks({ ...base0(), picks: { [tiktok]: 3 }, links: { [tiktok]: reel } }).catch((x) => x);
    expect(e).toMatchObject({ status: 400, apiCode: 'export-pick-follower' });
    expect(await readdir(base)).toEqual(['creative']);
  });
  it('refuses picks that are empty, malformed or name a version without the file', async () => {
    for (const [picks, code] of [[{}, 'export-invalid-picks'], [{ [reel]: 1.5 }, 'export-invalid-picks'], [{ [reel]: 9 }, 'export-pick-no-file'], [{ nope: 3 }, 'export-pick-no-file']] as const) {
      const e = await exportPicks({ ...base0(), picks: picks as Record<string, number> }).catch((x) => x);
      expect(e).toMatchObject({ status: 400, apiCode: code });
    }
    const f = await exportPicks({ ...base0(), picks: {}, follow: [post], links: { [tiktok]: reel } }).catch((x) => x);
    expect(f).toMatchObject({ status: 400, apiCode: 'export-invalid-picks' });
    expect(await readdir(base)).toEqual(['creative']);
  });
  it('refuses a pick whose file is missing or not a plain single-linked file, before copying anything (409)', async () => {
    await rm(join(creativeDir, 'outputs', 'v5', `${post}.png`));
    const e = await exportPicks({ ...base0(), picks: { [reel]: 5, [post]: 5 } }).catch((x) => x);
    expect(e).toMatchObject({ status: 409, apiCode: 'export-file-missing' });
    const { link } = await import('node:fs/promises');
    await link(join(creativeDir, 'outputs', 'v3', `${reel}.mp4`), join(base, 'hard'));
    const h = await exportPicks({ ...base0(), picks: { [reel]: 3 } }).catch((x) => x);
    expect(h).toMatchObject({ status: 409, apiCode: 'export-file-missing' });
    await rm(join(creativeDir, 'outputs', 'v5', `${reel}.mp4`));
    await symlink('/etc/hosts', join(creativeDir, 'outputs', 'v5', `${reel}.mp4`));
    expect(await exportPicks({ ...base0(), picks: { [reel]: 5 } }).catch((x) => x)).toMatchObject({ status: 409, apiCode: 'export-file-missing' });
    expect(await readdir(base)).toEqual(['creative', 'hard']);
  });
  it('a follower whose primary version has no file of it is refused (export-file-missing)', async () => {
    versions[0] = ver(3, [out(reel, 'mp4'), out(post, 'png')]);
    const e = await exportPicks({ ...base0(), picks: { [reel]: 3 }, follow: [tiktok], links: { [tiktok]: reel } }).catch((x) => x);
    expect(e).toMatchObject({ status: 409, apiCode: 'export-file-missing' });
  });
  it('refuses names that collide (case-insensitively) before any copy', async () => {
    const e = await exportPicks({ ...base0(), picks: { [reel]: 5, [tiktok]: 5 }, pattern: '{title}-{ratio}-v{v}' }).catch((x) => x);
    expect(e).toMatchObject({ status: 400, apiCode: 'export-name-collision' });
    expect(e.message).toContain('autumn-launch-9x16-v5.mp4');
    const c = await exportPicks({ ...base0(), picks: { [reel]: 5, [tiktok]: 5 }, pattern: 'X-{channel}', presets: [presets[0]!, { ...presets[1]!, channel: 'instagram' }] }).catch((x) => x);
    expect(c).toMatchObject({ status: 400, apiCode: 'export-name-collision' });
    expect(await readdir(base)).toEqual(['creative']);
  });
  it('refuses a pattern that renders an empty name', async () => {
    const e = await exportPicks({ ...base0(), picks: { [reel]: 5 }, pattern: '{nope}!!' }).catch((x) => x);
    expect(e).toMatchObject({ status: 400, apiCode: 'export-name-empty' });
  });
  it('never removes a destination file it did not create when a copy fails (source refused after the check)', async () => {
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, 'autumn-launch-instagram-reel-9x16-v5.mp4'), 'mine');
    const refused = async () => { throw Object.assign(new Error('The source file cannot be read safely'), { code: 'ECONFINED' }); };
    const e = await exportPicks({ ...base0(), picks: { [reel]: 5 }, copy: refused }).catch((x) => x);
    expect(e.status).toBe(500);
    expect(await readFile(join(dest, 'autumn-launch-instagram-reel-9x16-v5.mp4'), 'utf8')).toBe('mine');
    // The phase 7 path shares the same copy loop.
    await writeFile(join(dest, 'x-instagram-reel-9x16-v2.mp4'), 'mine too');
    const old = await exportVersion({ creativeDir, version, destination: dest, slug: 'x', copy: refused }).catch((x) => x);
    expect(old.status).toBe(500);
    expect(await readFile(join(dest, 'x-instagram-reel-9x16-v2.mp4'), 'utf8')).toBe('mine too');
  });
  it('the real confined copy refuses a source swapped for a symlink after the check, leaving the destination alone', async () => {
    await mkdir(dest, { recursive: true });
    const { copyConfinedFile } = await import('../src/brand/agent-guard.ts');
    const src = join(creativeDir, 'outputs', 'v5', `${reel}.mp4`);
    await rm(src);
    await symlink('/etc/hosts', src);
    const target = join(dest, 'x.mp4');
    const err = await copyConfinedFile(creativeDir, `outputs/v5/${reel}.mp4`, target).catch((x) => x);
    expect(err.code).toBe('ECONFINED');
    expect(err.targetCreated).toBeUndefined();
    await expect(readFile(target)).rejects.toThrow();
  });
  it('exports a follower at the version the client showed (follow as a record), even if the ★ changed since', async () => {
    // The dialog showed the Reel's ★ v3; the stored ★ is now v5; the Reel itself is not exported.
    const r = await exportPicks({ ...base0(), picks: {}, follow: { [tiktok]: 3 }, links: { [tiktok]: reel }, storedPicks: {} });
    expect(files(r)).toEqual(['autumn-launch-tiktok-9x16-v3.mp4']);
    expect(await readFile(join(dest, 'autumn-launch-tiktok-9x16-v3.mp4'), 'utf8')).toBe(`${tiktok}@v3`);
  });
  it('refuses a follower version that differs from its primary\'s pick, or names no version', async () => {
    const e = await exportPicks({ ...base0(), picks: { [reel]: 5 }, follow: { [tiktok]: 3 }, links: { [tiktok]: reel } }).catch((x) => x);
    expect(e).toMatchObject({ status: 400, apiCode: 'export-follow-mismatch' });
    const v = await exportPicks({ ...base0(), picks: {}, follow: { [tiktok]: 9 }, links: { [tiktok]: reel } }).catch((x) => x);
    expect(v).toMatchObject({ status: 400, apiCode: 'export-pick-no-file' });
    const bad = await exportPicks({ ...base0(), picks: {}, follow: { [tiktok]: 0 }, links: { [tiktok]: reel } }).catch((x) => x);
    expect(bad).toMatchObject({ status: 400, apiCode: 'export-invalid-picks' });
    expect(await readdir(base)).toEqual(['creative']);
  });
  it('a name taken in the destination gets -2, and a later name equal to that suffix gets its own suffix: nothing is overwritten', async () => {
    const channels = [{ ...presets[0]!, channel: 'x' }, { ...presets[1]!, channel: 'x 2' }, presets[2]!];
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, 'x.mp4'), 'mine');
    const r = await exportPicks({ ...base0(), presets: channels, picks: { [reel]: 5, [tiktok]: 5 }, pattern: '{channel}' });
    expect(files(r)).toEqual(['x-2.mp4', 'x-2-2.mp4']);
    expect(await readFile(join(dest, 'x.mp4'), 'utf8')).toBe('mine');
    expect(await readFile(join(dest, 'x-2.mp4'), 'utf8')).toBe(`${reel}@v5`);
    expect(await readFile(join(dest, 'x-2-2.mp4'), 'utf8')).toBe(`${tiktok}@v5`);
  });
  it('uses the date the client previewed when given', async () => {
    const r = await exportPicks({ ...base0(), now: '2025-12-31', picks: { [reel]: 5 }, pattern: '{date}-{format}' });
    expect(files(r)).toEqual(['2025-12-31-instagram-reel-9x16.mp4']);
  });
  it('keeps the safety rules: no overwrite, destinations inside the workspace refused', async () => {
    await exportPicks({ ...base0(), picks: { [reel]: 5 } });
    const again = await exportPicks({ ...base0(), picks: { [reel]: 5 } });
    expect(files(again)).toEqual(['autumn-launch-instagram-reel-9x16-v5-2.mp4']);
    const ws = join(base, 'ws');
    const e = await exportPicks({ ...base0(), destination: join(ws, 'x'), forbiddenRoot: ws, picks: { [reel]: 5 } }).catch((x) => x);
    expect(e.status).toBe(400);
  });
});
