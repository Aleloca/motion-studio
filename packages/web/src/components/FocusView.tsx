import { formatLabel, type FormatPreset, type Pin } from '@motion-studio/shared';
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useLocale, useT } from '../i18n.tsx';

const VIDEO = /\.(mp4|webm|mov)(\?|$)/i;
const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), video[controls], [tabindex]:not([tabindex="-1"])';

export function FocusView({ preset, src, compareSrc, versionN, compareN, verified = true, pins, pinNumbers, onAddPin, onClose }: {
  preset: FormatPreset; src: string | null; compareSrc: string | null; versionN: number | null; compareN: number | null;
  /** false when the shown output could not be checked with ffprobe. */ verified?: boolean;
  pins: Pin[]; /** 1-based global numbers of `pins`, so markers match the pending list; defaults to 1..n. */ pinNumbers?: number[]; onAddPin: (pin: Pin) => void; onClose: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const label = formatLabel(preset, locale);
  const [commenting, setCommenting] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Focus moves into the dialog and goes back to the opener (the frame button) when it closes.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);

  const keyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key !== 'Tab' || !dialogRef.current) return;
    // Focus trap: Tab / Shift+Tab cycle inside the dialog.
    const items = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) { e.preventDefault(); return; }
    const current = document.activeElement;
    if (e.shiftKey && (current === first || current === dialogRef.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && current === last) { e.preventDefault(); first.focus(); }
  };

  const place = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, round((e.clientX - r.left) / r.width, 3)));
    const y = Math.min(1, Math.max(0, round((e.clientY - r.top) / r.height, 3)));
    const video = videoRef.current;
    onAddPin({ format: preset.id, x, y, timeSec: video ? round(video.currentTime, 1) : null });
    setCommenting(false);
  };

  const media = (url: string | null, n: number | null, main: boolean) => (
    <figure style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 0', minWidth: 0 }}>
      <div data-testid={main ? 'focus-frame' : undefined} style={{ position: 'relative', aspectRatio: `${preset.width} / ${preset.height}`, width: `min(100%, calc(70vh * ${preset.width} / ${preset.height}))`, margin: '0 auto', background: 'var(--surface-2)', borderRadius: 6, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {!url && <span className="muted">{t.web.focus.noOutput}</span>}
        {url && VIDEO.test(url) && <video ref={main ? videoRef : undefined} src={url} controls style={{ width: '100%', height: '100%', objectFit: 'contain' }} />}
        {url && !VIDEO.test(url) && <img src={url} alt={`${label}${n ? ` v${n}` : ''}`} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />}
        {main && pins.map((p, k) => (
          <span key={k} aria-label={t.web.formatUi.comment({ n: pinNumbers?.[k] ?? k + 1 })} style={{ position: 'absolute', left: `${p.x * 100}%`, top: `${p.y * 100}%`, transform: 'translate(-50%, -100%)', width: 24, height: 24, borderRadius: '50% 50% 50% 0', background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 800, fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{pinNumbers?.[k] ?? k + 1}</span>
        ))}
        {main && commenting && (
          <button type="button" aria-label={t.web.focus.clickSpot} onClick={place}
            style={{ position: 'absolute', inset: 0, background: 'transparent', border: '2px dashed var(--accent)', cursor: 'crosshair', borderRadius: 0 }} />
        )}
      </div>
      {n !== null && <figcaption className="muted" style={{ fontSize: 12 }}>v{n}</figcaption>}
    </figure>
  );

  return (
    <div role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} ref={dialogRef}
      onKeyDown={keyDown}
      style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, zIndex: 50 }}>
      <div className="card stack" style={{ width: 'min(1100px, 100%)', maxHeight: '95vh', overflow: 'auto' }}>
        <div className="row">
          <strong>{label}</strong>
          <span className="mono muted">{preset.width}×{preset.height}</span>
          {src && !verified && <span className="badge">{t.web.formatUi.unverified}</span>}
          <div style={{ flex: 1 }} />
          <button type="button" aria-pressed={commenting} onClick={() => setCommenting((c) => !c)} disabled={!src}>{t.web.focus.addComment}</button>
          <button type="button" onClick={onClose}>{t.common.close}</button>
        </div>
        <div className="row" style={{ alignItems: 'flex-start', gap: 16, flexWrap: 'nowrap' }}>
          {compareSrc !== null && media(compareSrc, compareN, false)}
          {media(src, versionN, true)}
        </div>
        {commenting && <p className="muted" style={{ margin: 0 }}>{t.web.focus.clickHint({ video: Boolean(videoRef.current) })}</p>}
      </div>
    </div>
  );
}
