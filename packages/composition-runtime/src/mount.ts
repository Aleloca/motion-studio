import type { Clip, Composition, Track } from '@motion-studio/shared';
import { compileAnimations, compileKenBurns, REGISTERED_PROPERTIES, type CompiledAnimation } from './animations.ts';
import type { Natives, VirtualClock } from './clock.ts';
import { FrameTimeoutError, twoFrames, withTimeout } from './frames.ts';
import { connectLayer, LayerRequestError, type LayerHost } from './layer-host.ts';
import { encodeLayerConfig, type LayerFont } from './layer-protocol.ts';
import type { Rect, RuntimeError, RuntimeErrorCode, RuntimeMode } from './protocol.ts';
import { audioGain, frameCount, isClipVisible, needsResync, pickVideoFrame, sourceTrustedOf, sourceVideoEndOf, videoSourceTime } from './timing.ts';

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
  /** Render mode: where the video's frame is drawn (see `drawVideoFrame`). */
  canvas?: HTMLCanvasElement;
  layer?: LayerHost;
  prepare: Promise<void>;
  muted: boolean;
  /** Shown at the current time. */
  visible: boolean;
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

  /**
   * The URL of a composition file (under `assets/` or `layers/`), confined to the composition folder. `media` also allows the
   * core's normalised video files, `media/<id>.mp4` (README "normalised media"): the core rewrites a video clip's `src` to
   * one when it mints the session, and the server maps it to the file in its media cache. Never a composition path.
   */
  const assetUrl = (src: unknown, clipId?: string, media = false): string | null => {
    const prefixed = typeof src === 'string' && (src.startsWith('assets/') || src.startsWith('layers/') || (media && src.startsWith('media/')));
    if (typeof src !== 'string' || src.length === 0 || /[?#\\]/.test(src) || !prefixed) {
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
    let canvas: HTMLCanvasElement | undefined;
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
        const url = assetUrl(clip.src, clip.id, true);
        if (!url) break;
        video = doc.createElement('video');
        video.muted = muted || (clip.volume ?? 1) === 0;
        video.volume = Math.min(1, Math.max(0, clip.volume ?? 1));
        video.playsInline = true;
        video.preload = 'auto';
        video.disablePictureInPicture = true;
        video.src = url;
        if (opts.mode === 'render') {
          // Render: the frame is drawn into a canvas after each seek (drawVideoFrame), never composited as a video layer.
          video.style.display = 'none';
          canvas = doc.createElement('canvas');
          Object.assign(canvas.style, { display: 'block', width: '100%', height: '100%' });
          content.appendChild(canvas);
        } else {
          Object.assign(video.style, { display: 'block', width: '100%', height: '100%', objectFit: 'cover' });
        }
        content.appendChild(video);
        prepare = loadMedia(video, clip.id, clip.src);
        // Normalised media (README "Normalised media"): the core's file has no audio, so the preview plays the clip's sound
        // from the original asset (`audioSrc`) in an `<audio>` element kept on the timeline like an audio clip, starting at
        // `audioStart` (the original's first video frame on its media timeline). Render mode: the core mixes the sound.
        const audioSrc = (clip as { audioSrc?: unknown }).audioSrc;
        if (opts.mode === 'preview' && !still && typeof audioSrc === 'string') {
          video.muted = true;
          const volume = clip.volume ?? 1;
          const aurl = volume > 0 ? assetUrl(audioSrc, clip.id) : null;
          if (aurl) {
            const raw = (clip as { audioStart?: unknown }).audioStart;
            const offset = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 36_000 ? raw : 0;
            const el = doc.createElement('audio');
            el.preload = 'auto';
            el.src = aurl;
            audioBin.appendChild(el);
            const sound = { id: clip.id, type: 'audio', src: audioSrc, start: clip.start, duration: clip.duration, trimStart: offset + (clip.trimStart ?? 0), volume } as AudioClip;
            audios.push({ clip: sound, el, muted: !!track.muted });
          }
        }
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
    mounted.push({ clip, box, content, anims, ...(video ? { video } : {}), ...(canvas ? { canvas } : {}), ...(layer ? { layer } : {}), prepare, muted, visible: false });
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
      m.visible = on;
      m.box.style.display = on ? '' : 'none';
      if (!on) continue;
      const local = t - m.clip.start;
      for (const { anim, start } of m.anims) anim.currentTime = (local - start) * 1000;
    }
  };

  /**
   * Render mode draws a video's frame into its canvas after each seek instead of compositing the `<video>`. Measured in
   * Chrome 154 (4 pages seeking at once, load ≈150): a video layer that is shown for the first time attaches to the
   * compositor asynchronously, and until it does a screenshot shows the frame decoded at load (source frame 0), even
   * after `seeked`, two animation frames, and `requestVideoFrameCallback` reporting the right frame as presented: 11–13 of
   * ~100 first-visible frames were wrong; extra animation frames or keeping the layer at opacity 0 did not help. A canvas
   * is painted by the main thread like the rest of the page, so the two frames after a seek carry it. The preview keeps
   * the `<video>` (it plays).
   */
  /**
   * Draws `source` (`vw`×`vh`, a VideoFrame or the video) into the clip's canvas, `object-fit: cover`. The canvas gets the
   * pixels of the source region it shows times the clip's effective on-screen scale (its `scale` and animations included,
   * so a zoomed video stays sharp), never more than that source region holds; CSS stretches it to the box.
   * Colour: this path ignores a video's transfer tag while the preview `<video>` converts it; the core's normalised files are
   * tagged so that both show the same values (README "colour").
   */
  const drawVideoFrame = (m: Mounted, source: CanvasImageSource, vw: number, vh: number) => {
    const cv = m.canvas!;
    if (!(vw > 0 && vh > 0)) return;
    const lw = m.content.clientWidth || vw, lh = m.content.clientHeight || vh;
    const k = Math.max(lw / vw, lh / vh);
    const sw = lw / k, sh = lh / k; // the source region shown (cover)
    const r = m.content.getBoundingClientRect();
    const scale = Math.max(1, r.width / lw || 1, r.height / lh || 1);
    const w = Math.max(1, Math.round(Math.min(sw, lw * scale))), h = Math.max(1, Math.round(Math.min(sh, lh * scale)));
    if (cv.width !== w) cv.width = w;
    if (cv.height !== h) cv.height = h;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(source, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, w, h);
  };

  type Frame = { timestamp: number; duration: number | null; displayWidth: number; displayHeight: number; close(): void };
  const VideoFrameCtor = (globalThis as { VideoFrame?: new (s: HTMLVideoElement) => Frame }).VideoFrame;
  /** The frame the video holds now, as a WebCodecs VideoFrame (the caller closes it), or null. */
  const grabFrame = (v: HTMLVideoElement): Frame | null => {
    if (typeof VideoFrameCtor !== 'function' || v.readyState < 2) return null;
    try { return new VideoFrameCtor(v); } catch { return null; }
  };
  /** The timestamp (µs) of each video's load frame: the one it holds before its first seek (decoded at load). */
  const loadStamps = new WeakMap<HTMLVideoElement, number>();
  /** Videos that have drawn a frame after a seek: their load frame is no longer suspect. */
  const drawnOnce = new WeakSet<HTMLVideoElement>();

  /**
   * Draws the frame shown at `target` into the clip's canvas. `drawImage(video)` right after `seeked` can still read the
   * previous frame, so the frame is taken as a WebCodecs `VideoFrame` and checked by its timestamp and duration
   * (`frameVerdict`, timing.ts). A core-probed source (`sourceTrusted`) gets the strict rule: a frame that ended before
   * the target is never drawn, and if no right one comes before the seek's deadline the seek fails (`videoSeekTimeout`).
   * An untrusted source gets the lenient rule: the covering frame, else a stable one with a non-fatal
   * `videoFrameMismatch`. Returns false when nothing was drawn.
   */
  const paintVideo = async (m: Mounted, target: number, deadline: number): Promise<boolean> => {
    const v = m.video!;
    if (m.clip.type !== 'video') return true;
    const clip = m.clip;
    if (typeof VideoFrameCtor !== 'function') { drawVideoFrame(m, v, v.videoWidth, v.videoHeight); return true; }
    const span = clip.sourceFps ? 1 / clip.sourceFps : null;
    const videoEnd = sourceVideoEndOf(clip);
    const r = await pickVideoFrame<Frame>({
      read: () => grabFrame(v),
      stamp: (f) => ({ tsUs: Math.round(f.timestamp), durUs: typeof f.duration === 'number' && f.duration > 0 ? Math.round(f.duration) : null }),
      close: (f) => f.close(),
      nextFrame: () => new Promise<void>((resolve) => { n.requestAnimationFrame(() => resolve()); }),
      now: () => n.performanceNow(), deadline,
      targetUs: Math.round(target * 1e6), trusted: sourceTrustedOf(clip),
      videoEndUs: videoEnd === null ? null : Math.round(videoEnd * 1e6),
      // At the end of the media: the target sits in the last (declared or nominal 1/30 s) frame of the element's duration.
      atEnd: () => Number.isFinite(v.duration) && !v.seeking && v.currentTime >= v.duration - (span ?? 1 / 30) - 1e-3,
      loadTsUs: drawnOnce.has(v) ? null : (loadStamps.get(v) ?? null), spanUs: span === null ? null : Math.round(span * 1e6),
    });
    const at = (us: number) => (us / 1e6).toFixed(3);
    if (r.frame) {
      drawnOnce.add(v);
      if (r.verdict === 'warn') {
        report('videoFrameMismatch', r.tsUs! > Math.round(target * 1e6)
          ? `video ${clip.src}: frame at ${at(r.tsUs!)} s drawn for ${target.toFixed(3)} s, before the source starts (sourceStart missing or wrong)`
          : `video ${clip.src}: frame at ${at(r.tsUs!)} s drawn for ${target.toFixed(3)} s although its duration does not reach it (untrusted source)`, clip.id);
      }
      drawVideoFrame(m, r.frame as unknown as CanvasImageSource, r.frame.displayWidth, r.frame.displayHeight);
      r.frame.close();
      return true;
    }
    // Not drawn: the render fails rather than capture a frame that is not the target's.
    report('videoSeekTimeout', r.tsUs === null ? `video ${clip.src} gave no frame at ${target.toFixed(3)} s`
      : `video ${clip.src} still showed the frame at ${at(r.tsUs)} s (${r.verdict}), not ${target.toFixed(3)} s`, clip.id);
    return false;
  };

  /**
   * Seeks one video: the `seeked` wait and the frame check share one deadline (`timeouts.seek`). Render mode fails fast:
   * a frame that could not be drawn rejects the seek (`videoSeekTimeout`), so the renderer stops at once instead of
   * waiting out the deadline of every later seek.
   */
  const seekVideo = async (m: Mounted, t: number) => {
    const v = m.video!;
    if (m.clip.type !== 'video') return;
    const deadline = n.performanceNow() + timeouts.seek;
    const target = videoSourceTime(m.clip, t, v.duration);
    if (!v.paused) v.pause();
    if (m.canvas && !loadStamps.has(v)) {
      const f = grabFrame(v);
      if (f) { loadStamps.set(v, Math.round(f.timestamp)); f.close(); }
    }
    if (!(Math.abs(v.currentTime - target) < 1e-6 && !v.seeking && v.readyState >= 2)) {
      const seeked = new Promise<void>((resolve) => v.addEventListener('seeked', () => resolve(), { once: true }));
      v.currentTime = target;
      await withTimeout(seeked, Math.max(1, deadline - n.performanceNow()), n, `video ${m.clip.src} did not seek to ${target}`)
        .catch((e: unknown) => report('videoSeekTimeout', String(e instanceof Error ? e.message : e), m.clip.id));
    }
    if (m.canvas && !(await paintVideo(m, target, deadline))) {
      throw new Error(`videoSeekTimeout: video ${m.clip.src} has no frame for ${target.toFixed(3)} s`);
    }
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
      if (!m || !m.visible) return null;
      const r = m.content.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    },
  };
  return player;
}
