/**
 * Test-only Chrome driver: a zero-dependency CDP client over --remote-debugging-pipe (ported from the spike; the core's
 * own client is Task 4). Chrome runs headless (`--headless=new`) with a temporary profile under the OS temp folder and
 * in its own process group, which `close()` kills as a whole.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
];

/** `CHROME_PATH`, else the first system Chrome found. Never downloads anything. */
export function findChrome(): string | null {
  const env = process.env.CHROME_PATH;
  if (env) return existsSync(env) ? env : null;
  return CANDIDATES.find((p) => existsSync(p)) ?? null;
}

const FLAGS = [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
  '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-domain-reliability',
  '--metrics-recording-only', '--no-pings', '--mute-audio', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--hide-scrollbars',
  '--force-color-profile=srgb', '--font-render-hinting=none', '--disable-lcd-text', '--use-mock-keychain', '--password-store=basic',
  // Nothing may leave the machine: a dead proxy and a resolver that fails every name except loopback.
  '--proxy-server=http://127.0.0.1:9', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
];

interface Pending { res: (v: Record<string, unknown>) => void; rej: (e: Error) => void; method: string; timer: NodeJS.Timeout }

export class Browser extends EventEmitter {
  private id = 0;
  private buf = '';
  private pending = new Map<number, Pending>();
  exited = false;
  constructor(private proc: ChildProcess, private profile: string) {
    super();
    const out = proc.stdio[4] as Readable;
    (proc.stdio[3] as Writable).on('error', () => {});
    out.on('error', () => {});
    out.on('data', (d: Buffer) => {
      this.buf += d.toString();
      let i: number;
      while ((i = this.buf.indexOf('\0')) >= 0) {
        const msg = JSON.parse(this.buf.slice(0, i)) as { id?: number; method?: string; params?: unknown; sessionId?: string; error?: { message: string }; result?: Record<string, unknown> };
        this.buf = this.buf.slice(i + 1);
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.rej(new Error(`${p.method}: ${msg.error.message}`)); else p.res(msg.result ?? {});
        } else if (msg.method) this.emit(msg.method, msg.params, msg.sessionId);
      }
    });
    proc.on('exit', () => {
      this.exited = true;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.rej(new Error('browser exited')); }
      this.pending.clear();
    });
  }

  send(method: string, params: object = {}, sessionId?: string, timeoutMs = 120_000): Promise<Record<string, unknown>> {
    if (this.exited) return Promise.reject(new Error('browser exited'));
    const id = ++this.id;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { this.pending.delete(id); rej(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { res, rej, method, timer });
      (this.proc.stdio[3] as Writable).write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    });
  }

  async newPage(width: number, height: number): Promise<Page> {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank', newWindow: true }) as { targetId: string };
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
    const page = new Page(this, sessionId);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    return page;
  }

  async close(): Promise<void> {
    try { await Promise.race([this.send('Browser.close', {}, undefined, 5000), new Promise((r) => setTimeout(r, 5000))]); } catch { /* already gone */ }
    if (!this.exited) { try { process.kill(-this.proc.pid!, 'SIGKILL'); } catch { /* gone */ } }
    await new Promise<void>((r) => (this.exited ? r() : this.proc.once('exit', () => r())));
    try { process.kill(-this.proc.pid!, 'SIGKILL'); } catch { /* the group is already empty */ }
    rmSync(this.profile, { recursive: true, force: true, maxRetries: 3 });
  }
}

export class Page {
  constructor(private b: Browser, readonly sessionId: string) {}
  send(method: string, params: object = {}, timeoutMs?: number) { return this.b.send(method, params, this.sessionId, timeoutMs); }
  on(method: string, h: (p: Record<string, unknown>) => void) { this.b.on(method, (p: Record<string, unknown>, s: string) => { if (s === this.sessionId) h(p); }); }
  waitFor(method: string, timeoutMs = 120_000): Promise<Record<string, unknown>> {
    return new Promise((res, rej) => {
      const h = (p: Record<string, unknown>, s: string) => { if (s === this.sessionId) { clearTimeout(t); this.b.off(method, h); res(p); } };
      const t = setTimeout(() => { this.b.off(method, h); rej(new Error(`timeout waiting for ${method}`)); }, timeoutMs);
      this.b.on(method, h);
    });
  }
  /** Evaluates `expr` (awaiting promises) with a page-side timeout, returning the value by JSON. */
  async eval<T = unknown>(expr: string, timeoutMs = 120_000): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: timeoutMs }, timeoutMs + 10_000) as {
      result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (r.exceptionDetails) throw new Error(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value as T;
  }
  async goto(url: string): Promise<void> {
    const loaded = this.waitFor('Page.loadEventFired');
    await this.send('Page.navigate', { url });
    await loaded;
  }
  async close(): Promise<void> {
    await this.send('Page.close', {}, 30_000).catch(() => {});
  }
  async screenshot(): Promise<Buffer> {
    const r = await this.send('Page.captureScreenshot', { format: 'png' }) as { data: string };
    return Buffer.from(r.data, 'base64');
  }
}

export async function launchChrome(exe: string): Promise<Browser> {
  const profile = mkdtempSync(join(tmpdir(), 'ms-runtime-chrome-'));
  const proc = spawn(exe, [...FLAGS, `--user-data-dir=${profile}`, '--remote-debugging-pipe', 'about:blank'], {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], detached: true,
  });
  proc.stderr!.on('data', (d: Buffer) => { if (process.env.MS_CHROME_LOG) process.stderr.write(d); });
  const b = new Browser(proc, profile);
  await b.send('Browser.getVersion', {}, undefined, 120_000);
  return b;
}
