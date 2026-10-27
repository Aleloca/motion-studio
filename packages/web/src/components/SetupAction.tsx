import type { DoctorCheck, SetupStatus, SetupTaskState } from '@motion-studio/shared';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { useT } from '../i18n.tsx';
import { message } from '../screens/common.tsx';
import { Button, Icon, ProgressBar, Spinner } from '../ui/index.ts';

/** Anthropic's troubleshooting page for the install (user report 91). */
export const CLAUDE_TROUBLESHOOT_URL = 'https://code.claude.com/docs/en/troubleshoot-install';
const POLL_MS = 1000;
const COPIED_MS = 2000;

type Action = NonNullable<DoctorCheck['action']>;
const TASK_OF = { 'install-claude': 'claudeInstall', 'sign-in': 'claudeLogin', 'install-ffmpeg': 'ffmpegInstall' } as const;
const CANCEL_OF = { 'install-claude': 'claude-install', 'sign-in': 'claude-login', 'install-ffmpeg': 'ffmpeg-install' } as const;

const mb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1e6))} MB`;

/**
 * User report 91: the setup's status, read when a row offers an action and every second while a task runs. A task that
 * ends (done, failed, stopped) runs the checks again (`onEnded`).
 */
export function useSetupStatus(active: boolean, onEnded: () => void): { status: SetupStatus | null; error: string | null; set(s: SetupStatus): void } {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ended = useRef(onEnded);
  ended.current = onEnded;
  const prev = useRef<SetupStatus | null>(null);
  const apply = (s: SetupStatus) => {
    const before = prev.current;
    prev.current = s;
    setStatus(s);
    if (before && (Object.keys(s.tasks) as Array<keyof SetupStatus['tasks']>).some((k) => before.tasks[k].state === 'running' && s.tasks[k].state !== 'running')) ended.current();
  };
  const running = status ? Object.values(status.tasks).some((x) => x.state === 'running') : false;
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const load = () => api.getSetup().then((s) => { if (alive) { apply(s); setError(null); } }, (e: unknown) => { if (alive) setError(message(e)); });
    if (!prev.current) void load();
    if (!running) return () => { alive = false; };
    const id = setInterval(() => void load(), POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [active, running]); // eslint-disable-line react-hooks/exhaustive-deps
  return { status, error, set: apply };
}

function CopyCommand({ command }: { command: string }) {
  const w = useT().web.welcome;
  const code = useRef<HTMLElement>(null);
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async () => {
    if (timer.current) clearTimeout(timer.current);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(command);
      setState('copied');
      timer.current = setTimeout(() => setState('idle'), COPIED_MS);
    } catch {
      const sel = window.getSelection();
      if (sel && code.current) { const r = document.createRange(); r.selectNodeContents(code.current); sel.removeAllRanges(); sel.addRange(r); }
      setState('manual');
    }
  };
  return (
    <>
      <div className="ms-setup-cmd">
        <code ref={code}>{command}</code>
        <Button size="sm" variant="ghost" onClick={() => void copy()}>
          <Icon name={state === 'copied' ? 'check' : 'copy'} size={13} strokeWidth={state === 'copied' ? 2 : 1.4} />
          {state === 'copied' ? w.copied : w.copy}
        </Button>
      </div>
      {state === 'manual' ? <p className="ms-setup-hint" role="status">{w.copyManual}</p> : null}
    </>
  );
}

/** "Prefer to do it by hand?": the official command with Copy and the steps (Claude Code), or the plain steps (others). */
function Manual({ check, status }: { check: DoctorCheck; status: SetupStatus | null }) {
  const w = useT().web.welcome;
  if (check.action === 'install-claude') {
    const command = status?.claudeManual ?? check.fix;
    if (!command) return null;
    return (
      <details className="ms-setup-manual">
        <summary>{w.manualTitle}</summary>
        <ol>
          <li>{status?.platform === 'windows' ? w.manualOpenWindows : w.manualOpenOther}</li>
          <li>{w.manualPaste}<CopyCommand command={command} /></li>
          <li>{w.manualDone}</li>
        </ol>
      </details>
    );
  }
  if (!check.fix) return null;
  return (
    <details className="ms-setup-manual">
      <summary>{w.manualTitle}</summary>
      <p>{check.fix}</p>
    </details>
  );
}

function taskLine(action: Action, task: SetupTaskState, w: ReturnType<typeof useT>['web']['welcome']): string | null {
  if (task.state === 'running') {
    if (action === 'install-claude') return w.installingClaude;
    if (action === 'sign-in') return w.signingIn;
    return w.installingFfmpeg({ done: mb(task.bytes ?? 0), total: mb(task.total ?? 0) });
  }
  if (task.state === 'cancelled') return w.taskCancelled;
  if (task.state !== 'failed') return null;
  if (action === 'install-ffmpeg') return w.ffmpegFailed;
  if (action === 'sign-in') return task.error === 'timeout' ? w.signInTimeout : w.signInFailed;
  return task.error === 'timeout' ? w.installTimeout : w.installFailed;
}

/**
 * User report 91: the one-click remedy of a row (install Claude Code, sign in, install FFmpeg): the button, a confirmation
 * that says plainly what will run, the progress and the outcome in the row, and the manual way under a disclosure.
 */
export function SetupAction({ check, setup, onRecheck }: { check: DoctorCheck & { action: Action }; setup: ReturnType<typeof useSetupStatus>; onRecheck(): void }) {
  const t = useT();
  const w = t.web.welcome;
  const action = check.action;
  const { status } = setup;
  const task = status?.tasks[TASK_OF[action]] ?? { state: 'idle' as const };
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = task.state === 'running';
  const label = action === 'install-claude' ? w.installClaude : action === 'sign-in' ? w.signIn : w.installFfmpeg;
  const ffmpeg = status?.ffmpeg ?? null;
  const unavailable = status !== null && (!status.allowed || (action === 'install-ffmpeg' && !ffmpeg));
  const start = async () => {
    setStarting(true); setError(null);
    try {
      const s = action === 'install-claude' ? await api.setupInstallClaude() : action === 'sign-in' ? await api.setupSignIn() : await api.setupInstallFfmpeg();
      setup.set(s);
      setConfirming(false);
    } catch (e) { setError(message(e)); }
    finally { setStarting(false); }
  };
  const cancel = async () => {
    try { setup.set(await api.setupCancel(CANCEL_OF[action])); } catch (e) { setError(message(e)); }
  };
  const confirmText = action === 'install-claude' ? w.confirmClaude
    : action === 'sign-in' ? w.confirmSignIn
    : ffmpeg ? w.confirmFfmpeg({ version: ffmpeg.version, source: ffmpeg.source, size: mb(ffmpeg.sizeBytes), license: ffmpeg.license }) : '';
  const line = taskLine(action, task, w);
  const primary = action !== 'install-ffmpeg';
  return (
    <div className={`ms-remedy ms-setup ${primary ? 'ms-setup-primary' : ''}`}>
      {running ? (
        <div className="ms-setup-row">
          <div className="ms-setup-status" role="status"><Spinner decorative size={13} /><span>{line}</span></div>
          <div className="ms-grow" />
          <Button size="sm" variant="ghost" onClick={() => void cancel()}>{t.common.cancel}</Button>
        </div>
      ) : (
        <div className="ms-setup-row">
          {status && !unavailable && !confirming ? (
            <Button size="sm" variant={primary ? 'ink' : 'outline'} onClick={() => { setConfirming(true); setError(null); }}>{label}</Button>
          ) : null}
          <div className="ms-grow" />
          <Button size="sm" variant="outline" onClick={onRecheck}><Icon name="refresh" size={12} />{w.checkAgain}</Button>
        </div>
      )}
      {confirming ? (
        <div className="ms-setup-confirm" role="group" aria-label={label}>
          <p>{confirmText}</p>
          <div className="ms-setup-row">
            <Button size="sm" variant="ink" loading={starting} onClick={() => void start()}>{action === 'sign-in' ? w.confirmContinue : w.confirmInstall}</Button>
            <Button size="sm" variant="ghost" disabled={starting} onClick={() => setConfirming(false)}>{t.common.cancel}</Button>
          </div>
        </div>
      ) : null}
      {line && !running ? (
        <div className={`ms-setup-status ${task.state === 'failed' ? 'ms-warn' : ''}`} role={task.state === 'failed' ? 'alert' : 'status'}>
          {task.state === 'failed' ? <Icon name="warn" size={12} /> : null}
          <span>{line}</span>
        </div>
      ) : null}
      {running && action === 'install-ffmpeg' && task.total ? <ProgressBar value={((task.bytes ?? 0) / task.total) * 100} /> : null}
      {running && action === 'sign-in' && task.loginUrl ? (
        <a className="ms-setup-link" href={task.loginUrl} target="_blank" rel="noreferrer noopener">{w.openSignIn}</a>
      ) : null}
      {task.state === 'failed' && action === 'install-claude' ? (
        <a className="ms-setup-link" href={CLAUDE_TROUBLESHOOT_URL} target="_blank" rel="noreferrer noopener">{w.troubleshoot}</a>
      ) : null}
      {error ? <p className="ms-setup-status ms-warn" role="alert"><Icon name="warn" size={12} /><span>{error}</span></p> : null}
      {status && !status.allowed ? <p className="ms-setup-hint">{t.errors.setupNotLoopback}</p> : null}
      <Manual check={check} status={status} />
    </div>
  );
}
