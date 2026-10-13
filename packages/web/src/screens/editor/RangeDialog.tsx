// The keyboard path to a range comment (Phase 10b, Task 10, fix round 1): Start and End time fields, prefilled from the
// playhead to one second later (clamped to the duration). Mounted only while open, so the prefill is taken at that moment. "Continue" hands the range to the same flow as Shift + drag.
import { useState } from 'react';
import { useT } from '../../i18n.tsx';
import { Button, Modal, NumberField } from '../../ui/index.ts';
import { MIN_RANGE } from '../pinModel.ts';

/** The first range offered: the playhead to a second later, inside [0, duration]. */
export function defaultRange(playhead: number, duration: number): { start: number; end: number } {
  const start = Math.max(0, Math.min(playhead, Math.max(0, duration - MIN_RANGE)));
  return { start, end: Math.min(duration, start + 1) };
}

export function RangeDialog({ open, playhead, duration, onSubmit, onCancel }: {
  open: boolean; playhead: number; duration: number; onSubmit(r: { start: number; end: number }): void; onCancel(): void;
}) {
  const c = useT().web.conversation;
  const [r, setR] = useState(() => defaultRange(playhead, duration));
  const valid = r.end - r.start >= MIN_RANGE;
  return (
    <Modal open={open} onClose={onCancel} label={c.rangeDialogTitle} width={400}>
      <div className="ms-ed-dialog">
        <h2>{c.rangeDialogTitle}</h2>
        <div className="ms-range-fields">
          <NumberField label={c.rangeStart} unit="s" min={0} max={duration} step={0.1} decimals={2} value={r.start} onChange={(v) => setR((x) => ({ ...x, start: v }))} />
          <NumberField label={c.rangeEnd} unit="s" min={0} max={duration} step={0.1} decimals={2} value={r.end} onChange={(v) => setR((x) => ({ ...x, end: v }))} />
        </div>
        {!valid ? <p role="alert" className="ms-cv-note ms-err">{c.rangeInvalid}</p> : null}
        <div className="ms-ed-dialog-foot">
          <Button variant="ghost" onClick={onCancel}>{c.noteCancel}</Button>
          <Button variant="ink" disabled={!valid} onClick={() => onSubmit(r)}>{c.rangeContinue}</Button>
        </div>
      </div>
    </Modal>
  );
}
