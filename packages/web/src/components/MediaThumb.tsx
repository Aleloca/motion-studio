import type { CSSProperties } from 'react';

const VIDEO = /\.(mp4|webm|mov)$/i;

export function MediaThumb({ src, alt, style }: { src: string; alt: string; style?: CSSProperties }) {
  const base: CSSProperties = { width: '100%', height: '100%', objectFit: 'cover', display: 'block', ...style };
  return VIDEO.test(src)
    ? <video src={src} muted preload="metadata" aria-label={alt} style={base} />
    : <img src={src} alt={alt} style={base} />;
}
