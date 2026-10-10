import type { Clip, Composition, Track } from '@motion-studio/shared';
import { compileAnimations, compileKenBurns, REGISTERED_PROPERTIES, type CompiledAnimation } from './animations.ts';
import type { Natives, VirtualClock } from './clock.ts';
import { FrameTimeoutError, twoFrames, withTimeout } from './frames.ts';
import { connectLayer, LayerRequestError, type LayerHost } from './layer-host.ts';
import { encodeLayerConfig, type LayerFont } from './layer-protocol.ts';
import type { Rect, RuntimeError, RuntimeErrorCode, RuntimeMode } from './protocol.ts';
import { audioGain, frameCount, isClipVisible, needsResync, videoSourceTime } from './timing.ts';

export interface MountOptions {
  mode: RuntimeMode;
  /** Absolute URL of the composition folder, ending in `/`. Every asset must resolve inside it. */
  base: string;
  natives: Natives;
  /** The virtual clock of this document (render mode), advanced to t on every seek. */
  clock?: VirtualClock | null;
  report(e: RuntimeError): void;
  /** Native-time limits (ms). Generous by default: render machines can be heavily loaded. */
  timeouts?: { load?: number; seek?: number; layer?: number };
}

export interface ReadyInfo { duration: number; fps: number; width: number; height: number; frames: number }

export interface Player {
  readonly duration: number;
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  /** The time last applied. */
  readonly time: number;
  readonly playing: boolean;
  /** Fonts, media and layers loaded, then t = 0 shown. */
  ready(): Promise<ReadyInfo>;
  /** Deterministic seek; concurrent calls coalesce to the latest time. Pauses playback. */
  seek(t: number): Promise<void>;
  play(o?: { loop?: boolean; rate?: number }): void;
  pause(): void;
  select(clipId: string | null): void;
  setScale(scale: number | 'fit'): void;
  /** The selected clip (preview), or null. */
  readonly selected: string | null;
  /** Bounds of the selected clip in viewport CSS pixels, or null. */
  selectedBounds(): Rect | null;
  readonly scale: number;
  /** Called with the time shown: every frame while playing, after each seek and on pause. */
  onTime?: (t: number, playing: boolean) => void;
  /** Called when the selected clip's bounds may have changed. */
  onBounds?: () => void;
}

type VisualClip = Exclude<Clip, { type: 'audio' }>;
type AudioClip = Extract<Clip, { type: 'audio' }>;
interface Mounted {
  clip: VisualClip;
  box: HTMLDivElement;
  content: HTMLDivElement;
  anims: Array<{ anim: Animation; start: number }>;
  video?: HTMLVideoElement;
  layer?: LayerHost;
  prepare: Promise<void>;
  muted: boolean;
}
interface MountedAudio { clip: AudioClip; el: HTMLAudioElement; muted: boolean }

const DEFAULTS = { load: 120_000, seek: 60_000, layer: 60_000 };
const FALLBACK_FONT = 'sans-serif';

/** Registers the animated custom properties once per document (they must interpolate; see animations.ts). */
function registerProperties(w: Window & typeof globalThis): void {
  const css = (w as unknown as { CSS?: { registerProperty?: (d: object) => void } }).CSS;
  if (!css?.registerProperty) return;
  for (const p of REGISTERED_PROPERTIES) {
    try { css.registerProperty({ ...p, inherits: false }); } catch { /* already registered */ }
  }
}

function cssString(s: string): string {
  return `"${s.replace(/["\\\n\r\f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}"`;
}

