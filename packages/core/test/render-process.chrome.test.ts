// @vitest-environment node
/**
 * Process leaks and the watchdog (plan Review Focus 2 and 1, spec §5.2 layer 4), in real Chrome and ffmpeg:
 * - cancel mid-render, a renderer crash, ffmpeg exiting with an error, a 2 GB ArrayBuffer in a layer and an infinite loop
 *   in a layer's seek each fail the render with their own reason;
 * - after each, `ps` finds nothing of the browser's process group, no ffmpeg of the render (its temp folder is unique per
 *   test), no output and no temp file next to it; the work folder is gone;
 * - a retry after a failure starts clean and succeeds.
 * Skipped without Chrome or ffmpeg, unless MS_REQUIRE_CHROME=1 (CI).
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Composition, FormatPreset } from '@motion-studio/shared';
import { ChromeProvider, RenderError } from '../src/render/chromium-provider.ts';
import { renderComposition, type RenderCompositionOptions } from '../src/render/renderer.ts';
import { listProcesses } from '../src/render/watchdog.ts';
import { buildRuntime, frameCodedVideo, leftovers, put, renderTools } from './helpers/render-env.ts';

const tools = await renderTools('renderer process tests');
const W = 320, H = 180;
const VERSION_DIR = 'outputs/v1';

/** A layer that allocates 2 GB of ArrayBuffers (outside the V8 heap: --max-old-space-size does not stop it) once seeked past 0.1 s. */
const MEM_LAYER = `<!doctype html><html><body><script>
window.msReady = Promise.resolve();
const keep = [];
window.msSeek = (t) => { if (t >= 0.1 && keep.length === 0) { for (let i = 0; i < 32; i++) { const a = new Uint8Array(64 * 1024 * 1024); for (let j = 0; j < a.length; j += 4) a[j] = (j * 2654435761) & 255; keep.push(a); } } };
</script></body></html>`;
/** A layer whose seek never returns once past 0.1 s. */
const CPU_LAYER = `<!doctype html><html><body><script>
window.msReady = Promise.resolve();
window.msSeek = (t) => { if (t >= 0.1) { for (;;) {} } };
</script></body></html>`;

/** A layer whose every seek burns CPU for a while (a busy loop: timers and clocks are virtual in a layer). */
const SLOW_LAYER = `<!doctype html><html><body><script>
window.msReady = Promise.resolve();
window.msSeek = () => { let x = 0; for (let i = 0; i < 3e8; i++) x += i; window.__x = x; };
</script></body></html>`;

