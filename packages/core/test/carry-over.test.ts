import { link, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FORMATS, type FormatPreset } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyVerified, followCheck, normalizeTargets, versionDirReady } from '../src/creatives/carry-over.ts';

const preset = (id: string) => DEFAULT_FORMATS.find((p) => p.id === id)!;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('normalizeTargets', () => {
  const formats = ['reel', 'post', 'tiktok'];
  const links = { tiktok: 'reel' };
  it('keeps brief formats, maps followers to their primary, dedupes, in brief order', () => {
    expect(normalizeTargets(['post', 'tiktok', 'reel', 'ghost'], formats, links)).toEqual(['reel', 'post']);
    expect(normalizeTargets(['tiktok'], formats, links)).toEqual(['reel']);
  });
  it('means every primary when empty, absent or only unknown formats', () => {
    expect(normalizeTargets(undefined, formats, links)).toEqual(['reel', 'post']);
    expect(normalizeTargets([], formats, links)).toEqual(['reel', 'post']);
    expect(normalizeTargets(['ghost'], formats, links)).toEqual(['reel', 'post']);
  });
});

describe('followCheck', () => {
  const reel = preset('instagram-reel-9x16');
  it('uses the real duration of the primary file (null is strict)', () => {
    expect(followCheck(reel, preset('tiktok-9x16'), { durationSec: 70 }, 1000)).toEqual({ ok: true });
    expect(followCheck(reel, preset('youtube-shorts-9x16'), { durationSec: 70 }, 1000)).toEqual({ ok: false, reason: 'duration' });
    expect(followCheck(reel, preset('youtube-shorts-9x16'), { durationSec: null }, 1000)).toEqual({ ok: false, reason: 'duration' });
    expect(followCheck(reel, preset('youtube-shorts-9x16'), { durationSec: 30 }, 1000)).toEqual({ ok: true });
  });
  it('checks the follower maxFileMB against the actual file size', () => {
    const small: FormatPreset = { ...preset('tiktok-9x16'), id: 'small', maxFileMB: 1 };
    expect(followCheck(reel, small, { durationSec: 10 }, 1_000_000)).toEqual({ ok: true });
    expect(followCheck(reel, small, { durationSec: 10 }, 1_000_001)).toEqual({ ok: false, reason: 'fileSize' });
  });
});

describe('copyVerified and versionDirReady', () => {
  let dir: string;
  let warn: ReturnType<typeof vi.spyOn>;
  afterEach(() => warn.mockRestore());
  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    dir = await mkdtemp(join(tmpdir(), 'ms-carry-'));
    await mkdir(join(dir, 'outputs', 'v1'), { recursive: true });
    await writeFile(join(dir, 'outputs', 'v1', 'a.mp4'), 'contenuto');
  });

  it('copies byte for byte, never as a hard link, and returns the hash', async () => {
    await versionDirReady(dir, 2);
    expect(await copyVerified(dir, 'outputs/v1/a.mp4', 'outputs/v2/a.mp4', sha('contenuto'))).toBe(sha('contenuto'));
    expect(await readFile(join(dir, 'outputs', 'v2', 'a.mp4'), 'utf8')).toBe('contenuto');
    expect((await stat(join(dir, 'outputs', 'v2', 'a.mp4'))).nlink).toBe(1);
    expect((await stat(join(dir, 'outputs', 'v1', 'a.mp4'))).nlink).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('never accepts the source\'s current bytes when they differ from the expected hash', async () => {
    await versionDirReady(dir, 2);
    expect(await copyVerified(dir, 'outputs/v1/a.mp4', 'outputs/v2/a.mp4', sha('vecchio'))).toBeNull();
    await expect(stat(join(dir, 'outputs', 'v2', 'a.mp4'))).rejects.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('does not match the expected content'));
  });

  it('never overwrites an existing destination', async () => {
    await versionDirReady(dir, 2);
    await writeFile(join(dir, 'outputs', 'v2', 'a.mp4'), 'agente');
    expect(await copyVerified(dir, 'outputs/v1/a.mp4', 'outputs/v2/a.mp4', sha('contenuto'))).toBeNull();
    expect(await readFile(join(dir, 'outputs', 'v2', 'a.mp4'), 'utf8')).toBe('agente');
  });

  it('refuses a symlinked or hard-linked source', async () => {
    const outside = join(await mkdtemp(join(tmpdir(), 'ms-out-')), 'secret.txt');
    await writeFile(outside, 'segreto');
    await symlink(outside, join(dir, 'outputs', 'v1', 'b.mp4'));
    await link(join(dir, 'outputs', 'v1', 'a.mp4'), join(dir, 'outputs', 'v1', 'c.mp4'));
    await versionDirReady(dir, 2);
    expect(await copyVerified(dir, 'outputs/v1/b.mp4', 'outputs/v2/b.mp4', sha('segreto'))).toBeNull();
    expect(await copyVerified(dir, 'outputs/v1/c.mp4', 'outputs/v2/c.mp4', sha('contenuto'))).toBeNull();
    await expect(stat(join(dir, 'outputs', 'v2', 'b.mp4'))).rejects.toThrow();
  });

  it('replaces a version folder that is a link, and refuses outputs/ resolving elsewhere', async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), 'ms-else-'));
    await symlink(elsewhere, join(dir, 'outputs', 'v3'));
    expect(await versionDirReady(dir, 3)).toBe(true);
    expect((await stat(join(dir, 'outputs', 'v3'))).isDirectory()).toBe(true);
    const other = await mkdtemp(join(tmpdir(), 'ms-carry2-'));
    await symlink(elsewhere, join(other, 'outputs'));
    await expect(versionDirReady(other, 1)).rejects.toThrow();
  });
});
