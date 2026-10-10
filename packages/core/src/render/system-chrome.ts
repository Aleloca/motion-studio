import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

/**
 * Finds the user's own Chrome (spec §5.3, CLI): `CHROME_PATH` first, then the standard install places of macOS, Windows and
 * Linux. Nothing is downloaded here (Chrome for Testing is cft-download.ts, on consent only). A browser is usable when its
 * version answers and its major version is at least `MIN_CHROME_MAJOR` (`--headless=new`, out-of-process iframes and the CDP
 * calls the renderer uses).
 */

export const MIN_CHROME_MAJOR = 120;

export interface ChromeInstall {
  /** The executable. */
  exe: string;
  /** `154.0.8037.98`. */
  version: string;
  major: number;
  /** Where it was found: `CHROME_PATH` or a standard location. */
  source: 'env' | 'system';
}

/** Standard locations, best first, for `platform` (Chrome, then Chromium, Edge and Brave as fallbacks). */
export function chromeCandidates(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === 'darwin') {
    const apps = ['Google Chrome.app/Contents/MacOS/Google Chrome', 'Chromium.app/Contents/MacOS/Chromium',
      'Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'Brave Browser.app/Contents/MacOS/Brave Browser'];
    const roots = ['/Applications', ...(env.HOME ? [join(env.HOME, 'Applications')] : [])];
    return apps.flatMap((a) => roots.map((r) => join(r, a)));
  }
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter((r): r is string => !!r);
    const rel = ['Google\\Chrome\\Application\\chrome.exe', 'Chromium\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe',
      'BraveSoftware\\Brave-Browser\\Application\\brave.exe'];
    return rel.flatMap((r) => roots.map((root) => `${root}\\${r}`));
  }
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'];
  const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  const fixed = ['/usr/bin', '/usr/local/bin', '/snap/bin', '/opt/google/chrome'];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) for (const d of [...dirs, ...fixed]) { const p = join(d, n); if (!seen.has(p)) { seen.add(p); out.push(p); } }
  return out;
}

const VERSION_RE = /(\d+)\.(\d+)\.(\d+)\.(\d+)/;

/** `exe --version` (macOS, Linux), or the version folder next to `chrome.exe` (Windows, where `--version` prints nothing). */
export function chromeVersion(exe: string, timeoutMs = 60_000): Promise<string | null> {
  if (process.platform === 'win32') {
    try {
      const v = readdirSync(dirname(exe)).filter((d) => VERSION_RE.test(d) && statSync(join(dirname(exe), d)).isDirectory()).sort().pop();
      return Promise.resolve(v ? VERSION_RE.exec(v)![0] : null);
    } catch { return Promise.resolve(null); }
  }
  return new Promise((resolve) => {
    execFile(exe, ['--version'], { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : (VERSION_RE.exec(stdout)?.[0] ?? null));
    });
  });
}

/**
 * The first usable system Chrome, or null. `CHROME_PATH` wins when set: when it is not usable, null (an explicit choice is
 * never silently replaced).
 */
export async function findSystemChrome(o: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; candidates?: string[] } = {}): Promise<ChromeInstall | null> {
  const env = o.env ?? process.env;
  const check = async (exe: string, source: ChromeInstall['source']): Promise<ChromeInstall | null> => {
    if (!existsSync(exe)) return null;
    const version = await chromeVersion(exe);
    if (!version) return null;
    const major = Number(version.split('.')[0]);
    return major >= MIN_CHROME_MAJOR ? { exe, version, major, source } : null;
  };
  if (env.CHROME_PATH) return check(env.CHROME_PATH, 'env');
  for (const exe of o.candidates ?? chromeCandidates(o.platform, env)) {
    const found = await check(exe, 'system');
    if (found) return found;
  }
  return null;
}
