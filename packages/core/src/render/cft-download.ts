import { createHash, randomBytes } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, symlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32, createInflateRaw } from 'node:zlib';
import { hostArch } from './arch.ts';

/**
 * Chrome for Testing (chrome-headless-shell), on demand only (spec §5.3; global constraints): the CLI's fallback when no
 * system Chrome is found. Nothing here runs without `consent: true`, which only the UI passes after showing the size
 * (Task 8). It is never bundled nor redistributed, and goes to `<appData>/chromium/<version>/`.
 *
 * - The manifest endpoint is configurable (tests use a fake local server); the default is Google's official JSON.
 * - The download URL must be `https:` (plain `http:` only on loopback, for tests), its size must match the
 *   `Content-Length` and the size shown to the user, and it is capped.
 * - The zip is read by our own reader, which refuses before writing anything: absolute paths, `..`, backslashes, drive
 *   letters, NUL, encrypted or ZIP64 entries, symlinks with an absolute target or any `..`, entries under a symlink, a
 *   declared size exceeded while inflating, a CRC mismatch, too many entries or too many bytes. Files are created with
 *   `O_EXCL | O_NOFOLLOW`; symlinks are created last.
 * - It is extracted into a staging folder and renamed into place only when complete.
 */

export const CFT_ENDPOINT = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';
export const CFT_PRODUCT = 'chrome-headless-shell';
export const CFT_MAX_DOWNLOAD_BYTES = 400 * 1024 * 1024;
const MAX_UNZIPPED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_NAME = 1024;
const VERSION_RE = /^\d{1,5}\.\d{1,5}\.\d{1,6}\.\d{1,6}$/;

export type CftPlatform = 'mac-arm64' | 'mac-x64' | 'linux64' | 'win64' | 'win32';

export class CftError extends Error {
  constructor(readonly code: 'consentRequired' | 'unsupportedPlatform' | 'badManifest' | 'badUrl' | 'download' | 'sizeMismatch' | 'tooLarge' | 'unsafeArchive' | 'badArchive' | 'noExecutable' | 'hashMismatch', message: string) {
    super(message);
    this.name = 'CftError';
  }
}

/**
 * The Chrome for Testing platform for `platform`/`arch`. Callers pass the machine's architecture (`hostArch()`): Apple
 * Silicon is `mac-arm64` even when Node itself runs under Rosetta. The download and the lookup both use it.
 */
export function cftPlatform(platform: NodeJS.Platform, arch: string): CftPlatform {
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (platform === 'linux' && (arch === 'x64' || arch === 'x86_64')) return 'linux64';
  if (platform === 'win32') return arch === 'ia32' ? 'win32' : 'win64';
  throw new CftError('unsupportedPlatform', `Chrome for Testing has no build for ${platform}/${arch}`);
}

export const cftExecutableRel = (platform: CftPlatform) => `${CFT_PRODUCT}-${platform}/${CFT_PRODUCT}${platform.startsWith('win') ? '.exe' : ''}`;

/** What the UI shows before asking for consent: the size is always known (a download of unknown size is never offered). */
export interface CftDownloadInfo { version: string; platform: CftPlatform; url: string; sizeBytes: number }

function checkUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new CftError('badUrl', 'not a URL'); }
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
  if (u.username || u.password || !(u.protocol === 'https:' || (u.protocol === 'http:' && loopback))) throw new CftError('badUrl', `refused URL: ${u.origin}`);
  return u;
}

type FetchLike = typeof fetch;

