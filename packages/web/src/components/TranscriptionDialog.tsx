import type { TranscriptionPending, VideoAnalysisPending, VideoAnalysisView } from '@motion-studio/shared';
import { useEffect, useId, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { useT } from '../i18n.tsx';
import { Button, Modal } from '../ui/index.ts';
import { LongVideoDialog } from './LongVideoDialog.tsx';
import { TranscriptionChoices, transcriptionTitle, type TranscriptionChoicesProps } from './TranscriptionChoices.tsx';

/** The transcription question as a dialog (New creative's form, the library). Closing it leaves the analysis waiting. */
export function TranscriptionDialog({ slug, view, question, open, onClose, onSettings, ...other }: { slug: string; view: VideoAnalysisView; question: TranscriptionPending; open: boolean; onClose(): void; onSettings?(): void }
  & Pick<TranscriptionChoicesProps, 'submit' | 'recheck' | 'title' | 'why'>) {
  const t = useT();
  const id = useId();
  return (
    <Modal open={open} onClose={onClose} label={other.title ?? transcriptionTitle(t, view.file)} width={480}>
      <div className="ms-tdialog">
        {/* The Settings link leaves the page: the dialog closes with it (decision 1601). */}
        <TranscriptionChoices slug={slug} view={view} question={question} onDone={onClose} headingId={id} onSettings={onSettings ?? onClose} {...other}
          footer={<Button size="sm" variant="ghost" onClick={onClose}>{t.common.close}</Button>} />
      </div>
    </Modal>
  );
}

/**
 * The question a held analysis asks (long video or transcription), as its dialog. The question is kept as last asked: while
 * Whisper installs, the live view may already have dropped it, and the dialog stays until the install ends.
 */
export function AnalysisQuestionDialog({ slug, view, open, onClose, onSettings }: { slug: string; view: VideoAnalysisView | null; open: boolean; onClose(): void; onSettings?(): void }) {
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
    : <TranscriptionDialog key={key} slug={slug} view={last.view} question={last.question} open={open} onClose={onClose} {...(onSettings ? { onSettings } : {})} />;
}

/** A subtitles job's transcription question as the app's host keeps it (decision 1640): the creative and its title. */
export interface SubtitlesQuestion { slug: string; creative: string; title: string; jobId: string; pending: TranscriptionPending }

/**
 * Decision 1640: the transcription question of a creative's subtitles job, as its dialog. The same choices as a video's, sent
 * to the subtitles routes; the question is kept as last asked (while Whisper installs) like the analysis's. "Ricontrolla"
 * when nothing asks any more closes it.
 */
export function SubtitlesQuestionDialog({ question, open, onClose, onSettings }: { question: SubtitlesQuestion; open: boolean; onClose(): void; onSettings?(): void }) {
  const t = useT();
  const { slug, creative } = question;
  // The choices read a video's view: here a stand-in for the creative, whose question is the job's.
  const view: VideoAnalysisView = { file: `creatives/${creative}`, state: 'waiting', jobId: question.jobId, error: null, pending: question.pending, header: null, body: null };
  const recheck = () => api.subtitlesRecheck(slug, creative).then((r) => r.pending, (e: unknown) => {
    if (e instanceof ApiError && e.code === 'transcription-not-asked') return null;
    throw e;
  });
  return (
    <TranscriptionDialog slug={slug} view={view} question={question.pending} open={open} onClose={onClose} {...(onSettings ? { onSettings } : {})}
      title={t.transcription.subtitlesTitle({ title: question.title })} why={t.transcription.subtitlesWhy}
      submit={(c) => api.subtitlesChoice(slug, creative, c)} recheck={recheck} />
  );
}
