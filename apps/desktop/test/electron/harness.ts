/**
 * The real-Electron harness of render-window.electron.test.ts (phase 10a Task 7): bundled by the test and run by the
 * Electron binary as its main script. Every Electron data path points into the test's throwaway folder, and the
 * core's config folder is the test's temp one (`MOTION_STUDIO_CONFIG_DIR`). It reads one scenario from `MS_HARNESS`
 * (JSON) and prints `HARNESS <json>` lines; the test asserts on them.
 */
import { execFile } from 'node:child_process';
import { Session as InspectorSession } from 'node:inspector';
import { cpus, loadavg } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { join } from 'node:path';
import { app, BrowserWindow, contentTracing, nativeImage, powerSaveBlocker, session } from 'electron';
import type { Composition, FormatPreset } from '../../../../packages/shared/src/index.ts';
import { findFfmpeg, renderComposition, RenderError, type FfmpegInfo } from '@motion-studio/core';
import { startCompositionServer } from '../../../../packages/core/src/compositions/composition-server.ts';
import { renderFrames } from '../../../../packages/core/src/render/frames.ts';
import { appKeptAwake, closeAllRenderWindows, createRenderWindow, ElectronProvider, liveRenderWindowCount, rawFrameChecks, shutdownForQuit } from '../../src/render-window.ts';
import { readdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { hardenUiWindow, installPreviewFilter } from '../../src/preview-filter.ts';

interface Config {
  scenario: 'options' | 'session-rules' | 'render' | 'hostile-render' | 'preview' | 'lifecycle' | 'memory' | 'quit' | 'scale' | 'render-cost' | 'frames' | 'ui-load' | 'capture-probe' | 'raw-render' | 'raw-check' | 'css-pause';
  /** scale (report 51): the pages to open under `creative`, each at its scale (none: the default) and seek time. */
  scalePages?: Array<{ name: string; composition: Composition; format: string; scale?: number; t?: number }>;
  /** The built runtime. */
  dist: string;
  /** The creative folder (render scenarios). */
  creative?: string;
  composition?: Composition;
  format?: string;
  out?: string;
  ffmpeg?: FfmpegInfo;
  /** A server without any CSP (session rules, preview): `<origin>/<token>/page.html` frames every hostile layer. */
  naked?: { origin: string; token: string };
  /**
   * The UI-like pages (preview): every frame (control), the real server's frames, the CSP-less server's frames; with the
   * composition origin the filter is pinned to in each filtered phase (the real server, then the CSP-less one).
   */
  ui?: { origin: string; all: string; real: string; naked: string; inherit: string; realComposition: string; nakedComposition: string };
  parallel?: number;
  /** frames: the storyboard times (renderFrames, `width` wide). */
  frames?: { times: number[]; width: number };
  /** render-cost (decision 1348): the renders to time, each at its short side (none: 1x) and offscreen frame rate (none: the default). */
  costRuns?: Array<{ name: string; short?: number; frameRate?: number; painting?: boolean }>;
  /** ui-load (report 53): the app-like window's responsiveness, idle (no `render`) or while a render runs. */
  uiRuns?: UiRun[];
  /** capture-probe (report 53): the times to capture at `scale`, and where the first frames go. */
  /** raw-render (report 53): renders with raw frames, or `encoded` (PNG), at a short side (none: 1x). */
  rawRuns?: Array<{ name: string; short?: number; encoded?: boolean; quality?: 'standard' | 'high' | 'max'; background?: string }>;
  probe?: { scale: number; times: number[]; outDir: string };
  /** raw-check (report 56): the times to read raw and as PNG from one page, each from the same state. */
  rawCheck?: { times: number[]; changes: number };
  /** css-pause (report 56): the pages to open, and the layer agent's functions (source) that pause their animation. */
  cssPause?: { runs: number; pause: string; settle: string };
  /** Chromium switches appended before the app is ready (e.g. a forced colour profile). */
  switches?: Record<string, string>;
  /** A throwaway folder under the OS temp folder for every Electron data path (the test removes it after the exit). */
  scratch: string;
}

const config = JSON.parse(process.env.MS_HARNESS ?? '{}') as Config;
const scratch = config.scratch;
if (!scratch || !scratch.includes('ms-test-electron-')) throw new Error('harness: a throwaway scratch folder is required');
// Before anything reads them: no Electron data outside the throwaway folder.
app.setName('ms-electron-harness');
// No real keychain (Chromium's cookie encryption would otherwise ask for it).
app.commandLine.appendSwitch('use-mock-keychain');
app.commandLine.appendSwitch('password-store', 'basic');
for (const [k, v] of Object.entries(config.switches ?? {})) app.commandLine.appendSwitch(k, v);
for (const k of ['appData', 'userData', 'sessionData', 'logs', 'crashDumps'] as const) app.setPath(k, join(scratch, k));
// Not removed here: an rmSync of it in an 'exit' hook hung Electron's exit once pages had loaded over HTTP. The test does it.

const report = (o: unknown) => console.log(`HARNESS ${JSON.stringify(o)}`);
// Final wave B2: the effective data folders, logged before anything else; one outside the scratch folder stops this run
// at once. The test checks them too and only then says `go` (stdin): nothing runs before.
const PATHS = ['appData', 'userData', 'sessionData', 'logs', 'crashDumps'] as const;
const paths = Object.fromEntries(PATHS.map((k) => [k, app.getPath(k)]));
report({ phase: 'paths', pid: process.pid, ...paths });
if (PATHS.some((k) => !paths[k]!.startsWith(`${scratch}/`))) { report({ error: 'Electron data outside the scratch folder' }); app.exit(3); process.exit(3); }
const go = new Promise<void>((resolve) => {
  let input = '';
  process.stdin.on('data', (d: Buffer) => { input += d.toString(); if (/^go$/m.test(input)) resolve(); });
});
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * How long a CONTROL window (no filter: it must leak, or "nothing leaked" proves nothing) is given to do its work: its base
 * time stretched by the machine load (1 to 6 times), so a slow start under load does not close it before its probes fired.
 */
const controlSettle = (ms: number) => settle(ms * Math.min(6, Math.max(1, loadavg()[0]! / Math.max(1, cpus().length))));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const formatOf = (c: Composition, id: string): FormatPreset => ({ id, channel: 'Test', name: id, width: c.width, height: c.height, kind: 'video', extensions: ['mp4'], targetBitrateKbps: 800 });

/** Loads `url` in a hidden window on its own partition (`prepare` locks it, or not: a control). */
async function loadIn(partition: string, url: string, prepare: (ses: Electron.Session) => void | Promise<void>, ui = false) {
  const ses = session.fromPartition(partition, { cache: false });
  await prepare(ses);
  // `ui`: the UI window's own protection (preview-filter.ts) on top of the filter.
  const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, partition } });
  if (ui) hardenUiWindow(win.webContents);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await win.loadURL(url).catch(() => {});
  return win;
}

