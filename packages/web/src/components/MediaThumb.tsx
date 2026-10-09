// Shared media pieces: thumbnails that pick <img> or <video> by file kind (media.ts), a designed "can't preview"
// state in place of the browser's broken-image glyph, and covers that play their video on hover.
import { useEffect, useRef, useState, type CSSProperties, type ImgHTMLAttributes, type SyntheticEvent } from 'react';
import { useT } from '../i18n.tsx';
import { mediaKindOf } from '../media.ts';
import { reducedMotion } from '../motion/index.ts';
import { Icon, cx } from '../ui/index.ts';
import './media.css';

/** The designed state of a file the browser cannot show (unreadable, unsupported or missing). */
export function NoPreview({ small, className }: { small?: boolean; className?: string }) {
  const t = useT();
  return (
    <span className={cx('ms-nopreview', small && 'ms-sm', className)} role="img" aria-label={t.web.ui.noPreview}>
      <Icon name="image" size={small ? 14 : 18} />
      {small ? null : <span>{t.web.ui.noPreview}</span>}
    </span>
  );
}

/** An <img> that turns into `NoPreview` when the file cannot be decoded. */
export function SafeImg({ small, fallbackClassName, onError, ...img }: ImgHTMLAttributes<HTMLImageElement> & { small?: boolean; fallbackClassName?: string }) {
  const [broken, setBroken] = useState(false);
  // A new file gets a new chance.
  useEffect(() => { setBroken(false); }, [img.src]);
  if (broken) return <NoPreview small={small} className={fallbackClassName} />;
  return <img {...img} onError={(e) => { setBroken(true); onError?.(e); }} />;
}

/** A thumbnail: a video paused on its first frame, or the image (GIFs animate by themselves). */
export function MediaThumb({ src, alt, style }: { src: string; alt: string; style?: CSSProperties }) {
  const base: CSSProperties = { width: '100%', height: '100%', objectFit: 'cover', display: 'block', ...style };
  return mediaKindOf(src) === 'video'
    ? <video src={src} muted preload="metadata" aria-label={alt} style={base} />
    : <SafeImg src={src} alt={alt} style={base} />;
}

/** The element whose hover (or keyboard focus) plays a cover: the nearest `[data-hover-play]`, else the parent. */
function hoverTarget(el: HTMLElement): HTMLElement {
  return el.closest<HTMLElement>('[data-hover-play]') ?? el.parentElement ?? el;
}

/**
 * A creative cover: the still (poster or image) and, while the card is hovered or focused, its video playing muted
 * and looping over it (visual test point 31). With reduced motion nothing plays.
 */
export function CoverMedia({ src, video, onLoad }: {
  src: string;
  /** The video to play on hover (see `coverVideo`), or null. */
  video: string | null;
  onLoad?(e: SyntheticEvent<HTMLImageElement | HTMLVideoElement>): void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [hover, setHover] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || !video) return;
    const target = hoverTarget(el);
    const on = () => { if (!reducedMotion()) setHover(true); };
    const off = () => setHover(false);
    const focusOut = (e: FocusEvent) => { if (!target.contains(e.relatedTarget as Node | null)) off(); };
    target.addEventListener('pointerenter', on);
    target.addEventListener('pointerleave', off);
    target.addEventListener('focusin', on);
    target.addEventListener('focusout', focusOut);
    return () => {
      target.removeEventListener('pointerenter', on);
      target.removeEventListener('pointerleave', off);
      target.removeEventListener('focusin', on);
      target.removeEventListener('focusout', focusOut);
    };
  }, [video]);
  const stillIsVideo = mediaKindOf(src) === 'video';
  return (
    <span ref={ref} className="ms-cover">
      {stillIsVideo
        ? <video src={src} muted preload="metadata" aria-hidden="true" onLoadedMetadata={onLoad} />
        : <SafeImg src={src} alt="" onLoad={onLoad} small fallbackClassName="ms-cover-none" />}
      {hover && video ? <HoverVideo src={video} /> : null}
    </span>
  );
}

function HoverVideo({ src }: { src: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    // play() rejects when the browser blocks it or the element goes away first: the still stays, nothing to report.
    try { void v.play()?.catch(() => {}); } catch { /* not supported (tests) */ }
    return () => { try { v.pause(); } catch { /* idem */ } };
  }, [src]);
  return <video ref={ref} className="ms-cover-play" src={src} muted loop playsInline autoPlay preload="auto" aria-hidden="true" />;
}
