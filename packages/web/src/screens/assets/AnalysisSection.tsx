import { parseAnalysisBody, type AnalysisBody, type JobWaitReason, type SidecarHeader, type VideoAnalysisState, type VideoAnalysisView } from '@motion-studio/shared';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, api } from '../../api.ts';
import { useT } from '../../i18n.tsx';
import { Button, Icon, Pill, Tag, Textarea, clockText, toast, type PillTone } from '../../ui/index.ts';
import { AnalysisQuestionDialog } from '../../components/TranscriptionDialog.tsx';
import { useAnalysisQuestions } from '../../components/AnalysisQuestionHost.tsx';
import { message } from '../common.tsx';
import './analysis.css';

const TONE: Record<VideoAnalysisState, PillTone> = { none: 'neutral', queued: 'neutral', running: 'neutral', waiting: 'warn', ready: 'ok', stale: 'warn', error: 'warn' };

export interface AnalysisSectionProps {
  slug: string;
  view: VideoAnalysisView;
  /** Why its queued job waits (the live job's `waitReason`): the audio check has its own hint (report 63). */
  waitReason?: JobWaitReason | undefined;
  /** Seeks the player above to a time in seconds (a row of the timeline, the transcript or the moments). */
  onSeek(sec: number): void;
  /** The view after an action (Analizza, Modifica…), before the live message arrives. */
  onView?(view: VideoAnalysisView): void;
}

/**
 * Spec §9: a video's Analisi in the library's detail panel. State pill; when the analysis exists, the summary, the scenes
 * (with their on-screen text and speech), the usable moments, the transcript and the tags, each timed row a button that seeks
 * the player. A body the user reshaped (no `## Timeline`) is shown as it is. Analizza / Rianalizza (an edited analysis asks
 * first, decision 1480), Modifica (the body as text; the header stays the core's), Ferma while it is queued or running, and
 * "Scegli…" for a held analysis's question (its dialog).
 */
export function AnalysisSection({ slug, view, waitReason, onSeek, onView }: AnalysisSectionProps) {
  const t = useT();
  const v = t.videoAnalysis;
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  // Spec §6: a held analysis's question (long video, transcription) opens its dialog from here.
  const [asking, setAsking] = useState(false);
  const questions = useAnalysisQuestions();
  // Answered elsewhere: the dialog closes (while Whisper installs the analysis still asks).
  useEffect(() => { if (asking && !view.pending) setAsking(false); }, [asking, view.pending]);
  const edited = view.header?.edited === true;
  const fail = (e: unknown) => toast.show(v.actionFailed({ detail: message(e) }));
  const act = async (fn: () => Promise<VideoAnalysisView | void>) => {
    setBusy(true);
    try { const r = await fn(); if (r) onView?.(r); return true; } catch (e) { fail(e); return false; } finally { setBusy(false); }
  };
  const analyze = async (overwrite: boolean) => {
    setBusy(true);
    try {
      // Called before `onView?.`: an optional call skips evaluating its argument when there is no handler.
      const next = await api.analyzeVideo(slug, view.file, overwrite || undefined);
      onView?.(next);
      setConfirm(false);
    } catch (e) {
      // The file was edited meanwhile (another window): ask, as for a known edit.
      if (e instanceof ApiError && e.code === 'analysis-edited') setConfirm(true); else fail(e);
    } finally { setBusy(false); }
  };
  const reanalyze = () => (edited ? setConfirm(true) : void analyze(false));
  const save = async () => { if (draft !== null && await act(() => api.saveAnalysisBody(slug, view.file, draft))) setDraft(null); };

  const active = view.state === 'queued' || view.state === 'running';
  const hasBody = view.body !== null;
  const hint = view.state === 'none' ? v.hints.none
    : view.state === 'queued' ? (waitReason === 'transcription-check' ? v.hints.checkingAudio : v.hints.queued)
      : view.state === 'running' ? v.hints.running
        : view.state === 'stale' ? (edited ? v.hints.staleEdited : v.hints.stale)
          : view.state === 'waiting' && view.pending ? (view.pending.kind === 'long' ? v.hints.long : v.hints.transcription)
            : view.state === 'error' ? view.error : null;

  return (
    <section className="ms-ana" aria-label={v.section}>
      <div className="ms-lib-row ms-ana-head">
        <span className="ms-lib-label">{v.section}</span>
        <Pill tone={TONE[view.state]} spinner={active} dot={!active}>{v.states[view.state]}</Pill>
        {edited ? <span className="ms-lib-faint ms-lib-small">{v.edited}</span> : null}
        <span className="ms-ana-actions">
          {active ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(async () => { await api.cancelVideoAnalysis(slug, view.file); })}>{v.stop}</Button> : null}
          {view.state === 'waiting' && view.pending ? <Button size="sm" variant="ink" onClick={() => setAsking(true)}>{v.answer}</Button> : null}
          {view.state === 'ready' ? <Button size="sm" variant="outline" loading={busy && !confirm} disabled={busy || draft !== null} onClick={reanalyze}><Icon name="refresh" size={12} />{v.reanalyze}</Button>
            : view.state === 'none' || view.state === 'error' || view.state === 'stale'
              ? <Button size="sm" variant="outline" loading={busy && !confirm} disabled={busy || draft !== null} onClick={() => (view.state === 'stale' && edited ? setConfirm(true) : void analyze(false))}><Icon name="sparkle" size={12} />{view.state === 'none' ? v.analyze : v.reanalyze}</Button>
              : null}
          {view.body !== null && draft === null && !active ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDraft(view.body ?? '')}><Icon name="edit" size={12} />{v.edit}</Button> : null}
        </span>
      </div>
      {hint ? <p className={view.state === 'error' ? 'ms-ana-hint ms-ana-error' : 'ms-ana-hint'} role={view.state === 'error' ? 'alert' : undefined}>{hint}</p> : null}
      {confirm ? (
        <div className="ms-ana-confirm" role="group" aria-label={v.overwriteTitle}>
          <b>{v.overwriteTitle}</b>
          <p>{v.overwriteText}</p>
          <div className="ms-ana-confirm-actions">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm(false)}>{t.common.cancel}</Button>
            <Button size="sm" variant="danger" loading={busy} onClick={() => void analyze(true)}>{v.overwrite}</Button>
          </div>
        </div>
      ) : null}
      {draft !== null ? (
        <div className="ms-ana-editor">
          <Textarea rows={14} aria-label={v.editLabel} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <span className="ms-lib-faint ms-lib-small">{v.editHint}</span>
          <div className="ms-ana-confirm-actions">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDraft(null)}>{t.common.cancel}</Button>
            <Button size="sm" variant="ink" loading={busy} disabled={draft === view.body} onClick={() => void save()}>{t.common.save}</Button>
          </div>
        </div>
      ) : hasBody ? <AnalysisBodyView body={view.body!} header={view.header} onSeek={onSeek} /> : null}
      {/* Closed with Chiudi: the app's own dialog never opens this question by itself again (report 65). */}
      <AnalysisQuestionDialog slug={slug} view={view} open={asking} onClose={() => { questions.dismiss(slug, view); setAsking(false); }}
        onSettings={() => { questions.park(slug, view); setAsking(false); }} />
    </section>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return <div className="ms-ana-block"><span className="ms-ana-title">{title}</span>{children}</div>;
}

