import type { Clip, Composition, Track } from '@motion-studio/shared';
import { clipPathHasNoArea } from './clip-path.ts';
import { compileAnimations, compileKenBurns, REGISTERED_PROPERTIES, type CompiledAnimation } from './animations.ts';
import type { Natives, VirtualClock } from './clock.ts';
import { FrameTimeoutError, twoFrames, withTimeout } from './frames.ts';
import { connectLayer, LayerDisposedError, LayerRequestError, type LayerHost } from './layer-host.ts';
import { encodeLayerConfig, type LayerConfig, type LayerFont } from './layer-protocol.ts';
import type { Rect, RuntimeError, RuntimeErrorCode, RuntimeMode } from './protocol.ts';
import { activeCue, drawSubtitles, type RuntimeSubtitles } from './subtitles.ts';
import { audioGain, frameCount, isClipVisible, needsAudioResync, needsResync, pickVideoFrame, PRE_SEEK_SETTLE_MS, sourceTrustedOf, sourceVideoEndOf, videoSourceTime } from './timing.ts';

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
  /** The format's safe zone (insets): the room of a text clip without an explicit box (render-mode measure). */
  safeZone?: { top: number; bottom: number; left: number; right: number };
  /** The subtitle set the `subtitles` clip draws (page data, already checked), or none; `Player.setSubtitles` replaces it. */
  subtitles?: RuntimeSubtitles | null;
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
  /** Fonts, media and layers loaded, nothing shown yet (a re-mount seeks straight to its kept time). */
  load(): Promise<void>;
  /** Deterministic seek; concurrent calls coalesce to the latest time. Pauses playback. */
  seek(t: number): Promise<void>;
  /** `from`: start there instead of the time shown (a re-mount resumes where the old mount had got to). */
  play(o?: { loop?: boolean; rate?: number; from?: number }): void;
  pause(): void;
  select(clipId: string | null): void;
  setScale(scale: number | 'fit'): void;
  /** Preview: silences every sound (videos and audio clips) or restores each one's own setting. */
  setMuted(muted: boolean): void;
  /** Replaces the subtitles the `subtitles` clip draws (null: none): the built-in look redraws them at the time shown, a template's layer is opened again with them. */
  setSubtitles(subtitles: RuntimeSubtitles | null): void;
  /** The selected clip (preview), or null. */
  readonly selected: string | null;
  /** Bounds of the selected clip in viewport CSS pixels, or null. */
  selectedBounds(): Rect | null;
  readonly scale: number;
  /** Called with the time shown: every frame while playing, after each seek and on pause. */
  onTime?: (t: number, playing: boolean) => void;
  /** Called when the selected clip's bounds may have changed. */
  onBounds?: () => void;
  /**
   * Tears the mount down (preview `setComposition`): stops playback, cancels every animation, releases every media element
   * and layer frame, deletes its font faces, removes its elements and listeners. Afterwards the player reports nothing,
   * ignores every command and never calls back. Idempotent.
   */
  destroy(): void;
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
  /** The layer's frame (html clips and subtitle templates). */
  frame?: HTMLIFrameElement;
  prepare: Promise<void>;
  muted: boolean;
  /** Shown at the current time. */
  visible: boolean;
  /** A `subtitles` clip with the built-in look: the lane `drawSubtitles` draws the line in. */
  subs?: HTMLDivElement;
}
/** `derived`: the sound of a normalised video clip (its `audioSrc`), not an audio clip of the composition. */
interface MountedAudio { clip: AudioClip; el: HTMLAudioElement; muted: boolean; derived?: boolean }
/** What a subtitle template gets when there are no subtitles: an empty set, its language undetermined (BCP 47 `und`). */
const NO_SUBTITLES: RuntimeSubtitles = { lang: 'und', cues: [] };
/** How long `ready()` waits for a video clip's derived sound before going on without it (`clipAudioFailed`). */
const DERIVED_AUDIO_WAIT_MS = 3000;

const DEFAULTS = { load: 120_000, seek: 60_000, layer: 60_000 };
/**
 * Preview (final wave P5): how long a paused seek waits for the sought video frame before it shows the `<video>` as it is.
 * Short, so scrubbing never stalls on a source whose frames cannot be checked.
 */
