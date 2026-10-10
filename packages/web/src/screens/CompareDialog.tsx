// Compare two versions of one format (spec §3.2, prototype `CompareDialog`). The versions come from the format's own
// history (a follower compares its primary's), with the ★ marked. Images: the slider over the two (default) or side by
// side. Videos: two players side by side (default) under one shared transport, kept in sync by useSyncedMedia (the left
// one leads), or "Overlay": the slider over the two paused frames. "★ Use vN for export" stars either side.
import type { FormatPreset, VersionEntry } from '@motion-studio/shared';
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { api } from '../api.ts';
import { useLocale, useT } from '../i18n.tsx';
import { isVideoFile } from '../media.ts';
import { Button, Chip, Icon, Modal, Pill, Segmented, cx } from '../ui/index.ts';
import { useSyncedMedia } from '../ui/useSyncedMedia.ts';
import { boardSize } from './canvasModel.ts';
import { boardLabel } from './CanvasBoard.tsx';
import type { VersionActions } from './FormatVersions.tsx';
import { activatesControl, bare, isTyping } from './keys.ts';
import { PLAYER_CONTROLS, Transport, type Speed } from './Transport.tsx';
import type { FormatState } from './versionModel.ts';

export interface CompareDialogProps {
  open: boolean;
  onClose(): void;
  slug: string;
  creative: string;
  versions: VersionEntry[];
  presets: FormatPreset[];
  states: Record<string, FormatState>;
  /** The format compared. A follower has no versions of its own: its primary's history and ★ are compared. */
  format: string;
  /** Left and right versions when it opens (entries of the format's history). */
  initial: [number, number];
  /** The page's version actions: ★ goes through them (their in-flight guard and retries). */
  actions: VersionActions;
}

type Mode = 'overlay' | 'side';
interface Side { video: boolean; src: string; poster?: string; duration: number | null }

const STEP = 5;
const clamp = (v: number) => Math.max(0, Math.min(100, v));

export function CompareDialog(p: CompareDialogProps) {
  const c = useT().web.canvas.compare;
  return (
    <Modal open={p.open} onClose={p.onClose} label={c.label} width={1000}>
      {p.open ? <CompareBody {...p} /> : null}
    </Modal>
  );
}

