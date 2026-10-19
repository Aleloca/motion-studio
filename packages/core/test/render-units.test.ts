import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Composition } from '@motion-studio/shared';
import type { CdpClient, CdpEvent } from '../src/render/cdp-pipe.ts';
import { allowedPrefix, BASE_FLAGS, interceptRequests, isAllowedRequest, NETWORK_API_GUARD, networkLockdownFlags } from '../src/render/isolation.ts';
import { imageSize, splitSegments } from '../src/render/capture.ts';
import { mixClips, mixGraph } from '../src/render/audio-mix.ts';
import { binaryArch, concatLine, h264Args, targetKbps } from '../src/render/encode.ts';
import { filterArgv } from '../src/media/ffmpeg-filters.ts';
import { startWatchdog, type GroupMemory } from '../src/render/watchdog.ts';
import { chromeCandidates, findSystemChrome } from '../src/render/system-chrome.ts';
import { ChromeProvider } from '../src/render/chromium-provider.ts';

const work = mkdtempSync(join(tmpdir(), 'ms-test-render-units-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd';
const ORIGIN = 'http://127.0.0.1:43210';
const PAGE = `${ORIGIN}/${TOKEN}/runtime/index.html?mode=render`;

describe('isolation rules', () => {
  it('the allowlist is exactly the page origin and token prefix', () => {
    const prefix = allowedPrefix(PAGE);
    expect(prefix).toBe(`${ORIGIN}/${TOKEN}/`);
    for (const ok of [`${ORIGIN}/${TOKEN}/runtime/runtime.js`, `${ORIGIN}/${TOKEN}/v1/compositions/f/assets/a.png?x=1`]) expect(isAllowedRequest(ok, prefix)).toBe(true);
    for (const bad of [
      `${ORIGIN}/other/x`, `${ORIGIN}/${TOKEN}`, `http://127.0.0.1:43211/${TOKEN}/x`, `http://localhost:43210/${TOKEN}/x`,
      `https://127.0.0.1:43210/${TOKEN}/x`, `ws://127.0.0.1:43210/${TOKEN}/x`, `http://user:pw@127.0.0.1:43210/${TOKEN}/x`,
      'file:///etc/hosts', 'data:text/plain,x', `http://canary.test/${TOKEN}/x`, 'not a url',
    ]) expect(isAllowedRequest(bad, prefix), bad).toBe(false);
    expect(() => allowedPrefix('http://example.com/x/y')).toThrow();
    expect(() => allowedPrefix(`${ORIGIN}/short/runtime/index.html`)).toThrow();
  });

  it('the launch flags lock the network to the server port and never disable the sandbox', () => {
    const f = networkLockdownFlags(ORIGIN);
    expect(f).toContain('--proxy-server=http://127.0.0.1:9');
    expect(f).toContain('--proxy-bypass-list=<-loopback>;127.0.0.1:43210');
    expect(f).toContain('--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');
    expect([...BASE_FLAGS, ...f].some((x) => /no-sandbox|disable-setuid-sandbox|remote-debugging-port|disable-web-security/.test(x))).toBe(false);
    expect(BASE_FLAGS).toEqual(expect.arrayContaining(['--disable-background-networking', '--disable-extensions', '--disable-sync', '--no-first-run']));
    expect(() => networkLockdownFlags('http://localhost:4000')).toThrow();
    expect(() => new ChromeProvider({ exe: 'x', kind: 'system', limits: { timeLimitMs: 1 }, extraFlags: ['--no-sandbox'] })).toThrow(/not allowed/);
    expect(() => new ChromeProvider({ exe: 'x', kind: 'system', limits: { timeLimitMs: 1 }, extraFlags: ['--proxy-server=direct://'] })).toThrow(/not allowed/);
    // An allowlist: single-dash and unlisted network or debugging switches are refused too.
    for (const f of ['-no-sandbox', '--no-proxy-server', '--proxy-pac-url=http://x/p.pac', '--proxy-auto-detect', '--remote-debugging-address=0.0.0.0', '--disable-gpu --no-sandbox', '--enable-gpu=1']) {
      expect(() => new ChromeProvider({ exe: 'x', kind: 'system', limits: { timeLimitMs: 1 }, extraFlags: [f] }), f).toThrow(/not allowed/);
    }
    expect(() => new ChromeProvider({ exe: 'x', kind: 'system', limits: { timeLimitMs: 1 }, extraFlags: ['--disable-gpu', '--use-angle=metal'] })).not.toThrow();
  });

  it('report 51: the browser is launched at its first page\'s scale; a page at another scale is refused', async () => {
    const p = new ChromeProvider({ exe: 'x', kind: 'system', limits: { timeLimitMs: 1 } });
    const launches: unknown[][] = [];
    // No real browser: the launch is recorded and gives a browser for the composition server only (no target gate).
    (p as unknown as { launch: (...a: unknown[]) => Promise<unknown> }).launch = async (...a) => { launches.push(a); return { origin: ORIGIN }; };
    const page = (deviceScaleFactor?: number) => ({ width: 320, height: 180, url: `${ORIGIN}/${TOKEN}/runtime/index.html?mode=render`, signal: new AbortController().signal, ...(deviceScaleFactor !== undefined ? { deviceScaleFactor } : {}) });
    await p.open(page(2)).catch(() => {}); // fails later, on the missing gate
    expect(launches).toEqual([[ORIGIN, 2]]);
    for (const k of [undefined, 1, 4 / 3]) await expect(p.open(page(k)), String(k)).rejects.toThrow('render: one provider serves one scale');
    expect(launches).toHaveLength(1);
  });
});

/** A fake CDP transport: records calls, lets the test emit events, fails chosen calls. */
function fakeClient(fail: (method: string, sessionId?: string) => boolean = () => false, reply: (method: string, sessionId?: string) => unknown = (m) => (m === 'Runtime.evaluate' ? { result: { value: true } } : {})) {
  const calls: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
  const listeners = new Set<(e: CdpEvent) => void>();
  const client: CdpClient = {
    closed: null,
    async send(method, params = {}, o = {}) {
      calls.push({ method, params: params as Record<string, unknown>, ...(o.sessionId ? { sessionId: o.sessionId } : {}) });
      if (fail(method, o.sessionId)) throw new Error(`${method} failed`);
      return reply(method, o.sessionId) as never;
    },
    onEvent(l) { listeners.add(l); return () => listeners.delete(l); },
    onClose() { return () => {}; },
  };
  const emit = (e: CdpEvent) => { for (const l of [...listeners]) l(e); };
  return { client, calls, emit };
}
const flush = () => new Promise((r) => setTimeout(r, 10));

describe('request interception (fake CDP)', () => {
  it('enables Fetch on the page and on every child before resuming it; continues allowed requests and fails the rest', async () => {
    const { client, calls, emit } = fakeClient();
    const prefix = allowedPrefix(PAGE);
    const order: string[] = [];
    const ic = await interceptRequests(client, 'P', prefix, { clockSource: '/*clock*/', resume: async () => { order.push(`resume after ${calls.length} calls`); } });
    // The page (a fresh about:blank) runs first; then Fetch and the recursive auto-attach, then the rest.
    expect(order).toEqual(['resume after 0 calls']);
    expect(calls.map((c) => `${c.sessionId}:${c.method}`)).toEqual(['P:Fetch.enable', 'P:Page.addScriptToEvaluateOnNewDocument', 'P:Target.setAutoAttach', 'P:Page.enable']);
    expect(calls[2]!.params).toEqual({ autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    // The injected script disables WebRTC and WebTransport before the clock.
    expect(calls[1]!.params.source).toBe(`${NETWORK_API_GUARD}\n/*clock*/`);
    calls.length = 0;

    // A child (an out-of-process layer) is intercepted and auto-attaching BEFORE it is resumed.
    emit({ method: 'Target.attachedToTarget', sessionId: 'P', params: { sessionId: 'L', targetInfo: { type: 'iframe' } } });
    await flush();
    expect(calls.map((c) => `${c.sessionId}:${c.method}`)).toEqual(['L:Fetch.enable', 'L:Page.enable', 'L:Page.addScriptToEvaluateOnNewDocument', 'L:Target.setAutoAttach', 'L:Runtime.runIfWaitingForDebugger', 'L:Page.enable']);
    calls.length = 0;

    emit({ method: 'Fetch.requestPaused', sessionId: 'L', params: { requestId: 'r1', resourceType: 'Script', request: { url: `${prefix}runtime/layer.js` } } });
    emit({ method: 'Fetch.requestPaused', sessionId: 'L', params: { requestId: 'r2', resourceType: 'Document', request: { url: 'http://127.0.0.1:5555/selfnav-replace' } } });
    emit({ method: 'Fetch.requestPaused', sessionId: 'X', params: { requestId: 'r3', request: { url: 'http://evil/' } } }); // not our session: ignored
    emit({ method: 'Page.javascriptDialogOpening', sessionId: 'L', params: {} });
    await flush();
    expect(calls).toEqual([
      { method: 'Fetch.continueRequest', params: { requestId: 'r1' }, sessionId: 'L' },
      { method: 'Fetch.failRequest', params: { requestId: 'r2', errorReason: 'BlockedByClient' }, sessionId: 'L' },
      { method: 'Page.handleJavaScriptDialog', params: { accept: false }, sessionId: 'L' },
    ]);
    expect(ic.blocked).toEqual([{ url: 'http://127.0.0.1:5555/selfnav-replace', type: 'Document' }]);
    expect(ic.failure).toBeNull();
  });

  it('a frame that cannot be intercepted is never resumed and fails the render (fail closed); a worker needs no Fetch', async () => {
    const { client, calls, emit } = fakeClient((m, s) => m === 'Fetch.enable' && s !== 'P');
    const failures: Error[] = [];
    const ic = await interceptRequests(client, 'P', allowedPrefix(PAGE), { onFailure: (e) => failures.push(e) });
    calls.length = 0;
    emit({ method: 'Target.attachedToTarget', sessionId: 'P', params: { sessionId: 'W', targetInfo: { type: 'worker', targetId: 'tw' } } });
    emit({ method: 'Target.attachedToTarget', sessionId: 'P', params: { sessionId: 'F', targetInfo: { type: 'iframe', targetId: 'tf' } } });
    await flush();
    expect(calls.filter((c) => c.method === 'Runtime.runIfWaitingForDebugger').map((c) => c.sessionId)).toEqual(['W']);
    expect(calls.filter((c) => c.method === 'Target.closeTarget').map((c) => c.params.targetId)).toEqual(['tf']);
    expect(ic.failure?.message).toMatch(/could not intercept a iframe/);
    expect(failures).toHaveLength(1);
  });

  it('service and shared workers (and any unknown target type) are closed while paused, never resumed', async () => {
    const { client, calls, emit } = fakeClient();
    const ic = await interceptRequests(client, 'P', allowedPrefix(PAGE));
    calls.length = 0;
    for (const [sid, type] of [['S', 'service_worker'], ['H', 'shared_worker'], ['X', 'auction_worklet']] as const) {
      emit({ method: 'Target.attachedToTarget', sessionId: 'P', params: { sessionId: sid, targetInfo: { type, targetId: `t-${sid}`, url: `${ORIGIN}/${TOKEN}/sw.js` } } });
    }
    await flush();
    expect(calls).toEqual(['S', 'H', 'X'].map((sid) => ({ method: 'Target.closeTarget', params: { targetId: `t-${sid}` } })));
    expect(ic.refused.map((r) => r.type)).toEqual(['service_worker', 'shared_worker', 'auction_worklet']);
    expect(ic.failure).toBeNull();
  });

  it('a dedicated worker gets the guard while paused; if it throws, reports an exception or does not end with every API gone, the worker is closed, never resumed', async () => {
    const cases: Array<[string, (m: string, s?: string) => boolean, (m: string, s?: string) => unknown]> = [
      ['the evaluation fails', (m) => m === 'Runtime.evaluate', () => ({})],
      ['an exception', () => false, (m) => (m === 'Runtime.evaluate' ? { exceptionDetails: { text: 'boom' } } : {})],
      ['false: a failure swallowed by its own try/catch', () => false, (m) => (m === 'Runtime.evaluate' ? { result: { value: false } } : {})],
      ['no value', () => false, () => ({})],
    ];
    for (const [name, fail, reply] of cases) {
      const { client, calls, emit } = fakeClient(fail, reply);
      const ic = await interceptRequests(client, 'P', allowedPrefix(PAGE));
      calls.length = 0;
      emit({ method: 'Target.attachedToTarget', sessionId: 'P', params: { sessionId: 'W', targetInfo: { type: 'worker', targetId: 'tw' } } });
      await flush();
      expect(calls.find((c) => c.method === 'Runtime.evaluate')?.params.expression, name).toBe(NETWORK_API_GUARD);
      expect(calls.some((c) => c.method === 'Runtime.runIfWaitingForDebugger'), name).toBe(false);
      expect(calls.filter((c) => c.method === 'Target.closeTarget').map((c) => c.params.targetId), name).toEqual(['tw']);
      expect(ic.refused, name).toEqual([{ type: 'worker', url: '' }]);
    }
    // The guard itself evaluates to true once every API is gone.
    const scope: Record<string, unknown> = { RTCPeerConnection: class {}, WebTransport: class {} };
    expect(new Function('globalThis', `return ${NETWORK_API_GUARD.replace(/;$/, '')}`)(scope)).toBe(true);
    expect(scope.RTCPeerConnection).toBeUndefined();
    const frozen = Object.freeze({ WebTransport: class {} });
    expect(new Function('globalThis', `return ${NETWORK_API_GUARD.replace(/;$/, '')}`)(frozen)).toBe(false);
  });

  it('a refused target that is already gone counts as closed', async () => {
    const { client, emit } = fakeClient(() => false, (m) => { if (m === 'Target.closeTarget') throw new Error('Target.closeTarget: No target with given id found'); return {}; });
    const ic = await interceptRequests(client, 'P', allowedPrefix(PAGE));
    emit({ method: 'Target.attachedToTarget', sessionId: 'P', params: { sessionId: 'S', targetInfo: { type: 'service_worker', targetId: 't' } } });
    await flush();
    expect(ic.refused.map((r) => r.type)).toEqual(['service_worker']);
    expect(ic.failure).toBeNull();
  });

  it('a refused target that cannot be closed fails the render', async () => {
    const { client, emit } = fakeClient((m) => m === 'Target.closeTarget');
    const ic = await interceptRequests(client, 'P', allowedPrefix(PAGE));
    emit({ method: 'Target.attachedToTarget', sessionId: 'P', params: { sessionId: 'S', targetInfo: { type: 'service_worker', targetId: 't' } } });
    await flush();
    expect(ic.failure?.message).toMatch(/service_worker target .* could not be closed/);
  });
});

describe('page evaluation errors', () => {
  it('a seek the runtime failed fast on a video frame is a runtimeErrors failure carrying videoSeekTimeout', async () => {
    const { evaluate } = await import('../src/render/chromium-provider.ts');
    const thrower = (description: string) => fakeClient(() => false, () => ({ exceptionDetails: { exception: { description } } })).client;
    const e = await evaluate(thrower('Error: videoSeekTimeout: video assets/v.mp4 has no frame for 2.217 s'), 'P', 'x', 1000).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'runtimeErrors', details: [{ code: 'videoSeekTimeout' }] });
    await expect(evaluate(thrower('FrameTimeoutError: frameTimeout'), 'P', 'x', 1000)).rejects.toMatchObject({ code: 'frameTimeout' });
    await expect(evaluate(thrower('TypeError: x'), 'P', 'x', 1000)).rejects.toMatchObject({ code: 'loadFailed' });
  });
});

describe('segments, frames, encoding', () => {
  it('splits frames into contiguous, non-empty segments covering every frame once', () => {
    for (const [frames, n] of [[69, 4], [1, 4], [3, 4], [90, 1], [100, 16], [7, 3]] as const) {
      const segs = splitSegments(frames, n);
      expect(segs.length).toBe(Math.min(n, frames));
      expect(segs[0]!.from).toBe(0);
      expect(segs.at(-1)!.to).toBe(frames);
      for (let i = 1; i < segs.length; i++) expect(segs[i]!.from).toBe(segs[i - 1]!.to);
      expect(segs.every((s) => s.to > s.from)).toBe(true);
    }
  });

  it('reads PNG and JPEG sizes', () => {
    const png = Buffer.alloc(24); png.writeUInt32BE(0x89504e47, 0); png.write('IHDR', 12, 'latin1'); png.writeUInt32BE(320, 16); png.writeUInt32BE(180, 20);
    expect(imageSize(png)).toEqual({ width: 320, height: 180 });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0xb4, 0x01, 0x40, 0x03, 0, 0, 0, 0, 0]);
    expect(imageSize(jpeg)).toEqual({ width: 320, height: 180 });
    expect(imageSize(Buffer.from('nope'))).toBeNull();
  });

  it('H.264 settings follow phase 8 (CRF 20, 1.5x maxrate, 2x buffer, yuv420p, BT.709)', () => {
    const fmt = { width: 1080, height: 1920, targetBitrateKbps: 4000 };
    expect(targetKbps(fmt, 30)).toBe(4000);
    expect(targetKbps(fmt, 60)).toBe(6000);
    const text = (args: ReturnType<typeof h264Args>) => args.flatMap((x) => (typeof x === 'string' ? [x] : [...filterArgv(x)!])).join(' ');
    const a = text(h264Args('libx264', 4000, 30));
    expect(a).toContain('-c:v libx264');
    expect(a).toContain('-crf 20');
    expect(a).toContain('-maxrate 6000k -bufsize 8000k');
    expect(a).toContain('-pix_fmt yuv420p');
    expect(a).toContain('-colorspace bt709');
    expect(a).toContain('-vf scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv');
    expect(text(h264Args('h264_videotoolbox', 4000, 30))).toContain('-c:v h264_videotoolbox -b:v 4000k');
    expect(concatLine("/tmp/a'b/seg.mp4")).toBe("file '/tmp/a'\\''b/seg.mp4'");
  });

  it('reads the CPU architecture of Mach-O (thin and universal) and ELF binaries', async () => {
    const write = (name: string, b: Buffer) => { const p = join(work, name); writeFileSync(p, Buffer.concat([b, Buffer.alloc(64)])); return p; };
    const macho = (cpu: number) => { const b = Buffer.alloc(8); b.writeUInt32LE(0xfeedfacf, 0); b.writeUInt32LE(cpu, 4); return b; };
    expect(await binaryArch(write('x86', macho(0x01000007)))).toBe('x86_64');
    expect(await binaryArch(write('arm', macho(0x0100000c)))).toBe('arm64');
    const fat = Buffer.alloc(48); fat.writeUInt32BE(0xcafebabe, 0); fat.writeUInt32BE(2, 4); fat.writeUInt32BE(0x01000007, 8); fat.writeUInt32BE(0x0100000c, 28);
    expect(await binaryArch(write('fat', fat))).toBe('universal');
    const elf = Buffer.alloc(20); elf.writeUInt32BE(0x7f454c46, 0); elf[5] = 1; elf.writeUInt16LE(62, 18);
    expect(await binaryArch(write('elf', elf))).toBe('x86_64');
    expect(await binaryArch(join(work, 'missing'))).toBe('unknown');
  });
});

