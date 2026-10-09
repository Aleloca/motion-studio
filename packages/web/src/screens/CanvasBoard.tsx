// A board of the creative canvas (prototype CanvasView boards + PinComposer): the format in proportion with the
// selected version's output, the generation sheen (T10), the reveal of a new picture (T11), safe zones with their
// labels, the comment markers and the comment bubble, "Open editor" on hover/focus.
import { channelName, formatName, type FormatPreset, type Pin } from '@motion-studio/shared';
import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode, type SyntheticEvent } from 'react';
import { formatNumber, useLocale, useT } from '../i18n.tsx';
import { anim, D, E, isSubmitChord } from '../motion/index.ts';
import { Button, Icon, Pill, Textarea, cx } from '../ui/index.ts';
import { boardFrame, outputMedia, pointIn, ratioText, type BoardModel } from './canvasModel.ts';

export type Tool = 'select' | 'comment' | 'hand';

/** A comment being written: a new one (`index` null) or a pending one reopened for editing. */
export interface Draft { format: string; x: number; y: number; text: string; index: number | null }

export interface BoardProps {
  slug: string;
  creative: string;
  board: BoardModel;
  /** The version whose outputs are shown (null before the first one). */
  n: number | null;
  tool: Tool;
  selected: boolean;
  working: boolean;
  safe: boolean;
  /** Pending comments of the creative with their global numbers (chips use the same numbers). */
  pins: Array<{ pin: Pin; number: number }>;
  draft: Draft | null;
  /** Number of the next new comment. */
  nextNumber: number;
  onSelect(): void;
  onOpen(frame: HTMLElement): void;
  onPlace(x: number, y: number): void;
  onEditPin(number: number): void;
  onDraftText(text: string): void;
  onDraftCommit(): void;
  onDraftCancel(): void;
  onDraftDelete(): void;
  /** Extra content under the frame (the generation progress of the first board). */
  footer?: ReactNode;
}

export function boardLabel(board: BoardModel, locale: ReturnType<typeof useLocale>): string {
  return board.preset ? `${channelName(board.preset.channel, locale)} · ${formatName(board.preset, locale)}` : board.id;
}

