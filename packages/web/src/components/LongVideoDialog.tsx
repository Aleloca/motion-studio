import type { VideoAnalysisPending, VideoAnalysisView } from '@motion-studio/shared';
import { useId, useState } from 'react';
import { api } from '../api.ts';
import { message } from '../errors.ts';
import { formatNumber, useLocale, useT } from '../i18n.tsx';
import { Button, Icon, Modal } from '../ui/index.ts';
import './transcription.css';

type LongPending = Extract<VideoAnalysisPending, { kind: 'long' }>;
const baseName = (file: string) => file.slice(file.lastIndexOf('/') + 1);

/**
 * Spec §5.1: a video over 20 minutes asks first. Both densities with their frames and estimated tokens: "Analizza tutto"
 * (one frame per scene plus one every 10 s) or "Analizza a densità ridotta" (one per scene, at most one every 30 s).
 */
export function LongVideoChoices({ slug, view, question: p, onDone, headingId }: { slug: string; view: VideoAnalysisView; question: LongPending; onDone?(): void; headingId?: string }) {
  const t = useT();
  const v = t.videoAnalysis;
  const locale = useLocale();
  const [busy, setBusy] = useState<'full' | 'reduced' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const n = (x: number) => formatNumber(locale, x);
  const minutes = formatNumber(locale, Math.round((view.header?.durationSec ?? 0) / 60) || Math.round((p.frames * 10) / 60));
  const choose = async (density: 'full' | 'reduced') => {
    setBusy(density);
    setError(null);
    try { await api.confirmLongVideo(slug, view.file, density); onDone?.(); }
    catch (e) { setError(v.actionFailed({ detail: message(e) })); }
    finally { setBusy(null); }
  };
  return (
    <div className="ms-tchoices">
      <h2 id={headingId} className="ms-tchoices-title">{v.longTitle({ file: baseName(view.file) })}</h2>
      <p className="ms-tchoices-why">{v.longText({ minutes })}</p>
      {error ? <p className="ms-tchoices-error" role="alert">{error}</p> : null}
      <div className="ms-tchoices-list" role="group" aria-label={v.longTitle({ file: baseName(view.file) })}>
        <button type="button" className="ms-tchoice" disabled={busy !== null} aria-busy={busy === 'full' || undefined} onClick={() => void choose('full')}>
          <span className="ms-tchoice-icon" aria-hidden="true"><Icon name="video" size={14} /></span>
          <span className="ms-tchoice-text"><b>{v.longFull}</b><span>{v.longEstimate({ frames: n(p.frames), tokens: n(p.tokens) })}</span></span>
        </button>
        <button type="button" className="ms-tchoice" disabled={busy !== null} aria-busy={busy === 'reduced' || undefined} onClick={() => void choose('reduced')}>
          <span className="ms-tchoice-icon" aria-hidden="true"><Icon name="grid" size={14} /></span>
          <span className="ms-tchoice-text"><b>{v.longReduced}</b><span>{v.longEstimate({ frames: n(p.reducedFrames), tokens: n(p.reducedTokens) })} · {v.longReducedNote}</span></span>
        </button>
      </div>
    </div>
  );
}

/** The long-video question as a dialog (New creative, the library). Closing it leaves the analysis waiting. */
export function LongVideoDialog({ slug, view, question, open, onClose }: { slug: string; view: VideoAnalysisView; question: LongPending; open: boolean; onClose(): void }) {
  const t = useT();
  const id = useId();
  return (
    <Modal open={open} onClose={onClose} label={t.videoAnalysis.longTitle({ file: baseName(view.file) })} width={480}>
      <div className="ms-tdialog">
        <LongVideoChoices slug={slug} view={view} question={question} onDone={onClose} headingId={id} />
        <div className="ms-tdialog-foot"><Button size="sm" variant="ghost" onClick={onClose}>{t.common.close}</Button></div>
      </div>
    </Modal>
  );
}
