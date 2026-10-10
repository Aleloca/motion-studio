import type { ProjectIntegrity } from '@motion-studio/shared';
import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { message } from '../errors.ts';
import type { EventsState } from '../eventsReducer.ts';
import { useT } from '../i18n.tsx';
import { Button, Icon, Modal, toast } from '../ui/index.ts';
import './integrity.css';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

/** The project's integrity state, re-checked whenever a job ends or the project changes; null until loaded or when it is in order. */
export function useIntegrity(slug: string, live: EventsState): { state: ProjectIntegrity | null; reload(): void } {
  const [state, setState] = useState<ProjectIntegrity | null>(null);
  const [nonce, setNonce] = useState(0);
  const finished = useMemo(() => Object.values(live.jobs).filter((j) => TERMINAL.has(j.state)).length, [live.jobs]);
  const tick = live.projectTicks[slug] ?? 0;
  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => api.getIntegrity(slug)).then((s) => { if (alive) setState(s); }, () => { /* the page's own load reports a broken project */ });
    return () => { alive = false; };
  }, [slug, finished, tick, nonce]);
  const blocked = state !== null && (state.quarantined || state.gitProblem !== null);
  return { state: blocked ? state : null, reload: () => setNonce((n) => n + 1) };
}

/**
 * The project's blocked state (decisions log 141): a quarantine lists the protected files that changed, with an explicit
 * "Accept these changes" behind a confirmation; a git problem (a config key, an attributes driver, a commondir/gitdir
 * layout) is shown apart with its remedy and can never be accepted. Pass the state from `useIntegrity` (render this only
 * when it is not null).
 */
export function IntegrityNotice({ slug, state, reload }: { slug: string; state: ProjectIntegrity; reload(): void }) {
  const t = useT();
  const g = t.web.integrity;
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.acceptIntegrity(slug, state.token);
      setAsking(false);
      toast.show(g.accepted, { tone: 'ok' });
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'integrity-changed' ? g.changedSince : g.acceptFailed({ detail: message(e) }));
    } finally {
      setBusy(false);
      reload();
    }
  };

  return (
    <section className="ms-integrity" aria-label={state.quarantined ? g.title : g.gitTitle}>
      {state.quarantined ? (
        <div className="ms-integrity-box" role="alert">
          <div className="ms-integrity-head"><Icon name="warn" size={16} /><h2>{g.title}</h2></div>
          <p>{g.body}</p>
          {state.files.length > 0 ? (
            <>
              <h3 className="ms-integrity-label">{g.filesLabel}</h3>
              <ul className="ms-integrity-files">
                {state.files.map((f) => (
                  <li key={f.path}><code>{f.path}</code><span className="ms-integrity-change">{g.change[f.change]}</span></li>
                ))}
              </ul>
            </>
          ) : null}
          <p className="ms-integrity-hint">{g.restoreHint}</p>
          {state.gitProblem === null ? (
            <div className="ms-integrity-actions">
              <Button variant="outline" onClick={() => { setError(null); setAsking(true); }}>{g.accept}</Button>
            </div>
          ) : null}
          {error && !asking ? <p className="ms-integrity-error" role="alert">{error}</p> : null}
        </div>
      ) : null}
      {state.gitProblem !== null ? (
        <div className="ms-integrity-box ms-integrity-git" role="alert">
          <div className="ms-integrity-head"><Icon name="warn" size={16} /><h2>{g.gitTitle}</h2></div>
          <p>{g.gitBody}</p>
          <p className="ms-integrity-remedy">{state.gitProblem}</p>
        </div>
      ) : null}
      <Modal open={asking} onClose={() => setAsking(false)} label={g.confirmTitle} width={520} dismissible={!busy}>
        <div className="ms-integrity-dialog">
          <h2>{g.confirmTitle}</h2>
          <p className="ms-integrity-confirm">{g.confirmText}</p>
          <p>{g.confirmDetail}</p>
          <ul className="ms-integrity-files">
            {state.files.map((f) => (
              <li key={f.path}><code>{f.path}</code><span className="ms-integrity-change">{g.change[f.change]}</span></li>
            ))}
          </ul>
          {error ? <p className="ms-integrity-error" role="alert">{error}</p> : null}
          <div className="ms-integrity-foot">
            <Button variant="ghost" disabled={busy} onClick={() => setAsking(false)}>{g.cancel}</Button>
            <Button variant="danger" loading={busy} onClick={() => void accept()}>{g.confirm}</Button>
          </div>
        </div>
      </Modal>
    </section>
  );
}