export function mount(root: HTMLElement, composition: Composition, opts: MountOptions): Player {
  const doc = root.ownerDocument;
  const w = doc.defaultView as Window & typeof globalThis;
  const n = opts.natives;
  const timeouts = { ...DEFAULTS, ...opts.timeouts };
  const c = composition;
  const still = !(c.duration > 0);
  const report = (code: RuntimeErrorCode, message: string, clipId?: string) => opts.report({ code, message, ...(clipId ? { clipId } : {}) });
  registerProperties(w);

  const assetUrl = (src: unknown, clipId?: string): string | null => {
    if (typeof src !== 'string' || src.length === 0 || /[?#\\]/.test(src) || !(src.startsWith('assets/') || src.startsWith('layers/'))) {
      report('assetPathRejected', `asset path rejected: ${String(src).slice(0, 200)}`, clipId);
      return null;
    }
    let u: URL;
    try { u = new URL(src, opts.base); } catch { report('assetPathRejected', `bad asset path ${src}`, clipId); return null; }
    if (!u.href.startsWith(opts.base)) { report('assetPathRejected', `asset outside the composition: ${src}`, clipId); return null; }
    return u.href;
  };

  // Fonts: every declared font is FontFace.load()ed explicitly (document.fonts.ready is not a font gate: spike §1).
  const declaredFamilies = new Set<string>();
  const layerFonts: LayerFont[] = [];
  const fontLoads: Array<Promise<void>> = [];
  for (const f of c.fonts ?? []) {
    const url = assetUrl(f.src);
    if (!url) continue;
    const weight = f.weight === undefined ? undefined : String(f.weight);
    declaredFamilies.add(f.family.toLowerCase());
    layerFonts.push({ family: f.family, url, ...(weight ? { weight } : {}), ...(f.style ? { style: f.style } : {}) });
    try {
      const face = new w.FontFace(f.family, `url("${url}")`, { ...(weight ? { weight } : {}), ...(f.style ? { style: f.style } : {}) });
      doc.fonts.add(face);
      fontLoads.push(face.load().then(() => {}, (e: unknown) => report('fontLoadFailed', `font ${f.family} (${f.src}) failed to load: ${String(e)}`)));
    } catch (e) {
      report('fontLoadFailed', `font ${f.family}: ${String(e)}`);
    }
  }
  const fontsLoaded = Promise.all(fontLoads).then(() => {});
  const defaultFamily = c.fonts?.[0]?.family;

  // Stage: composition pixels; preview scales it to the viewport.
  const stage = doc.createElement('div');
  stage.className = 'ms-stage';
  Object.assign(stage.style, {
    position: 'absolute', left: '0', top: '0', width: `${c.width}px`, height: `${c.height}px`, overflow: 'hidden',
    background: c.background, transformOrigin: '0 0',
  });
  root.appendChild(stage);
  const audioBin = doc.createElement('div');
  audioBin.hidden = true;
  root.appendChild(audioBin);

  const mounted: Mounted[] = [];
  const audios: MountedAudio[] = [];
  let z = 0;

  const makeAnimations = (target: Element, list: CompiledAnimation[], clipId: string) => {
    const out: Array<{ anim: Animation; start: number }> = [];
    for (const a of list) {
      const timing: KeyframeAnimationOptions = { duration: Math.max(1, a.duration * 1000), easing: a.easing, fill: a.fill };
      let anim: Animation;
      try {
        anim = target.animate(a.keyframes as Keyframe[], timing);
      } catch (e) {
        report('badAnimation', `animation of ${a.property}: ${String(e)}; using linear`, clipId);
        try { anim = target.animate(a.keyframes.map((k) => ({ ...k, easing: 'linear' })) as Keyframe[], { ...timing, easing: 'linear' }); } catch { continue; }
      }
      anim.pause();
      out.push({ anim, start: a.start });
    }
    return out;
  };

  const loadMedia = (el: HTMLMediaElement, clipId: string, src: string) => withTimeout(new Promise<void>((resolve, reject) => {
    if (el.readyState >= 2) { resolve(); return; }
    el.addEventListener('loadeddata', () => resolve(), { once: true });
    el.addEventListener('error', () => reject(new Error(`cannot load ${src}`)), { once: true });
  }), timeouts.load, n, `loading ${src} timed out`).catch((e: unknown) => report('assetLoadFailed', String(e instanceof Error ? e.message : e), clipId));

  const mountVisual = (clip: VisualClip, track: Track) => {
    const p = clip.props as Record<string, unknown> & { x?: number; y?: number; width?: number; height?: number; rotation?: number; scale?: number; opacity?: number };
    const box = doc.createElement('div');
    box.className = 'ms-clip';
    box.dataset.clipId = clip.id;
    const isText = clip.type === 'text';
    Object.assign(box.style, {
      position: 'absolute', left: `${p.x ?? 0}px`, top: `${p.y ?? 0}px`, zIndex: String(++z), display: 'none',
    });
    const width = p.width ?? (isText ? undefined : c.width);
    const height = p.height ?? (isText ? undefined : c.height);
    if (width !== undefined) box.style.width = `${width}px`;
    if (height !== undefined) box.style.height = `${height}px`;
    if (p.rotation) box.style.rotate = `${p.rotation}deg`;
    if (p.scale !== undefined && p.scale !== 1) box.style.scale = String(p.scale);
    if (p.opacity !== undefined && p.opacity !== 1) box.style.opacity = String(p.opacity);

    const content = doc.createElement('div');
    content.className = 'ms-content';
    Object.assign(content.style, {
      width: '100%', height: '100%', position: 'relative', boxSizing: 'border-box',
      translate: 'var(--ms-x) var(--ms-y)', scale: 'var(--ms-scale)', rotate: 'var(--ms-rotate)',
    });
    box.appendChild(content);

    let prepare: Promise<void> = Promise.resolve();
    let video: HTMLVideoElement | undefined;
    let layer: LayerHost | undefined;
    let media: Element | undefined;
    const muted = opts.mode === 'render' || !!track.muted;

    switch (clip.type) {
      case 'text': {
        const tp = clip.props;
        const family = tp.fontFamily ?? defaultFamily;
        if (!family) report('fontMissing', `text clip has no font and the composition declares none; using ${FALLBACK_FONT}`, clip.id);
        else if (!declaredFamilies.has(family.toLowerCase())) report('fontMissing', `font ${family} is not declared in fonts[]; using a fallback`, clip.id);
        content.textContent = tp.text;
        Object.assign(content.style, {
          fontFamily: family ? `${cssString(family)}, ${FALLBACK_FONT}` : FALLBACK_FONT,
          fontSize: `${tp.fontSize ?? 48}px`, fontWeight: String(tp.fontWeight ?? 'normal'), color: tp.color ?? '#ffffff',
          textAlign: tp.align ?? 'left', lineHeight: '1.2', whiteSpace: 'pre-wrap', overflowWrap: 'break-word',
        });
        break;
      }
      case 'shape': {
        Object.assign(content.style, { color: clip.props.fill ?? '#ffffff', backgroundColor: 'currentColor', borderRadius: `${clip.props.radius ?? 0}px` });
        break;
      }
      case 'image':
      case 'svg': {
        content.style.overflow = 'hidden';
        const url = assetUrl(clip.src, clip.id);
        if (!url) break;
        const img = doc.createElement('img');
        img.alt = '';
        img.decoding = 'sync';
        img.draggable = false;
        Object.assign(img.style, { display: 'block', width: '100%', height: '100%', objectFit: clip.props.fit ?? 'cover' });
        img.src = url;
        content.appendChild(img);
        media = img;
        prepare = withTimeout(img.decode(), timeouts.load, n, `decoding ${clip.src} timed out`)
          .catch((e: unknown) => report('assetLoadFailed', `image ${clip.src}: ${String(e instanceof Error ? e.message : e)}`, clip.id));
        break;
      }
      case 'video': {
        content.style.overflow = 'hidden';
        const url = assetUrl(clip.src, clip.id);
        if (!url) break;
        video = doc.createElement('video');
        video.muted = muted || (clip.volume ?? 1) === 0;
        video.volume = Math.min(1, Math.max(0, clip.volume ?? 1));
        video.playsInline = true;
        video.preload = 'auto';
        video.disablePictureInPicture = true;
        Object.assign(video.style, { display: 'block', width: '100%', height: '100%', objectFit: 'cover' });
        video.src = url;
        content.appendChild(video);
        prepare = loadMedia(video, clip.id, clip.src);
        break;
      }
      case 'html': {
        const url = assetUrl(clip.src, clip.id);
        if (!url) break;
        const params: Record<string, string | number> = {};
        for (const [key, param] of Object.entries(clip.params ?? {})) {
          if (param.type === 'image') { const u = assetUrl(param.value, clip.id); if (u) params[key] = u; } else params[key] = param.value;
        }
        const frame = doc.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.setAttribute('scrolling', 'no');
        frame.tabIndex = -1;
        frame.name = encodeLayerConfig({ v: 1, mode: opts.mode, clipId: clip.id, params, fonts: layerFonts, frameTimeoutMs: Math.max(1, Math.floor(timeouts.layer / 2)) });
        Object.assign(frame.style, { display: 'block', width: '100%', height: '100%', border: '0', background: 'transparent', colorScheme: 'normal' });
        layer = connectLayer(frame, n, timeouts.layer);
        frame.src = url;
        content.appendChild(frame);
        const lh = layer;
        prepare = lh.ready().then(
          (warnings) => { for (const m of warnings) report('fontLoadFailed', `layer: ${m}`, clip.id); },
          (e: unknown) => report('layerTimeout', `html layer ${clip.src}: ${String(e instanceof Error ? e.message : e)}`, clip.id),
        );
        break;
      }
      default:
        report('unknownClipType', `unknown clip type ${(clip as { type?: unknown }).type as string}`, (clip as { id?: string }).id);
        return;
    }

    let anims: Array<{ anim: Animation; start: number }> = [];
    if (!still) {
      const compiled = compileAnimations(clip.animations, { width: c.width, height: c.height, clipDuration: clip.duration }, (m) => report('badAnimation', m, clip.id));
      if (compiled.some((a) => a.property === '--ms-blur')) content.style.filter = 'blur(var(--ms-blur))';
      anims = makeAnimations(content, compiled, clip.id);
      if ((clip.type === 'image' || clip.type === 'svg') && clip.props.kenBurns && media) {
        anims.push(...makeAnimations(media, [compileKenBurns(clip.props.kenBurns, clip.duration)], clip.id));
      }
    }
    stage.appendChild(box);
    mounted.push({ clip, box, content, anims, ...(video ? { video } : {}), ...(layer ? { layer } : {}), prepare, muted });
  };

  for (const track of c.tracks) {
    for (const clip of track.clips) {
      if (clip.type === 'audio') {
        if (opts.mode !== 'preview' || still) continue; // render: the core mixes audio with ffmpeg
        const url = assetUrl(clip.src, clip.id);
        if (!url) continue;
        const el = doc.createElement('audio');
        el.preload = 'auto';
        el.src = url;
        audioBin.appendChild(el);
        audios.push({ clip, el, muted: !!track.muted });
        continue;
      }
      if (track.hidden) continue;
      mountVisual(clip, track);
    }
  }

  // ---- time ----
  let time = 0;
  let playing = false;
  let loop = true;
  let rate = 1;
  let selected: string | null = null;
  let scaleMode: number | 'fit' = 'fit';
  let scale = 1;
  let audioBlockedReported = false;

  const clampT = (t: number) => (still ? 0 : Math.min(Math.max(0, t), c.duration));

  /** Visibility and JSON animations at t (synchronous, cheap). */
  const applyStatic = (t: number) => {
    for (const m of mounted) {
      const on = isClipVisible(m.clip, t, c.duration);
      m.box.style.display = on ? '' : 'none';
      if (!on) continue;
      const local = t - m.clip.start;
      for (const { anim, start } of m.anims) anim.currentTime = (local - start) * 1000;
    }
  };

  const seekVideo = async (m: Mounted, t: number) => {
    const v = m.video!;
    if (m.clip.type !== 'video') return;
    const target = videoSourceTime(m.clip, t, v.duration);
    if (!v.paused) v.pause();
    if (Math.abs(v.currentTime - target) < 1e-6 && !v.seeking && v.readyState >= 2) return;
    const seeked = new Promise<void>((resolve) => v.addEventListener('seeked', () => resolve(), { once: true }));
    v.currentTime = target;
    await withTimeout(seeked, timeouts.seek, n, `video ${m.clip.src} did not seek to ${target}`)
      .catch((e: unknown) => report('videoSeekTimeout', String(e instanceof Error ? e.message : e), m.clip.id));
  };

  const doSeek = async (t: number) => {
    time = clampT(t);
    opts.clock?.advanceTo(time * 1000);
    await fontsLoaded;
    applyStatic(time);
    const work: Array<Promise<void>> = [];
    for (const m of mounted) {
      if (!isClipVisible(m.clip, time, c.duration)) continue;
      if (m.video) work.push(seekVideo(m, time));
      if (m.layer) {
        work.push(m.layer.seek(time - m.clip.start).catch((e: unknown) => {
          if (e instanceof LayerRequestError && e.code === 'frameTimeout') {
            report('frameTimeout', `html layer painted no frame after seeking to ${time}: ${e.message}`, m.clip.id);
            throw e; // render: fail the seek rather than capture a stale layer
          }
          report('layerError', `layer seek: ${String(e instanceof Error ? e.message : e)}`, m.clip.id);
        }));
      }
    }
    for (const a of audios) if (!a.el.paused) a.el.pause();
    await Promise.all(work);
    if (opts.mode === 'render') {
      // Render: wait as long as a seek may take; no frame means the seek fails (a capture now could be stale).
      try {
        await twoFrames(n, { strict: true, timeoutMs: timeouts.seek });
      } catch (e) {
        if (e instanceof FrameTimeoutError) report('frameTimeout', `no animation frame after seeking to ${time}: ${e.message}`);
        throw e;
      }
    } else {
      await twoFrames(n);
    }
  };

  let seekLoop: Promise<void> | null = null;
  let pendingSeek: number | null = null;
  const seek = (t: number): Promise<void> => {
    if (playing) stopPlayback();
    pendingSeek = t;
    if (!seekLoop) {
      seekLoop = (async () => {
        try {
          while (pendingSeek !== null) {
            const next = pendingSeek;
            pendingSeek = null;
            await doSeek(next);
          }
        } catch (e) {
          pendingSeek = null; // a failed seek drops the queued ones; the caller sees the failure
          throw e;
        } finally {
          seekLoop = null;
        }
        player.onTime?.(time, false);
        player.onBounds?.();
      })();
    }
    return seekLoop;
  };

  // ---- preview playback (real time, native clock) ----
  let wallStart = 0;
  let tStart = 0;
  const syncMedia = (t: number) => {
    for (const m of mounted) {
      if (!m.video || m.clip.type !== 'video') continue;
      const v = m.video;
      const on = isClipVisible(m.clip, t, c.duration);
      if (!on) { if (!v.paused) v.pause(); continue; }
      const target = (m.clip.trimStart ?? 0) + (t - m.clip.start);
      v.playbackRate = rate;
      if (v.paused) { v.currentTime = target; playMedia(v, m.clip.id); } else if (needsResync(v.currentTime, target, c.fps)) v.currentTime = target;
    }
    for (const a of audios) {
      const el = a.el;
      const local = t - a.clip.start;
      const on = local >= 0 && local < a.clip.duration;
      if (!on) { if (!el.paused) el.pause(); continue; }
      el.volume = audioGain(a.clip, t);
      el.muted = a.muted;
      el.playbackRate = rate;
      const target = (a.clip.trimStart ?? 0) + local;
      if (el.paused) { el.currentTime = target; playMedia(el); } else if (needsResync(el.currentTime, target, c.fps)) el.currentTime = target;
    }
  };
  const playMedia = (el: HTMLMediaElement, clipId?: string) => {
    el.play().catch((e: unknown) => {
      if ((e as { name?: string })?.name !== 'NotAllowedError') return;
      if (!audioBlockedReported) { audioBlockedReported = true; report('audioBlocked', 'the browser blocked audio playback; playing muted', clipId); }
      el.muted = true;
      el.play().catch(() => {});
    });
  };
  const frame = () => {
    if (!playing) return;
    let t = tStart + ((n.performanceNow() - wallStart) / 1000) * rate;
    if (t >= c.duration) {
      if (loop) {
        t = c.duration > 0 ? t % c.duration : 0;
        tStart = t; wallStart = n.performanceNow();
        for (const m of mounted) m.video?.pause();
        for (const a of audios) a.el.pause();
      } else {
        time = c.duration;
        stopPlayback();
        seek(c.duration).catch(() => {});
        return;
      }
    }
    time = t;
    applyStatic(t);
    for (const m of mounted) if (m.layer && isClipVisible(m.clip, t, c.duration)) m.layer.tick(t - m.clip.start);
    syncMedia(t);
    player.onTime?.(t, true);
    n.requestAnimationFrame(frame);
  };
  const stopPlayback = () => {
    playing = false;
    for (const m of mounted) m.video?.pause();
    for (const a of audios) a.el.pause();
  };

  // ---- preview layout ----
  const applyScale = () => {
    if (opts.mode !== 'preview') { scale = 1; stage.style.transform = ''; return; }
    const vw = w.innerWidth || c.width; const vh = w.innerHeight || c.height;
    scale = scaleMode === 'fit' ? Math.min(vw / c.width, vh / c.height) : scaleMode;
    const ox = (vw - c.width * scale) / 2; const oy = (vh - c.height * scale) / 2;
    stage.style.transform = `translate(${ox}px, ${oy}px) scale(${scale})`;
  };
  applyScale();
  if (opts.mode === 'preview') w.addEventListener('resize', () => { applyScale(); player.onBounds?.(); });

  let readyPromise: Promise<ReadyInfo> | null = null;
  const player: Player = {
    duration: still ? 0 : c.duration,
    fps: c.fps,
    width: c.width,
    height: c.height,
    get time() { return time; },
    get playing() { return playing; },
    get scale() { return scale; },
    get selected() { return selected; },
    ready() {
      readyPromise ??= (async () => {
        await Promise.all([fontsLoaded, ...mounted.map((m) => m.prepare), ...audios.map((a) => loadMedia(a.el, a.clip.id, a.clip.src))]);
        await seek(0);
        return { duration: player.duration, fps: c.fps, width: c.width, height: c.height, frames: frameCount(c.duration, c.fps) };
      })();
      return readyPromise;
    },
    seek,
    play(o = {}) {
      if (opts.mode !== 'preview' || still) return;
      loop = o.loop ?? true;
      rate = o.rate ?? 1;
      if (playing) { tStart = time; wallStart = n.performanceNow(); return; }
      playing = true;
      tStart = time >= c.duration ? 0 : time;
      wallStart = n.performanceNow();
      n.requestAnimationFrame(frame);
    },
    pause() {
      if (!playing) return;
      stopPlayback();
      seek(time).catch(() => {});
    },
    select(clipId) { selected = clipId; player.onBounds?.(); },
    setScale(s) { scaleMode = s; applyScale(); player.onBounds?.(); },
    selectedBounds() {
      if (!selected) return null;
      const m = mounted.find((x) => x.clip.id === selected);
      if (!m || m.box.style.display === 'none') return null;
      const r = m.content.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    },
  };
  return player;
}