/**
 * Watches a session's service workers until `stop()`: `serviceWorkers` is the most running at once (sampled every 200 ms and
 * on every status change), `swEvents` every registration and running-status change, timed from the start (the diagnostic
 * of a failure). A single read at the end would miss a worker that ran and was stopped (Chromium stops an idle one after 30 s).
 */
function watchServiceWorkers(ses: Electron.Session) {
  const t0 = Date.now();
  const swEvents: string[] = [];
  let max = 0;
  const sample = () => { max = Math.max(max, Object.keys(ses.serviceWorkers.getAllRunning()).length); };
  const onRegistered = (_e: unknown, d: { scope: string }) => { swEvents.push(`${Date.now() - t0}ms registered ${d.scope}`); sample(); };
  const onStatus = (d: { versionId: number; runningStatus: string }) => { swEvents.push(`${Date.now() - t0}ms v${d.versionId} ${d.runningStatus}`); sample(); };
  ses.serviceWorkers.on('registration-completed', onRegistered);
  ses.serviceWorkers.on('running-status-changed', onStatus);
  const timer = setInterval(sample, 200);
  return {
    stop() {
      clearInterval(timer);
      sample();
      ses.serviceWorkers.off('registration-completed', onRegistered);
      ses.serviceWorkers.off('running-status-changed', onStatus);
      return { serviceWorkers: max, swEvents };
    },
  };
}

/**
 * Report 53: counts the frames `provider`'s pages read raw and encoded; `encoded` takes their raw frames away (the PNG or
 * JPEG frames of before).
 */
/** Two BGRA frames compared: bytes that differ, the largest difference, and the mean difference per channel (B, G, R, A). */
function frameDiff(a: Buffer, b: Buffer) {
  let n = 0, max = 0;
  const sum = [0, 0, 0, 0];
  for (let k = 0; k < Math.min(a.length, b.length); k++) { const d = a[k]! - b[k]!; if (d) { n++; max = Math.max(max, Math.abs(d)); sum[k % 4]! += d; } }
  const px = Math.min(a.length, b.length) / 4;
  return { sizes: a.length === b.length, differing: n, max, mean: sum.map((x) => Math.round((1000 * x) / px) / 1000) };
}

function countFrames(provider: ElectronProvider, encoded: boolean) {
  const counts = { rawFrames: 0, encodedFrames: 0 };
  const open = provider.open.bind(provider);
  provider.open = async (o) => {
    const { captureRaw, ...p } = await open(o);
    const capture = p.capture;
    return {
      ...p, capture: (...a) => { counts.encodedFrames++; return capture(...a); },
      ...(captureRaw && !encoded ? { captureRaw: () => { counts.rawFrames++; return captureRaw(); } } : {}),
    };
  };
  return counts;
}

interface UiRun {
  name: string;
  /** Idle runs: how long to measure. */
  seconds?: number;
  render?: { short?: number; quality?: 'standard' | 'high' | 'max'; parallel?: number; encoded?: boolean };
  /** Profile the main process (inspector) during the run: its top self-time functions. */
  profile?: boolean;
  /** Trace the run (contentTracing): the main process's UI-thread tasks over 16 ms, by where they were posted from. */
  trace?: boolean;
}

/** The browser process's UI-thread tasks (`CrBrowserMain`) of a trace file, longer than 16 ms, summed by their origin. */
function longMainTasks(file: string, pid: number, minMs = 16) {
  const trace = JSON.parse(readFileSync(file, 'utf8')) as { traceEvents: Array<{ ph: string; pid: number; tid: number; name: string; dur?: number; args?: Record<string, unknown> }> };
  const ev = trace.traceEvents;
  const tid = ev.find((e) => e.ph === 'M' && e.name === 'thread_name' && e.pid === pid && (e.args as { name?: string })?.name === 'CrBrowserMain')?.tid;
  const by = new Map<string, { n: number; ms: number; max: number }>();
  let total = 0;
  for (const e of ev) {
    if (e.pid !== pid || e.tid !== tid || e.ph !== 'X' || !e.dur || e.dur < minMs * 1000 || !/RunTask/.test(e.name)) continue;
    const a = (e.args ?? {}) as { src_file?: string; src_func?: string; src?: { file_name?: string; function_name?: string } };
    const key = `${a.src_func ?? a.src?.function_name ?? '?'} ${(a.src_file ?? a.src?.file_name ?? '?').split('/').slice(-2).join('/')}`;
    const v = by.get(key) ?? { n: 0, ms: 0, max: 0 };
    v.n++; v.ms += e.dur / 1000; v.max = Math.max(v.max, e.dur / 1000); total += e.dur / 1000;
    by.set(key, v);
  }
  return { totalMs: Math.round(total), top: [...by].sort((a, b) => b[1].ms - a[1].ms).slice(0, 10).map(([k, v]) => ({ task: k, n: v.n, ms: Math.round(v.ms), max: Math.round(v.max) })) };
}