describe('audio graph', () => {
  const comp = (tracks: unknown[]): Composition => ({ $schema: 'motion-studio/composition@1', width: 320, height: 180, fps: 30, duration: 3, background: '#000000', fonts: [], scenes: [], tracks } as unknown as Composition);
  it('takes audio clips and video clips with sound from unmuted tracks, cut at the composition end', () => {
    const clips = mixClips(comp([
      { id: 'a', kind: 'audio', clips: [
        { id: 'm', type: 'audio', src: 'assets/m.wav', start: 2, duration: 5, volume: 0.5, fadeIn: 0.2, fadeOut: 9 },
        { id: 's', type: 'audio', src: 'assets/s.wav', start: 0.5, duration: 1, volume: 0 },
      ] },
      { id: 'v', kind: 'video', clips: [{ id: 'v', type: 'video', src: 'assets/v.mp4', start: 0, duration: 1, trimStart: 0.25, props: {} }] },
      { id: 'mute', kind: 'audio', muted: true, clips: [{ id: 'x', type: 'audio', src: 'assets/x.wav', start: 0, duration: 1 }] },
    ]));
    expect(clips).toEqual([
      { src: 'assets/v.mp4', start: 0, duration: 1, trimStart: 0.25, volume: 1, fadeIn: 0, fadeOut: 0, fromVideo: true },
      { src: 'assets/m.wav', start: 2, duration: 1, trimStart: 0, volume: 0.5, fadeIn: 0.2, fadeOut: 1, fromVideo: false },
    ]);
    expect(mixClips({ ...comp([]), duration: 0 })).toEqual([]);
  });

  it('hidden clips and the clips of hidden tracks are not heard (the editor\'s eye, Phase 10b), as in the preview', () => {
    const clips = mixClips(comp([
      { id: 'a', kind: 'audio', clips: [
        { id: 'm', type: 'audio', src: 'assets/m.wav', start: 0, duration: 1 },
        { id: 'h', type: 'audio', src: 'assets/h.wav', start: 0, duration: 1, hidden: true },
      ] },
      { id: 'v', kind: 'video', clips: [{ id: 'v', type: 'video', src: 'assets/v.mp4', start: 0, duration: 1, hidden: true, props: {} }] },
      { id: 'ht', kind: 'audio', hidden: true, clips: [{ id: 'x', type: 'audio', src: 'assets/x.wav', start: 0, duration: 1 }] },
    ]));
    expect(clips.map((c) => c.src)).toEqual(['assets/m.wav']);
  });

  it('places clips in samples and mixes without normalisation, then limits, at exactly the composition length', () => {
    const [flag, g] = filterArgv(mixGraph([{ start: 0.5, duration: 1, trimStart: 0.25, volume: 0.8, fadeIn: 0.1, fadeOut: 0.2 }], 3 * 48_000))!;
    expect(flag).toBe('-filter_complex');
    expect(g).toContain('atrim=start_sample=12000:end_sample=60000');
    expect(g).toContain('afade=t=in:start_sample=0:nb_samples=4800');
    expect(g).toContain('afade=t=out:start_sample=38400:nb_samples=9600');
    expect(g).toContain('adelay=delays=24000S:all=1');
    expect(g).toContain('amix=inputs=1:duration=longest:dropout_transition=0:normalize=0');
    expect(g).toContain('apad=whole_len=144000,alimiter=limit=0.89:level=false:latency=1,atrim=end_sample=144000');
  });
});