export function CanvasBoard(p: BoardProps) {
  const t = useT();
  const c = t.web.canvas;
  const locale = useLocale();
  const { board, n } = p;
  const frame = useRef<HTMLDivElement>(null);
  const label = boardLabel(board, locale);
  const size = boardFrame(board);
  const media = board.out && n !== null ? outputMedia(p.slug, p.creative, n, board.out) : null;
  const video = board.preset?.kind === 'video';
  const duration = board.out?.durationSec ?? null;

  // T11: every new picture arrives from blurred to sharp.
  const reveal = (e: SyntheticEvent<HTMLElement>) => {
    void anim(e.currentTarget, [{ opacity: 0, filter: 'blur(8px)' }, { opacity: 1, filter: 'blur(0)' }], D.l, E.out);
  };
  const place = (e: MouseEvent<HTMLButtonElement>) => {
    const pt = pointIn(e.currentTarget.getBoundingClientRect(), e);
    p.onPlace(pt.x, pt.y);
  };

  return (
    <div className={cx('ms-cv-board', p.selected && 'ms-on')} data-board={board.id}>
      <div className="ms-cv-board-head" style={{ maxWidth: Math.max(size.width, 220) }}>
        <b className="ms-cv-board-name">{label}</b>
        {board.preset ? <span className="ms-cv-board-meta">{ratioText(board.preset)}{duration !== null ? ` · ${c.seconds({ n: formatNumber(locale, duration, { maximumFractionDigits: 1 }) })}` : ''}</span> : null}
        {p.working && (!board.out || video) ? <Pill spinner>{c.rendering}</Pill> : null}
        {board.out && !board.out.verified ? <Pill tone="warn">{t.web.formatUi.unverified}</Pill> : null}
      </div>
      <div className="ms-cv-frame-wrap" style={{ width: size.width, height: size.height }}>
        <div
          ref={frame}
          className={cx('ms-cv-frame', !board.out && 'ms-empty-frame')}
          data-frame={board.id}
          onClick={p.onSelect}
          onDoubleClick={() => { if (board.out && frame.current) p.onOpen(frame.current); }}
        >
          {media && n !== null ? (
            media.video
              ? <video key={media.src} src={media.src} muted playsInline preload="metadata" aria-label={`${label} v${n}`} onLoadedData={reveal} />
              : <img key={media.src} src={media.src} alt={`${label} v${n}`} onLoad={reveal} draggable={false} />
          ) : (
            <span className="ms-cv-frame-note">
              {!board.preset ? t.web.formatUi.unknownPreset({ id: board.id }) : n === null ? c.notGenerated : t.web.formatUi.missingIn({ n })}
            </span>
          )}
          {p.working ? <span className="ms-shimmer" aria-hidden="true" /> : null}
          {p.safe && board.preset ? <SafeZoneBands preset={board.preset} /> : null}
          {p.tool === 'comment' && board.out ? (
            <button type="button" className="ms-cv-hit" aria-label={c.commentOn({ label })} onClick={(e) => { e.stopPropagation(); place(e); }} />
          ) : null}
          {p.tool === 'select' && board.out ? (
            <button type="button" className="ms-cv-open" aria-label={c.openEditorOf({ label })}
              onClick={(e) => { e.stopPropagation(); if (frame.current) p.onOpen(frame.current); }}>
              <Icon name={board.preset?.kind === 'image' ? 'image' : 'video'} size={14} strokeWidth={1.6} />{c.openEditor}
            </button>
          ) : null}
        </div>
        {p.pins.map(({ pin, number }) => (
          <button key={number} type="button" className={cx('ms-cv-pin', p.draft?.index === number - 1 && 'ms-on')} style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%` }}
            aria-label={c.pin.edit({ n: number })} title={pin.note} onClick={(e) => { e.stopPropagation(); p.onEditPin(number); }}>
            {number}
          </button>
        ))}
        {p.draft && p.draft.format === board.id ? (
          <PinBubble draft={p.draft} number={p.draft.index === null ? p.nextNumber : p.draft.index + 1} video={video}
            onText={p.onDraftText} onCommit={p.onDraftCommit} onCancel={p.onDraftCancel} onDelete={p.onDraftDelete} />
        ) : null}
      </div>
      {p.footer}
    </div>
  );
}

/** Safe zones (point 37): tinted bands with what covers them, over a frame of `preset`. Nothing without a zone. */
export function SafeZoneBands({ preset }: { preset: FormatPreset }) {
  const c = useT().web.canvas;
  const zone = preset.safeZone;
  if (!zone) return null;
  const band = (s: CSSProperties) => ({ ...s, position: 'absolute' as const });
  const top = `${(zone.top / preset.height) * 100}%`;
  const bottom = `${(zone.bottom / preset.height) * 100}%`;
  return (
    <span className="ms-cv-safe" aria-hidden="true">
      {zone.top > 0 ? <i className="ms-cv-safe-top" style={band({ height: top })}><em>{c.safeTop}</em></i> : null}
      {zone.bottom > 0 ? <i className="ms-cv-safe-bottom" style={band({ height: bottom })}><em>{c.safeBottom}</em></i> : null}
      {zone.left > 0 ? <i className="ms-cv-safe-left" style={band({ width: `${(zone.left / preset.width) * 100}%`, top, bottom })} /> : null}
      {zone.right > 0 ? <i className="ms-cv-safe-right" style={band({ width: `${(zone.right / preset.width) * 100}%`, top, bottom })} /> : null}
    </span>
  );
}

/**
 * The comment bubble (point 40): the text is written next to the spot; Comment adds it to the pending chips. It sits in
 * a positioned box the size of the frame and opens to the left when its scroll area (`.ms-cv-viewport` on the canvas,
 * `.ms-fv-stage` in the format view) has no room on the right. `time` replaces the canvas' "At 0:00" (the format view
 * comments on an exact frame).
 */
export function PinBubble({ draft, number, video, time, onText, onCommit, onCancel, onDelete }: {
  draft: Draft; number: number; video: boolean; time?: string; onText(t: string): void; onCommit(): void; onCancel(): void; onDelete(): void;
}) {
  const t = useT();
  const c = t.web.canvas.pin;
  const ref = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [opened] = useState(() => `${draft.format}:${draft.index}`);
  useLayoutEffect(() => {
    void anim(ref.current, [{ opacity: 0, transform: 'scale(.92) translateY(4px)' }, { opacity: 1, transform: 'none' }], D.s, E.spring);
    const el = field.current;
    if (el) { el.focus({ preventScroll: true }); el.setSelectionRange(el.value.length, el.value.length); }
  }, [opened]);
  // The card opens to the right of the marker, or to its left when the canvas has no room there.
  const [left, setLeft] = useState(draft.x > 0.55);
  useLayoutEffect(() => {
    const el = ref.current;
    const box = el?.closest('.ms-cv-viewport, .ms-fv-stage')?.getBoundingClientRect();
    const marker = el?.parentElement?.getBoundingClientRect();
    if (!el || !box || !marker || !box.width) return;
    const at = marker.left + draft.x * marker.width;
    const room = box.right - at;
    setLeft(room < el.offsetWidth + 40 && at - box.left > room);
  }, [draft.x, draft.format]);
  const empty = !draft.text.trim();
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); return; }
    if (isSubmitChord(e.nativeEvent) && !e.repeat) { e.preventDefault(); if (!empty) onCommit(); }
  };
  return (
    <>
      {draft.index === null ? <span className="ms-cv-pin ms-draft" style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%` }} aria-hidden="true">{number}</span> : null}
      <div ref={ref} className={cx('ms-cv-bubble', left && 'ms-left')} style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%` }}
        role="group" aria-label={c.marker({ n: number })} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <Textarea ref={field} rows={3} maxLength={2000} aria-label={c.field} placeholder={c.placeholder} value={draft.text}
          onChange={(e) => onText(e.target.value)} onKeyDown={onKeyDown} />
        <div className="ms-cv-bubble-foot">
          {time !== undefined ? <span className="ms-cv-bubble-time">{time}</span>
            : video ? <span className="ms-cv-bubble-time" title={c.atStartHint}>{c.atStart}</span> : null}
          <span className="ms-grow" />
          {draft.index !== null ? (
            <Button size="sm" variant="ghost" icon aria-label={c.remove} title={c.remove} onClick={onDelete}><Icon name="trash" size={13} /></Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={onCancel}>{t.common.cancel}</Button>
          <Button size="sm" variant="ink" disabled={empty} onClick={onCommit}>{draft.index === null ? c.add : c.save}</Button>
        </div>
      </div>
    </>
  );
}
