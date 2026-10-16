// Headless Chrome for the site's checks and posters: a throwaway profile, never the user's keychain or passwords, and
// only the process this script started is ever killed. Driven over CDP with Node's own WebSocket.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.CHROME, process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);

export async function launchChrome() {
  const bin = CANDIDATES.find((p) => existsSync(p));
  if (!bin) throw new Error('Chrome not found: set CHROME to its path');
  const profile = mkdtempSync(join(tmpdir(), 'ms-site-chrome-'));
  const proc = spawn(bin, [
    '--headless=new', `--user-data-dir=${profile}`, '--use-mock-keychain', '--password-store=basic',
    '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const stop = () => { if (proc.exitCode === null) proc.kill('SIGKILL'); rmSync(profile, { recursive: true, force: true }); };
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`Chrome did not start: ${buf.slice(-400)}`)), 60000);
    proc.stderr.on('data', (d) => {
      buf += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.on('exit', (code) => reject(new Error(`Chrome exited (${code})`)));
  }).catch((e) => { stop(); throw e; });
  const browser = await connect(wsUrl);
  return {
    browser,
    async newPage() {
      const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
      return browser.session(sessionId, targetId);
    },
    async close() {
      try { await browser.send('Browser.close'); } catch { /* already gone */ }
      await new Promise((r) => { if (proc.exitCode !== null) r(); else { proc.once('exit', r); setTimeout(() => { if (proc.exitCode === null) proc.kill('SIGKILL'); r(); }, 5000); } });
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    } else if (msg.method) for (const l of listeners) l(msg);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return {
    send,
    session(sessionId, targetId) {
      const on = (method, fn) => { const l = (m) => { if (m.sessionId === sessionId && m.method === method) fn(m.params); }; listeners.add(l); return () => listeners.delete(l); };
      const page = {
        targetId,
        send: (method, params) => send(method, params, sessionId),
        on,
        async goto(u) {
          const loaded = new Promise((r) => { const off = on('Page.loadEventFired', () => { off(); r(); }); });
          await page.send('Page.navigate', { url: u });
          await loaded;
        },
        async eval(expression) {
          const r = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
          if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
          return r.result.value;
        },
        close: () => send('Target.closeTarget', { targetId }),
      };
      return page;
    },
  };
}
