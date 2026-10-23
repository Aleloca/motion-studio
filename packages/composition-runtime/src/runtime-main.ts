import type { Composition } from '@motion-studio/shared';
import { installVirtualClock, nativesOf } from './clock.ts';
import { mount, type Player, type ReadyInfo } from './mount.ts';
import { COMPOSITION_DATA_ID, readCompositionData, type SafeZone } from './page.ts';
import { createPreviewBridge, DRAFT_PARSER_KEY, type BridgePlayer, type PreviewBridge } from './preview-bridge.ts';
import { parseParentOrigin, PREVIEW_PROTOCOL_VERSION, RUNTIME_QUERY, type DraftParser, type PreviewOutgoing, type RuntimeError, type RuntimeMode } from './protocol.ts';
import type { RuntimeSubtitles } from './subtitles.ts';

/** The render-mode API on `window.__ms` (driven over CDP by the core renderer). */
export interface RuntimeApi {
  readonly mode: RuntimeMode;
  /** Resolves when mounted, fonts, media and layers loaded and t = 0 shown; rejects only on a fatal error. */
  ready(): Promise<ReadyInfo & { errors: RuntimeError[] }>;
  /** Shows composition time `t` (seconds); resolves once it is painted. */
  seek(t: number): Promise<void>;
  /** How many times a video canvas lost its GPU context (its pixels) so far (decision 1752; `Player.canvasLosses`). */
  readonly canvasLosses: number;
  readonly duration: number;
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  /** Every problem met so far (asset, font, video, layer). */
  readonly errors: RuntimeError[];
}

const MAX_ERRORS = 200;
/**
 * Load limits of a re-mounted draft (ms): shorter than a first mount's, so one slow or missing file cannot hold the
 * drafts queued behind it for minutes. A file that loads later still shows; the timeout is only reported.
 */
const REMOUNT_TIMEOUTS = { load: 15_000, layer: 15_000 };

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
    return { mode, ready: () => failed, seek: () => failed, canvasLosses: 0, duration: 0, fps: 0, width: 0, height: 0, errors };
  };

  const block = w.document.getElementById(COMPOSITION_DATA_ID);
  // A malformed subtitles block is left out with a warning (`subtitlesInvalid`): the page still renders, without them.
  const data = block ? readCompositionData(block.textContent ?? '', report) : null;
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
  let player: Player;
  try {
    player = mount(root, comp as Composition, {
      mode, base: base.href, natives, clock, report, ...(data.safeZone ? { safeZone: data.safeZone } : {}), ...(data.subtitles ? { subtitles: data.subtitles } : {}),
    });
  } catch (e) {
    return fail('compositionInvalid', `the composition could not be mounted: ${String(e instanceof Error ? e.message : e).slice(0, 300)}`);
  }
  const ready = player.ready().then((info) => ({ ...info, errors: [...errors] }));
  ready.catch(() => {});

  if (parentOrigin) {
    const live = createLivePreview({
      w, root, first: player, composition: comp as Composition, base: base.href, natives, report,
      safeZone: data.safeZone, subtitles: data.subtitles ?? null,
      post: (m) => { if (bridge) bridge.post(m); },
    });
    const parserOf = () => (w as unknown as Record<string, { parseDraft?: DraftParser } | undefined>)[DRAFT_PARSER_KEY]?.parseDraft;
    const b = createPreviewBridge({ parent: w.parent, parentOrigin, player: live, parseDraft: parserOf });
    // The draft parser (zod) is a script of its own, loaded only here: a render page never carries it. A draft that comes
    // before it has loaded waits for it (bridge `parserReady`).
    if (!parserOf()) {
      const script = w.document.createElement('script');
      script.src = 'preview.js';
      script.addEventListener('load', () => b.parserReady());
      script.addEventListener('error', () => w.console.warn('[motion-studio] preview.js did not load: drafts are refused'));
      w.document.head.appendChild(script);
    }
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
    get canvasLosses() { return player.canvasLosses; },
    duration: player.duration,
    fps: player.fps,
    width: player.width,
    height: player.height,
    get errors() { return [...errors]; },
  };
}