/** Reads the manifest and the download size (a HEAD request). No consent needed: nothing is downloaded but metadata. */
export async function cftDownloadInfo(o: { endpoint?: string; channel?: string; platform?: CftPlatform; fetchImpl?: FetchLike; signal?: AbortSignal } = {}): Promise<CftDownloadInfo> {
  const f = o.fetchImpl ?? fetch;
  const endpoint = checkUrl(o.endpoint ?? CFT_ENDPOINT);
  const platform = o.platform ?? cftPlatform(process.platform, await hostArch());
  const res = await f(endpoint, { signal: o.signal, redirect: 'error' }).catch((e: Error) => { throw new CftError('download', `manifest: ${e.message}`); });
  if (!res.ok) throw new CftError('download', `manifest: HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > 4 * 1024 * 1024) throw new CftError('badManifest', 'manifest too large');
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new CftError('badManifest', 'manifest is not JSON'); }
  const ch = (data as { channels?: Record<string, { version?: unknown; downloads?: Record<string, unknown> }> })?.channels?.[o.channel ?? 'Stable'];
  const version = ch?.version;
  const list = ch?.downloads?.[CFT_PRODUCT];
  if (typeof version !== 'string' || !VERSION_RE.test(version) || !Array.isArray(list)) throw new CftError('badManifest', 'no version or downloads');
  const entry = list.find((d: unknown) => (d as { platform?: unknown })?.platform === platform) as { url?: unknown } | undefined;
  if (typeof entry?.url !== 'string') throw new CftError('badManifest', `no download for ${platform}`);
  const url = checkUrl(entry.url).href;
  const head = await f(url, { method: 'HEAD', signal: o.signal, redirect: 'error' }).catch(() => null);
  const len = Number(head?.ok ? head.headers.get('content-length') : NaN);
  // The user must see the size before agreeing (Task 8): no size, no offer.
  if (!Number.isSafeInteger(len) || len <= 0) throw new CftError('sizeMismatch', 'the download size is unknown');
  return { version, platform, url, sizeBytes: len };
}

/** The newest installed Chrome for Testing under `<appDataDir>/chromium/`, or null. */
export async function findInstalledCft(appDataDir: string, platformArg?: CftPlatform): Promise<{ exe: string; version: string } | null> {
  const platform = platformArg ?? cftPlatform(process.platform, await hostArch());
  const root = join(appDataDir, 'chromium');
  const versions = (await readdir(root).catch(() => [] as string[])).filter((v) => VERSION_RE.test(v))
    .sort((a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return y[i]! - x[i]!; return 0; });
  for (const version of versions) {
    const exe = join(root, version, ...cftExecutableRel(platform).split('/'));
    const st = await lstat(exe).catch(() => null);
    if (st?.isFile()) return { exe, version };
  }
  return null;
}

export interface InstallCftOptions {
  /** Must be exactly `true`: the user agreed after seeing the size (Task 8). */
  consent: boolean;
  /** The app data folder (`<appData>/chromium/<version>/`). */
  appDataDir: string;
  /** What the user agreed to (from `cftDownloadInfo`, size included); fetched when missing. The download must have exactly that size. */
  info?: CftDownloadInfo;
  endpoint?: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  maxBytes?: number;
  onProgress?: (p: { bytes: number; total: number | null }) => void;
}

/** Downloads and installs chrome-headless-shell (see the module comment). Returns its executable and version. */
export async function installCft(o: InstallCftOptions): Promise<{ exe: string; version: string }> {
  if (o.consent !== true) throw new CftError('consentRequired', 'Chrome for Testing is downloaded only after the user agrees');
  const info = o.info ?? await cftDownloadInfo({ endpoint: o.endpoint, fetchImpl: o.fetchImpl, signal: o.signal });
  if (!VERSION_RE.test(info.version)) throw new CftError('badManifest', 'bad version');
  if (!Number.isSafeInteger(info.sizeBytes) || info.sizeBytes <= 0) throw new CftError('sizeMismatch', 'the size shown to the user is unknown');
  const root = join(o.appDataDir, 'chromium');
  const target = join(root, info.version);
  const exeRel = cftExecutableRel(info.platform);
  const existing = await lstat(join(target, ...exeRel.split('/'))).catch(() => null);
  if (existing?.isFile()) return { exe: join(target, ...exeRel.split('/')), version: info.version };
  await mkdir(root, { recursive: true });
  const id = randomBytes(8).toString('hex');
  const zipPath = join(root, `.download-${id}.zip`);
  const staging = join(root, `.staging-${id}`);
  try {
    await download(checkUrl(info.url).href, zipPath, { ...o, expected: info.sizeBytes });
    await mkdir(staging);
    await extractZip(zipPath, staging);
    const exe = await lstat(join(staging, ...exeRel.split('/'))).catch(() => null);
    if (!exe?.isFile()) throw new CftError('noExecutable', `the archive has no ${exeRel}`);
    if (existsSync(target)) await rm(target, { recursive: true, force: true });
    await rename(staging, target);
    return { exe: join(target, ...exeRel.split('/')), version: info.version };
  } finally {
    await rm(zipPath, { force: true });
    await rm(staging, { recursive: true, force: true });
  }
}

async function download(url: string, to: string, o: InstallCftOptions & { expected: number }): Promise<void> {
  await streamDownload({ url, dest: to, expectedBytes: o.expected, maxBytes: o.maxBytes ?? CFT_MAX_DOWNLOAD_BYTES, ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}), ...(o.signal ? { signal: o.signal } : {}), ...(o.onProgress ? { onProgress: o.onProgress } : {}) });
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
/** At most this many redirects are followed (only with `allowRedirectHosts`). */
const MAX_REDIRECT_HOPS = 3;

export interface StreamDownloadOptions {
  url: string;
  /** The exact size the user agreed to: the server's `Content-Length` must be this, and so must the bytes received. */
  expectedBytes: number;
  maxBytes: number;
  /** Created with `O_EXCL | O_NOFOLLOW`, mode 0600; removed on any failure. */
  dest: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  onProgress?: (p: { bytes: number; total: number | null }) => void;
  /** Hex sha256 the file must have, computed while streaming and checked before the caller renames it into place. */
  sha256?: string;
  /**
   * Hosts a redirect may lead to (exact host names; `https:` only, plain `http:` on loopback for tests), at most 3 hops.
   * Absent: no redirect at all (`redirect: 'error'`, Chrome for Testing).
   */
  allowRedirectHosts?: readonly string[];
}

/**
 * The streaming download shared by Chrome for Testing and the Whisper models: https only, redirects refused unless to an
 * allowed host, an exact and capped `Content-Length` that must equal the size shown to the user, progress, and an optional
 * streaming sha256 check. Nothing is left at `dest` when it fails.
 */
export async function streamDownload(o: StreamDownloadOptions): Promise<void> {
  const f = o.fetchImpl ?? fetch;
  let current = checkUrl(o.url);
  let res: Response | null = null;
  for (let hop = 0; ; hop++) {
    res = await f(current.href, { signal: o.signal, redirect: o.allowRedirectHosts ? 'manual' : 'error' }).catch((e: Error) => { throw new CftError('download', e.message); });
    if (!o.allowRedirectHosts || !REDIRECTS.has(res.status)) break;
    await res.body?.cancel().catch(() => {});
    if (hop >= MAX_REDIRECT_HOPS) throw new CftError('badUrl', 'too many redirects');
    const location = res.headers.get('location');
    if (!location) throw new CftError('download', `HTTP ${res.status} without a location`);
    let next: URL;
    try { next = new URL(location, current); } catch { throw new CftError('badUrl', 'bad redirect'); }
    next = checkUrl(next.href);
    if (!o.allowRedirectHosts.includes(next.hostname)) throw new CftError('badUrl', `refused redirect to ${next.origin}`);
    current = next;
  }
  if (!res.ok || !res.body) throw new CftError('download', `HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length'));
  if (!Number.isSafeInteger(len) || len <= 0) throw new CftError('sizeMismatch', 'no Content-Length');
  if (len > o.maxBytes) throw new CftError('tooLarge', `${len} bytes > ${o.maxBytes}`);
  if (o.expectedBytes !== len) throw new CftError('sizeMismatch', `expected ${o.expectedBytes} bytes, the server sends ${len}`);
  const fh = await open(o.dest, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const hash = createHash('sha256');
  let bytes = 0;
  let ok = false;
  try {
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read().catch((e: Error) => { throw new CftError('download', e.message); });
        if (done) break;
        bytes += value.length;
        if (bytes > len) { await reader.cancel().catch(() => {}); throw new CftError('sizeMismatch', 'more bytes than announced'); }
        hash.update(value);
        await fh.write(value);
        o.onProgress?.({ bytes, total: len });
      }
    } finally {
      await fh.close();
    }
    if (bytes !== len) throw new CftError('sizeMismatch', `downloaded ${bytes} of ${len} bytes`);
    if (o.sha256 !== undefined && hash.digest('hex') !== o.sha256.toLowerCase()) throw new CftError('hashMismatch', 'the sha256 of the download is not the expected one');
    ok = true;
  } finally {
    if (!ok) await rm(o.dest, { force: true }).catch(() => {});
  }
}