const span = (from: number, to: number) => `${clockText(from)}–${clockText(to)}`;

function AnalysisBodyView({ body, header, onSeek }: { body: string; header: SidecarHeader | null; onSeek(sec: number): void }) {
  const t = useT();
  const v = t.videoAnalysis;
  const parsed: AnalysisBody | null = useMemo(() => parseAnalysisBody(body), [body]);
  if (!parsed) {
    return (
      <>
        <p className="ms-ana-hint">{v.raw}</p>
        <pre className="ms-ana-raw">{body}</pre>
      </>
    );
  }
  const seekButton = (at: number, label: string, children: ReactNode, key: string | number) => (
    <li key={key}><button type="button" className="ms-ana-row" aria-label={`${v.seek({ time: clockText(at) })} · ${label}`} onClick={() => onSeek(at)}>{children}</button></li>
  );
  const noTranscript = !header ? v.noTranscript.empty : !header.hasAudio ? v.noTranscript.noAudio
    : header.transcript === 'none-skipped' ? v.noTranscript.skipped : header.transcript === 'none-no-speech' ? v.noTranscript.noSpeech : v.noTranscript.empty;
  return (
    <>
      {parsed.summary ? <Block title={v.summary}><p className="ms-ana-summary">{parsed.summary}</p></Block> : null}
      {parsed.timeline.length ? (
        <Block title={v.timeline}>
          <ul className="ms-ana-list">
            {parsed.timeline.map((s, i) => seekButton(s.from, s.onScreen, (
              <>
                <span className="ms-ana-time">{span(s.from, s.to)}</span>
                <span className="ms-ana-text">
                  <span>{s.onScreen}</span>
                  {s.onScreenText.length ? <span className="ms-ana-ost"><span className="ms-ana-ost-label">{v.onScreenText}</span>{s.onScreenText.map((x, j) => <q key={j}>{x}</q>)}</span> : null}
                  {s.speech.map((sp, j) => <span key={j} className="ms-ana-speech"><span className="ms-ana-time">{clockText(sp.at)}</span><q>{sp.text}</q></span>)}
                </span>
              </>
            ), i))}
          </ul>
        </Block>
      ) : null}
      {parsed.usableMoments.length ? (
        <Block title={v.moments}>
          <ul className="ms-ana-list">
            {parsed.usableMoments.map((m, i) => seekButton(m.from, m.why, <><span className="ms-ana-time">{span(m.from, m.to)}</span><span className="ms-ana-text">{m.why}</span></>, i))}
          </ul>
        </Block>
      ) : null}
      <Block title={v.transcript}>
        {parsed.transcript.length ? (
          <>
            <span className="ms-lib-faint ms-lib-small">{v.automatic}</span>
            <ul className="ms-ana-list">
              {parsed.transcript.map((s, i) => seekButton(s.from, s.text, <><span className="ms-ana-time">{clockText(s.from)}</span><span className="ms-ana-text">{s.text}</span></>, i))}
            </ul>
          </>
        ) : <span className="ms-lib-muted">{noTranscript}</span>}
      </Block>
      {parsed.tags.length ? <Block title={v.tags}><div className="ms-adetail-tags">{parsed.tags.map((g) => <Tag key={g}>{g}</Tag>)}</div></Block> : null}
    </>
  );
}
