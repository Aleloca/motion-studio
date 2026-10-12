/**
 * Chrome for Testing on demand, against a FAKE local endpoint only: the real endpoint is never contacted, not even for the
 * manifest (every fetch goes through a guard that fails the test for any non-loopback URL).
 */
import { createServer, type Server } from 'node:http';
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CFT_ENDPOINT, cftDownloadInfo, CftError, extractZip, findInstalledCft, installCft, safeEntryName, type CftPlatform } from '../src/render/cft-download.ts';

interface Entry { name: string; data?: string | Buffer; mode?: number; link?: string; store?: boolean }

/** A minimal zip writer (deflate or store, unix modes, symlinks), enough to forge hostile archives. */
function makeZip(entries: Entry[], o: { badCrc?: string } = {}): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = Buffer.from(e.link ?? e.data ?? '');
    const method = e.store || e.link !== undefined ? 0 : 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const crc = o.badCrc === e.name ? (crc32(raw) ^ 1) >>> 0 : crc32(raw);
    const mode = e.link !== undefined ? 0o120777 : e.name.endsWith('/') ? 0o040755 : (e.mode ?? 0o100644);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE((mode << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const PLATFORM: CftPlatform = 'mac-arm64';
const VERSION = '154.0.8037.98';
const exeEntry = { name: `chrome-headless-shell-${PLATFORM}/chrome-headless-shell`, data: '#!/bin/sh\necho fake\n', mode: 0o100755 };
const goodZip = makeZip([
  { name: `chrome-headless-shell-${PLATFORM}/` }, exeEntry,
  { name: `chrome-headless-shell-${PLATFORM}/lib/libx.dylib`, data: 'x'.repeat(5000) },
  { name: `chrome-headless-shell-${PLATFORM}/lib/current`, link: 'libx.dylib' },
]);

let server: Server;
let base: string;
let work: string;
const hits: string[] = [];
/** What the fake endpoint serves for /dl.zip, and the Content-Length it announces (HEAD and GET separately). */
const served: { zip: Buffer; headLength?: number; getLength?: number; truncate?: boolean } = { zip: goodZip };

/** Fetch that refuses anything but the fake loopback endpoint: the real one is never contacted. */
const guardedFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== '127.0.0.1') throw new Error(`test tried to reach ${url.origin}`);
  return fetch(input, init);
};

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'ms-test-render-cft-'));
  server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.url === '/manifest.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ channels: { Stable: { version: VERSION, downloads: { 'chrome-headless-shell': [
        { platform: 'linux64', url: `${base}/other.zip` }, { platform: PLATFORM, url: `${base}/dl.zip` },
      ] } } } }));
      return;
    }
    if (req.url === '/evil-manifest.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ channels: { Stable: { version: '../../x', downloads: { 'chrome-headless-shell': [{ platform: PLATFORM, url: `${base}/dl.zip` }] } } } }));
      return;
    }
    if (req.url === '/dl.zip') {
      const len = req.method === 'HEAD' ? (served.headLength ?? served.zip.length) : (served.getLength ?? served.zip.length);
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(len) });
      if (req.method === 'HEAD') { res.end(); return; }
      if (served.truncate) { res.write(served.zip.subarray(0, served.zip.length - 10)); res.destroy(); return; }
      res.end(served.zip);
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
  rmSync(work, { recursive: true, force: true });
});
beforeEach(() => { hits.length = 0; served.zip = goodZip; delete served.headLength; delete served.getLength; delete served.truncate; });

const appData = (name: string) => join(work, name);
const install = (name: string, extra: Partial<Parameters<typeof installCft>[0]> = {}) =>
  installCft({ consent: true, appDataDir: appData(name), endpoint: `${base}/manifest.json`, fetchImpl: guardedFetch, ...extra });