interface ZipEntry { name: string; method: number; crc: number; compSize: number; size: number; offset: number; mode: number; unix: boolean; dir: boolean; link: boolean }

/** Checks an archive member name; returns its normalised segments or throws. */
export function safeEntryName(name: string): string[] {
  if (name.length === 0 || name.length > MAX_NAME || name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new CftError('unsafeArchive', `unsafe path in archive: ${JSON.stringify(name.slice(0, 200))}`);
  }
  const segs = name.replace(/\/$/, '').split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) throw new CftError('unsafeArchive', `unsafe path in archive: ${JSON.stringify(name.slice(0, 200))}`);
  return segs;
}

async function readAt(fh: FileHandle, pos: number, len: number): Promise<Buffer> {
  const b = Buffer.alloc(len);
  const { bytesRead } = await fh.read(b, 0, len, pos);
  if (bytesRead !== len) throw new CftError('badArchive', 'truncated archive');
  return b;
}

async function readCentralDirectory(fh: FileHandle, size: number): Promise<ZipEntry[]> {
  const tailLen = Math.min(size, 65_557);
  const tail = await readAt(fh, size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new CftError('badArchive', 'not a zip archive');
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new CftError('badArchive', 'ZIP64 archives are not supported');
  if (count > MAX_ENTRIES) throw new CftError('unsafeArchive', 'too many entries');
  if (cdOffset + cdSize > size) throw new CftError('badArchive', 'bad central directory');
  const cd = await readAt(fh, cdOffset, cdSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new CftError('badArchive', 'bad central directory entry');
    const madeBy = cd.readUInt16LE(p + 4);
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    const compSize = cd.readUInt32LE(p + 20);
    const usize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const ext = cd.readUInt32LE(p + 38);
    const offset = cd.readUInt32LE(p + 42);
    if (p + 46 + nameLen > cd.length) throw new CftError('badArchive', 'bad central directory entry');
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 1) throw new CftError('unsafeArchive', 'encrypted entry');
    if (compSize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff) throw new CftError('badArchive', 'ZIP64 entries are not supported');
    if (method !== 0 && method !== 8) throw new CftError('badArchive', `unsupported compression ${method}`);
    const unix = (madeBy >> 8) === 3;
    const mode = unix ? ext >>> 16 : 0;
    const type = mode & 0o170000;
    entries.push({ name, method, crc, compSize, size: usize, offset, mode, unix, dir: name.endsWith('/') || type === 0o040000, link: type === 0o120000 });
  }
  return entries;
}

