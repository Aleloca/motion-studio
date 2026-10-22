import type { TranscriptionChoice, TranscriptionPending, TranscriptionStatus, VideoAnalysisPending, VideoAnalysisView } from '@motion-studio/shared';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api.ts';
import { message } from '../errors.ts';
import { formatNumber, useLocale, useT } from '../i18n.tsx';
import { formatBytes } from '../screens/assets/model.ts';
import { costText } from '../shell/Tokens.tsx';
import { isMac } from '../platform.ts';
import { href } from '../routes.ts';
import { Button, Check, Icon, Pill, ProgressBar } from '../ui/index.ts';
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
  /** Beside "Continua senza trascrizione" at the bottom (the dialog's Chiudi). */
  footer?: ReactNode;
  /** The Settings link was followed (a dialog closes, decision 1601). */
  onSettings?(): void;
  /**
   * Where the choice goes (a subtitles job's question, decision 1640): it answers with the question as it stands (absent:
   * nothing asks any more). Default: the video analysis's route for `view.file`.
   */
  submit?(c: Omit<TranscriptionChoice, 'file'>): Promise<{ pending: TranscriptionPending | VideoAnalysisPending | null }>;
  /** "Ricontrolla" for that question: the new offer, null when nothing asks any more. Default: the analysis's route. */
  recheck?(): Promise<TranscriptionPending | null>;
  /** The heading and the line under it, when the question is not about a video's analysis (the subtitles'). */
  title?: string;
  why?: string;
}

/** The commands that get a Whisper the app can run (report 64): whisper.cpp from Homebrew, or the Python one. */
export const WHISPER_COMMANDS = { brew: 'brew install whisper-cpp', pip: 'pip install openai-whisper' } as const;
const COPIED_MS = 1600;

