// An Intel-only ffmpeg on a Mac without Rosetta: spawning it fails with EBADARCH (errno -86), possibly thrown
// synchronously by Node ("spawn Unknown system error -86"). That is "not usable", never a crash at startup.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  const execFile = ((cmd: string, args: string[], opts: unknown, cb: (e: Error | null, so?: string, se?: string) => void) => {
    if (!cmd.includes('/arm/')) throw Object.assign(new Error('spawn Unknown system error -86'), { errno: -86, code: 'Unknown system error -86' });
    if (args.includes('-version')) { cb(null, 'ffmpeg version 7.1 Copyright', ''); return undefined; }
    cb(null, '', '');
    return undefined;
  }) as unknown as typeof real.execFile;
  return { ...real, execFile };
});

const { findFfmpeg } = await import('../src/render/encode.ts');
const { execCommand, isBadArchError } = await import('../src/exec.ts');
const { execFf } = await import('../src/media/ffmpeg-exec.ts');
const { runDoctor } = await import('../src/doctor.ts');

function fakeDirs() {
  const root = mkdtempSync(join(tmpdir(), 'ms-badarch-'));
  const intel = join(root, 'intel'), arm = join(root, 'arm');
  mkdirSync(intel); mkdirSync(arm);
  writeFileSync(join(intel, 'ffmpeg'), 'x'); writeFileSync(join(arm, 'ffmpeg'), 'x');
  return { intel, arm };
}

describe('EBADARCH (no Rosetta)', () => {
  it('isBadArchError recognises errno -86 and the message', () => {
    expect(isBadArchError(Object.assign(new Error('x'), { errno: -86 }))).toBe(true);
    expect(isBadArchError(new Error('spawn Unknown system error -86'))).toBe(true);
    expect(isBadArchError(new Error('ENOENT'))).toBe(false);
  });
  it('execFf and execCommand resolve instead of throwing', async () => {
    const r = await execFf('/x/intel/ffmpeg', ['-version']);
    expect(r.code).not.toBe(0);
    const c = await execCommand('/x/intel/ffmpeg', ['-version']);
    expect(c).toMatchObject({ notFound: false, badArch: true });
    expect(c.code).not.toBe(0);
  });
  it('findFfmpeg skips the Intel-only build and uses the next directory', async () => {
    const { intel, arm } = fakeDirs();
    const info = await findFfmpeg({ PATH: `${intel}:${arm}` });
    expect(info?.path).toBe(join(arm, 'ffmpeg'));
  });
  it('findFfmpeg returns null when no build can run', async () => {
    const { intel } = fakeDirs();
    expect(await findFfmpeg({ PATH: intel })).toBeNull();
    expect(await findFfmpeg({ FFMPEG_PATH: join(intel, 'ffmpeg') })).toBeNull();
  });
  it('the doctor names the wrong architecture instead of throwing', async () => {
    const exec = async (cmd: string, args: string[]) => (cmd === 'ffmpeg'
      ? { code: -1, stdout: '', stderr: 'spawn Unknown system error -86', notFound: false, badArch: true }
      : { code: 0, stdout: cmd === 'git' ? 'git version 2.40.0' : '9.9.9 (Claude Code)', stderr: '', notFound: false, ...(args.includes('auth') ? { stdout: '{"loggedIn":true}' } : {}) });
    const checks = await runDoctor({ exec, claudeCommand: ['claude'], nodeVersion: 'v24.9.0', ffmpegInfo: async () => null });
    const ff = checks.find((c) => c.id === 'ffmpeg')!;
    expect(ff).toMatchObject({ ok: false, required: false });
    expect(ff.message).toMatch(/Intel/);
    // another build on the PATH runs: ok
    const ok = await runDoctor({ exec, claudeCommand: ['claude'], nodeVersion: 'v24.9.0', ffmpegInfo: async () => ({ arch: 'arm64', hostArch: 'arm64', translated: false, version: '7.1' }) });
    expect(ok.find((c) => c.id === 'ffmpeg')).toMatchObject({ ok: true });
  });
});