describe('watchdog', () => {
  it('trips on a process over its memory limit, on the group total, and on time', async () => {
    const run = (sample: GroupMemory, limits: { maxProcessMB?: number; maxGroupMB?: number; timeLimitMs: number }) => new Promise((resolve) => {
      const w = startWatchdog({ pgid: 1, limits: { intervalMs: 10, ...limits }, onTrip: (t) => { w.stop(); resolve(t); }, sample: async () => sample });
    });
    expect(await run({ totalMB: 2100, maxMB: 2050, pids: 5 }, { timeLimitMs: 60_000 })).toEqual({ reason: 'memory', memoryMB: 2050, limitMB: 1536 });
    expect(await run({ totalMB: 7000, maxMB: 900, pids: 9 }, { timeLimitMs: 60_000 })).toEqual({ reason: 'memory', memoryMB: 7000, limitMB: 6144 });
    expect(await run({ totalMB: 10, maxMB: 5, pids: 1 }, { timeLimitMs: 50 })).toMatchObject({ reason: 'time', limitMs: 50 });
  });
});

describe('memory of explicit processes (the desktop render windows)', () => {
  it.skipIf(process.platform === 'win32')('measures given pids, takes the larger of two readings, and ignores unknown or invalid pids', async () => {
    const { samplePidsMemory } = await import('../src/render/watchdog.ts');
    const own = await samplePidsMemory([process.pid]);
    expect(own).not.toBeNull();
    expect(own!.pids).toBe(1);
    expect(own!.maxMB).toBeGreaterThan(10);
    // Another reading of the same process (Electron's app metrics) wins when larger; other pids in it are ignored.
    const big = await samplePidsMemory([process.pid], new Map([[process.pid, 64 * 1024 ** 3], [1, 1e12]]));
    expect(big!.maxMB).toBe(64 * 1024);
    expect(big!.totalMB).toBe(64 * 1024);
    expect(await samplePidsMemory([])).toBeNull();
    expect(await samplePidsMemory([0, -1, 1.5])).toBeNull();
  });
});