function CompareBody({ onClose, slug, creative, versions, presets, states, format: asked, initial, actions }: CompareDialogProps) {
  const t = useT();
  const c = t.web.canvas.compare;
  const fv = t.web.formatVersions;
  const locale = useLocale();
  const format = states[asked]?.follows ?? asked;
  const state = states[format];
  const history = state?.history ?? versions.filter((v) => v.outputs.some((o) => o.format === format)).map((v) => v.n);
  const star = state?.star.version ?? null;
  const [a, setA] = useState(initial[0]);
  const [b, setB] = useState(initial[1]);
  const [split, setSplit] = useState(50);
  const stage = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const preset = presets.find((x) => x.id === format) ?? null;
  const label = boardLabel({ id: format, preset, out: null }, locale);
  const media = (n: number): Side | null => {
    const out = versions.find((x) => x.n === n)?.outputs.find((o) => o.format === format);
    if (!out) return null;
    const rel = (file: string) => api.fileUrl(slug, creative, `outputs/v${n}/${file}`);
    return { video: isVideoFile(out.file), src: rel(out.file), poster: out.preview ? rel(out.preview) : undefined, duration: out.durationSec };
  };
  const sides = [media(a), media(b)] as const;
  const video = sides.some((s) => s?.video);
  const [mode, setMode] = useState<Mode>(() => (video ? 'side' : 'overlay'));
  const overlay = mode === 'overlay';

  // Videos: one transport for both (the elements come from callback refs: another version is another element).
  const [left, setLeft] = useState<HTMLVideoElement | null>(null);
  const [right, setRight] = useState<HTMLVideoElement | null>(null);
  const [rate, setRate] = useState<Speed>('1');
  const [loop, setLoop] = useState(false);
  const sync = useSyncedMedia(left, right, { durations: [sides[0]?.duration, sides[1]?.duration], rate: Number(rate), loop });
  const ready = Boolean((left && !sync.failed[0]) || (right && !sync.failed[1]));
  const changeMode = (m: Mode) => {
    // "Overlay" compares the two frames where they are, paused.
    if (m === 'overlay') sync.pause();
    setMode(m);
  };

  // Keyboard (videos): Space plays/pauses, ←/→ one frame. The dialog is a layer of its own (page shortcuts skip it); keys
  // a control inside already handled (the divider, the view switch) or typed into a field are left alone.
  const keys = useRef({ on: false, toggle: sync.toggle, step: sync.step });
  keys.current = { on: video && ready, toggle: sync.toggle, step: sync.step };
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const el = root.current;
      const target = e.target instanceof Node ? e.target : null;
      if (!el || !target || e.defaultPrevented || !keys.current.on) return;
      if (!el.contains(target) && target !== el.closest('.ms-dialog')) return;
      if (!bare(e) || e.shiftKey || isTyping(e) || activatesControl(e, PLAYER_CONTROLS)) return;
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        if (!e.repeat) keys.current.toggle();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        keys.current.step(e.key === 'ArrowRight' ? 1 : -1);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // The stage fits the dialog: one frame (overlay) or two next to each other, with room for the transport (videos).
  const base = preset ? boardSize(preset.width, preset.height) : { width: 400, height: 400 };
  const fit = (maxW: number, maxH: number) => {
    const k = Math.min(maxW / base.width, maxH / base.height, base.height < 360 ? 1.4 : 1);
    return { width: Math.round(base.width * k), height: Math.round(base.height * k) };
  };
  const size = overlay ? fit(580, video ? 440 : 520) : fit(310, video ? 440 : 520);

  const moveTo = (clientX: number) => {
    const r = stage.current?.getBoundingClientRect();
    if (r && r.width) setSplit(clamp(Math.round(((clientX - r.left) / r.width) * 100)));
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    moveTo(e.clientX);
  };
  const onSliderKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? split - STEP
      : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? split + STEP
      : e.key === 'Home' ? 0 : e.key === 'End' ? 100 : null;
    if (next === null) return;
    e.preventDefault();
    setSplit(clamp(next));
  };

  const tag = (i: 0 | 1, n: number) => (
    <span className={cx('ms-cmp-tag', overlay && i === 1 ? 'ms-cmp-tag-r' : 'ms-cmp-tag-l')} aria-hidden="true">v{n}{n === star ? ' ★' : ''}</span>
  );
  // The same two panes in both views (the players are not reloaded): next to each other, or stacked with the left one
  // on top, cut at the divider.
  const pane = (i: 0 | 1, n: number) => {
    const m = sides[i];
    const style: CSSProperties | undefined = overlay ? (i === 0 ? { clipPath: `inset(0 ${100 - split}% 0 0)` } : undefined) : size;
    return (
      <div className={cx('ms-cmp-pane', i === 0 && 'ms-cmp-left')} style={style}>
        {!m ? <span className="ms-cmp-none">{c.noOutput}</span>
          : m.video ? (
            // The left one carries the sound; the right one is muted (two soundtracks at once help nobody).
            <video key={m.src} ref={i === 0 ? setLeft : setRight} src={m.src} poster={m.poster} muted={i === 1} playsInline preload="auto"
              aria-label={`${label} v${n}`} />
          ) : <img key={m.src} src={m.src} alt={`${label} v${n}`} draggable={false} />}
        {m?.video && sync.failed[i] ? <span className="ms-cmp-failed" role="alert">{c.videoFailed({ n })}</span> : null}
        {overlay ? null : tag(i, n)}
      </div>
    );
  };
  const side = (name: string, value: number, set: (n: number) => void) => {
    const v = versions.find((x) => x.n === value);
    const marks = value === star && state
      ? <Pill tone="accent">{state.star.manual ? c.starManual : c.starAuto}</Pill>
      : value === state?.defaultVersion ? <span title={fv.autoTip}><Pill>{fv.auto}</Pill></span> : null;
    return (
      <div className="ms-cmp-side">
        <span className="ms-cap">{name}</span>
        <div className="ms-cmp-chips" role="group" aria-label={name}>
          {history.map((n) => <Chip key={n} on={n === value} onClick={() => set(n)}>v{n}{n === star ? ' ★' : ''}</Chip>)}
        </div>
        {marks ? <span className="ms-cmp-marks">{marks}</span> : null}
        {v ? <span className="ms-cmp-note">{v.request.trim() || t.web.canvas.versions.fromBrief}</span> : null}
      </div>
    );
  };
  // ★ either side: the right one first (usually the newer), each version once.
  const starable = state && !state.follows ? [...new Set([b, a])].filter((n) => media(n) !== null) : [];
  const pending = actions.pending(format);

  return (
    <div ref={root} className="ms-cmp">
      <div className="ms-cmp-main">
        <div className="ms-cmp-stage">
          <div
            ref={stage}
            className={cx('ms-cmp-pair', overlay ? 'ms-overlay' : 'ms-side')}
            style={overlay ? size : undefined}
            onPointerDown={overlay ? onPointerDown : undefined}
            onPointerMove={overlay ? (e) => { if (dragging.current) moveTo(e.clientX); } : undefined}
            onPointerUp={() => { dragging.current = false; }}
            onPointerCancel={() => { dragging.current = false; }}
          >
            {pane(0, a)}
            {pane(1, b)}
            {overlay ? (
              <>
                <div className="ms-cmp-divider" style={{ left: `${split}%` }}
                  role="slider" tabIndex={0} aria-label={c.slider} aria-valuemin={0} aria-valuemax={100} aria-valuenow={split}
                  aria-valuetext={`v${a} ${split}% · v${b} ${100 - split}%`} onKeyDown={onSliderKey}>
                  <span className="ms-cmp-knob" aria-hidden="true"><Icon name="chevron" size={12} /><Icon name="chevron" size={12} /></span>
                </div>
                {tag(0, a)}
                {tag(1, b)}
              </>
            ) : null}
          </div>
        </div>
        {video ? (
          <Transport clock={sync.clock} duration={sync.duration} playing={sync.playing} disabled={!ready} hint={t.web.formatView.keysLocked}
            onToggle={sync.toggle} onStep={sync.step} onSeek={sync.seek} onPause={sync.pause} onResume={sync.play}
            loop={loop} onLoop={setLoop} speed={rate} onSpeed={setRate} />
        ) : null}
      </div>
      <div className="ms-cmp-side-col">
        <div className="ms-cmp-head">
          <b>{c.title({ label })}</b>
          <Button size="sm" variant="ghost" icon aria-label={t.common.close} onClick={onClose}><Icon name="close" size={12} /></Button>
        </div>
        <div className="ms-cmp-side">
          <span className="ms-cap" aria-hidden="true">{c.view}</span>
          <Segmented label={c.view} value={mode} onChange={changeMode}
            options={video ? [{ value: 'side', label: c.sideBySide }, { value: 'overlay', label: c.overlay }] : [{ value: 'overlay', label: c.overlay }, { value: 'side', label: c.sideBySide }]} />
        </div>
        {side(c.left, a, setA)}
        {side(c.right, b, setB)}
        <span className="ms-grow" />
        {starable.length ? (
          <div className="ms-cmp-actions">
            {starable.map((n, i) => (n === star ? (
              <Button key={n} disabled>{c.usedForExport({ n })}</Button>
            ) : (
              <Button key={n} variant={i === 0 ? 'ink' : 'default'} disabled={pending} onClick={() => { actions.star(format, n); onClose(); }}>{c.useForExport({ n })}</Button>
            )))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