/** A dialog-like list (gradient thumbnails and text) the main process scrolls with wheel events; the page logs its frames. */
const UI_LIST = `<!doctype html><html><head><style>body{margin:0;font:13px system-ui;background:#1b1b1f;color:#ddd}
#l{position:absolute;inset:0;overflow-y:auto}.r{display:flex;gap:12px;align-items:center;padding:8px 12px;border-bottom:1px solid #333}
.t{width:160px;height:90px;border-radius:6px;flex:none}</style></head><body><div id="l"></div><script>
const l = document.getElementById('l');
for (let i = 0; i < 600; i++) { const r = document.createElement('div'); r.className = 'r';
  r.innerHTML = '<div class="t" style="background:linear-gradient(' + (i * 37 % 360) + 'deg,hsl(' + (i * 53 % 360) + ',70%,45%),hsl(' + (i * 97 % 360) + ',60%,25%))"></div><div><b>File ' + i + '</b><br>2560 × 1440 · store · device ' + (i % 8) + '</div>';
  l.appendChild(r); }
l.scrollTop = 30000;
window.ms = { frames: [], scroll: [], wheels: [], longTasks: [] };
const loop = (t) => { window.ms.frames.push(t); window.ms.scroll.push(l.scrollTop); requestAnimationFrame(loop); };
requestAnimationFrame(loop);
l.addEventListener('wheel', () => { window.ms.wheels.push(performance.now()); }, { passive: true });
new PerformanceObserver((list) => { for (const e of list.getEntries()) window.ms.longTasks.push(e.duration); }).observe({ entryTypes: ['longtask'] });
</script></body></html>`;

const pct = (xs: number[], p: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!; };
const r1 = (x: number) => Math.round(x * 10) / 10;

/**
 * CPU seconds of every process of this app (Electron's metrics) and of its ffmpeg children (`ps`, run asynchronously: a
 * synchronous child would block the very loop being measured), by pid.
 */
async function cpuSnapshot(): Promise<Map<number, { kind: string; s: number }>> {
  const m = new Map<number, { kind: string; s: number }>();
  for (const p of app.getAppMetrics()) m.set(p.pid, { kind: p.type, s: p.cpu.cumulativeCPUUsage ?? 0 });
  try {
    const out = await new Promise<string>((res, rej) => execFile('ps', ['-A', '-o', 'pid=,ppid=,time=,comm='], { encoding: 'utf8' }, (e, o) => (e ? rej(e) : res(o))));
    for (const line of out.split('\n')) {
      const mm = /^\s*(\d+)\s+(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):([\d.]+)\s+(.*)$/.exec(line);
      if (!mm || Number(mm[2]) !== process.pid || !/ffmpeg/.test(mm[7]!)) continue;
      const s = Number(mm[3] ?? 0) * 86400 + Number(mm[4] ?? 0) * 3600 + Number(mm[5]) * 60 + Number(mm[6]);
      m.set(Number(mm[1]), { kind: 'ffmpeg', s });
    }
  } catch { /* ps unavailable */ }
  return m;
}

/** Report 53: the UI window's frames, the main process's event-loop delay and the CPU per process kind, during `run`. */
async function uiLoadRun(c: Config, run: UiRun) {
  const ses = session.fromPartition(`ui-load-${run.name}`, { cache: false });
  const ui = new BrowserWindow({ show: false, x: 40, y: 40, width: 420, height: 520, focusable: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, session: ses } });
  await ui.loadURL(`data:text/html;base64,${Buffer.from(UI_LIST).toString('base64')}`);
  ui.showInactive();
  await settle(1500);
  const uiPid = ui.webContents.getOSProcessId();
  const before = await cpuSnapshot();
  const seen = new Map(before);
  const sampler = setInterval(() => { void cpuSnapshot().then((m) => { for (const [pid, v] of m) seen.set(pid, v); }); }, 1000);
  // Smooth wheel scrolling, down then up, as a user flicking through a list (60 events a second).
  let dir = 1, n = 0;
  const wheel = setInterval(() => {
    if (++n % 120 === 0) dir = -dir;
    try { ui.webContents.sendInputEvent({ type: 'mouseWheel', x: 200, y: 260, deltaX: 0, deltaY: -40 * dir, canScroll: true } as Electron.MouseWheelInputEvent); } catch { /* closing */ }
  }, 16);
  // The main process's peak RSS (raw frames are 14.7 MB each at 2560 × 1440, against a few MB of PNG).
  let rss = process.memoryUsage().rss;
  const rssTimer = setInterval(() => { rss = Math.max(rss, process.memoryUsage().rss); }, 100);
  const eld = monitorEventLoopDelay({ resolution: 5 });
  let prof: InspectorSession | null = null;
  if (run.profile) {
    prof = new InspectorSession(); prof.connect();
    const post = (m: string, p?: object) => new Promise<unknown>((res, rej) => prof!.post(m, p ?? {}, (e, r) => (e ? rej(e) : res(r))));
    await post('Profiler.enable'); await post('Profiler.setSamplingInterval', { interval: 500 }); await post('Profiler.start');
  }
  if (run.trace) await contentTracing.startRecording({ included_categories: ['toplevel', 'ipc', 'mojom', 'devtools'], excluded_categories: ['*'] });
  await ui.webContents.executeJavaScript('window.ms.frames.length = 0; window.ms.scroll.length = 0; window.ms.wheels.length = 0; window.ms.longTasks.length = 0; true');
  eld.enable();
  const t0 = Date.now();
  let render: Record<string, unknown> = {};
  if (run.render) {
    const provider = new ElectronProvider({ maxWindows: run.render.parallel ?? 4, limits: { timeLimitMs: 30 * 60_000 } });
    const counts = countFrames(provider, run.render.encoded === true);
    const r = await renderComposition({
      dir: c.creative!, versionDir: 'outputs/v1', composition: c.composition!, format: formatOf(c.composition!, c.format!), out: join(scratch, `${run.name}.mp4`),
      provider, parallel: run.render.parallel ?? 4, signal: new AbortController().signal, distDir: c.dist, ffmpeg: (await findFfmpeg()) ?? c.ffmpeg!, tempDir: scratch,
      ...(run.render.short !== undefined ? { short: run.render.short } : {}), ...(run.render.quality ? { quality: run.render.quality } : {}),
    });
    render = { frames: r.frames, width: r.width, height: r.height, encoder: r.encoder, sha256: r.sha256, ...counts };
  } else {
    await settle((run.seconds ?? 10) * 1000);
  }
  const ms = Date.now() - t0;
  eld.disable();
  clearInterval(wheel);
  clearInterval(sampler);
  clearInterval(rssTimer);
  for (const [pid, v] of await cpuSnapshot()) seen.set(pid, v);
  const traced = run.trace ? longMainTasks(await contentTracing.stopRecording(join(scratch, `${run.name}.trace.json`)), process.pid) : undefined;
  let top: Array<{ fn: string; ms: number }> | undefined;
  if (prof) {
    const p = await new Promise<{ profile: { nodes: Array<{ id: number; callFrame: { functionName: string; url: string; lineNumber: number } }>; samples: number[]; timeDeltas: number[] } }>((res, rej) => prof!.post('Profiler.stop', (e, r) => (e ? rej(e) : res(r as never))));
    prof.disconnect();
    const self = new Map<number, number>();
    p.profile.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (p.profile.timeDeltas[i] ?? 0)));
    const byFn = new Map<string, number>();
    for (const node of p.profile.nodes) {
      const f = node.callFrame;
      const key = `${f.functionName || '(anon)'} ${f.url.split('/').pop() ?? ''}:${f.lineNumber}`;
      byFn.set(key, (byFn.get(key) ?? 0) + (self.get(node.id) ?? 0) / 1000);
    }
    top = [...byFn].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([fn, v]) => ({ fn, ms: Math.round(v) }));
  }
  const page = await ui.webContents.executeJavaScript('({ frames: window.ms.frames.slice(), scroll: window.ms.scroll.slice(), wheels: window.ms.wheels.slice(), longTasks: window.ms.longTasks.slice() })') as { frames: number[]; scroll: number[]; wheels: number[]; longTasks: number[] };
  const gaps = page.frames.slice(1).map((t, i) => t - page.frames[i]!);
  const wheelGaps = page.wheels.slice(1).map((t, i) => t - page.wheels[i]!);
  // A stall: the list did not move for 50 ms or more while it was being scrolled (the user's "jerky" scrolling).
  let stalls = 0, stallMax = 0, still = 0;
  for (let i = 1; i < page.scroll.length; i++) {
    if (page.scroll[i] === page.scroll[i - 1]) { still += gaps[i - 1]!; continue; }
    if (still >= 50) { stalls++; stallMax = Math.max(stallMax, still); }
    still = 0;
  }
  const cpu: Record<string, number> = {};
  for (const [pid, v] of seen) {
    const kind = pid === process.pid ? 'main' : pid === uiPid ? 'ui' : v.kind === 'Tab' ? 'renderWindows' : v.kind;
    cpu[kind] = r1((cpu[kind] ?? 0) + v.s - (before.get(pid)?.s ?? 0));
  }
  await close(ui);
  return {
    ms, ...render,
    ui: { frames: page.frames.length, fps: r1(page.frames.length / (ms / 1000)), gapP50: r1(pct(gaps, 50)), gapP95: r1(pct(gaps, 95)), gapP99: r1(pct(gaps, 99)), gapMax: r1(Math.max(0, ...gaps)),
      over25: gaps.filter((g) => g > 25).length, over50: gaps.filter((g) => g > 50).length, longTasks: page.longTasks.length, longTaskMax: r1(Math.max(0, ...page.longTasks)),
      wheels: page.wheels.length, wheelGapP99: r1(pct(wheelGaps, 99)), wheelGapMax: r1(Math.max(0, ...wheelGaps)), wheelGapsOver50: wheelGaps.filter((g) => g > 50).length,
      scrollStalls: stalls, scrollStallMax: r1(stallMax) },
    mainEld: { p50: r1(eld.percentile(50) / 1e6), p99: r1(eld.percentile(99) / 1e6), max: r1(eld.max / 1e6), mean: r1(eld.mean / 1e6) },
    cpuSeconds: cpu, mainRssPeakMB: Math.round(rss / 2 ** 20),
    ...(traced ? { mainLongTasks: traced } : {}),
    ...(top ? { mainProfile: top } : {}),
  };
}