describe('Chrome for Testing download (fake endpoint)', () => {
  it('the default endpoint is the official JSON, and the guard refuses it in tests', async () => {
    expect(CFT_ENDPOINT).toBe('https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json');
    await expect(cftDownloadInfo({ fetchImpl: guardedFetch, platform: PLATFORM })).rejects.toThrow(/test tried to reach https:\/\/googlechromelabs\.github\.io/);
  });

  it('needs consent: without it nothing is requested, not even the manifest', async () => {
    for (const consent of [false, undefined, 'yes', 1]) {
      await expect(install('no-consent', { consent: consent as boolean })).rejects.toMatchObject({ code: 'consentRequired' });
    }
    expect(hits).toEqual([]);
    expect(existsSync(appData('no-consent'))).toBe(false);
  });

  it('reads the version, URL and size for this platform (HEAD only)', async () => {
    const info = await cftDownloadInfo({ endpoint: `${base}/manifest.json`, platform: PLATFORM, fetchImpl: guardedFetch });
    expect(info).toEqual({ version: VERSION, platform: PLATFORM, url: `${base}/dl.zip`, sizeBytes: goodZip.length });
    expect(hits).toEqual(['GET /manifest.json', 'HEAD /dl.zip']);
  });

  it('installs into <appData>/chromium/<version>/ with the executable bit and an inside symlink, then finds it', async () => {
    const info = await cftDownloadInfo({ endpoint: `${base}/manifest.json`, platform: PLATFORM, fetchImpl: guardedFetch });
    const progress: number[] = [];
    const r = await install('ok', { info, onProgress: (p) => progress.push(p.bytes) });
    const dir = join(appData('ok'), 'chromium', VERSION, `chrome-headless-shell-${PLATFORM}`);
    expect(r).toEqual({ exe: join(dir, 'chrome-headless-shell'), version: VERSION });
    expect(lstatSync(r.exe).mode & 0o111).not.toBe(0);
    expect(readlinkSync(join(dir, 'lib', 'current'))).toBe('libx.dylib');
    expect(readFileSync(join(dir, 'lib', 'libx.dylib'), 'utf8')).toBe('x'.repeat(5000));
    expect(progress.at(-1)).toBe(goodZip.length);
    // Nothing left over next to it.
    expect(readdirSync(join(appData('ok'), 'chromium'))).toEqual([VERSION]);
    expect(await findInstalledCft(appData('ok'), PLATFORM)).toEqual(r);
  });

  it('refuses a size different from the one shown to the user, a lying Content-Length and a truncated download', async () => {
    const info = await cftDownloadInfo({ endpoint: `${base}/manifest.json`, platform: PLATFORM, fetchImpl: guardedFetch });
    served.getLength = goodZip.length + 100; // the GET announces another size than the HEAD the user saw
    await expect(install('size1', { info })).rejects.toMatchObject({ code: 'sizeMismatch' });
    delete served.getLength;
    served.truncate = true;
    await expect(install('size2', { info })).rejects.toBeInstanceOf(Error);
    delete served.truncate;
    await expect(install('size3', { info, maxBytes: 100 })).rejects.toMatchObject({ code: 'tooLarge' });
    for (const n of ['size1', 'size2', 'size3']) {
      expect(existsSync(join(appData(n), 'chromium', VERSION))).toBe(false);
      expect(readdirSync(join(appData(n), 'chromium'))).toEqual([]); // the partial zip was removed
    }
  });

  it('never offers a download of unknown size: no size from HEAD, or none in what the user agreed to', async () => {
    served.headLength = 0;
    await expect(cftDownloadInfo({ endpoint: `${base}/manifest.json`, platform: PLATFORM, fetchImpl: guardedFetch })).rejects.toMatchObject({ code: 'sizeMismatch' });
    hits.length = 0;
    const info = { version: VERSION, platform: PLATFORM, url: `${base}/dl.zip`, sizeBytes: null as unknown as number };
    await expect(install('nosize', { info })).rejects.toMatchObject({ code: 'sizeMismatch' });
    expect(hits).toEqual([]); // refused before any download
  });

  it('refuses a version that is not a version (it becomes a folder name)', async () => {
    await expect(install('evil-version', { endpoint: `${base}/evil-manifest.json` })).rejects.toMatchObject({ code: 'badManifest' });
  });

  const hostile: Array<[string, Entry[]]> = [
    ['a `..` entry', [exeEntry, { name: '../escape.txt', data: 'x' }]],
    ['a nested `..` entry', [exeEntry, { name: `chrome-headless-shell-${PLATFORM}/../../escape.txt`, data: 'x' }]],
    ['an absolute entry', [exeEntry, { name: '/tmp/escape.txt', data: 'x' }]],
    ['a backslash entry', [exeEntry, { name: '..\\escape.txt', data: 'x' }]],
    ['a drive-letter entry', [exeEntry, { name: 'C:/escape.txt', data: 'x' }]],
    ['a symlink pointing out with ..', [exeEntry, { name: `chrome-headless-shell-${PLATFORM}/out`, link: '../../../../etc' }]],
    ['a symlink to an absolute path', [exeEntry, { name: `chrome-headless-shell-${PLATFORM}/abs`, link: '/etc/passwd' }]],
    ['an entry written through a symlink', [exeEntry, { name: 'dir', link: '.' }, { name: 'dir/x.txt', data: 'x' }]],
    ['a duplicate entry', [exeEntry, exeEntry]],
  ];
  for (const [what, entries] of hostile) {
    it(`refuses an archive with ${what}, writing nothing`, async () => {
      served.zip = makeZip(entries);
      const name = `hostile-${what.replace(/\W+/g, '-')}`;
      await expect(install(name)).rejects.toMatchObject({ code: 'unsafeArchive' });
      expect(readdirSync(join(appData(name), 'chromium'))).toEqual([]);
      expect(existsSync(join(work, 'escape.txt'))).toBe(false);
    });
  }

  it('refuses a CRC mismatch and an archive without the executable', async () => {
    served.zip = makeZip([exeEntry, { name: 'a.txt', data: 'hello' }], { badCrc: 'a.txt' });
    await expect(install('crc')).rejects.toMatchObject({ code: 'badArchive' });
    served.zip = makeZip([{ name: 'readme.txt', data: 'x' }]);
    await expect(install('noexe')).rejects.toMatchObject({ code: 'noExecutable' });
    expect(readdirSync(join(appData('noexe'), 'chromium'))).toEqual([]);
  });

  it('checks names directly too', () => {
    expect(safeEntryName('a/b/c.txt')).toEqual(['a', 'b', 'c.txt']);
    expect(safeEntryName('a/b/')).toEqual(['a', 'b']);
    for (const bad of ['', '/a', 'a/../b', './a', 'a//b', 'a\\b', 'C:x', 'a\0b']) expect(() => safeEntryName(bad), bad).toThrow(CftError);
  });

  it('extractZip refuses a file that is not a zip', async () => {
    const f = join(work, 'not.zip');
    const { writeFileSync, mkdirSync } = await import('node:fs');
    writeFileSync(f, 'hello');
    mkdirSync(join(work, 'not-dest'));
    await expect(extractZip(f, join(work, 'not-dest'))).rejects.toMatchObject({ code: 'badArchive' });
  });
});
