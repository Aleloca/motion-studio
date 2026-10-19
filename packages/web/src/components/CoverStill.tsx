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

/**
 * A small thumbnail of a composition's still (the export dialogs, the version menus), asked once on screen; nothing while
 * there is none (the caller's empty frame stays).
 */
export function StillImg({ still }: { still: StillRef }) {
  const { ref, seen } = useSeen<HTMLElement>();
  const { url } = useCompositionStill(still, seen);
  // Until the URL arrives an empty box of the thumbnail's size is the element watched for visibility.
  return url ? <img src={url} alt="" /> : <span ref={ref} style={{ display: 'block', width: '100%', height: '100%' }} />;
}
