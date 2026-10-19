// Reports 45/47: a cover made of a still of the composition, for a creative whose latest version has no render file. Asked
// once on screen (compositionStill.ts); `onNone` tells the card there is none, so it keeps its placeholder.
import { useEffect, type SyntheticEvent } from 'react';
import { useCompositionStill, useSeen, type StillRef } from './compositionStill.ts';
import { SafeImg } from './MediaThumb.tsx';

export function CoverStill({ still, onNone, onLoad }: { still: StillRef; onNone?(): void; onLoad?(e: SyntheticEvent<HTMLImageElement>): void }) {
  const { ref, seen } = useSeen<HTMLSpanElement>();
  const { url, state } = useCompositionStill(still, seen);
  useEffect(() => { if (state === 'none') onNone?.(); }, [state]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <span ref={ref} className="ms-cover">
      {url ? <SafeImg src={url} alt="" onLoad={onLoad} small fallbackClassName="ms-cover-none" /> : null}
    </span>
  );
}
