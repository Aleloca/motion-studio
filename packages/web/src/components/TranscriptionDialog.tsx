import type { TranscriptionPending, VideoAnalysisPending, VideoAnalysisView } from '@motion-studio/shared';
import { useEffect, useId, useState } from 'react';
import { useT } from '../i18n.tsx';
import { Button, Modal } from '../ui/index.ts';
import { LongVideoDialog } from './LongVideoDialog.tsx';
import { TranscriptionChoices, transcriptionTitle } from './TranscriptionChoices.tsx';

/** The transcription question as a dialog (New creative's form, the library). Closing it leaves the analysis waiting. */
export function TranscriptionDialog({ slug, view, question, open, onClose }: { slug: string; view: VideoAnalysisView; question: TranscriptionPending; open: boolean; onClose(): void }) {
  const t = useT();
  const id = useId();
  return (
    <Modal open={open} onClose={onClose} label={transcriptionTitle(t, view.file)} width={480}>
      <div className="ms-tdialog">
        <TranscriptionChoices slug={slug} view={view} question={question} onDone={onClose} headingId={id} />
        <div className="ms-tdialog-foot"><Button size="sm" variant="ghost" onClick={onClose}>{t.common.close}</Button></div>
      </div>
    </Modal>
  );
}

/**
 * The question a held analysis asks (long video or transcription), as its dialog. The question is kept as last asked: while
 * Whisper installs, the live view may already have dropped it, and the dialog stays until the install ends.
 */
export function AnalysisQuestionDialog({ slug, view, open, onClose }: { slug: string; view: VideoAnalysisView | null; open: boolean; onClose(): void }) {
  const [last, setLast] = useState<{ view: VideoAnalysisView; question: VideoAnalysisPending } | null>(null);
  useEffect(() => {
    if (!view) return;
    setLast((l) => (view.pending ? { view, question: view.pending } : l && l.view.file === view.file ? { ...l, view } : l));
  }, [view]);
  if (!last) return null;
  // Keyed by the video and its question: another question never inherits this one's state (review of phase 3).
  const key = `${last.question.kind}:${last.view.file}`;
  return last.question.kind === 'long'
    ? <LongVideoDialog key={key} slug={slug} view={last.view} question={last.question} open={open} onClose={onClose} />
    : <TranscriptionDialog key={key} slug={slug} view={last.view} question={last.question} open={open} onClose={onClose} />;
}
