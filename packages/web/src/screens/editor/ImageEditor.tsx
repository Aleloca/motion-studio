// The image editor's own pieces (Phase 10b, Task 9): the zoom bar and the frame size it sets. The layout, stage, handles and
// inspector are the editor shell's (a still has no timeline, and its inspector hides the timing and animation sections);
// the layers panel is LayersPanel.tsx. "Fit" sizes the frame to the stage (the shell's default); 50 to 400 % is a share of the
// image's own pixels, and the stage scrolls when the frame outgrows it.
import type { CSSProperties } from 'react';
import { formatNumber, useLocale, useT } from '../../i18n.tsx';
import { Button, Slider } from '../../ui/index.ts';

export const ZOOM_MIN = 50;
export const ZOOM_MAX = 400;
export const ZOOM_STEP = 10;

/** The stage frame's size: fitted to the stage when `zoom` is null, otherwise `zoom` % of the image's pixels. */
export function zoomFrame(width: number, height: number, zoom: number | null): CSSProperties {
  if (zoom === null) return { width: `min(100cqw, calc(100cqh * ${width / height}))`, aspectRatio: `${width} / ${height}` };
  return { width: `${Math.round((width * zoom) / 100)}px`, aspectRatio: `${width} / ${height}` };
}

export function ZoomBar({ zoom, onZoom }: { zoom: number | null; onZoom(zoom: number | null): void }) {
  const e = useT().web.editor;
  const locale = useLocale();
  const pct = (n: number) => e.zoomValue({ pct: formatNumber(locale, n) });
  return (
    <div className="ms-ed-zoom" role="group" aria-label={e.zoom}>
      <Button size="sm" variant={zoom === null ? 'outline' : 'ghost'} aria-pressed={zoom === null} title={e.zoomFitTitle} onClick={() => onZoom(null)}>{e.zoomFit}</Button>
      <Slider className="ms-ed-zoom-slider" label={e.zoom} min={ZOOM_MIN} max={ZOOM_MAX} step={ZOOM_STEP} value={zoom ?? 100}
        valueText={zoom === null ? e.zoomFit : pct(zoom)} onChange={onZoom} />
      <span className="ms-ed-zoom-value">{zoom === null ? e.zoomFit : pct(zoom)}</span>
    </div>
  );
}
