// Compare two versions of the creative with a slider (prototype CompareDialog; spec §6.2 #6). Phase 7 compares
// creative versions (no ★ to pick for export: that comes with per-format versions in Phase 9).
import type { FormatPreset, VersionEntry } from '@motion-studio/shared';
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useLocale, useT } from '../i18n.tsx';
import { Button, Chip, Icon, Modal } from '../ui/index.ts';
import { boardSize, outputMedia } from './canvasModel.ts';
import { boardLabel } from './CanvasBoard.tsx';

export interface CompareDialogProps {
  open: boolean;
  onClose(): void;
  slug: string;
  creative: string;
  versions: VersionEntry[];
  presets: FormatPreset[];
  /** Formats with an output in some version, in canvas order. */
  formats: string[];
  initialFormat: string;
  /** Left and right versions when it opens. */
  initial: [number, number];
}

const STEP = 5;
const clamp = (v: number) => Math.max(0, Math.min(100, v));

export function CompareDialog(p: CompareDialogProps) {
  const t = useT();
  const c = t.web.canvas.compare;
  return (
    <Modal open={p.open} onClose={p.onClose} label={c.label} width={980}>
      {p.open ? <CompareBody {...p} /> : null}
    </Modal>
  );
}

function CompareBody({ onClose, slug, creative, versions, presets, formats, initialFormat, initial }: CompareDialogProps) {
  const t = useT();
  const c = t.web.canvas.compare;
  const locale = useLocale();
  const [format, setFormat] = useState(initialFormat);
  const [a, setA] = useState(initial[0]);
  const [b, setB] = useState(initial[1]);
  const [split, setSplit] = useState(50);
  const stage = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const preset = presets.find((x) => x.id === format) ?? null;
  const label = boardLabel({ id: format, preset, out: null }, locale);
  // The comparison fits a 520 px high stage.
  const base = preset ? boardSize(preset.width, preset.height) : { width: 400, height: 400 };
  const k = Math.min(1, 520 / base.height, 560 / base.width) * (base.height < 360 ? 1.4 : 1);
  const size = { width: Math.round(base.width * k), height: Math.round(base.height * k) };
  const media = (n: number) => {
    const v = versions.find((x) => x.n === n);
    const out = v?.outputs.find((o) => o.format === format);
    return v && out ? outputMedia(slug, creative, v.n, out) : null;
  };
  const show = (n: number) => {
    const m = media(n);
    if (!m) return <span className="ms-cmp-none">{c.noOutput}</span>;
    return m.video
      ? <video src={m.src} muted playsInline preload="metadata" aria-label={`${label} v${n}`} />
      : <img src={m.src} alt={`${label} v${n}`} draggable={false} />;
  };
  const moveTo = (clientX: number) => {
    const r = stage.current?.getBoundingClientRect();
    if (r && r.width) setSplit(clamp(Math.round(((clientX - r.left) / r.width) * 100)));
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    moveTo(e.clientX);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? split - STEP
      : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? split + STEP
      : e.key === 'Home' ? 0 : e.key === 'End' ? 100 : null;
    if (next === null) return;
    e.preventDefault();
    setSplit(clamp(next));
  };
  const side = (name: string, value: number, set: (n: number) => void) => {
    const v = versions.find((x) => x.n === value);
    return (
      <div className="ms-cmp-side">
        <span className="ms-cap">{name}</span>
        <div className="ms-cmp-chips" role="group" aria-label={name}>
          {versions.map((x) => <Chip key={x.n} on={x.n === value} onClick={() => set(x.n)}>v{x.n}</Chip>)}
        </div>
        {v ? <span className="ms-cmp-note">{v.request.trim() || t.web.canvas.versions.fromBrief}</span> : null}
      </div>
    );
  };

  return (
    <div className="ms-cmp">
      <div className="ms-cmp-stage">
        <div
          ref={stage}
          className="ms-cmp-frame"
          style={{ width: size.width, height: size.height }}
          onPointerDown={onPointerDown}
          onPointerMove={(e) => { if (dragging.current) moveTo(e.clientX); }}
          onPointerUp={() => { dragging.current = false; }}
          onPointerCancel={() => { dragging.current = false; }}
        >
          <div className="ms-cmp-layer">{show(b)}</div>
          <div className="ms-cmp-layer ms-cmp-left" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}>{show(a)}</div>
          <div className="ms-cmp-divider" style={{ left: `${split}%` }}
            role="slider" tabIndex={0} aria-label={c.slider} aria-valuemin={0} aria-valuemax={100} aria-valuenow={split}
            aria-valuetext={`v${a} ${split}% · v${b} ${100 - split}%`} onKeyDown={onKeyDown}>
            <span className="ms-cmp-knob" aria-hidden="true"><Icon name="chevron" size={12} /><Icon name="chevron" size={12} /></span>
          </div>
          <span className="ms-cmp-tag ms-cmp-tag-l" aria-hidden="true">v{a}</span>
          <span className="ms-cmp-tag ms-cmp-tag-r" aria-hidden="true">v{b}</span>
        </div>
      </div>
      <div className="ms-cmp-side-col">
        <div className="ms-cmp-head">
          <b>{c.title({ label })}</b>
          <Button size="sm" variant="ghost" icon aria-label={t.common.close} onClick={onClose}><Icon name="close" size={12} /></Button>
        </div>
        {formats.length > 1 ? (
          <div className="ms-cmp-side">
            <span className="ms-cap">{c.format}</span>
            <div className="ms-cmp-chips" role="group" aria-label={c.format}>
              {formats.map((id) => (
                <Chip key={id} on={id === format} onClick={() => setFormat(id)}>
                  {boardLabel({ id, preset: presets.find((x) => x.id === id) ?? null, out: null }, locale)}
                </Chip>
              ))}
            </div>
          </div>
        ) : null}
        {side(c.left, a, setA)}
        {side(c.right, b, setB)}
      </div>
    </div>
  );
}