async function close(win: BrowserWindow) {
  if (win.isDestroyed()) return;
  const closed = new Promise<void>((r) => win.once('closed', () => r()));
  win.close();
  await closed;
}

async function run(): Promise<void> {
  const c = config;
  switch (c.scenario) {
    case 'options': {
      const prefix = `http://127.0.0.1:47001/abcdefghijklmnop0123/`;
      const rw = await createRenderWindow({ prefix, width: 320, height: 180 });
      const wc = rw.win.webContents;
      // Undocumented in the typings, present at runtime: the preferences the window really got.
      const prefs = ((wc as unknown as { getLastWebPreferences?: () => Record<string, unknown> | null }).getLastWebPreferences?.() ?? {});
      const ses = wc.session;
      const metric = app.getAppMetrics().find((m) => m.pid === wc.getOSProcessId());
      report({
        prefs: { sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration, nodeIntegrationInSubFrames: prefs.nodeIntegrationInSubFrames, preload: prefs.preload ?? null, webviewTag: prefs.webviewTag },
        // What the page itself sees: no Node, no preload bridge.
        pageGlobals: await wc.executeJavaScript('[typeof require, typeof process, typeof module, typeof window.electron, typeof window.motionStudio].join()'),
        processSandboxed: metric?.sandboxed ?? null,
        visible: rw.win.isVisible(), offscreen: wc.isOffscreen(), painting: wc.isPainting(), persistent: ses.isPersistent(), separate: ses !== session.defaultSession,
        proxy: {
          internet: await ses.resolveProxy('https://example.com/'),
          server: await ses.resolveProxy('http://127.0.0.1:47001/abcdefghijklmnop0123/x'),
          otherLoopback: await ses.resolveProxy('http://127.0.0.1:4318/api/health'),
          localhost: await ses.resolveProxy('http://localhost:47001/'),
        },
        webrtc: wc.getWebRTCIPHandlingPolicy(),
        keptAwake: appKeptAwake(),
        pids: rw.pids().length,
        windowsOpen: liveRenderWindowCount(),
      });
      await rw.close();
      report({ windowsAfterClose: liveRenderWindowCount(), allWindows: BrowserWindow.getAllWindows().length, keptAwake: appKeptAwake() });
      // The destroy()/loadURL race: a fresh window right after a close loads fine.
      const again = await createRenderWindow({ prefix, width: 64, height: 64 });
      report({ freshAfterClose: again.win.webContents.getURL() });
      await again.close();
      return;
    }
    case 'session-rules': {
      // No CDP interception, no CSP: only the session's proxy and webRequest rules (and the WebRTC policy).
      const page = `${c.naked!.origin}/${c.naked!.token}/page.html`;
      let controlWorkers: ReturnType<typeof watchServiceWorkers> | undefined;
      // The service workers of each window are watched for its whole life, not read once at the end: Chromium stops an idle
      // worker after 30 s, and the control's load-stretched settle (up to 36 s) outlived the page's worker.
      const control = await loadIn(`ms-test-control-${Date.now()}`, page, (ses) => { controlWorkers = watchServiceWorkers(ses); });
      const controlLoaded = Date.now();
      await controlSettle(6000);
      const controlSw = controlWorkers!.stop();
      await close(control);
      report({ phase: 'control-sw', ...controlSw, settledMs: Date.now() - controlLoaded, load: loadavg()[0] });
      report({ phase: 'control-done' });
      const rw = await createRenderWindow({ prefix: `${c.naked!.origin}/${c.naked!.token}/`, width: 800, height: 600 });
      const lockedWorkers = watchServiceWorkers(rw.win.webContents.session);
      await rw.win.loadURL(page).catch(() => {});
      const opened = rw.win.webContents.getURL();
      await settle(6000);
      const frames = rw.win.webContents.mainFrame.framesInSubtree.length;
      // The page registers a service worker on the allowed prefix: the session refuses its script, so none ever runs.
      const { serviceWorkers, swEvents } = lockedWorkers.stop();
      await rw.close();
      report({ phase: 'locked-done', opened, frames, serviceWorkers, swEvents });
      return;
    }
    case 'render': {
      const provider = new ElectronProvider({ maxWindows: c.parallel ?? 2, limits: { timeLimitMs: 30 * 60_000 } });
      const t0 = Date.now();
      const r = await renderComposition({
        dir: c.creative!, versionDir: 'outputs/v1', composition: c.composition!, format: formatOf(c.composition!, c.format!), out: c.out!,
        provider, parallel: c.parallel ?? 2, signal: new AbortController().signal, distDir: c.dist, ffmpeg: c.ffmpeg!, encoder: 'libx264',
        tempDir: scratch,
      });
      report({ ok: true, frames: r.frames, width: r.width, height: r.height, warnings: r.warnings, ms: Date.now() - t0, windowsAfter: liveRenderWindowCount(), peak: provider.peakMemory });
      return;
    }
    case 'frames': {
      // A storyboard as the app asks for one (renderFrames, purpose `frames`, a smaller capture): after decision 1348 the
      // windows paint no `paint` events; each frame must still show its own time.
      const provider = new ElectronProvider({ limits: { timeLimitMs: 30 * 60_000 } });
      const r = await renderFrames({
        dir: c.creative!, versionDir: 'outputs/v1', composition: c.composition!, format: formatOf(c.composition!, c.format!), times: c.frames!.times,
        width: c.frames!.width, imageFormat: 'png', provider, signal: new AbortController().signal, distDir: c.dist,
      });
      report({ errors: r.errors, frames: r.frames.map((f) => ({ t: f.t, width: f.width, height: f.height, png: f.data.toString('base64') })), windowsAfter: liveRenderWindowCount() });
      return;
    }
    case 'render-cost': {
      // Decision 1348: what a render costs the main process (offscreen windows hand their frames to it) and the machine,
      // at 1x and at a scale, with the default parallel pages: wall time, main-process CPU (process.cpuUsage), its peak RSS
      // sampled every 100 ms. `painting` restores the paint events the render windows stop (the cost before decision 1348), `frameRate` lowers them.
      for (const run of c.costRuns!) {
        const provider = new ElectronProvider({
          limits: { timeLimitMs: 30 * 60_000 },
          ...(run.frameRate !== undefined || run.painting ? { createWindow: async (o) => {
            const rw = await createRenderWindow(o);
            if (run.frameRate !== undefined) rw.win.webContents.setFrameRate(run.frameRate);
            if (run.painting) rw.win.webContents.startPainting();
            return rw;
          } } : {}),
        });
        let rss = 0;
        const timer = setInterval(() => { rss = Math.max(rss, process.memoryUsage().rss); }, 100);
        const [cpu0, t0] = [process.cpuUsage(), Date.now()];
        const r = await renderComposition({
          dir: c.creative!, versionDir: 'outputs/v1', composition: c.composition!, format: formatOf(c.composition!, c.format!), out: join(scratch, `${run.name}.mp4`),
          provider, signal: new AbortController().signal, distDir: c.dist, ffmpeg: c.ffmpeg!, encoder: 'libx264', tempDir: scratch,
          ...(run.short !== undefined ? { short: run.short } : {}),
        });
        clearInterval(timer);
        const cpu = process.cpuUsage(cpu0);
        report({ cost: run.name, frames: r.frames, width: r.width, height: r.height, ms: Date.now() - t0, mainCpuMs: Math.round((cpu.user + cpu.system) / 1000), mainRssPeakMB: Math.round(rss / 2 ** 20), windowsAfter: liveRenderWindowCount() });
      }
      return;
    }
    case 'ui-load': {
      for (const run of c.uiRuns!) report({ uiLoad: run.name, ...(await uiLoadRun(c, run)) });
      return;
    }
    case 'hostile-render': {
      // All layers: the composition server (CSP), CDP interception, the session rules. Seek past the delayed navigation.
      const server = await startCompositionServer({ uiOrigins: [], distDir: c.dist });
      const provider = new ElectronProvider({ limits: { timeLimitMs: 30 * 60_000 } });
      try {
        const s = await server.mintSession({ creativeDir: c.creative!, versionDir: 'outputs/v1', format: c.format!, composition: c.composition!, mode: 'render' });
        const page = await provider.open({ width: c.composition!.width, height: c.composition!.height, url: s.url, signal: new AbortController().signal });
        const seeks: string[] = [];
        for (const t of [0, 1, 1.6, 1.9]) seeks.push(await page.seek(t).then(() => 'ok', (e: Error) => e.message.slice(0, 80)));
        const png = await page.capture('png');
        // Display media, with a user gesture (so the session's handler is really asked): refused cleanly.
        const win = BrowserWindow.getAllWindows()[0]!;
        const displayMedia = await win.webContents.executeJavaScript("navigator.mediaDevices.getDisplayMedia({ video: true }).then(() => 'granted', (e) => e.name)", true)
          .catch((e: Error) => `threw: ${e.message}`);
        await settle(3000);
        report({ seeks, captured: png.length > 100, failure: provider.failure, errors: page.info.errors.map((e) => e.code), displayMedia });
      } finally {
        await provider.close();
        await server.close();
      }
      report({ windowsAfter: liveRenderWindowCount() });
      return;
    }
    case 'preview': {
      // The UI-like page frames the real preview (composition server, preview mode) and, directly, every hostile layer of
      // a server without CSP (the residual). Control first (no filter), then the UI session with the filter.
      const ui = c.ui!;
      const control = await loadIn(`ms-test-ui-control-${Date.now()}`, ui.all, () => {});
      await controlSettle(7000);
      const controlFrames = control.webContents.mainFrame.framesInSubtree.length;
      await close(control);
      report({ phase: 'control-done', controlFrames });
      // The UI window as the app sets it up: the filter on its session (pinned to that phase's composition server), the
      // WebRTC policy. Never the will-frame-navigate guard: the filter alone is under test.
      for (const [phase, page, comp] of [['real-done', ui.real, ui.realComposition], ['naked-done', ui.naked, ui.nakedComposition], ['inherit-done', ui.inherit, ui.nakedComposition]] as const) {
        const win = await loadIn(`ms-test-ui-${phase}-${Date.now()}`, page, (ses) => installPreviewFilter(ses, { appOrigin: ui.origin, compositionOrigin: () => comp }), true);
        await settle(7000);
        const frames = win.webContents.mainFrame.framesInSubtree.map((f) => f.url);
        const webTransport = await win.webContents.executeJavaScript('typeof WebTransport').catch((e: Error) => e.message);
        await close(win);
        report({ phase, frames, webTransport });
      }
      return;
    }
    case 'lifecycle': {
      const comp = c.composition!;
      const server = await startCompositionServer({ uiOrigins: [], distDir: c.dist });
      const s = await server.mintSession({ creativeDir: c.creative!, versionDir: 'outputs/v1', format: c.format!, composition: comp, mode: 'render' });
      const open = (p: ElectronProvider, signal = new AbortController().signal) => p.open({ width: comp.width, height: comp.height, url: s.url, signal });
      try {
        // App quit: every render window of every provider closes, and their renderers are gone.
        const a = new ElectronProvider({ limits: { timeLimitMs: 30 * 60_000 } });
        const b = new ElectronProvider({ limits: { timeLimitMs: 30 * 60_000 } });
        const pages = await Promise.all([open(a), open(a), open(b)]);
        const pids = BrowserWindow.getAllWindows().flatMap((w) => [w.webContents.getOSProcessId()]);
        report({ phase: 'opened', windows: liveRenderWindowCount(), pages: pages.length, pids: pids.length });
        await closeAllRenderWindows();
        await settle(1500);
        report({ phase: 'quit', windows: liveRenderWindowCount(), allWindows: BrowserWindow.getAllWindows().length, alive: pids.filter(alive).length });
        await a.close(); await b.close();

        // Cancel: aborting closes the window of a page being opened and the open fails as cancelled.
        const p = new ElectronProvider({ limits: { timeLimitMs: 30 * 60_000 } });
        const ac = new AbortController();
        const pending = open(p, ac.signal);
        setTimeout(() => ac.abort(), 50);
        const cancelled = await pending.then(() => 'opened', (e: unknown) => (e instanceof RenderError ? e.code : String(e)));
        await p.close();
        report({ phase: 'cancel', cancelled, windows: liveRenderWindowCount() });

        // Time limit: the watchdog fails the provider and closes its windows.
        const slow = new ElectronProvider({ limits: { timeLimitMs: 1500 } });
        const page = await open(slow);
        const wpid = BrowserWindow.getAllWindows()[0]?.webContents.getOSProcessId() ?? 0;
        await settle(4000);
        const afterTrip = await page.seek(0.5).then(() => 'ok', (e: unknown) => (e instanceof RenderError ? e.code : (e as Error).message.slice(0, 60)));
        report({ phase: 'time', failure: slow.failure?.code ?? null, seek: afterTrip, windows: liveRenderWindowCount(), alive: wpid > 0 && alive(wpid) });
        await slow.close();

        // Window cap: one more page than the provider allows is refused.
        const capped = new ElectronProvider({ maxWindows: 1, limits: { timeLimitMs: 30 * 60_000 } });
        await open(capped);
        const refused = await open(capped).then(() => 'opened', (e: Error) => e.message);
        await capped.close();
        report({ phase: 'cap', refused, windows: liveRenderWindowCount() });
      } finally {
        await closeAllRenderWindows();
        await server.close();
      }
      return;
    }
    case 'quit': {
      // Quit during a render, through the app's quit sequence (shutdownForQuit, as main.ts's before-quit runs it). The
      // core is stood in for by its close(): cancel the render (the core's preClose cancels every job) and wait for it.
      const provider = new ElectronProvider({ maxWindows: 2, limits: { timeLimitMs: 30 * 60_000 } });
      const ac = new AbortController();
      let frames = 0;
      const outcome = renderComposition({
        dir: c.creative!, versionDir: 'outputs/v1', composition: c.composition!, format: formatOf(c.composition!, c.format!), out: c.out!,
        provider, parallel: 2, signal: ac.signal, distDir: c.dist, ffmpeg: c.ffmpeg!, encoder: 'libx264', tempDir: scratch,
        onProgress: (p) => { frames = p.frames; },
      }).then(() => 'rendered', (e: unknown) => (e instanceof RenderError ? e.code : String(e)));
      const started = Date.now();
      while (frames < 3 && Date.now() - started < 300_000) await settle(200);
      const windowsBefore = liveRenderWindowCount();
      const quit = new Promise<void>((resolve) => {
        app.once('before-quit', (e) => {
          e.preventDefault();
          void shutdownForQuit({ closeServer: async () => { ac.abort(); await outcome; } }).then(resolve);
        });
      });
      app.quit();
      await quit;
      const dir = dirname(c.out!);
      const temps = readdirSync(dir).filter((n) => n.startsWith(`.${basename(c.out!)}.render-`));
      const workDirs = readdirSync(scratch).filter((n) => n.startsWith('ms-render-'));
      report({ phase: 'quit', framesAtQuit: frames, windowsBefore, result: await outcome, windows: liveRenderWindowCount(), allWindows: BrowserWindow.getAllWindows().length, out: existsSync(c.out!), temps, workDirs });
      return;
    }
    case 'scale': {
      // Report 51: pages through the provider, as a render opens them (`deviceScaleFactor` at a scale, none at 1). Each
      // reports the layer frame's devicePixelRatio and process, the page's, and the PNG at `t`.
      const server = await startCompositionServer({ uiOrigins: [], distDir: c.dist });
      try {
        for (const p of c.scalePages!) {
          const provider = new ElectronProvider({ limits: { timeLimitMs: 30 * 60_000 } });
          try {
            const s = await server.mintSession({ creativeDir: c.creative!, versionDir: 'outputs/v1', format: p.format, composition: p.composition, mode: 'render' });
            const page = await provider.open({ width: p.composition.width, height: p.composition.height, url: s.url, signal: new AbortController().signal, ...(p.scale !== undefined ? { deviceScaleFactor: p.scale } : {}) });
            await page.seek(p.t ?? 0);
            const png = await page.capture('png');
            const wc = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === s.url)!.webContents;
            const layers = [];
            for (const f of wc.mainFrame.framesInSubtree) {
              if (!f.url.includes('/layers/')) continue;
              layers.push({ outOfProcess: f.osProcessId !== wc.mainFrame.osProcessId, ...(await f.executeJavaScript('({ dpr: devicePixelRatio, inner: [innerWidth, innerHeight] })') as object) });
            }
            const top = await wc.executeJavaScript('({ dpr: devicePixelRatio, inner: [innerWidth, innerHeight] })');
            // Decision 1348: still no paint events once the window shows the composition (a navigation does not restart them).
            report({ page: p.name, errors: page.info.errors.length, top, layers, painting: wc.isPainting(), png: png.toString('base64') });
          } finally {
            await provider.close();
          }
        }
      } finally {
        await server.close();
      }
      return;
    }
    case 'raw-render': {
      // The test's FfmpegInfo lost its encoder set in JSON: the standard quality's `auto` encoder needs it.
      const ff = (await findFfmpeg()) ?? c.ffmpeg!;
      // Report 53: renders at quality max (PNG frames when encoded), with the provider's raw frames or without them
      // (`encoded`: the pages lose `captureRaw`); every frame read is counted by kind.
      for (const run of c.rawRuns!) {
        const provider = new ElectronProvider({ limits: { timeLimitMs: 30 * 60_000 } });
        const counts = countFrames(provider, run.encoded === true);
        const r = await renderComposition({
          dir: c.creative!, versionDir: 'outputs/v1', composition: run.background ? { ...c.composition!, background: run.background } : c.composition!, format: formatOf(c.composition!, c.format!), out: join(c.out ?? scratch, `${run.name}.mp4`),
          provider, parallel: 2, signal: new AbortController().signal, distDir: c.dist, ffmpeg: ff, quality: run.quality ?? 'max', tempDir: scratch,
          ...(run.short !== undefined ? { short: run.short } : {}),
        });
        report({ raw: run.name, frames: r.frames, width: r.width, height: r.height, sha256: r.sha256, ...counts, windowsAfter: liveRenderWindowCount() });
      }
      // Report 56: the provider's checks of raw frames against PNG frames, by scale.
      report({ rawChecks: await rawFrameChecks() });
      return;
    }
    case 'raw-check': {
      // Report 56: one page, and at each time the raw frame and the PNG of the same state, compared byte for byte (the
      // PNG decoded to BGRA). The raw frame is read as a render reads it, right after the seek; then raw again, after the
      // PNG. (Report 56 read it with the renderers stopped; the raw read now makes the renderer draw first, report 57.)
      const server = await startCompositionServer({ uiOrigins: [], distDir: c.dist });
      const provider = new ElectronProvider({ limits: { timeLimitMs: 30 * 60_000 } });
      try {
        const comp = c.composition!;
        const s = await server.mintSession({ creativeDir: c.creative!, versionDir: 'outputs/v1', format: c.format!, composition: comp, mode: 'render' });
        const page = await provider.open({ width: comp.width, height: comp.height, url: s.url, signal: new AbortController().signal, rawFrames: true });
        if (!page.captureRaw) throw new Error('raw-check: the page has no raw frames');
        const rows: unknown[] = [];
        for (const t of c.rawCheck!.times) {
          await page.seek(t);
          const raw = (await page.captureRaw()).data;
          const png = nativeImage.createFromBuffer(await page.capture('png')).toBitmap();
          const again = (await page.captureRaw()).data;
          rows.push({ t, raw: frameDiff(raw, png), again: frameDiff(again, png) });
        }
        // Report 57: a raw read must show the page as it is when the read is asked for, even when the compositor lags.
        // The page changes (a square in its corner, a new colour each time) with no frame waited for, and is read raw at
        // once, while this app's GPU process (its own pid, `getAppMetrics`) is stopped 8 ms in every 10 (always resumed).
        const wc = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === s.url)!.webContents;
        const gpu = app.getAppMetrics().find((m) => m.type === 'GPU')?.pid;
        let stall: NodeJS.Timeout | null = null;
        const changes: Array<{ i: number; want: number[]; got: number[] }> = [];
        try {
          if (gpu) stall = setInterval(() => { try { process.kill(gpu, 'SIGSTOP'); setTimeout(() => { try { process.kill(gpu, 'SIGCONT'); } catch { /* gone */ } }, 8); } catch { /* gone */ } }, 10);
          for (let i = 0; i < c.rawCheck!.changes; i++) {
            const want = [(i * 37) % 256, 255 - ((i * 37) % 256), 128];
            await wc.executeJavaScript(`{ let d = document.getElementById('ms-test-change'); if (!d) { d = document.createElement('div'); d.id = 'ms-test-change'; d.style.cssText = 'position:fixed;left:0;top:0;width:16px;height:16px;z-index:2147483647'; document.documentElement.appendChild(d); } d.style.background = 'rgb(${want.join(',')})'; } 1`);
            const f = await page.captureRaw();
            const got = [f.data[8 * f.width * 4 + 8 * 4 + 2]!, f.data[8 * f.width * 4 + 8 * 4 + 1]!, f.data[8 * f.width * 4 + 8 * 4]!];
            changes.push({ i, want, got });
          }
        } finally {
          if (stall) clearInterval(stall);
          if (gpu) try { process.kill(gpu, 'SIGCONT'); } catch { /* gone */ }
        }
        report({ rawCheck: rows, changes, gpu: gpu ?? null });
        await page.close();
      } finally {
        await provider.close();
        await server.close();
      }
      return;
    }
    case 'css-pause': {
      // Report 56: a page whose CSS animation (a box moving 100 px/s, on the compositor) starts on load, paused at 0 right
      // after the load (often still play-pending) as the layer agent's seek does: plainly (pause, currentTime) and with
      // its `settleAnimations`; where the box is on the surface for each, after the seek's frames.
      const html = '<!doctype html><style>html,body{margin:0;background:#000}#b{position:absolute;left:0;top:0;width:20px;height:20px;background:#fff;animation:go 2s linear forwards}'
        + '@keyframes go{from{transform:translateX(0)}to{transform:translateX(200px)}}</style><div id="b"></div>';
      const { pause, settle: settleSrc } = c.cssPause!;
      const boxAt = async (wc: Electron.WebContents) => {
        const img = await wc.capturePage(undefined, { stayHidden: true });
        const b = img.toBitmap();
        const w = img.getSize().width;
        // The box's left edge on row 10 in hundredths of a pixel: its centre of mass (anti-aliased edges included) less 9.5.
        let sum = 0, moment = 0;
        for (let x = 0; x < w; x++) { const g = b[(10 * w + x) * 4 + 1]! / 255; sum += g; moment += g * x; }
        return Math.round(100 * (moment / sum - 9.5));
      };
      const rows: unknown[] = [];
      for (let i = 0; i < c.cssPause!.runs; i++) {
        for (const mode of ['plain', 'settled'] as const) {
          const win = await loadIn(`css-${mode}-${i}`, `data:text/html,${encodeURIComponent(html)}`, () => {});
          win.webContents.stopPainting();
          const pending = await win.webContents.executeJavaScript(`(async () => {
            const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
            const two = async () => { await frame(); await frame(); };
            const pending = document.getAnimations().some((a) => a.pending);
            const started = (${pause})(document, 0);
            await two();
            if (${JSON.stringify(mode)} === 'settled') { await (${settleSrc})(started, 0, frame); await two(); }
            return pending;
          })()`) as boolean;
          rows.push({ mode, pending, box: await boxAt(win.webContents) });
          await close(win);
        }
      }
      report({ cssPause: rows });
      return;
    }
    case 'capture-probe': {
      const server = await startCompositionServer({ uiOrigins: [], distDir: c.dist });
      const provider = new ElectronProvider({ limits: { timeLimitMs: 30 * 60_000 } });
      try {
        const comp = c.composition!;
        const s = await server.mintSession({ creativeDir: c.creative!, versionDir: 'outputs/v1', format: c.format!, composition: comp, mode: 'render' });
        const scale = c.probe!.scale;
        const page = await provider.open({ width: comp.width, height: comp.height, url: s.url, signal: new AbortController().signal, ...(scale !== 1 ? { deviceScaleFactor: scale } : {}) });
        const wc = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === s.url)!.webContents;
        const times = c.probe!.times;
        const out: Record<string, unknown> = {};
        // jpeg1, barrier (report 57): a JPEG at quality 1 alone, and as the redraw before a raw read.
        for (const mode of ['png', 'jpeg', 'raw', 'jpeg1', 'barrier'] as const) {
          await contentTracing.startRecording({ included_categories: ['toplevel'], excluded_categories: ['*'] });
          const t0 = Date.now();
          let i = 0;
          for (const t of times) {
            await page.seek(t);
            if (mode === 'raw' || mode === 'barrier') {
              if (mode === 'barrier') await page.capture('jpeg', 1);
              const img = await wc.capturePage(undefined, { stayHidden: true });
              const bmp = img.toBitmap();
              if (i < 2) { writeFileSync(join(c.probe!.outDir, `raw-${i}.bgra`), bmp); out[`size${i}`] = img.getSize(); }
            } else {
              const buf = await page.capture(mode === 'jpeg1' ? 'jpeg' : mode, mode === 'jpeg' ? 95 : mode === 'jpeg1' ? 1 : undefined);
              if (i < 2 && mode === 'png') writeFileSync(join(c.probe!.outDir, `png-${i}.png`), buf);
            }
            i++;
          }
          const ms = Date.now() - t0;
          out[mode] = { ms, perFrame: Math.round(ms / times.length), ui: longMainTasks(await contentTracing.stopRecording(join(scratch, `${mode}.json`)), process.pid, 0) };
        }
        report({ probe: out, painting: wc.isPainting() });
      } finally {
        await provider.close();
        await server.close();
      }
      return;
    }
    case 'memory': {
      const provider = new ElectronProvider({ maxWindows: 1, limits: { timeLimitMs: 30 * 60_000, maxProcessMB: 700 } });
      const r = await renderComposition({
        dir: c.creative!, versionDir: 'outputs/v1', composition: c.composition!, format: formatOf(c.composition!, c.format!), out: c.out!,
        provider, parallel: 1, signal: new AbortController().signal, distDir: c.dist, ffmpeg: c.ffmpeg!, encoder: 'libx264', tempDir: scratch,
      }).then(() => 'rendered', (e: unknown) => (e instanceof RenderError ? e.code : String(e)));
      report({ result: r, peak: provider.peakMemory, windowsAfter: liveRenderWindowCount() });
      return;
    }
  }
}

app.dock?.hide();
// The harness's own windows (controls, the UI-like page) are hidden too: keep macOS App Nap off for the whole run (the
// provider holds its own blocker only while render windows are open).
void app.whenReady().then(() => powerSaveBlocker.start('prevent-app-suspension'));
// Hidden windows only: the harness must not end when none is open.
app.on('window-all-closed', () => {});
void app.whenReady().then(() => go).then(run).then(
  async () => { await closeAllRenderWindows(); report({ done: true }); app.exit(0); },
  async (e: unknown) => { report({ error: e instanceof Error ? `${e.name}: ${e.message}` : String(e), code: (e as { code?: unknown }).code ?? null }); await closeAllRenderWindows(); app.exit(1); },
);