describe('memory limits', () => {
  it('scale with the page size and the open pages, capped at 75 % of the machine', async () => {
    const { scaledMemoryLimits } = await import('../src/render/watchdog.ts');
    expect(scaledMemoryLimits(1080, 1920, 1, 16_384)).toEqual({ maxProcessMB: 1536, maxGroupMB: 2560 });
    expect(scaledMemoryLimits(320, 180, 4, 16_384)).toEqual({ maxProcessMB: 1536, maxGroupMB: 7168 });
    expect(scaledMemoryLimits(3840, 2160, 4, 16_384)).toEqual({ maxProcessMB: 3072, maxGroupMB: 12_288 });
  });

  it('reads function limits at every sample and samples faster near a limit', async () => {
    let limit = 10_000;
    const intervals: number[] = [];
    let w!: ReturnType<typeof startWatchdog>;
    let n = 0;
    const trip = await new Promise((resolve) => {
      w = startWatchdog({
        pgid: 1, limits: { intervalMs: 400, timeLimitMs: 60_000, maxProcessMB: () => limit },
        onTrip: (t) => { w.stop(); resolve(t); },
        sample: async () => {
          if (n > 0) intervals.push(w.nextSampleMs); // the delay chosen after the previous sample
          n++;
          if (n === 3) limit = 1000;
          const mb = n >= 4 ? 1100 : 900;
          return { totalMB: mb, maxMB: mb, pids: 1 };
        },
      });
    });
    // 900 MB: far from 10 000 (every 400 ms), then within 75 % of 1000 (every 250 ms), then 1100 MB trips it.
    expect(trip).toEqual({ reason: 'memory', memoryMB: 1100, limitMB: 1000 });
    expect(intervals).toEqual([400, 400, 250]);
  });
});

