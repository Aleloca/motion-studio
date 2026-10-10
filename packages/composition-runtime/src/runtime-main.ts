import type { Composition } from '@motion-studio/shared';
import { installVirtualClock, nativesOf } from './clock.ts';
import { mount, type Player, type ReadyInfo } from './mount.ts';
import { COMPOSITION_DATA_ID, readCompositionData } from './page.ts';
import { createPreviewBridge, type PreviewBridge } from './preview-bridge.ts';
import { parseParentOrigin, PREVIEW_PROTOCOL_VERSION, RUNTIME_QUERY, type RuntimeError, type RuntimeMode } from './protocol.ts';

/** The render-mode API on `window.__ms` (driven over CDP by the core renderer). */
export interface RuntimeApi {
  readonly mode: RuntimeMode;
  /** Resolves when mounted, fonts, media and layers loaded and t = 0 shown; rejects only on a fatal error. */
  ready(): Promise<ReadyInfo & { errors: RuntimeError[] }>;
  /** Shows composition time `t` (seconds); resolves once it is painted. */
  seek(t: number): Promise<void>;
  readonly duration: number;
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  /** Every problem met so far (asset, font, video, layer). */
  readonly errors: RuntimeError[];
}

const MAX_ERRORS = 200;

/** Starts the runtime in `w`: the entry of `runtime.js`. */
export function startRuntime(w: Window & typeof globalThis): RuntimeApi {
  const qs = new URLSearchParams(w.location.search);
  const mode: RuntimeMode = qs.get(RUNTIME_QUERY.mode) === 'preview' ? 'preview' : 'render';
  // Render: the clock goes in before anything else can read time. (Task 4 may also inject clock.js over CDP; idempotent.)
  const clock = mode === 'render' ? installVirtualClock(w) : null;
  const natives = nativesOf(w);
  const errors: RuntimeError[] = [];
  let bridge: PreviewBridge | null = null;
  const report = (e: RuntimeError) => {
    if (errors.length < MAX_ERRORS) errors.push(e);
    w.console.warn(`[motion-studio] ${e.code}${e.clipId ? ` (${e.clipId})` : ''}: ${e.message}`);
    try { bridge?.post({ type: 'error', error: e }); } catch { /* malformed: a runtime bug, already logged */ }
  };

  const parentOrigin = mode === 'preview' && w.parent !== w ? parseParentOrigin(qs.get(RUNTIME_QUERY.parentOrigin)) : null;
  const fail = (code: RuntimeError['code'], message: string): RuntimeApi => {
    const e = { code, message };
    report(e);
    if (parentOrigin) w.parent.postMessage({ type: 'error', error: e }, parentOrigin);
    const failed = Promise.reject(new Error(`${code}: ${message}`));
    failed.catch(() => {});
    return { mode, ready: () => failed, seek: () => failed, duration: 0, fps: 0, width: 0, height: 0, errors };
  };

  const block = w.document.getElementById(COMPOSITION_DATA_ID);
  const data = block ? readCompositionData(block.textContent ?? '') : null;
  if (!data) return fail('compositionMissing', 'the page has no composition data block');
  let base: URL;
  try { base = new URL(data.base, w.location.href); } catch { return fail('baseNotAllowed', 'bad composition base'); }
  const here = new URL(w.location.href);
  if (base.origin !== here.origin || (base.protocol !== 'http:' && base.protocol !== 'https:') || !base.pathname.endsWith('/') || base.search || base.hash) {
    return fail('baseNotAllowed', 'the composition base must be a folder on the page origin');
  }
  const comp = data.composition as Partial<Composition>;
  const okNum = (v: unknown, min: number) => typeof v === 'number' && Number.isFinite(v) && v >= min;
  if (!okNum(comp.width, 1) || !okNum(comp.height, 1) || !okNum(comp.fps, 1) || !okNum(comp.duration, 0) || !Array.isArray(comp.tracks)
    || !comp.tracks.every((t) => t && Array.isArray(t.clips))) {
    return fail('compositionInvalid', 'the composition lacks width, height, fps, duration or tracks');
  }

  const root = w.document.getElementById('ms-root') ?? w.document.body;
  const player: Player = mount(root, comp as Composition, { mode, base: base.href, natives, clock, report });
  const ready = player.ready().then((info) => ({ ...info, errors: [...errors] }));
  ready.catch(() => {});

  if (parentOrigin) {
    const b = createPreviewBridge({ parent: w.parent, parentOrigin, player });
    // Nothing but errors goes out before `ready`.
    player.onTime = (t, playing) => { if (bridge) b.post({ type: 'time', t, playing }); };
    player.onBounds = () => { if (bridge) b.post({ type: 'clipBounds', clipId: player.selected, bounds: player.selectedBounds(), scale: player.scale }); };
    void ready.then((info) => {
      bridge = b;
      w.addEventListener('message', (ev) => b.handle(ev));
      b.post({
        type: 'ready', version: PREVIEW_PROTOCOL_VERSION, duration: info.duration, fps: info.fps, width: info.width, height: info.height,
        scenes: (comp.scenes ?? []).map((s) => ({ id: s.id, ...(s.name ? { name: s.name } : {}), start: s.start, duration: s.duration })),
        errors: info.errors,
      });
    });
  }

  return {
    mode,
    ready: () => ready,
    seek: (t: number) => (Number.isFinite(t) ? player.seek(t) : Promise.reject(new Error('seek: t must be a finite number'))),
    duration: player.duration,
    fps: player.fps,
    width: player.width,
    height: player.height,
    get errors() { return [...errors]; },
  };
}