/** Selects the text of `el`, so the user can copy it by hand. */
function selectText(el: HTMLElement | null) {
  const sel = window.getSelection();
  if (!el || !sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** A command as a code chip with its Copia button (the Pairing page's pattern: a failed copy selects it and says how). */
function CommandChip({ command, onCopied }: { command: string; onCopied(state: 'idle' | 'copied' | 'manual'): void }) {
  const tr = useT().transcription;
  const code = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async () => {
    if (timer.current) clearTimeout(timer.current);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(command);
      setCopied(true);
      onCopied('copied');
      // The status clears with the label, so a second copy is announced again (decision 1605).
      timer.current = setTimeout(() => { setCopied(false); onCopied('idle'); }, COPIED_MS);
    } catch {
      selectText(code.current);
      onCopied('manual');
    }
  };
  return (
    <div className="ms-tcmd">
      <code ref={code}>{command}</code>
      <Button size="sm" variant="ghost" aria-label={tr.copyCommand({ command })} onClick={() => void copy()}>
        <Icon name={copied ? 'check' : 'copy'} size={13} strokeWidth={copied ? 2 : 1.4} />
        {copied ? tr.copied : tr.copy}
      </Button>
    </div>
  );
}

/**
 * Spec §6, report 64: the transcription question, shared by the dialog (New creative, the library) and the brief chat's card.
 * Whisper comes first and is the recommended option (free, the audio stays on the Mac): to install with the model's size when
 * a model download makes it work, plain when it works already (saying so when a Python engine downloads its own model). When
 * the app cannot run one, Whisper still comes first, with the commands that install one (to copy), the way to Settings and
 * "Ricontrolla" (the detection again, the offer refreshed in place). Then, under "A pagamento", the providers with a saved
 * key with their estimated cost and the "audio leaves the Mac" line (nothing when none has a key). At the bottom, quiet:
 * "Ricorda la scelta" and "Continua senza trascrizione" (beside the dialog's Chiudi, `footer`). Installing shows the
 * download's progress (read from the transcription status) until the analysis goes on or the download fails.
 */
export function TranscriptionChoices({ slug, view, question, onDone, headingId, footer, onSettings, submit, recheck: recheckOffer, title, why }: TranscriptionChoicesProps) {
  const t = useT();
  const tr = t.transcription;
  const locale = useLocale();
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState<TranscriptionChoice['choice'] | null>(null);
  const [installing, setInstalling] = useState(false);
  const [download, setDownload] = useState<TranscriptionStatus['download'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // "Ricontrolla": the offer it answered (until the screen passes a newer question) and what it found.
  const [fresh, setFresh] = useState<{ for: TranscriptionPending; offer: TranscriptionPending } | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const [recheckNote, setRecheckNote] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'manual'>('idle');
  const p = fresh && fresh.for === question ? fresh.offer : question;
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
    // A Python engine that downloads its own model needs no download from us (decision 1551 of the review).
    const install = choice === 'whisper' && !p.whisper.installed && !p.whisper.downloadsOwnModel;
    try {
      const body = { choice, remember, ...(install ? { sizeBytes: p.whisper.sizeBytes } : {}) };
      const r = submit ? await submit(body) : await api.transcriptionChoice(slug, { file: view.file, ...body });
      // Installing: the job stays held until the model is in place; the live view then drops its question.
      if (install && r.pending?.kind === 'transcription' && !r.pending.error) setInstalling(true);
      else onDone?.();
    } catch (e) { setError(tr.choiceFailed({ detail: message(e) })); }
    finally { setBusy(null); }
  };
  // Decision 1591: the detection again; the new offer replaces the shown one, or the question went away (answered elsewhere).
  const recheck = async () => {
    setRechecking(true);
    setRecheckNote(null);
    try {
      const offer = recheckOffer ? await recheckOffer() : await api.recheckTranscription(slug, view.file).then((r) => (r.pending?.kind === 'transcription' ? r.pending : null));
      if (!offer) { onDone?.(); return; }
      setFresh({ for: question, offer });
      const w = offer.whisper;
      if (!(w.installed || w.downloadsOwnModel || w.canInstall)) setRecheckNote(tr.stillNone);
    } catch (e) { setRecheckNote(tr.recheckFailed({ detail: message(e) })); }
    finally { setRechecking(false); }
  };
  // The live view without a question any more: the install finished and the analysis went on.
  useEffect(() => { if (installing && view.pending?.kind !== 'transcription') onDone?.(); }, [installing, view.pending, onDone]);

  const ready = p.whisper.installed || p.whisper.downloadsOwnModel;
  const local = ready || p.whisper.canInstall;
  const model = tr.models[p.whisper.model];
  const facts = [tr.freeLocal, p.whisper.downloadsOwnModel ? tr.ownModel : p.whisper.installed ? tr.modelReady({ model }) : tr.modelOnce({ model, size })].join(' · ');
  const pendingError = liveError ?? p.error;
  const shownError = error ?? (pendingError ? tr.installFailed({ detail: pendingError }) : null);
  const percent = download && download.total > 0 ? Math.round((download.bytes / download.total) * 100) : 0;
  const locked = busy !== null || installing;
  const whisperHead = (
    <span className="ms-tchoice-text">
      <span className="ms-tchoice-head"><b>{tr.whisperTitle}</b><Pill tone="accent">{tr.recommended}</Pill></span>
      <span>{local ? facts : tr.freeLocal}</span>
    </span>
  );
  const paid = (choice: 'openai' | 'elevenlabs', title: string) => (
    <button type="button" className="ms-tchoice ms-tchoice-paid" disabled={locked} aria-busy={busy === choice || undefined} onClick={() => void choose(choice)}>
      <span className="ms-tchoice-icon" aria-hidden="true"><Icon name="globe" size={14} /></span>
      <span className="ms-tchoice-text"><b>{title}</b><span>{tr.leavesMac}</span></span>
    </button>
  );

  return (
    <div className="ms-tchoices">
      <h2 id={headingId} className="ms-tchoices-title">{title ?? transcriptionTitle(t, view.file)}</h2>
      <p className="ms-tchoices-why">{why ?? tr.why}</p>
      {shownError ? <p className="ms-tchoices-error" role="alert">{shownError}</p> : null}
      {installing ? (
        <div className="ms-tchoices-progress" role="status">
          <ProgressBar value={percent} label={tr.downloading({ percent })} />
          <span>{tr.downloading({ percent })}</span>
        </div>
      ) : (
        <div className="ms-tchoices-list" role="group" aria-label={tr.choicesLabel}>
          {local ? (
            <button type="button" className="ms-tchoice ms-tchoice-primary" disabled={locked} aria-busy={busy === 'whisper' || undefined} onClick={() => void choose('whisper')}>
              <span className="ms-tchoice-icon" aria-hidden="true"><Icon name={ready ? 'check' : 'download'} size={14} /></span>
              {whisperHead}
            </button>
          ) : (
            <div className="ms-tchoice ms-tchoice-primary ms-tchoice-steps">
              <span className="ms-tchoice-icon" aria-hidden="true"><Icon name="download" size={14} /></span>
              <div className="ms-tchoice-body">
                {whisperHead}
                <p className="ms-tsteps-intro">{tr.getWhisper}</p>
                <ol className="ms-tsteps">
                  <li><span>{tr.stepBrew}</span><CommandChip command={WHISPER_COMMANDS.brew} onCopied={setCopyState} /></li>
                  <li><span>{tr.stepPip}</span><CommandChip command={WHISPER_COMMANDS.pip} onCopied={setCopyState} /></li>
                </ol>
                <p className={copyState === 'manual' ? 'ms-tsteps-note' : 'ms-tsteps-note ms-sr'} role="status">
                  {copyState === 'manual' ? tr.copyFallback({ keys: isMac() ? '⌘C' : 'Ctrl+C' }) : copyState === 'copied' ? tr.copiedStatus : ''}
                </p>
                <div className="ms-tsteps-actions">
                  <Button size="sm" variant="outline" disabled={rechecking} aria-busy={rechecking || undefined} onClick={() => void recheck()}>
                    <Icon name="refresh" size={13} />{rechecking ? tr.rechecking : tr.recheck}
                  </Button>
                  <a className="ms-tsteps-link" href={href.settings('transcription')} onClick={() => onSettings?.()}>{tr.pickInstalled}</a>
                </div>
                {recheckNote ? <p className="ms-tsteps-note" role="status">{recheckNote}</p> : null}
              </div>
            </div>
          )}
          {p.openai || p.elevenlabs ? <h3 className="ms-tchoices-paidhead">{tr.paidHeading}</h3> : null}
          {p.openai ? paid('openai', tr.withOpenai({ cost: cost(p.openai.costUsd) })) : null}
          {p.elevenlabs ? paid('elevenlabs', tr.withElevenlabs({ cost: cost(p.elevenlabs.costUsd) })) : null}
        </div>
      )}
      <div className="ms-tchoices-foot">
        {!installing ? <label className="ms-tchoices-remember"><Check on={remember} onChange={setRemember} label={tr.remember} /><span aria-hidden="true">{tr.remember}</span></label> : null}
        <span className="ms-tchoices-foot-actions">
          {!installing ? (
            <button type="button" className="ms-tchoices-skip" disabled={locked} aria-busy={busy === 'none' || undefined} onClick={() => void choose('none')}>{tr.continueWithout}</button>
          ) : null}
          {footer}
        </span>
      </div>
    </div>
  );
}
