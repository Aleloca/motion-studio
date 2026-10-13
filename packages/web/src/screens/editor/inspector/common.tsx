// What the inspector's sections share (Phase 10b, Task 8): the control that edits through the draft, the rows that show a field's
// problems under it, and the section frame.
import type { Clip, CompositionProblem, EditOp, EditResult } from '@motion-studio/shared';
import type { ReactNode } from 'react';
import { cx } from '../../../ui/index.ts';

export interface Ctl {
  clip: Clip;
  locked: boolean;
  /** Applies an edit; a refusal is kept (translated) for `field`. Edits with a `coalesce` key are one undo step per burst. */
  run(field: string, op: EditOp, coalesce?: string): EditResult;
  /** The end of a burst of edits (Enter, blur, a click): the next edit is an undo step of its own. */
  end(): void;
  /** The texts to show under a field: the last refusal of `field` and the draft's validation problems about `names`. */
  problems(field: string, names: readonly string[]): string[];
  /** The id the problem text of `field` has when it shows (for aria-describedby). */
  errId(field: string): string;
  brandColors: string[];
  compositionColors: string[];
  problemsOf: readonly CompositionProblem[];
}

/** One field with its problems underneath. */
export function Row({ ctl, field, fields = [field], children, className }: { ctl: Ctl; field: string; fields?: string[]; children: ReactNode; className?: string }) {
  const texts = ctl.problems(field, fields);
  return (
    <div className={cx('ms-insp-row', className)}>
      {children}
      {texts.length > 0 ? <p id={ctl.errId(field)} className="ms-insp-err" role="alert">{texts.join(' · ')}</p> : null}
    </div>
  );
}

export function Section({ title, children, name }: { title: string; children: ReactNode; name: string }) {
  return (
    <section className="ms-insp-sec" aria-label={title} data-section={name}>
      <h4>{title}</h4>
      {children}
    </section>
  );
}

/** A labelled line (the label is visible text for controls that have no inner tag). */
export function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return <div className="ms-insp-lab"><span className="ms-insp-cap">{label}</span>{children}</div>;
}