/** The normalised media of the inlined composition's video clips, by their original `src` (core: `withSessionMedia`). */
type SessionVideo = Record<string, unknown> & { src: string };
const SESSION_VIDEO_FIELDS = ['src', 'sourceFps', 'sourceStart', 'sourceVideoEnd', 'sourceTrusted', 'audioSrc', 'audioStart'] as const;

function sessionVideos(c: Composition): Map<string, SessionVideo> {
  const out = new Map<string, SessionVideo>();
  for (const track of c.tracks) {
    for (const clip of track.clips as Array<Record<string, unknown>>) {
      const original = clip.originalSrc;
      if (clip.type !== 'video' || typeof clip.src !== 'string' || !clip.src.startsWith('media/') || typeof original !== 'string' || !original.startsWith('assets/')) continue;
      const v: Record<string, unknown> = {};
      for (const k of SESSION_VIDEO_FIELDS) if (clip[k] !== undefined) v[k] = clip[k];
      out.set(original, v as SessionVideo);
    }
  }
  return out;
}

/** A draft's video clips that name a source the session normalised play that file, as the inlined composition does. */
function withSessionVideos(c: Composition, videos: ReadonlyMap<string, SessionVideo>): Composition {
  if (videos.size === 0) return c;
  for (const track of c.tracks) {
    for (const clip of track.clips) {
      if (clip.type !== 'video') continue;
      const v = videos.get(clip.src);
      if (v) Object.assign(clip, v);
    }
  }
  return c;
}

/**
 * The preview's player as the bridge sees it: the mounted composition, replaced in place by `setComposition` (Phase 10b).
 *
 * A draft is mounted below the one shown (same document, never hidden: a hidden cross-origin layer frame may get no
 * animation frames), loaded, seeked to the kept time, then swapped in: the old mount is destroyed (animations cancelled,
 * media and layer frames released, fonts deleted). Commands meanwhile go to the mount shown; scale, mute, play state and
 * the selection (when its clip still exists) carry over. Drafts arriving during a re-mount wait, and only the latest of
 * them is mounted next. Each applied draft is answered by `compositionApplied` with its `seq` and its load errors (those
 * are not posted one by one).
 */