describe.skipIf(!tools.ok)('renderer: processes, cancel, crash, watchdog', () => {
  let work: string;
  let dist: string;
  let creative: string;

  const format = (id: string): FormatPreset => ({ id, channel: 'Test', name: id, width: W, height: H, kind: 'video', extensions: ['mp4'], targetBitrateKbps: 800 });
  const composition = (duration: number, extra: unknown[] = []): Composition => ({
    $schema: 'motion-studio/composition@1', width: W, height: H, fps: 30, duration, background: '#101010', fonts: [],
    scenes: [{ id: 'all', start: 0, duration }],
    tracks: [
      { id: 'v', kind: 'video', clips: [{ id: 'v', type: 'video', src: 'assets/v.mp4', start: 0, duration, sourceFps: 30, props: { x: 0, y: 0, width: W, height: H } }] },
      ...extra,
    ],
  } as unknown as Composition);
  const layerTrack = (src: string, duration: number) => ({ id: 'l', kind: 'visual', clips: [{ id: 'l', type: 'html', src, start: 0, duration, props: { x: 0, y: 0, width: 80, height: 80 } }] });

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'ms-render-proc-'));
    dist = join(work, 'dist');
    await buildRuntime(dist);
    creative = join(work, 'creative');
    for (const id of ['slow', 'mem', 'cpu', 'retry']) {
      const dir = join(creative, VERSION_DIR, 'compositions', id);
      frameCodedVideo(tools.ffmpeg!, join(dir, 'assets', 'v.mp4'), { fps: 30, frames: 95 });
      mkdirSync(join(dir, 'layers'), { recursive: true });
    }
    put(join(creative, VERSION_DIR, 'compositions', 'mem', 'layers', 'mem.html'), MEM_LAYER);
    put(join(creative, VERSION_DIR, 'compositions', 'cpu', 'layers', 'cpu.html'), CPU_LAYER);
    put(join(creative, VERSION_DIR, 'compositions', 'retry', 'layers', 'slow.html'), SLOW_LAYER);
  }, 600_000);

  afterAll(() => { if (work) rmSync(work, { recursive: true, force: true }); });

  /** Runs one render with its own temp folder; returns the error (or null), the provider and the temp folder. */
  async function attempt(id: string, comp: Composition, o: Partial<RenderCompositionOptions> & { provider?: ChromeProvider; onFrame?: (n: number, p: ChromeProvider, ac: AbortController) => void } = {}) {
    const temp = join(work, `tmp-${id}-${Date.now()}`);
    mkdirSync(temp);
    const provider = o.provider ?? new ChromeProvider({ exe: tools.chrome!.exe, kind: 'system', limits: { timeLimitMs: 20 * 60_000 } });
    const ac = new AbortController();
    const out = join(creative, VERSION_DIR, `${id}.mp4`);
    let error: unknown = null;
    const t0 = Date.now();
    try {
      await renderComposition({
        dir: creative, versionDir: VERSION_DIR, composition: comp, format: format(id), out, provider, parallel: 2, signal: ac.signal,
        distDir: dist, ffmpeg: tools.ffmpeg!, encoder: 'libx264', tempDir: temp,
        onProgress: (p) => o.onFrame?.(p.frames, provider, ac), ...o,
      });
    } catch (e) { error = e; }
    if (process.env.MS_RENDER_DEBUG) console.info(`[render] ${id}: ${((Date.now() - t0) / 1000).toFixed(1)} s → ${error ? (error as Error).message.slice(0, 80) : 'ok'}`);
    return { error, provider, temp, out };
  }

  async function expectClean(r: { provider: ChromeProvider; temp: string; out: string }, id: string) {
    expect(r.provider.pgid).toBeGreaterThan(1);
    // ps: nothing of the browser's group, nothing using its profile, no ffmpeg writing into this render's temp folder.
    expect(await leftovers({ pgids: [r.provider.pgid!], markers: [r.provider.profileDir!, r.temp] })).toEqual([]);
    expect(readdirSync(r.temp)).toEqual([]);
    expect(readdirSync(join(creative, VERSION_DIR)).filter((f) => f.startsWith(id) || f.startsWith(`.${id}`))).toEqual([]);
  }

  it('cancel mid-render: cancelled, and nothing is left (no process, no output, no temp file)', async () => {
    let ffmpegSeen = false;
    const r = await attempt('slow', composition(3), {
      onFrame: (n, _p, ac) => {
        if (n === 12) {
          // Cancel once ps has seen this render's segment encoders running.
          void listProcesses().then((rows) => { ffmpegSeen = rows.some((x) => /ffmpeg/.test(x.command) && x.command.includes('tmp-slow-')); ac.abort(); });
        }
      },
    });
    expect(r.error).toBeInstanceOf(RenderError);
    expect((r.error as RenderError).code).toBe('cancelled');
    expect(ffmpegSeen).toBe(true); // the segment encoders were running when it was cancelled
    await expectClean(r, 'slow');
  }, 900_000);

  it('a renderer crash: crashed, and nothing is left', async () => {
    let killed = 0;
    const r = await attempt('slow', composition(3), {
      onFrame: (n, p) => {
        if (n !== 10) return;
        void listProcesses().then((rows) => {
          for (const x of rows) if (x.pgid === p.pgid && x.command.includes('--type=renderer')) { try { process.kill(x.pid, 'SIGKILL'); killed++; } catch { /* gone */ } }
        });
      },
    });
    expect(killed).toBeGreaterThan(0);
    expect((r.error as RenderError).code).toBe('crashed');
    await expectClean(r, 'slow');
  }, 900_000);

  it('ffmpeg exiting with an error: ffmpegFailed, and nothing is left', async () => {
    const r = await attempt('slow', composition(1), { x264Preset: 'no-such-preset' });
    expect((r.error as RenderError).code).toBe('ffmpegFailed');
    expect((r.error as RenderError).message).toMatch(/ffmpeg exited with/);
    await expectClean(r, 'slow');
  }, 900_000);

  it('a 2 GB ArrayBuffer in a layer trips the memory watchdog, which kills the browser group', async () => {
    const r = await attempt('mem', composition(1, [layerTrack('layers/mem.html', 1)]));
    expect((r.error as RenderError).code).toBe('memoryLimit');
    console.info(`[render] memory watchdog: ${(r.error as Error).message}; peak ${JSON.stringify(r.provider.peakMemory)}`);
    await expectClean(r, 'mem');
  }, 900_000);

  it('an infinite loop in a layer: the frame times out (Runtime.evaluate timeout), and nothing is left', async () => {
    const provider = new ChromeProvider({ exe: tools.chrome!.exe, kind: 'system', limits: { timeLimitMs: 20 * 60_000 }, timeouts: { frameMs: 20_000 } });
    const t0 = Date.now();
    const r = await attempt('cpu', composition(1, [layerTrack('layers/cpu.html', 1)]), { provider });
    expect((r.error as RenderError).code).toBe('frameTimeout');
    expect(Date.now() - t0).toBeLessThan(10 * 60_000); // generous: the load here is very high
    await expectClean(r, 'cpu');
  }, 900_000);

  it('the time limit of a render fails it as timeLimit, and a retry starts clean and succeeds', async () => {
    let capturing = false;
    const r = await attempt('retry', composition(3, [layerTrack('layers/slow.html', 3)]), { timeLimitMs: 25_000, onFrame: (n) => { if (n > 0) capturing = true; } });
    expect((r.error as RenderError).code).toBe('timeLimit');
    expect(capturing).toBe(true); // it stopped a render that was running
    await expectClean(r, 'retry');
    const ok = await attempt('retry', composition(1));
    expect(ok.error).toBeNull();
    expect(readdirSync(join(creative, VERSION_DIR)).filter((f) => f.includes('retry'))).toEqual(['retry.mp4']);
    expect(await leftovers({ pgids: [ok.provider.pgid!], markers: [ok.provider.profileDir!, ok.temp] })).toEqual([]);
  }, 900_000);
});