describe('system Chrome discovery', () => {
  it('lists the standard places per platform and honours CHROME_PATH strictly', async () => {
    expect(chromeCandidates('darwin', { HOME: '/Users/x' })[0]).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    expect(chromeCandidates('darwin', { HOME: '/Users/x' })).toContain('/Users/x/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    expect(chromeCandidates('win32', { PROGRAMFILES: 'C:\\Program Files', LOCALAPPDATA: 'C:\\L' })).toContain('C:\\L\\Google\\Chrome\\Application\\chrome.exe');
    expect(chromeCandidates('linux', { PATH: '/opt/x' })).toContain('/opt/x/google-chrome');
    expect(await findSystemChrome({ env: { CHROME_PATH: join(work, 'no-such-chrome') } })).toBeNull();
    const fake = join(work, 'old-chrome');
    writeFileSync(fake, '#!/bin/sh\necho "Google Chrome 99.0.1.2"\n', { mode: 0o755 });
    expect(await findSystemChrome({ env: { CHROME_PATH: fake } })).toBeNull(); // too old
    const ok = join(work, 'new-chrome');
    writeFileSync(ok, '#!/bin/sh\necho "Google Chrome 154.0.8037.98"\n', { mode: 0o755 });
    if (process.platform !== 'win32') expect(await findSystemChrome({ env: { CHROME_PATH: ok } })).toEqual({ exe: ok, version: '154.0.8037.98', major: 154, source: 'env' });
  });

  it('only Google Chrome and Chromium; the version is cached per path until the file changes', async () => {
    for (const p of ['darwin', 'win32', 'linux'] as const) {
      expect(chromeCandidates(p, { HOME: '/h', PROGRAMFILES: 'C:\\P', PATH: '/b' }).some((c) => /edge|brave/i.test(c)), p).toBe(false);
    }
    if (process.platform === 'win32') return;
    const exe = join(work, 'cached-chrome');
    const calls = `${exe}.calls`;
    writeFileSync(exe, `#!/bin/sh\necho x >> "${calls}"\necho "Google Chrome 154.0.1.1"\n`, { mode: 0o755 });
    const { readFileSync: read } = await import('node:fs');
    const count = () => read(calls, 'utf8').split('\n').filter(Boolean).length;
    expect((await findSystemChrome({ env: { CHROME_PATH: exe } }))?.version).toBe('154.0.1.1');
    expect((await findSystemChrome({ env: { CHROME_PATH: exe } }))?.version).toBe('154.0.1.1');
    expect(count()).toBe(1);
    writeFileSync(exe, `#!/bin/sh\necho x >> "${calls}"\necho "Google Chrome 155.0.22.333"\n`, { mode: 0o755 }); // an update: new size
    expect((await findSystemChrome({ env: { CHROME_PATH: exe } }))?.version).toBe('155.0.22.333');
    expect(count()).toBe(2);
  });
});

describe('render engine: provider injection and resolution', () => {
  it('an injected provider wins; else system Chrome; else an installed Chrome for Testing; else none', async () => {
    const { createRenderEngine } = await import('../src/render/renderer.ts');
    const { cftExecutableRel, cftPlatform } = await import('../src/render/cft-download.ts');
    const { hostArch } = await import('../src/render/encode.ts');
    const injected = { kind: 'electron' as const, open: async () => { throw new Error('x'); }, close: async () => {} };
    const e1 = createRenderEngine({ provider: async () => injected, env: { CHROME_PATH: join(work, 'no-chrome') } });
    expect(await e1.info()).toEqual({ kind: 'injected' });
    // A factory that says what it is (the desktop's Electron provider) is reported as that.
    expect(await createRenderEngine({ provider: Object.assign(async () => injected, { kind: 'electron' as const }) }).info()).toEqual({ kind: 'electron' });
    expect(await e1.provider()).toBe(injected);

    const none = createRenderEngine({ env: { CHROME_PATH: join(work, 'no-chrome') }, appDataDir: join(work, 'empty-app-data') });
    expect(await none.info()).toEqual({ kind: null });
    await expect(none.provider()).rejects.toMatchObject({ code: 'noBrowser' });

    const appData = join(work, 'app-data');
    const platform = cftPlatform(process.platform, await hostArch());
    const exe = join(appData, 'chromium', '154.0.8037.98', ...cftExecutableRel(platform).split('/'));
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(exe, '..'), { recursive: true });
    writeFileSync(exe, '', { mode: 0o755 });
    const cft = createRenderEngine({ env: { CHROME_PATH: join(work, 'no-chrome') }, appDataDir: appData });
    expect(await cft.info()).toEqual({ kind: 'cft', exe, version: '154.0.8037.98' });
    expect((await cft.provider()).kind).toBe('cft');

    const ok = join(work, 'sys-chrome');
    writeFileSync(ok, '#!/bin/sh\necho "Google Chrome 154.0.8037.98"\n', { mode: 0o755 });
    if (process.platform !== 'win32') expect(await createRenderEngine({ env: { CHROME_PATH: ok }, appDataDir: appData }).info()).toEqual({ kind: 'system', exe: ok, version: '154.0.8037.98' });
  });
});

