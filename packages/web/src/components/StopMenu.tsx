import type { JobSummary } from '@motion-studio/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../api.ts';
import { useT } from '../i18n.tsx';
import { Button, Icon, Popover, Textarea, toast, cx } from '../ui/index.ts';
import { liveErrorText, newClientId } from './liveErrors.ts';
import { SplitAction } from './SplitAction.tsx';

/** Jobs a message can redirect: creative and console turns. Every other job has Stop only. */
export const isRedirectable = (job: JobSummary) => job.kind === 'creative' || job.kind === 'console';

export interface StopMenuProps {
  job: JobSummary;
  /**
   * "Stop and redirect…" hands over to the caller's composer (the conversation focuses its box in redirect mode). Without
   * it the menu opens its own small form (the Activity center, which has no composer).
   */
  onRedirect?(): void;
  /** Where a failed stop is said (the composer's error line); without it a toast. */
  onError?(text: string): void;
  className?: string;
}

/**
 * The Stop button of a running job (Phase 13, spec §3): "Stop" ends the turn with no confirmation (an open paid approval is
 * cancelled by the core, nothing is spent); the chevron adds "Stop and redirect…". Esc never stops anything: stopping is
 * always an explicit click.
 */
export function StopMenu({ job, onRedirect, onError, className }: StopMenuProps) {
  const t = useT();
  const u = t.web.liveUi;
  const [stopping, setStopping] = useState(false);
  const [form, setForm] = useState(false);
  const group = useRef<HTMLSpanElement>(null);
  useEffect(() => { setStopping(false); }, [job.id, job.state]);
  const report = (text: string) => { if (onError) onError(text); else toast.show(text); };
  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    try {
      await api.stopJob(job.id);
    } catch {
      setStopping(false);
      report(u.stopFailed);
    }
  };
  const primary = (
    <Button variant="outline" size="sm" className="ms-stop" loading={stopping} disabled={stopping} onClick={() => void stop()}>{u.stop}</Button>
  );
  if (!isRedirectable(job)) return <span className={cx('ms-split', className)}>{primary}</span>;
  return (
    <>
      <SplitAction
        className={className} groupRef={group} primary={primary} menuLabel={u.stopMenu} disabled={stopping}
        items={[
          { key: 'stop', label: u.stop, onSelect: () => void stop() },
          { key: 'redirect', label: u.stopAndRedirect, onSelect: () => (onRedirect ? onRedirect() : setForm(true)) },
        ]}
      />
      {form && <RedirectForm job={job} anchor={group} onClose={() => setForm(false)} />}
    </>
  );
}

/** The redirect form of a job with no composer around it: the words, "Redirect" and "Cancel". */
function RedirectForm({ job, anchor, onClose }: { job: JobSummary; anchor: React.RefObject<HTMLElement | null>; onClose(): void }) {
  const t = useT();
  const u = t.web.liveUi;
  const id = useId();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  const clientId = useRef<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { field.current?.focus(); }, []);
  const send = async () => {
    const words = text.trim();
    if (!words || inFlight.current) return;
    inFlight.current = true;
    setSending(true); setError(null);
    clientId.current ??= newClientId();
    try {
      await api.redirectJob(job.id, { clientId: clientId.current, text: words });
      onClose();
    } catch (e) {
      setError(u.redirectFailed({ detail: liveErrorText(e, t) }));
    } finally { inFlight.current = false; setSending(false); }
  };
  return (
    <Popover open onClose={onClose} anchor={anchor} placement="bottom-end" width={300} label={u.redirectTitleFor({ label: job.label })}>
      <form className="ms-redirect-form" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <label htmlFor={id} className="ms-redirect-label">{u.redirectFieldLabel}</label>
        <Textarea id={id} ref={field} rows={3} maxLength={4000} value={text} placeholder={u.redirectPlaceholder}
          onChange={(e) => { setText(e.target.value); clientId.current = null; }} />
        <p className="ms-redirect-note">{u.redirectNote}</p>
        {error && <p role="alert" className="ms-composer-error">{error}</p>}
        <div className="ms-redirect-actions">
          <Button size="sm" variant="ghost" onClick={onClose}>{u.redirectCancel}</Button>
          <Button type="submit" size="sm" variant="accent" aria-label={u.redirectSend} disabled={!text.trim() || sending}><Icon name="forward" size={13} />{u.redirectSend}</Button>
        </div>
      </form>
    </Popover>
  );
}
