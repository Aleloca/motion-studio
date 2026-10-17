// Comments on a spot of the picture (spec §6.2 #7, point 38), shared by the format page's editor and its viewer: the hit area
// that takes the click placing a comment, the markers on the picture (on a video only within ±0.5 s of their time) and the
// hint naming the frame. They read the playhead from the clock, so only they re-render while the video plays.
import type { MouseEvent } from 'react';
import { useT } from '../i18n.tsx';
import { cx } from '../ui/index.ts';
import { useClock, type Clock } from '../ui/clock.ts';
import { timecode, type Mark } from './Transport.tsx';

/** A comment shows on the picture within this distance of its time (point 38). */
export const PIN_WINDOW = 0.5;

/** The paused picture takes the click that places a comment (point 38: on the frame at the current time). */
export function HitArea({ clock, video, label, onPlace }: { clock: Clock; video: boolean; label: string; onPlace(e: MouseEvent<HTMLButtonElement>): void }) {
  const t = useT();
  const { settled } = useClock(clock);
  return (
    <button type="button" className="ms-cv-hit" aria-label={video ? t.web.formatView.commentFrame({ time: timecode(settled) }) : t.web.canvas.commentOn({ label })} onClick={onPlace} />
  );
}

/** The comment markers on the picture: on a video only within ±0.5 s of their time (point 38). */
export function PinLayer({ clock, video, marks, open, onOpen }: { clock: Clock; video: boolean; marks: Mark[]; open: number | null; onOpen(number: number): void }) {
  const c = useT().web.canvas;
  const { time } = useClock(clock);
  const visible = video ? marks.filter((m) => m.pin.timeSec === null || (m.pin.range ? time >= m.pin.range.start - 1e-6 && time <= m.pin.range.end + 1e-6 : Math.abs(m.pin.timeSec - time) <= PIN_WINDOW + 1e-6)) : marks;
  return (
    <>
      {visible.map(({ pin, number }) => (
        <button key={number} type="button" className={cx('ms-cv-pin', open === number - 1 && 'ms-on')} style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%` }}
          aria-label={c.pin.edit({ n: number })} title={pin.note} onClick={(e) => { e.stopPropagation(); onOpen(number); }}>
          {number}
        </button>
      ))}
    </>
  );
}

/** What a click on the picture does now: comment the frame at the playhead (a video) or the image. */
export function CommentHint({ clock, video }: { clock: Clock; video: boolean }) {
  const f = useT().web.formatView;
  const { settled } = useClock(clock);
  return <div className="ms-cv-hint ms-fv-hint" role="status">{video ? f.commentAt({ time: timecode(settled) }) : f.commentImage}</div>;
}