describe('process groups: no blind kill after the leader is gone', () => {
  it('killGroupIfMarked kills a group only when ps shows our marker in it', async () => {
    if (process.platform === 'win32') return;
    const { spawn } = await import('node:child_process');
    const { killGroupIfMarked, groupMembers } = await import('../src/render/watchdog.ts');
    const marker = join(work, 'marker-profile-0123456789');
    const p = spawn('/bin/sh', ['-c', 'sleep 60; true', marker], { detached: true, stdio: 'ignore' });
    const exited = new Promise((r) => p.once('exit', r));
    expect(await killGroupIfMarked(p.pid!, join(work, 'some-other-profile-xyz'))).toBe(false);
    expect(await groupMembers(p.pid!)).toContain(p.pid);
    expect(await killGroupIfMarked(p.pid!, marker)).toBe(true);
    await exited;
    expect(await groupMembers(p.pid!)).toEqual([]);
  });
});

describe('VideoToolbox quality check caching', () => {
  it.skipIf(process.platform !== 'darwin')('retries after a transient failure, caches a real quality failure', async () => {
    const { checkVideotoolbox } = await import('../src/render/encode.ts');
    const { readFileSync: read } = await import('node:fs');
    const fake = (name: string, body: string) => { const p = join(work, name); writeFileSync(p, `#!/bin/sh\necho x >> "${p}.calls"\n${body}\n`, { mode: 0o755 }); return p; };
    const calls = (p: string) => { try { return read(`${p}.calls`, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
    const info = (path: string) => ({ path, version: 'fake', arch: 'arm64' as const, hostArch: 'arm64', translated: false, encoders: new Set(['h264_videotoolbox']), fdProtocol: true });

    const broken = fake('ff-broken', 'echo "VT session failed" >&2; exit 1');
    expect(await checkVideotoolbox(info(broken), 64, 64, 30, 500)).toMatchObject({ ok: false, transient: true });
    expect(await checkVideotoolbox(info(broken), 64, 64, 30, 500)).toMatchObject({ ok: false, transient: true });
    expect(calls(broken)).toBe(2); // not cached: tried again

    const poor = fake('ff-poor', 'case "$*" in *ssim*) echo "SSIM Y:0.5 All:0.500000 (3.0)" >&2;; esac; exit 0');
    expect(await checkVideotoolbox(info(poor), 64, 64, 30, 500)).toEqual({ ok: false, ssim: 0.5, reason: 'quality' });
    const after = calls(poor);
    expect(await checkVideotoolbox(info(poor), 64, 64, 30, 500)).toEqual({ ok: false, ssim: 0.5, reason: 'quality' });
    expect(calls(poor)).toBe(after); // cached
  });
});

describe('TargetGate', () => {
  it('closes a target that is not ours and fails the render when it cannot', async () => {
    const { TargetGate } = await import('../src/render/isolation.ts');
    const { client, calls, emit } = fakeClient((m) => m === 'Target.closeTarget');
    const failures: Error[] = [];
    const gate = new TargetGate(client, 1000, (e) => failures.push(e));
    await gate.start();
    emit({ method: 'Target.attachedToTarget', params: { sessionId: 'S', targetInfo: { targetId: 'popup', type: 'shared_worker', url: 'x' } } });
    await flush();
    expect(calls.filter((c) => c.method === 'Target.closeTarget').map((c) => c.params.targetId)).toEqual(['popup']);
    expect(gate.refused.map((r) => r.type)).toEqual(['shared_worker']);
    expect(failures[0]?.message).toMatch(/shared_worker target that is not ours could not be closed/);
  });

  it('a target already gone when it is closed counts as closed, not as an isolation failure', async () => {
    const { TargetGate } = await import('../src/render/isolation.ts');
    const failures: Error[] = [];
    const client: CdpClient = {
      closed: null, onClose: () => () => {},
      async send(method) { if (method === 'Target.closeTarget') throw new Error('Target.closeTarget: No target with given id found'); return {} as never; },
      onEvent(l) { listeners.push(l); return () => {}; },
    };
    const listeners: Array<(e: CdpEvent) => void> = [];
    const gate = new TargetGate(client, 1000, (e) => failures.push(e));
    await gate.start();
    for (const l of listeners) l({ method: 'Target.attachedToTarget', params: { sessionId: 'S', targetInfo: { targetId: 'gone', type: 'service_worker' } } });
    await flush();
    expect(gate.refused).toHaveLength(1);
    expect(failures).toEqual([]);
  });
});