export const PREVIEW_FRAME_WAIT_MS = 5_000;
/** Ends a `videoFrameMismatch` message when the frame was accepted only after the seek's deadline (a stalled seek). */
const LATE_FRAME = 'held until the seek deadline';

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
  let destroyed = false;
  const report = (code: RuntimeErrorCode, message: string, clipId?: string) => {
    if (!destroyed) opts.report({ code, message, ...(clipId ? { clipId } : {}) });
  };
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
  const faces: FontFace[] = [];
  for (const f of c.fonts ?? []) {
    const url = assetUrl(f.src);
    if (!url) continue;
    const weight = f.weight === undefined ? undefined : String(f.weight);
    declaredFamilies.add(f.family.toLowerCase());
    layerFonts.push({ family: f.family, url, ...(weight ? { weight } : {}), ...(f.style ? { style: f.style } : {}) });
    try {
      const face = new w.FontFace(f.family, `url("${url}")`, { ...(weight ? { weight } : {}), ...(f.style ? { style: f.style } : {}) });
      doc.fonts.add(face);
      faces.push(face);
      fontLoads.push(face.load().then(() => {}, (e: unknown) => report('fontLoadFailed', `font ${f.family} (${f.src}) failed to load: ${String(e)}`)));
    } catch (e) {
      report('fontLoadFailed', `font ${f.family}: ${String(e)}`);
    }
  }
  const fontsLoaded = Promise.all(fontLoads).then(() => {});
  const defaultFamily = c.fonts?.[0]?.family;
  /** The CSS font chain of a clip that names `family` (or none): the family, the composition's fallbacks, the generic font. */
  const fontChain = (family: string | undefined) => [...(family ? [cssString(family)] : []), ...(c.fontFallbacks ?? []).map(cssString), FALLBACK_FONT].join(', ');
  /** Reports a text family the composition does not declare (or no family at all), as a text clip does. */
  const checkFamily = (family: string | undefined, kind: string, clipId: string) => {
    if (!family) report('fontMissing', `${kind} clip has no font and the composition declares none; using ${FALLBACK_FONT}`, clipId);
    else if (!declaredFamilies.has(family.toLowerCase())) report('fontMissing', `font ${family} is not declared in fonts[]; using a fallback`, clipId);
  };
  let subtitles = opts.subtitles ?? null;

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

  /** A derived sound (see MountedAudio): a short, bounded wait; a failure is only a warning, the clip plays silent. */
  const loadDerivedAudio = (a: MountedAudio) => withTimeout(new Promise<void>((resolve, reject) => {
    if (a.el.readyState >= 2) { resolve(); return; }
    a.el.addEventListener('loadeddata', () => resolve(), { once: true });
    a.el.addEventListener('error', () => reject(new Error(`cannot load ${a.clip.src}`)), { once: true });
  }), Math.min(DERIVED_AUDIO_WAIT_MS, timeouts.load), n, `loading ${a.clip.src} timed out`)
    .catch((e: unknown) => report('clipAudioFailed', String(e instanceof Error ? e.message : e), a.clip.id));

  /**
   * An html layer in `content`: a sandboxed frame (its own opaque origin, see layer-protocol.ts) on `url`, configured through
   * its `name`, connected; `prepare` resolves once it is ready (a failure is reported, never thrown). Html clips and
   * subtitle templates (`extra.subtitles`) alike. `hidden`: laid over the frame already there, transparent (a remount).
   */
  const openLayer = (content: HTMLElement, clipId: string, url: string, file: string, extra: Pick<LayerConfig, 'params'> & Partial<Pick<LayerConfig, 'subtitles'>>, hidden = false) => {
    const frame = doc.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('scrolling', 'no');
    frame.tabIndex = -1;
    frame.name = encodeLayerConfig({ v: 1, mode: opts.mode, clipId, params: extra.params, fonts: layerFonts, frameTimeoutMs: Math.max(1, Math.floor(timeouts.layer / 2)), ...(extra.subtitles ? { subtitles: extra.subtitles } : {}) });
    Object.assign(frame.style, { display: 'block', width: '100%', height: '100%', border: '0', background: 'transparent', colorScheme: 'normal' });
    if (hidden) Object.assign(frame.style, { position: 'absolute', left: '0', top: '0', opacity: '0' });
    const layer = connectLayer(frame, n, timeouts.layer, { failFast: opts.mode === 'render' });
    frame.src = url;
    content.appendChild(frame);
    const prepare = layer.ready().then(
      (warnings) => { for (const m of warnings) report('fontLoadFailed', `layer: ${m}`, clipId); },
      // `layerStalled` (decision 709): msReady waited on the frozen render clock; anything else is the layer not answering.
      // A layer disposed meanwhile (torn down, or a template replaced) is no failure.
      (e: unknown) => { if (!(e instanceof LayerDisposedError)) report(e instanceof LayerRequestError && e.code === 'layerStalled' ? 'layerStalled' : 'layerTimeout', `html layer ${file}: ${String(e instanceof Error ? e.message : e)}`, clipId); },
    );
    return { frame, layer, prepare };
  };
  /** Lets go of a layer and its frame. */
  const closeLayer = (l: { frame: HTMLIFrameElement; layer: LayerHost }) => {
    l.layer.dispose();
    l.frame.removeAttribute('src');
    l.frame.remove();
  };

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
    let frame: HTMLIFrameElement | undefined;
    let media: Element | undefined;
    let subs: HTMLDivElement | undefined;
    const muted = opts.mode === 'render' || !!track.muted;

    switch (clip.type) {
      case 'text': {
        const tp = clip.props;
        const family = tp.fontFamily ?? defaultFamily;
        checkFamily(family, 'text', clip.id);
        content.textContent = tp.text;
        Object.assign(content.style, {
          fontFamily: fontChain(family),
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
          // Preview (final wave P5): while paused, the sought frame is drawn into this canvas and shown instead of the
          // `<video>`, which Chrome may still composite with its load frame (see drawVideoFrame); playback shows the video.
          canvas = doc.createElement('canvas');
          Object.assign(canvas.style, { display: 'none', width: '100%', height: '100%' });
          content.appendChild(canvas);
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
            audios.push({ clip: sound, el, muted: !!track.muted, derived: true });
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
        ({ frame, layer, prepare } = openLayer(content, clip.id, url, clip.src, { params }));
        break;
      }
      case 'subtitles': {
        // The line comes from the subtitle set (`subtitles`), drawn at each time by `drawSubtitles` (applyStatic). Its
        // fonts are the composition's, loaded with the others before any seek shows a frame.
        if (clip.template) {
          // Task 17: an html layer draws the line instead (same frame, sandbox, bootstrap and checks as an html clip), fed
          // with the subtitle set (`window.msSubtitles`, `window.msActiveCue`); the built-in look stays off for this clip.
          const url = assetUrl(clip.template, clip.id);
          if (url) ({ frame, layer, prepare } = openLayer(content, clip.id, url, clip.template, { params: {}, subtitles: subtitles ?? NO_SUBTITLES }));
          break;
        }
        checkFamily(clip.props.fontFamily ?? defaultFamily, 'subtitles', clip.id);
        subs = doc.createElement('div');
        subs.className = 'ms-subs';
        subs.style.display = 'none';
        content.appendChild(subs);
        break;
      }
      default:
        report('unknownClipType', `unknown clip type ${(clip as { type?: unknown }).type as string}`, (clip as { id?: string }).id);
        return;
    }

    let anims: Array<{ anim: Animation; start: number }> = [];
    if (!still) {
      const compiled = compileAnimations(clip.type === 'subtitles' ? undefined : clip.animations, { width: c.width, height: c.height, clipDuration: clip.duration }, (m) => report('badAnimation', m, clip.id));
      if (compiled.some((a) => a.property === '--ms-blur')) content.style.filter = 'blur(var(--ms-blur))';
      anims = makeAnimations(content, compiled, clip.id);
      if ((clip.type === 'image' || clip.type === 'svg') && clip.props.kenBurns && media) {
        anims.push(...makeAnimations(media, [compileKenBurns(clip.props.kenBurns, clip.duration)], clip.id));
      }
    }
    stage.appendChild(box);
    mounted.push({ clip, box, content, anims, ...(video ? { video } : {}), ...(canvas ? { canvas } : {}), ...(layer ? { layer } : {}), ...(frame ? { frame } : {}), ...(subs ? { subs } : {}), prepare, muted, visible: false });
  };

  for (const track of c.tracks) {
    for (const clip of track.clips) {
      // Hidden (the editor's eye, Phase 10b): neither drawn nor heard, in both modes (the core's mix skips them too).
      if (clip.hidden || track.hidden) continue;
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

  const subtitleFrame = { width: c.width, height: c.height, ...(opts.safeZone ? { safeZone: opts.safeZone } : {}) };
  /** The subtitle line at t (whole microseconds, so frame times like 1/30 s land on the same millisecond every time). */
  const drawLine = (m: Mounted, t: number) => {
    if (!m.subs || m.clip.type !== 'subtitles') return;
    const ms = Math.round(t * 1e6) / 1e3;
    const i = subtitles ? activeCue(subtitles.cues, ms) : -1;
    drawSubtitles(m.subs, m.clip, i >= 0 ? subtitles!.cues[i]! : null, ms, subtitleFrame, { fontFamily: fontChain(m.clip.props.fontFamily ?? defaultFamily) });
  };

  /** Visibility, JSON animations and the subtitle line at t (synchronous, cheap). */
  const applyStatic = (t: number) => {
    for (const m of mounted) {
      const on = isClipVisible(m.clip, t, c.duration);
      m.visible = on;
      m.box.style.display = on ? '' : 'none';
      if (!on) continue;
      const local = t - m.clip.start;
      for (const { anim, start } of m.anims) anim.currentTime = (local - start) * 1000;
      drawLine(m, t);
    }
  };

  /**
   * Render mode draws a video's frame into its canvas after each seek instead of compositing the `<video>`. Measured in
   * Chrome 154 (4 pages seeking at once, load ≈150): a video layer that is shown for the first time attaches to the
   * compositor asynchronously, and until it does a screenshot shows the frame decoded at load (source frame 0), even
   * after `seeked`, two animation frames, and `requestVideoFrameCallback` reporting the right frame as presented: 11–13 of
   * ~100 first-visible frames were wrong; extra animation frames or keeping the layer at opacity 0 did not help. A canvas
   * is painted by the main thread like the rest of the page, so the two frames after a seek carry it.
   *
   * Preview (final wave P5): the same race left a paused preview on frame 0 after a seek (a paused video presents no new
   * frame, so the stale load frame could stay for good: the macOS CI failure of the preview test). A paused preview now
   * shows the checked frame from a canvas too (`presentVideo`), with no error ever reported for it; playback shows the
   * `<video>` again. If no frame can be checked in time, the `<video>` stays as it was before.
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
   * Per video, the pre-seek frames (µs) already held out for the whole settle window and drawn with a warning: that frame
   * evidently is what this source shows there (its metadata under-reports its duration), so it is not held again.
   */
  const settledFrames = new WeakMap<HTMLVideoElement, Set<number>>();

  /**
   * Draws the frame shown at `target` into the clip's canvas. `drawImage(video)` right after `seeked` can still read the
   * previous frame, so the frame is taken as a WebCodecs `VideoFrame` and checked by its timestamp and duration
   * (`frameVerdict`, timing.ts). A core-probed source (`sourceTrusted`) gets the strict rule: a frame that ended before
   * the target is never drawn, and if no right one comes before the seek's deadline the seek fails (`videoSeekTimeout`).
   * An untrusted source gets the lenient rule: the covering frame, else a stable one with a non-fatal
   * `videoFrameMismatch`. Returns false when nothing was drawn.
   */
  const paintVideo = async (m: Mounted, target: number, deadline: number, preSeekTsUs: number | null, settleUntil: number, quiet = false): Promise<boolean> => {
    const v = m.video!;
    // Preview: what the user sees while paused, never a render error (the `<video>` stays shown when nothing is drawn).
    const say: typeof report = quiet ? () => {} : report;
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
      preSeekTsUs, settleUntil,
    });
    if (r.frame && r.heldOut && preSeekTsUs !== null && r.tsUs === preSeekTsUs) {
      let seen = settledFrames.get(v);
      if (!seen) settledFrames.set(v, seen = new Set());
      seen.add(preSeekTsUs);
    }
    const at = (us: number) => (us / 1e6).toFixed(3);
    if (r.frame) {
      drawnOnce.add(v);
      if (r.verdict === 'warn') {
        // Accepted only once the seek's deadline passed (a held load frame): the seek stalled, and the message says so.
        const late = n.performanceNow() > deadline ? `, ${LATE_FRAME}` : '';
        say('videoFrameMismatch', r.tsUs! > Math.round(target * 1e6)
          ? `video ${clip.src}: frame at ${at(r.tsUs!)} s drawn for ${target.toFixed(3)} s, before the source starts (sourceStart missing or wrong)${late}`
          : `video ${clip.src}: frame at ${at(r.tsUs!)} s drawn for ${target.toFixed(3)} s although its duration does not reach it (untrusted source)${late}`, clip.id);
      }
      drawVideoFrame(m, r.frame as unknown as CanvasImageSource, r.frame.displayWidth, r.frame.displayHeight);
      r.frame.close();
      return true;
    }
    // Not drawn: the render fails rather than capture a frame that is not the target's.
    say('videoSeekTimeout', r.tsUs === null ? `video ${clip.src} gave no frame at ${target.toFixed(3)} s`
      : `video ${clip.src} still showed the frame at ${at(r.tsUs)} s (${r.verdict}), not ${target.toFixed(3)} s`, clip.id);
    return false;
  };

  /**
   * Armed just before a seek sets `currentTime`: `wait(ms)` resolves true once Chrome presents a frame for the seek
   * (`requestVideoFrameCallback`), false after `ms` or without the API. Measured in Chrome 155 (render pages at background
   * QoS): the callback fires on every paused seek, also for a `display: none` video and for a frame equal to the previous
   * one, often after `seeked`; until it fires `new VideoFrame(video)` can still give the pre-seek frame, and once it has
   * fired it gives the seek's. The Ubuntu CI failure of the lenient WebM test (run 39141011457) was that race on a frame
   * already held out once (`settledFrames`), drawn one output frame late.
   */
  const framePresented = (v: HTMLVideoElement): { wait(ms: number): Promise<boolean> } | null => {
    const rv = v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number; cancelVideoFrameCallback?: (id: number) => void };
    if (typeof rv.requestVideoFrameCallback !== 'function') return null;
    let done = false;
    let wake: (() => void) | null = null;
    const id = rv.requestVideoFrameCallback(() => { done = true; wake?.(); });
    return {
      wait: (ms) => done ? Promise.resolve(true) : new Promise<boolean>((resolve) => {
        const timer = n.setTimeout(() => { wake = null; if (typeof rv.cancelVideoFrameCallback === 'function') rv.cancelVideoFrameCallback(id); resolve(done); }, ms);
        wake = () => { n.clearTimeout(timer); resolve(true); };
      }),
    };
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
    const moves = !(Math.abs(v.currentTime - target) < 1e-6 && !v.seeking && v.readyState >= 2);
    // The frame shown before this seek: the load frame (first seek), and for an untrusted source moving to another target
    // the pre-seek frame, which Chrome may still hand out for a while after `seeked` (frameVerdict), unless that very
    // frame was already held out once in this video (`settledFrames`). Both apply only when Chrome does not report the
    // seek's frame as presented in time (`framePresented`): the fallback.
    let preSeekTsUs: number | null = null;
    if (m.canvas && (!loadStamps.has(v) || (moves && !sourceTrustedOf(m.clip)))) {
      const f = grabFrame(v);
      if (f) {
        const ts = Math.round(f.timestamp);
        f.close();
        if (!loadStamps.has(v)) loadStamps.set(v, ts);
        if (moves && !sourceTrustedOf(m.clip) && !settledFrames.get(v)?.has(ts)) preSeekTsUs = ts;
      }
    }
    if (moves) {
      const seeked = new Promise<void>((resolve) => v.addEventListener('seeked', () => resolve(), { once: true }));
      const presented = m.canvas ? framePresented(v) : null;
      v.currentTime = target;
      await withTimeout(seeked, Math.max(1, deadline - n.performanceNow()), n, `video ${m.clip.src} did not seek to ${target}`)
        .catch((e: unknown) => report('videoSeekTimeout', String(e instanceof Error ? e.message : e), m.clip.id));
      // Chrome presented this seek's frame (even one equal to the frame before): what the video holds now is it, so the
      // pre-seek frame is not suspect any more and is never held out (a legitimately repeated frame costs nothing).
      if (presented && await presented.wait(Math.min(PRE_SEEK_SETTLE_MS, Math.max(1, deadline - n.performanceNow())))) preSeekTsUs = null;
    }
    if (!m.canvas) return;
    if (opts.mode === 'preview') {
      // A paused preview shows the checked frame (final wave P5); nothing is reported, and without one the `<video>` stays.
      const until = Math.min(deadline, n.performanceNow() + PREVIEW_FRAME_WAIT_MS);
      const ok = await paintVideo(m, target, until, preSeekTsUs, Math.min(until, n.performanceNow() + PRE_SEEK_SETTLE_MS), true);
      presentVideo(m, ok && !playing ? 'canvas' : 'video');
      return;
    }
    if (!(await paintVideo(m, target, deadline, preSeekTsUs, n.performanceNow() + PRE_SEEK_SETTLE_MS))) {
      throw new Error(`videoSeekTimeout: video ${m.clip.src} has no frame for ${target.toFixed(3)} s`);
    }
  };

  /** Preview (final wave P5): the canvas with the sought frame while paused, the `<video>` while it plays. */
  const presentVideo = (m: Mounted, show: 'canvas' | 'video') => {
    if (opts.mode !== 'preview' || !m.canvas || !m.video) return;
    m.canvas.style.display = show === 'canvas' ? 'block' : 'none';
    m.video.style.display = show === 'canvas' ? 'none' : 'block';
  };

  /**
   * Render mode (Phase 14 task 0, decision 740): whether a mounted clip's content has no visible area in the frame (the stage,
   * within the viewport) at the time just applied. Chrome throttles a sandboxed (cross-origin) iframe with no visible area
   * and runs no animation frames in it, so a layer seek there would wait for frames until `frameTimeout`. Such a layer
   * shows nothing, so its seek is skipped; it is seeked again, and painted, at the first seek that brings it into view.
   * Measured on the bounding box (position, size, `translate`/`scale`/`rotate` animations); never true without a layout.
   */
  const outOfFrame = (el: Element): boolean => {
    const s = stage.getBoundingClientRect();
    if (!(s.width > 0 && s.height > 0)) return false;
    const view = doc.documentElement;
    const left = Math.max(s.left, 0); const top = Math.max(s.top, 0);
    const right = Math.min(s.right, view.clientWidth || s.right); const bottom = Math.min(s.bottom, view.clientHeight || s.bottom);
    const r = el.getBoundingClientRect();
    return !(Math.min(r.right, right) > Math.max(r.left, left) && Math.min(r.bottom, bottom) > Math.max(r.top, top));
  };

  /** Render mode (decision 794): whether the element's own computed `clip-path` leaves it no visible area (see `clipPathHasNoArea`). */
  const clippedAway = (el: HTMLElement): boolean =>
    clipPathHasNoArea(doc.defaultView?.getComputedStyle(el).clipPath ?? '', el.offsetWidth, el.offsetHeight);

  const doSeek = async (t: number) => {
    if (destroyed) return;
    time = clampT(t);
    opts.clock?.advanceTo(time * 1000);
    await fontsLoaded;
    if (destroyed) return;
    applyStatic(time);
    const work: Array<Promise<void>> = [];
    for (const m of mounted) {
      if (!isClipVisible(m.clip, time, c.duration)) continue;
      if (m.video) work.push(seekVideo(m, time));
      if (m.layer && !(opts.mode === 'render' && (outOfFrame(m.content) || clippedAway(m.content)))) {
        work.push(m.layer.seek(time - m.clip.start).catch((e: unknown) => {
          // A subtitle template replaced while this seek ran (`remountTemplate`): its successor is sought at the time shown.
          if (e instanceof LayerDisposedError) return;
          if (e instanceof LayerRequestError && e.code === 'frameTimeout') {
            report('frameTimeout', `html layer painted no frame after seeking to ${time}: ${e.message}`, m.clip.id);
            throw e; // render: fail the seek rather than capture a stale layer
          }
          // Not thrown, deliberately (C8): the report fails the render at its end (the renderer refuses any runtime error but
          // the ignored ones), while a layer that navigated away or never answered must not stop the frames of the others.
          report(e instanceof LayerRequestError && e.code === 'layerStalled' ? 'layerStalled' : 'layerError', `layer seek: ${String(e instanceof Error ? e.message : e)}`, m.clip.id);
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
    if (destroyed) return Promise.resolve();
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
        // The real state: a `play` that arrived while the seek ran keeps playing (A5: the parent must not read it as an end).
        if (destroyed) return;
        player.onTime?.(time, playing);
        player.onBounds?.();
      })();
    }
    return seekLoop;
  };

  // ---- preview playback (real time, native clock) ----
  /** The whole preview is silenced (`mute`); each video's own muted state is kept to be restored. */
  let allMuted = false;
  const ownMuted = new Map<HTMLMediaElement, boolean>();
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
      el.muted = a.muted || allMuted;
      el.playbackRate = rate;
      const target = (a.clip.trimStart ?? 0) + local;
      // Audio tolerates more drift than video before a jump (each jump clicks): about 3 frames, at least 50 ms.
      if (el.paused) { el.currentTime = target; playMedia(el); } else if (needsAudioResync(el.currentTime, target, c.fps)) el.currentTime = target;
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
    if (!playing || destroyed) return;
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
  const onResize = () => { applyScale(); player.onBounds?.(); };
  if (opts.mode === 'preview') w.addEventListener('resize', onResize);

  /**
   * Preview `setSubtitles` with a subtitle template (Task 17): its layer is opened again with the new set (a layer reads its
   * configuration once, at load), laid transparent over the one shown; once ready and sought to the time shown, it replaces
   * it, so an edit never blanks the line. A seek of the old layer still running then rejects at once (`LayerDisposedError`,
   * not reported), so the player's next seek is never held. A newer `setSubtitles` drops a layer still loading.
   */
  const remounts = new Map<Mounted, { frame: HTMLIFrameElement; layer: LayerHost }>();
  const remountTemplate = (m: Mounted) => {
    if (m.clip.type !== 'subtitles' || !m.clip.template || !m.frame || !m.layer) return;
    const url = assetUrl(m.clip.template, m.clip.id);
    if (!url) return;
    const was = remounts.get(m);
    if (was) closeLayer(was);
    const next = openLayer(m.content, m.clip.id, url, m.clip.template, { params: {}, subtitles: subtitles ?? NO_SUBTITLES }, true);
    remounts.set(m, next);
    const current = () => !destroyed && remounts.get(m) === next;
    void next.prepare.then(async () => {
      if (!current()) return;
      // Shown only once sought to the time shown: again while a seek of the player moved it meanwhile (that seek went to the
      // old layer); while playing once, then its ticks carry it.
      for (let at = Number.NaN; m.visible && time !== at;) {
        at = time;
        await next.layer.seek(at - m.clip.start).catch((e: unknown) => {
          if (current() && !(e instanceof LayerDisposedError)) report(e instanceof LayerRequestError && e.code === 'layerStalled' ? 'layerStalled' : 'layerError', `layer seek: ${String(e instanceof Error ? e.message : e)}`, m.clip.id);
        });
        if (!current()) return;
        if (playing) break;
      }
      remounts.delete(m);
      closeLayer({ frame: m.frame!, layer: m.layer! });
      Object.assign(next.frame.style, { opacity: '' });
      m.frame = next.frame;
      m.layer = next.layer;
      m.prepare = next.prepare;
    });
  };

  /** Stops a media element and lets go of its resource (`src` removed, then `load()` resets it to empty). */
  const releaseMedia = (el: HTMLMediaElement) => {
    try { el.pause(); } catch { /* not playing */ }
    el.removeAttribute('src');
    try { el.load(); } catch { /* jsdom */ }
    el.remove();
  };
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    playing = false;
    pendingSeek = null;
    player.onTime = undefined;
    player.onBounds = undefined;
    if (opts.mode === 'preview') w.removeEventListener('resize', onResize);
    for (const l of remounts.values()) l.layer.dispose(); // their frames go with the others below
    remounts.clear();
    for (const m of mounted) {
      for (const { anim } of m.anims) { try { anim.cancel(); } catch { /* already gone */ } }
      if (m.video) releaseMedia(m.video);
      if (m.canvas) { m.canvas.width = 0; m.canvas.height = 0; }
      m.layer?.dispose();
      for (const f of m.content.querySelectorAll('iframe')) { f.removeAttribute('src'); f.remove(); }
      for (const img of m.content.querySelectorAll('img')) img.removeAttribute('src');
    }
    for (const a of audios) releaseMedia(a.el);
    for (const f of faces) { try { doc.fonts.delete(f); } catch { /* not in the set */ } }
    mounted.length = 0;
    audios.length = 0;
    faces.length = 0;
    ownMuted.clear();
    stage.remove();
    audioBin.remove();
  };

  let readyPromise: Promise<ReadyInfo> | null = null;
  let loadPromise: Promise<void> | null = null;
  /**
   * Render mode (Phase 12, Ruling I): each text clip is laid out once, hidden, with its fonts loaded, and a text that needs
   * more room than it has is reported as an advisory `textOverflow`. Never throws; nothing is changed on screen.
   * - A dimension the clip sets (width, height) is its box: the text's scroll size past its client size in it.
   * - A dimension it leaves free (no height, or neither: final wave P6) is bounded by the frame, or by the format's safe zone
   *   when it has one: the clip's laid-out box must lie inside it on all four edges (fix round 1, M6). The box's rectangle is
   *   read as the browser draws it, so the clip's own `rotation` and `scale` count; its animations do not (they move the
   *   content, not the box).
   */
  const room = opts.safeZone
    ? { left: opts.safeZone.left, top: opts.safeZone.top, right: c.width - opts.safeZone.right, bottom: c.height - opts.safeZone.bottom }
    : { left: 0, top: 0, right: c.width, bottom: c.height };
  const measureText = () => {
    if (opts.mode !== 'render' || destroyed) return;
    for (const m of mounted) {
      if (m.clip.type !== 'text') continue;
      const p = m.clip.props;
      try {
        const { display, visibility } = m.box.style;
        Object.assign(m.box.style, { display: 'block', visibility: 'hidden' });
        const need = { w: m.content.scrollWidth, h: m.content.scrollHeight };
        const box = { w: m.content.clientWidth, h: m.content.clientHeight };
        const outer = { w: m.box.offsetWidth, h: m.box.offsetHeight };
        // The box as drawn, in composition pixels (the stage may be scaled); without a layout (no rectangle) the clip's x/y.
        const sr = stage.getBoundingClientRect();
        const br = m.box.getBoundingClientRect();
        const k = sr.width > 0 ? sr.width / c.width : 0;
        const ext = k > 0 && br.width > 0 && br.height > 0
          ? { left: (br.left - sr.left) / k, top: (br.top - sr.top) / k, right: (br.right - sr.left) / k, bottom: (br.bottom - sr.top) / k }
          : { left: p.x ?? 0, top: p.y ?? 0, right: (p.x ?? 0) + Math.max(outer.w, need.w), bottom: (p.y ?? 0) + Math.max(outer.h, need.h) };
        Object.assign(m.box.style, { display, visibility });
        if (p.width !== undefined || p.height !== undefined) {
          const over = (p.width !== undefined && need.w > box.w + 1) || (p.height !== undefined && need.h > box.h + 1);
          if (over && box.w > 0 && box.h > 0) { report('textOverflow', `text overflows its box: needs ${need.w}x${need.h}, box ${box.w}x${box.h}`, m.clip.id); continue; }
        }
        if (p.height === undefined) {
          // The free dimensions end where the frame (or its safe zone) ends, on every edge.
          const over = ext.left < room.left - 1 || ext.top < room.top - 1 || ext.right > room.right + 1 || ext.bottom > room.bottom + 1;
          if (over && need.w > 0 && need.h > 0) {
            const at = [ext.left, ext.top, ext.right, ext.bottom].map((x) => Math.round(x)).join(',');
            report('textOverflow', `text overflows the frame: spans ${at}, room ${room.left},${room.top},${room.right},${room.bottom}`, m.clip.id);
          }
        }
      } catch { /* advisory only */ }
    }
  };
  const load = () => (loadPromise ??= Promise.all([fontsLoaded, ...mounted.map((m) => m.prepare),
    ...audios.map((a) => (a.derived ? loadDerivedAudio(a) : loadMedia(a.el, a.clip.id, a.clip.src)))]).then(() => { measureText(); }));
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
        await load();
        await seek(0);
        return { duration: player.duration, fps: c.fps, width: c.width, height: c.height, frames: frameCount(c.duration, c.fps) };
      })();
      return readyPromise;
    },
    load,
    seek,
    play(o = {}) {
      if (destroyed || opts.mode !== 'preview' || still) return;
      loop = o.loop ?? true;
      rate = o.rate ?? 1;
      if (o.from !== undefined && Number.isFinite(o.from)) time = clampT(o.from);
      if (playing) { tStart = time; wallStart = n.performanceNow(); return; }
      playing = true;
      for (const m of mounted) presentVideo(m, 'video');
      tStart = time >= c.duration ? 0 : time;
      wallStart = n.performanceNow();
      n.requestAnimationFrame(frame);
    },
    pause() {
      if (destroyed || !playing) return;
      stopPlayback();
      seek(time).catch(() => {});
    },
    select(clipId) { if (destroyed) return; selected = clipId; player.onBounds?.(); },
    setScale(s) { if (destroyed) return; scaleMode = s; applyScale(); player.onBounds?.(); },
    setMuted(m) {
      if (destroyed || opts.mode !== 'preview' || m === allMuted) return;
      allMuted = m;
      for (const x of mounted) {
        const v = x.video;
        if (!v) continue;
        if (m) { ownMuted.set(v, v.muted); v.muted = true; } else { v.muted = ownMuted.get(v) ?? v.muted; ownMuted.delete(v); }
      }
      for (const a of audios) a.el.muted = a.muted || m;
    },
    setSubtitles(next) {
      if (destroyed) return;
      subtitles = next;
      // The built-in look is redrawn at once at the time shown (a pure function of it): no seek, no re-mount. A template's
      // layer is opened again with the new set.
      for (const m of mounted) {
        if (m.subs && m.visible) drawLine(m, time);
        else if (m.clip.type === 'subtitles' && m.layer) remountTemplate(m);
      }
    },
    selectedBounds() {
      if (!selected) return null;
      const m = mounted.find((x) => x.clip.id === selected);
      if (!m || !m.visible) return null;
      const r = m.content.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    },
    destroy,
  };
  return player;
}
