// The range comments as shaded spans over the timeline's lanes (Phase 10b, Task 10); passed to the Timeline as `overlay`.
// They are pictures, not controls: the lanes underneath keep every pointer event.
import type { Mark } from '../Transport.tsx';
import { useLocale, useT } from '../../i18n.tsx';
import { rangeTimes } from '../pinModel.ts';
import { timeToPx } from './timelineMath.ts';

export function RangeSpans({ marks, pps }: { marks: Mark[]; pps: number }) {
  const c = useT().web.conversation;
  const locale = useLocale();
  return (
    <>
      {marks.filter((m) => m.pin.range).map(({ pin, number }) => {
        const r = pin.range!;
        const { a, b } = rangeTimes(locale, r);
        return <span key={number} className="ms-tl-span" role="img" aria-label={c.rangeSpan({ a, b, note: pin.note ?? '' })} data-range={`${r.start}-${r.end}`}
          style={{ left: timeToPx(r.start, pps), width: Math.max(2, timeToPx(r.end - r.start, pps)) }} />;
      })}
    </>
  );
}
