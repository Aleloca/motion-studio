import type { JobSummary } from '@motion-studio/shared';
import { useId, useRef, useState } from 'react';
import { api } from '../api.ts';
import { useT } from '../i18n.tsx';
import { Button, Icon, Textarea } from '../ui/index.ts';
import { liveErrorText, newClientId } from './liveErrors.ts';
import { StopMenu } from './StopMenu.tsx';

export interface ConsoleMessageBoxProps {
  /** The running console turn. */
  jobId: string;
  /** The Claude Code in use takes messages mid-turn (GET /api/agent/capabilities). The console has no queue. */
  liveInput: boolean;
  /** With the job, the box shows the same Stop menu as the conversation and the Activity center. */
  job?: JobSummary;
}

/**
 * A message to a running console turn (Phase 13, spec §2). The console has no queue: without live input there is nothing
 * to send mid-turn, and the box says so. Stop and redirect go through the same job routes as every other turn.
 */
export function ConsoleMessageBox({ jobId, liveInput, job }: ConsoleMessageBoxProps) {
  const t = useT();
  const u = t.web.liveUi;
  const id = useId();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const clientId = useRef<string | null>(null);
  const canSend = liveInput && text.trim().length > 0 && !sending;
  const send = async () => {
    if (!canSend || inFlight.current) return;
    inFlight.current = true;
    setSending(true); setError(null);
    clientId.current ??= newClientId();
    try {
      await api.sendConsoleMessage(jobId, { clientId: clientId.current, text: text.trim() });
      setText(''); clientId.current = null;
    } catch (e) {
      setError(liveErrorText(e, t));
    } finally { inFlight.current = false; setSending(false); }
  };
  return (
    <form className="ms-composer ms-console-box" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <div className="ms-composer-box">
        <label htmlFor={id} className="ms-composer-label">{u.consoleMessage}</label>
        <Textarea id={id} rows={2} maxLength={4000} value={text} disabled={!liveInput} placeholder={u.livePlaceholder}
          onChange={(e) => { setText(e.target.value); clientId.current = null; }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
        {!liveInput && <p className="ms-composer-note">{u.consoleUnsupported}</p>}
        {error && <p role="alert" className="ms-composer-error">{error}</p>}
        <div className="ms-composer-foot">
          <span className="ms-composer-hint">{liveInput ? u.liveHint : ''}</span>
          {job && <StopMenu job={job} onError={setError} />}
          <Button type="submit" size="sm" variant="accent" aria-label={u.send} disabled={!canSend}><Icon name="upload" size={13} strokeWidth={1.8} />{u.send}</Button>
        </div>
      </div>
    </form>
  );
}
