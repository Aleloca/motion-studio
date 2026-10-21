import type { VideoAnalysisView } from '@motion-studio/shared';
import { useEffect, useMemo, useState } from 'react';
import { api } from './api.ts';
import type { EventsState } from './eventsReducer.ts';

/**
 * Decision 1468: the analyses of a project's videos. The listing is fetched on mount, after each (re)connection and when the
 * library changes; a live `video-analysis` view replaces the listed one only when it arrived after the listing was asked
 * for (`seq`), so a message older than the listing never hides its newer state. `pending`: the views holding a question
 * for the user (a long video, the transcription choice).
 */
export function useVideoAnalyses(slug: string, live: EventsState): { byFile: Record<string, VideoAnalysisView>; pending: VideoAnalysisView[]; reload(): void } {
  const [listed, setListed] = useState<{ views: VideoAnalysisView[]; seq: number } | null>(null);
  const [nonce, setNonce] = useState(0);
  const tick = live.projectTicks[slug] ?? 0;
  useEffect(() => {
    let alive = true;
    const seq = live.analysisSeq ?? 0;
    Promise.resolve().then(() => api.listVideoAnalyses(slug))
      .then((views) => { if (alive) setListed({ views, seq }); })
      .catch(() => { /* the live views still show; the next change refetches */ });
    return () => { alive = false; };
  }, [slug, tick, live.snapshots, nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  const mine = live.analyses?.[slug];
  return useMemo(() => {
    const byFile: Record<string, VideoAnalysisView> = {};
    for (const v of listed?.views ?? []) byFile[v.file] = v;
    for (const [file, e] of Object.entries(mine ?? {})) if (!listed || e.seq > listed.seq) byFile[file] = e.view;
    return { byFile, pending: Object.values(byFile).filter((v) => v.pending !== null), reload: () => setNonce((n) => n + 1) };
  }, [listed, mine]);
}

/** Decision 1478: the videos a creative's first turn waits for (empty: no wait), fetched first and then followed live. */
export function useAnalysisWait(slug: string, creative: string, live: EventsState): string[] {
  const [fetched, setFetched] = useState<{ files: string[]; seq: number } | null>(null);
  useEffect(() => {
    let alive = true;
    const seq = live.analysisSeq ?? 0;
    Promise.resolve().then(() => api.analysisWait(slug, creative))
      .then((r) => { if (alive) setFetched({ files: r.files, seq }); })
      .catch(() => { /* no wait shown */ });
    return () => { alive = false; };
  }, [slug, creative, live.snapshots]); // eslint-disable-line react-hooks/exhaustive-deps
  const msg = live.analysisWaits?.[`${slug}/${creative}`];
  if (msg && msg.seq > (fetched?.seq ?? 0)) return msg.files;
  return fetched?.files ?? msg?.files ?? [];
}
