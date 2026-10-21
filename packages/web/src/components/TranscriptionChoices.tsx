import type { TranscriptionChoice, TranscriptionPending, TranscriptionStatus, VideoAnalysisView } from '@motion-studio/shared';
import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { message } from '../errors.ts';
import { formatNumber, useLocale, useT } from '../i18n.tsx';
import { formatBytes } from '../screens/assets/model.ts';
import { costText } from '../shell/Tokens.tsx';
import { Check, Icon, ProgressBar, cx, type IconName } from '../ui/index.ts';
import './transcription.css';

/** How often the download's progress is read while Whisper installs. */
export const INSTALL_POLL_MS = 1000;

const baseName = (file: string) => file.slice(file.lastIndexOf('/') + 1);
export const transcriptionTitle = (t: ReturnType<typeof useT>, file: string) => t.transcription.dialogTitle({ file: baseName(file) });

export interface TranscriptionChoicesProps {
  slug: string;
  /** The video's live view (the screen passes each new one): without a question any more, an install has finished. */
  view: VideoAnalysisView;
  /** The transcription question, as last asked. */
  question: TranscriptionPending;
  /** The choice went through (for Whisper to install: once the download ended and the analysis went on). */
  onDone?(): void;
  /** The heading's id (a dialog names itself by it). */
  headingId?: string;
}

/**
 * Spec §6: the transcription question, shared by the dialog (New creative, the library) and the brief chat's card. In order:
 * Whisper on the Mac (to install, with its size, when a model download makes it work; plain when it works already), the
 * providers with a saved key with their estimated cost and the "audio leaves the Mac" line, "Continua senza trascrizione";
 * "Ricorda la scelta"; what transcription is for; how to get a Whisper when nothing local is possible. Installing shows the
 * download's progress (read from the transcription status) until the analysis goes on or the download fails.
 */
export function TranscriptionChoices({ slug, view, question: p, onDone, headingId }: TranscriptionChoicesProps) {
  const t = useT();
  const tr = t.transcription;
  const locale = useLocale();
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState<TranscriptionChoice['choice'] | null>(null);
  const [installing, setInstalling] = useState(false);
  const [download, setDownload] = useState<TranscriptionStatus['download'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // While installing, the download's progress is read every second; a failure shows the pending's error (the core's).
  useEffect(() => {
    if (!installing) return;
    let alive = true;
    const read = () => { Promise.resolve().then(() => api.getTranscription()).then((s) => { if (alive) setDownload(s.download); }, () => {}); };
    read();
    const id = window.setInterval(read, INSTALL_POLL_MS);
    return () => { alive = false; window.clearInterval(id); };
  }, [installing]);
  const liveError = view.pending?.kind === 'transcription' ? view.pending.error : undefined;
  useEffect(() => { if (installing && liveError) setInstalling(false); }, [installing, liveError]);

  const size = formatBytes(p.whisper.sizeBytes, (n) => formatNumber(locale, n));
  const cost = (usd: number) => costText(t, locale, usd) ?? '';
  const choose = async (choice: TranscriptionChoice['choice']) => {
    setBusy(choice);
    setError(null);
    const install = choice === 'whisper' && !p.whisper.installed;
    try {
      const r = await api.transcriptionChoice(slug, { file: view.file, choice, remember, ...(install ? { sizeBytes: p.whisper.sizeBytes } : {}) });
      // Installing: the job stays held until the model is in place; the live view then drops its question.
      if (install && r.pending?.kind === 'transcription' && !r.pending.error) setInstalling(true);
      else onDone?.();
    } catch (e) { setError(tr.choiceFailed({ detail: message(e) })); }
    finally { setBusy(null); }
  };
  // The live view without a question any more: the install finished and the analysis went on.
  useEffect(() => { if (installing && view.pending?.kind !== 'transcription') onDone?.(); }, [installing, view.pending, onDone]);

  const local = p.whisper.installed || p.whisper.canInstall;
  const pendingError = liveError ?? p.error;
  const shownError = error ?? (pendingError ? tr.installFailed({ detail: pendingError }) : null);
  const percent = download && download.total > 0 ? Math.round((download.bytes / download.total) * 100) : 0;
  const option = (choice: TranscriptionChoice['choice'], icon: IconName, title: string, sub: string | null, tone?: 'paid') => (
    <button type="button" className={cx('ms-tchoice', tone === 'paid' && 'ms-tchoice-paid')} disabled={busy !== null || installing} aria-busy={busy === choice || undefined} onClick={() => void choose(choice)}>
      <span className="ms-tchoice-icon" aria-hidden="true"><Icon name={icon} size={14} /></span>
      <span className="ms-tchoice-text"><b>{title}</b>{sub ? <span>{sub}</span> : null}</span>
    </button>
  );

  return (
    <div className="ms-tchoices">
      <h2 id={headingId} className="ms-tchoices-title">{transcriptionTitle(t, view.file)}</h2>
      <p className="ms-tchoices-why">{tr.why}</p>
      {shownError ? <p className="ms-tchoices-error" role="alert">{shownError}</p> : null}
      {installing ? (
        <div className="ms-tchoices-progress" role="status">
          <ProgressBar value={percent} label={tr.downloading({ percent })} />
          <span>{tr.downloading({ percent })}</span>
        </div>
      ) : (
        <div className="ms-tchoices-list" role="group" aria-label={tr.choicesLabel}>
          {local ? option('whisper', p.whisper.installed ? 'check' : 'download', p.whisper.installed ? tr.methods.whisper : tr.installWhisper({ size }), tr.free) : null}
          {p.openai ? option('openai', 'globe', tr.withOpenai({ cost: cost(p.openai.costUsd) }), tr.leavesMac, 'paid') : null}
          {p.elevenlabs ? option('elevenlabs', 'globe', tr.withElevenlabs({ cost: cost(p.elevenlabs.costUsd) }), tr.leavesMac, 'paid') : null}
          {option('none', 'close', tr.continueWithout, null)}
        </div>
      )}
      {!local && !installing ? <p className="ms-tchoices-note">{tr.noBundled}</p> : null}
      {!installing ? <label className="ms-tchoices-remember"><Check on={remember} onChange={setRemember} label={tr.remember} /><span aria-hidden="true">{tr.remember}</span></label> : null}
    </div>
  );
}
