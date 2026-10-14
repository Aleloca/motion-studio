import type { AgentEvent, JobSummary } from '@motion-studio/shared';
import { useId, useRef, useState } from 'react';
import { api } from '../api.ts';
import { useT } from '../i18n.tsx';
import { Button, Icon, Textarea } from '../ui/index.ts';
import { liveErrorText, newClientId } from './liveErrors.ts';
import { StopMenu } from './StopMenu.tsx';

export interface ConsoleMessageBoxProps {
  /** The running console turn. */
  jobId: string;
  /** The Claude Code in use takes messages mid-turn (GET /api/agent/capabilities); `null` while that is being asked (neutral: disabled, no note). The console has no queue. */
  liveInput: boolean | null;
  /** With the job, the box shows the same Stop menu as the conversation and the Activity center. */
  job?: JobSummary;
  /** The job's live events: a message the core reports as `user_message_not_delivered` is shown as such (final wave Q7). */
  events?: AgentEvent[];
}

/**
 * A message to a running console turn (Phase 13, spec §2). The console has no queue: without live input there is nothing
 * to send mid-turn, and the box says so. Stop and redirect go through the same job routes as every other turn.
 */
export function ConsoleMessageBox({ jobId, liveInput, job, events }: ConsoleMessageBoxProps) {
  const t = useT();
  const u = t.web.liveUi;
  const id = useId();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ clientId: string; text: string }[]>([]);
  const notDelivered = new Set((events ?? []).flatMap((e) => (e.kind === 'user_message_not_delivered' ? [e.clientId] : [])));
  const inFlight = useRef(false);
  const clientId = useRef<string | null>(null);
  const canSend = liveInput === true && text.trim().length > 0 && !sending;
  const send = async () => {
    if (!canSend || inFlight.current) return;
    inFlight.current = true;
    setSending(true); setError(null);
    clientId.current ??= newClientId();
    try {
      const sentId = clientId.current;
      await api.sendConsoleMessage(jobId, { clientId: sentId, text: text.trim() });
      setSent((l) => [...l, { clientId: sentId, text: text.trim() }]);
      setText(''); clientId.current = null;
    } catch (e) {
      setError(liveErrorText(e, t));
    } finally { inFlight.current = false; setSending(false); }
  };
  return (
    <form className="ms-composer ms-console-box" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <div className="ms-composer-box">
        <label htmlFor={id} className="ms-composer-label">{u.consoleMessage}</label>
        <Textarea id={id} rows={2} maxLength={4000} value={text} disabled={liveInput !== true} placeholder={u.livePlaceholder}
          onChange={(e) => { setText(e.target.value); clientId.current = null; }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
        {liveInput === false && <p className="ms-composer-note">{u.consoleUnsupported}</p>}
        {sent.filter((m) => notDelivered.has(m.clientId)).map((m) => (
          <div key={m.clientId} className="ms-console-lost">
            <span className="ms-pill ms-warn">{u.state.notDelivered}</span> <span>{m.text}</span>
            <p className="ms-composer-note" role="status">{u.notDeliveredReason}</p>
          </div>
        ))}
        {error && <p role="alert" className="ms-composer-error">{error}</p>}
        <div className="ms-composer-foot">
          <span className="ms-composer-hint">{liveInput === true ? u.liveHint : ''}</span>
          {job && <StopMenu job={job} onError={setError} />}
          <Button type="submit" size="sm" variant="accent" aria-label={u.send} disabled={!canSend}><Icon name="upload" size={13} strokeWidth={1.8} />{u.send}</Button>
        </div>
      </div>
    </form>
  );
}