function createLivePreview(o: {
  w: Window & typeof globalThis; root: HTMLElement; first: Player; composition: Composition; base: string;
  natives: ReturnType<typeof nativesOf>; report(e: RuntimeError): void; post(m: PreviewOutgoing): void;
  safeZone: SafeZone | undefined; subtitles: RuntimeSubtitles | null;
}): BridgePlayer {
  const doc = o.root.ownerDocument;
  const videos = sessionVideos(o.composition);
  /** The videos the parent may add (`sessionMedia`, staged ones): bounded like the core's session media. */
  const MAX_VIDEOS = 1000;
  let current = o.first;
  let holder: HTMLElement | null = null; // the first mount lives directly in the root
  let selected: string | null = null;
  let scale: number | 'fit' = 'fit';
  let muted = false;
  let playOpts: { loop: boolean; rate: number } | null = null;
  let applying = false;
  /** Seek commands seen (and the last time asked): a re-mount follows one that came while it ran. */
  let seekGen = 0;
  let lastSeek = 0;
  let pending: { composition: Composition; keepTime: boolean; seq: number } | null = null;
  /** The subtitles drawn: the page's, then each `setSubtitles`; a draft mounts with the latest. */
  let subtitles = o.subtitles;
  /** `setSubtitles` commands seen: a draft gets them at the swap only when one came while it mounted. */
  let subtitlesGen = 0;

  const wire = (p: Player) => {
    p.onTime = (t, playing) => o.post({ type: 'time', t, playing });
    p.onBounds = () => o.post({ type: 'clipBounds', clipId: p.selected, bounds: p.selectedBounds(), scale: p.scale });
  };
  wire(current);

  const apply = async (d: { composition: Composition; keepTime: boolean; seq: number }) => {
    applying = true;
    const genAtStart = seekGen;
    const subtitlesAtStart = subtitlesGen;
    const errors: RuntimeError[] = [];
    let collecting = true;
    const report = (e: RuntimeError) => { if (!collecting) o.report(e); else if (errors.length < MAX_ERRORS) errors.push(e); };
    const box = doc.createElement('div');
    box.className = 'ms-mount';
    Object.assign(box.style, { position: 'absolute', inset: '0', overflow: 'hidden', zIndex: '0' });
    o.root.insertBefore(box, o.root.firstChild); // below the mount shown
    let next: Player | null = null;
    try {
      const c = withSessionVideos(d.composition, videos);
      next = mount(box, c, {
        mode: 'preview', base: o.base, natives: o.natives, clock: null, report, timeouts: REMOUNT_TIMEOUTS, subtitles, ...(o.safeZone ? { safeZone: o.safeZone } : {}),
      });
      next.setScale(scale);
      await next.load();
      const ids = idsOf(c);
      // The time to show: the one a seek command asked for meanwhile, else the kept one (or 0). A seek that arrives while
      // the new mount seeks moves it again (a few times at most: commands keep coming only while the user scrubs).
      let want = seekGen !== genAtStart ? lastSeek : d.keepTime ? current.time : 0;
      for (let i = 0; i < 4; i++) {
        const gen = seekGen;
        await next.seek(want);
        if (seekGen === gen) break;
        want = lastSeek;
      }
      // Everything else is read at the swap, so a select, setScale, mute or play/pause sent during the re-mount holds.
      const keep = selected !== null && ids.has(selected) ? selected : null;
      const resume = current.playing && playOpts ? { ...playOpts, from: current.time } : null;
      next.setScale(scale);
      // A `setSubtitles` sent during the re-mount; otherwise the draft already has them (a template would load again).
      if (subtitlesGen !== subtitlesAtStart) next.setSubtitles(subtitles);
      // Swap: the old mount goes, the new one is the one shown.
      current.destroy();
      holder?.remove();
      box.style.zIndex = '';
      current = next;
      holder = box;
      selected = keep;
      collecting = false;
      if (muted) next.setMuted(true);
      next.select(keep);
      wire(next);
      if (resume) next.play(resume);
      o.post({ type: 'time', t: next.time, playing: next.playing });
      o.post({ type: 'clipBounds', clipId: next.selected, bounds: next.selectedBounds(), scale: next.scale });
    } catch (e) {
      // The mount shown stays; the draft's failure is its answer.
      if (errors.length < MAX_ERRORS) errors.push({ code: 'compositionInvalid', message: `the draft could not be mounted: ${String(e instanceof Error ? e.message : e).slice(0, 300)}` });
      next?.destroy();
      box.remove();
    } finally {
      o.post({ type: 'compositionApplied', seq: d.seq, errors });
      applying = false;
      if (pending) { const p = pending; pending = null; void apply(p); }
    }
  };

  return {
    seek: (t) => { playOpts = null; seekGen++; lastSeek = t; return current.seek(t); },
    play: (p) => { playOpts = p; current.play(p); },
    pause: () => { playOpts = null; current.pause(); },
    select: (id) => { selected = id; current.select(id); },
    setScale: (s) => { scale = s; current.setScale(s); },
    setMuted: (m) => { muted = m; current.setMuted(m); },
    setComposition: (composition, d) => {
      const draft = { composition, keepTime: d.keepTime, seq: d.seq };
      if (applying) { pending = draft; return; }
      void apply(draft);
    },
    setSubtitles: (s) => { subtitles = s; subtitlesGen++; current.setSubtitles(s); },
    addSessionMedia: (m) => {
      if (!videos.has(m.src) && videos.size >= MAX_VIDEOS) return;
      // As the core's `withSessionMedia` writes a session video into the inlined composition.
      videos.set(m.src, {
        src: `media/${m.index}.mp4`, sourceFps: m.sourceFps, sourceStart: m.sourceStart, sourceVideoEnd: m.sourceVideoEnd, sourceTrusted: true,
        ...(m.audioStart !== undefined ? { audioSrc: m.src, audioStart: m.audioStart } : {}),
      });
    },
  };
}

function idsOf(c: Composition): Set<string> {
  const ids = new Set<string>();
  for (const t of c.tracks) for (const clip of t.clips) ids.add(clip.id);
  return ids;
}
