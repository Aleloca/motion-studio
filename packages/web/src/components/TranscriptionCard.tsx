import type { VideoAnalysisPending, VideoAnalysisView } from '@motion-studio/shared';
import { useEffect, useState } from 'react';
import { useT } from '../i18n.tsx';
import { LongVideoChoices } from './LongVideoDialog.tsx';
import { TranscriptionChoices, transcriptionTitle } from './TranscriptionChoices.tsx';
import './transcription.css';

const baseName = (file: string) => file.slice(file.lastIndexOf('/') + 1);

/**
 * Spec 1479: in the brief agent's chat a held analysis asks in a card of the conversation, never a modal. The same body as the
 * dialog (transcription choices, or the long video's densities). The card stays while Whisper installs; `onDone` once the
 * question is answered (the screen then stops showing it).
 */
export function TranscriptionCard({ slug, view, onDone }: { slug: string; view: VideoAnalysisView; onDone?(file: string): void }) {
  const t = useT();
  const [question, setQuestion] = useState<VideoAnalysisPending | null>(view.pending);
  useEffect(() => { if (view.pending) setQuestion(view.pending); }, [view.pending]);
  if (!question) return null;
  const label = question.kind === 'long' ? t.videoAnalysis.longTitle({ file: baseName(view.file) }) : transcriptionTitle(t, view.file);
  const done = () => onDone?.(view.file);
  return (
    <div className="ms-tcard" role="group" aria-label={label} data-analysis-question={view.file}>
      {question.kind === 'long'
        ? <LongVideoChoices slug={slug} view={view} question={question} onDone={done} />
        : <TranscriptionChoices slug={slug} view={view} question={question} onDone={done} />}
    </div>
  );
}
