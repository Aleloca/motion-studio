import { randomBytes } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CftError, extractZip, streamDownload } from '../render/cft-download.ts';
import { ffmpegBinDir } from './tool-path.ts';

/**
 * User report 91: FFmpeg for a non-technical user, with one click (after a confirmation that names what is downloaded and
 * from where). A pinned static build, checked against its SHA-256 before anything is extracted, goes into Motion Studio's
 * own data folder (`<configDir>/tools/ffmpeg/bin`): no administrator rights, no package manager, nothing else on the
 * computer changes. The app finds it there (setup/tool-path.ts appends that folder to its PATH).
 *
 * Sources (the checksums were read from the publishers' own pages, 2026-10-27):
 * - Windows (x64; Windows on Arm runs it emulated): Gyan Doshi's "release essentials" build, from the GitHub mirror of
 *   gyan.dev (github.com/GyanD/codexffmpeg), one zip holding ffmpeg.exe and ffprobe.exe. GPLv3.
 * - macOS (arm64, x64) and Linux (x64, arm64): Martin Riedl's release builds (ffmpeg.martin-riedl.de), one zip for ffmpeg
 *   and one for ffprobe; old releases stay at the same address. They include x264 and x265, so they are GPL builds.
 */

export interface FfmpegArchive { url: string; sha256: string; sizeBytes: number }
export interface FfmpegBuild {
  version: string;
  /** Who publishes it, as the confirmation names it. */
  source: string;
  license: string;
  archives: FfmpegArchive[];
}

const GITHUB_ASSET_HOSTS = ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'] as const;
export const FFMPEG_MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024;

const riedl = (path: string, ffmpeg: [string, number], ffprobe: [string, number]): FfmpegBuild => ({
  version: '9.0.2', source: 'ffmpeg.martin-riedl.de', license: 'GPL',
  archives: [
    { url: `https://ffmpeg.martin-riedl.de/download/${path}/ffmpeg.zip`, sha256: ffmpeg[0], sizeBytes: ffmpeg[1] },
    { url: `https://ffmpeg.martin-riedl.de/download/${path}/ffprobe.zip`, sha256: ffprobe[0], sizeBytes: ffprobe[1] },
  ],
});

/** The pinned builds, keyed `platform/arch` (arch as `hostArch()` names it). */
export const FFMPEG_BUILDS: Readonly<Record<string, FfmpegBuild>> = {
  'win32/x86_64': {
    version: '9.0.2', source: 'gyan.dev', license: 'GPLv3',
    archives: [{
      url: 'https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip',
      sha256: '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba', sizeBytes: 114_768_076,
    }],
  },
  'darwin/arm64': riedl('macos/arm64/1789931890_9.0.2',
    ['c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924', 28_395_699],
    ['fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6', 28_317_701]),
  'darwin/x86_64': riedl('macos/amd64/1789931006_9.0.2',
    ['7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4', 33_816_391],
    ['2322438ed2f6319a691291b247d09c69dcaa3a982460d1f269a7e1af335cfdfd', 33_719_233]),
  'linux/x86_64': riedl('linux/amd64/1789931100_9.0.2',
    ['fa8ecf4abbd290d98f7d188b8649cc6b391ae209a98452be955a15aab1909d7f', 33_326_445],
    ['3f428c49070be3d24ec338602b76d412e401ffcb8a5641ef0e729181a232fc32', 33_223_234]),
  'linux/arm64': riedl('linux/arm64/1789931697_9.0.2',
    ['93a76ae90db5474eecdf951a729857c64f3de23567228d6a7d5e6e8e3cd1021b', 28_753_826],
    ['bcbe80fb741c180083327afaf5434812e006b33cacde2016b9aeaf6936128330', 28_655_683]),
};

/** The build for this computer (Windows on Arm gets the x64 one, which Windows runs emulated), or null. */
export function ffmpegBuildFor(platform: NodeJS.Platform, arch: string): FfmpegBuild | null {
  const a = arch === 'x64' ? 'x86_64' : arch;
  if (platform === 'win32') return FFMPEG_BUILDS['win32/x86_64']!;
  return FFMPEG_BUILDS[`${platform}/${a}`] ?? null;
}

export const ffmpegBuildSize = (b: FfmpegBuild) => b.archives.reduce((n, a) => n + a.sizeBytes, 0);

/** The first regular file named `name` under `dir` (depth-first, a few levels: the archives keep it in `bin/` or at the top). */
async function findFile(dir: string, name: string, depth = 4): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) if (e.isFile() && e.name === name) return join(dir, e.name);
  if (depth === 0) return null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const hit = await findFile(join(dir, e.name), name, depth - 1);
    if (hit) return hit;
  }
  return null;
}

export interface InstallFfmpegOptions {
  configDir: string;
  build: FfmpegBuild;
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  onProgress?: (p: { bytes: number; total: number }) => void;
}

/**
 * Downloads the archives (exact size, SHA-256, GitHub's asset hosts as the only redirects), extracts them with the checked
 * zip reader, and puts ffmpeg and ffprobe in `<configDir>/tools/ffmpeg/bin` (replaced only once both are ready). Returns
 * that folder. Nothing is left behind on failure.
 */
export async function installFfmpeg(o: InstallFfmpegOptions): Promise<string> {
  const platform = o.platform ?? process.platform;
  const exe = (n: string) => (platform === 'win32' ? `${n}.exe` : n);
  const bin = ffmpegBinDir(o.configDir);
  const root = dirname(bin);
  await mkdir(root, { recursive: true });
  const id = randomBytes(8).toString('hex');
  const work = join(root, `.work-${id}`);
  const staged = join(root, `.bin-${id}`);
  const total = ffmpegBuildSize(o.build);
  let before = 0;
  try {
    await mkdir(work);
    await mkdir(staged);
    for (const [i, a] of o.build.archives.entries()) {
      const zip = join(work, `${i}.zip`);
      await streamDownload({
        url: a.url, dest: zip, expectedBytes: a.sizeBytes, maxBytes: FFMPEG_MAX_DOWNLOAD_BYTES, sha256: a.sha256,
        allowRedirectHosts: GITHUB_ASSET_HOSTS,
        ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}), ...(o.signal ? { signal: o.signal } : {}),
        onProgress: (p) => o.onProgress?.({ bytes: before + p.bytes, total }),
      });
      before += a.sizeBytes;
      const out = join(work, String(i));
      await mkdir(out);
      await extractZip(zip, out);
      await rm(zip, { force: true });
    }
    for (const name of ['ffmpeg', 'ffprobe']) {
      const found = await findFile(work, exe(name));
      if (!found) throw new CftError('noExecutable', `the archive has no ${exe(name)}`);
      const to = join(staged, exe(name));
      await copyFile(found, to);
      if (platform !== 'win32') await chmod(to, 0o755);
    }
    if (await lstat(bin).catch(() => null)) await rm(bin, { recursive: true, force: true });
    await rename(staged, bin);
    return bin;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
    await rm(staged, { recursive: true, force: true }).catch(() => {});
  }
}