/** Streams one entry's bytes through `sink`, checking the declared size and the CRC. */
async function inflateEntry(fh: FileHandle, e: ZipEntry, sink: (chunk: Buffer) => Promise<void>): Promise<void> {
  const local = await readAt(fh, e.offset, 30);
  if (local.readUInt32LE(0) !== 0x04034b50) throw new CftError('badArchive', 'bad local header');
  const start = e.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  let crc = 0;
  let total = 0;
  const take = async (chunk: Buffer) => {
    total += chunk.length;
    if (total > e.size) throw new CftError('unsafeArchive', `${e.name}: more bytes than declared`);
    crc = crc32(chunk, crc);
    await sink(chunk);
  };
  if (e.compSize > 0) {
    const raw = fh.createReadStream({ start, end: start + e.compSize - 1, autoClose: false });
    if (e.method === 0) {
      for await (const chunk of raw) await take(chunk as Buffer);
    } else {
      const inflate = createInflateRaw();
      raw.pipe(inflate);
      raw.on('error', (err) => inflate.destroy(err));
      for await (const chunk of inflate) await take(chunk as Buffer);
    }
  }
  if (total !== e.size || (crc >>> 0) !== e.crc) throw new CftError('badArchive', `${e.name}: size or CRC mismatch`);
}

/** Extracts `zipPath` into the empty folder `dest` (see the module comment for the checks). */
export async function extractZip(zipPath: string, dest: string): Promise<void> {
  const fh = await open(zipPath, 'r');
  try {
    const size = (await fh.stat()).size;
    const entries = await readCentralDirectory(fh, size);
    let declared = 0;
    const names = new Set<string>();
    const links = new Map<string, string>();
    for (const e of entries) {
      const segs = safeEntryName(e.name);
      const key = segs.join('/');
      if (names.has(key)) throw new CftError('unsafeArchive', `duplicate entry ${key}`);
      names.add(key);
      declared += e.size;
      if (declared > MAX_UNZIPPED_BYTES) throw new CftError('unsafeArchive', 'archive too large once extracted');
      if (e.link) {
        if (e.size > 4096) throw new CftError('unsafeArchive', 'symlink target too long');
        let target = '';
        await inflateEntry(fh, e, async (c) => { target += c.toString('utf8'); });
        if (target.length === 0 || target.startsWith('/') || target.includes('\\') || target.includes('\0') || /^[A-Za-z]:/.test(target)) {
          throw new CftError('unsafeArchive', `symlink ${key} points outside`);
        }
        // No `..` at all: a relative target without `..` can only point down from its own folder, so a chain of such
        // links always stays inside (a lexical check of `x/..` would miss `x` itself being a link).
        if (target.split('/').some((s) => s === '..')) throw new CftError('unsafeArchive', `symlink ${key} points outside`);
        links.set(key, target);
      }
    }
    // No entry may live under a symlink (it would be written through it).
    for (const key of names) {
      const segs = key.split('/');
      for (let i = 1; i < segs.length; i++) if (links.has(segs.slice(0, i).join('/'))) throw new CftError('unsafeArchive', `${key} is under a symlink`);
    }
    for (const e of entries) {
      if (e.link) continue;
      const segs = safeEntryName(e.name);
      const abs = join(dest, ...segs);
      if (e.dir) { await mkdir(abs, { recursive: true }); continue; }
      await mkdir(join(dest, ...segs.slice(0, -1)), { recursive: true });
      const out = await open(abs, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, (e.mode & 0o111) ? 0o755 : 0o644);
      try {
        await inflateEntry(fh, e, async (c) => { await out.write(c); });
      } finally {
        await out.close();
      }
    }
    for (const [key, target] of links) {
      const segs = key.split('/');
      await mkdir(join(dest, ...segs.slice(0, -1)), { recursive: true });
      await symlink(target, join(dest, ...segs));
    }
  } finally {
    await fh.close();
  }
}
