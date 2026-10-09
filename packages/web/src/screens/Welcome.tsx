import { LOCALES, type DoctorCheck, type LanguageSetting, type Locale, type Messages, type WorkspaceInfo, type WorkspaceProblem, type WorkspaceSettings } from '@motion-studio/shared';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api.ts';
import { desktop } from '../desktop.ts';
import { useT, type LanguageState } from '../i18n.tsx';
import { enter, exit, pop, reducedMotion, useEnter } from '../motion/index.ts';
import { href, type WelcomeStep } from '../routes.ts';
import { Button, Icon, Input, Pill, Select, Spinner, cx, toast } from '../ui/index.ts';
import './welcome.css';
import { message } from './common.tsx';

/** The folders inside every project (core `PROJECT_DIRS`): what the preview shows under each project. */
const PROJECT_DIRS = 'brand, assets, references, creatives';
/** Pace of the system check reveal (prototype: 280 ms per row). */
const REVEAL_MS = 280;
const PREVIEW_PROJECTS = 3;


function problemText(problem: WorkspaceProblem, path: string, w: Messages['web']['welcome']): string {
  switch (problem.code) {
    case 'not-found': return w.workspaceNotFound({ path });
    case 'invalid': return w.workspaceInvalid({ path, detail: problem.message });
    case 'not-writable': return problem.message;
  }
}

/** "acme.com" → "https://acme.com"; null when it is not a web address. */
export function normalizeSite(raw: string): string | null {
  const text = raw.trim();
  if (!text || /\s/.test(text)) return null;
  // Only "scheme://" counts as a scheme: "acme.com:8080" is a host with a port.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    // No credentials: "mailto:x@acme.com" would otherwise read as user "mailto" on acme.com.
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname.includes('.') || url.username || url.password) return null;
    return withScheme;
  } catch { return null; }
}

export interface WelcomeProps {
  checks: DoctorCheck[] | null;
  /** A recheck is running: `checks` still holds the previous result. */
  checking?: boolean;
  /** Completed doctor runs: the rows are revealed one by one once per run (not when only the texts change). */
  checksRun?: number;
  /** The doctor or the workspace could not be loaded (server unreachable). */
  loadError?: string | null;
  workspace: WorkspaceInfo | null;
  /** Step to open on (route `welcome/:step`); clamped to the first one that is not done yet. A later result that
   *  invalidates the current step (a required check now failing) moves back with T17. */
  step?: WelcomeStep;
  /** The setup is not required (Replay setup): the logo leads back to the projects. */
  canLeave?: boolean;
  language?: LanguageSetting;
  systemLocale?: Locale;
  onLanguage?(next: LanguageState): void;
  onRecheck(): void;
  onWorkspace(next: { path: string; settings: WorkspaceSettings }): void;
  /** Setup done (or skipped): where to go. */
  onFinish(hash: string): void;
}

/**
 * First-run setup (spec §6.2 #1): system check, workspace, first project, with the stepper on the left. The panel
 * changes step with T17: out towards −16 px, in from +16 px (mirrored when going back).
 */
export function Welcome(props: WelcomeProps) {
  const { checks, loadError, workspace, canLeave, onFinish } = props;
  const t = useT();
  const w = t.web.welcome;
  const blocking = !checks || Boolean(loadError) || checks.some((c) => c.required && !c.ok);
  // Saved here at step 2: the parent's workspace may arrive later.
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const configured = Boolean(workspace?.settings) || savedPath !== null;
  const maxStep: WelcomeStep = blocking ? 1 : configured ? 3 : 2;
  const [step, setStep] = useState<WelcomeStep>(() => Math.min(props.step ?? 1, maxStep) as WelcomeStep);
  const shown = step;
  // Rows revealed once per doctor run, across remounts of step 1.
  const revealedRun = useRef<number | null>(null);

  // T17. `seq` changes with every move, so the panel always comes back in even if the clamped step stays the same.
  const panel = useRef<HTMLDivElement>(null);
  const moving = useRef(false);
  const dir = useRef(0);
  const [seq, setSeq] = useState(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const go = async (n: WelcomeStep) => {
    if (moving.current || n === step || n < 1) return;
    moving.current = true;
    const d = n > step ? 1 : -1;
    await exit(panel.current, { x: -d * 16 });
    if (!alive.current) return;
    dir.current = d;
    setStep(n);
    setSeq((s) => s + 1);
    moving.current = false;
  };
  useLayoutEffect(() => {
    if (!dir.current) return;
    void enter(panel.current, { x: dir.current * 16, y: 0 });
    dir.current = 0;
  }, [seq]);
  // The current step is kept while rechecking; only a result that rules it out sends the panel back (T17).
  useEffect(() => { if (step > maxStep) void go(maxStep); });
  const root = useEnter<HTMLDivElement>([]);

  // The panel's main action, also run by ↵ (spec: "Press ↵ to continue").
  const primary = useRef<(() => void) | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest('button, a, textarea, select, [role="listbox"], [role="dialog"], .ms-pop')) return;
      e.preventDefault();
      primary.current?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const passed = checks?.filter((c) => c.ok).length ?? 0;
  const steps: Array<[string, string]> = [
    [w.checkTitle, loadError ? w.serverUnreachableShort : checks ? w.checksPassed({ ok: passed, total: checks.length }) : w.checking],
    [w.workspaceTitle, w.workspaceSub],
    [w.projectTitle, w.projectSub],
  ];

  let body: ReactNode;
  if (shown === 1) body = <CheckStep {...props} blocking={blocking} onNext={() => void go(2)} primary={primary} onBack={() => {}} revealedRun={revealedRun} />;
  // Re-check from step 2 goes back to the system check, where the rows reveal again.
  else if (shown === 2) body = <WorkspaceStep {...props} onRecheck={() => void go(1).then(props.onRecheck)} onBack={() => void go(1)} onSaved={(r) => { setSavedPath(r.path); props.onWorkspace(r); void go(3); }} primary={primary} />;
  else body = <ProjectStep onBack={() => void go(2)} onFinish={onFinish} primary={primary} />;

  return (
    <div className="ms-welcome" ref={root}>
      <header className="ms-welcome-top">
        {canLeave ? (
          <a className="ms-logo" href={href.projects()} aria-label={t.web.shell.home} onClick={(e) => { e.preventDefault(); onFinish(href.projects()); }}>
            <LogoGlyph />
          </a>
        ) : <span className="ms-logo" aria-hidden="true"><LogoGlyph /></span>}
        <b className="ms-welcome-brand">Motion Studio</b>
        <div className="ms-grow" />
        {props.onLanguage ? <LanguagePicker value={props.language ?? 'system'} systemLocale={props.systemLocale ?? 'en'} onChange={props.onLanguage} /> : null}
      </header>
      <main className="ms-welcome-stage">
        <div className="ms-welcome-grid">
          <div className="ms-welcome-side" data-enter>
            <div className="ms-welcome-hero">
              <span className="ms-welcome-cap">{w.setupStep({ n: shown, total: 3 })}</span>
              <h1>{w.title}</h1>
              <p>{w.intro}</p>
            </div>
            <ol className="ms-steps" aria-label={w.steps}>
              {steps.map(([title, sub], i) => {
                const n = i + 1;
                const state = n < shown ? 'done' : n === shown ? 'now' : 'next';
                return (
                  <li key={n} className={cx('ms-step', `ms-${state}`)} aria-current={state === 'now' ? 'step' : undefined}>
                    <span className="ms-step-mark" aria-hidden="true">{state === 'done' ? <Icon name="check" size={11} strokeWidth={2.2} /> : n}</span>
                    <span className="ms-step-text">
                      <b>{title}</b>
                      <span>{sub}</span>
                      {state === 'done' ? <span className="ms-sr">{w.stepDone}</span> : null}
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>
          <section className="ms-welcome-panel" ref={panel} data-enter data-delay="60" aria-labelledby="ms-welcome-h2">
            {body}
          </section>
        </div>
      </main>
    </div>
  );
}

function LogoGlyph() {
  return <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 2.5v7l6-3.5-6-3.5Z" /></svg>;
}

function LanguagePicker({ value, systemLocale, onChange }: { value: LanguageSetting; systemLocale: Locale; onChange(next: LanguageState): void }) {
  const t = useT();
  const s = t.web.settings;
  const options = [
    { value: 'system' as LanguageSetting, label: s.languageSystem({ detected: s.languageNames[systemLocale] }) },
    ...LOCALES.map((l) => ({ value: l as LanguageSetting, label: s.languageNames[l] })),
  ];
  const choose = async (setting: LanguageSetting) => {
    try {
      const r = await api.setLanguage(setting);
      onChange({ locale: r.locale, setting: r.languageSetting, systemLocale: r.systemLocale });
    } catch (e) { toast.show(s.languageFailed({ detail: message(e) })); }
  };
  return <Select className="ms-welcome-lang" value={value} options={options} onChange={(v) => void choose(v)} label={s.language} />;
}

type PrimaryRef = { current: (() => void) | null };

/** Head, body and footer shared by the three panels. */
function Panel({ title, intro, children, footer }: { title: string; intro: string; children: ReactNode; footer: ReactNode }) {
  return (
    <>
      <div className="ms-panel-head">
        <h2 id="ms-welcome-h2">{title}</h2>
        <p>{intro}</p>
      </div>
      <div className="ms-panel-body">{children}</div>
      <div className="ms-panel-foot">{footer}</div>
    </>
  );
}

function Footer({ onBack, back = true, hint = true, children }: { onBack(): void; back?: boolean; hint?: boolean; children: ReactNode }) {
  const t = useT();
  const w = t.web.welcome;
  return (
    <>
      <Button variant="ghost" disabled={!back} onClick={onBack}>{w.back}</Button>
      <div className="ms-grow" />
      {hint ? <span className="ms-welcome-hint" aria-hidden="true">{w.enterHint}</span> : null}
      {children}
    </>
  );
}

/* ---------- step 1: system check ---------- */

function CheckStep({ checks, checking, checksRun, loadError, onRecheck, blocking, onNext, primary, onBack, revealedRun }: WelcomeProps & { blocking: boolean; onNext(): void; primary: PrimaryRef; onBack(): void; revealedRun: { current: number | null } }) {
  const t = useT();
  const w = t.web.welcome;
  useEffect(() => { primary.current = blocking || checking ? null : onNext; });
  return (
    <Panel
      title={w.checkTitle}
      intro={w.checkIntro}
      footer={(
        <Footer onBack={onBack} back={false} hint={!blocking}>
          {blocking && checks && !loadError ? <span className="ms-welcome-blocked">{w.blocked}</span> : null}
          <Button variant="ink" size="lg" disabled={blocking || checking} onClick={onNext}>{w.continue}</Button>
        </Footer>
      )}
    >
      <SystemChecks checks={checks} checking={Boolean(checking)} run={checksRun ?? 0} revealedRun={revealedRun} loadError={loadError ?? null} onRecheck={onRecheck} />
    </Panel>
  );
}

/**
 * The doctor checks, revealed one by one once per doctor run (`run`); new texts for the same run (a language switch)
 * or coming back to step 1 show them at once. While `checking`, every row waits again. Failures show their remedy
 * with "Check again".
 */
export function SystemChecks({ checks, checking, run, revealedRun, loadError, onRecheck }: {
  checks: DoctorCheck[] | null; checking: boolean; run: number; revealedRun: { current: number | null }; loadError: string | null; onRecheck(): void;
}) {
  const t = useT();
  const w = t.web.welcome;
  const [revealed, setRevealed] = useState(() => (revealedRun.current === run ? Infinity : 0));
  const count = checks?.length ?? 0;
  const ready = checks !== null && !checking;
  useEffect(() => {
    if (!ready) return;
    if (revealedRun.current === run || reducedMotion()) { revealedRun.current = run; setRevealed(Infinity); return; }
    setRevealed(0);
    let i = 0;
    const id = setInterval(() => {
      i += 1;
      setRevealed(i);
      if (i >= count) { clearInterval(id); revealedRun.current = run; setRevealed(Infinity); }
    }, REVEAL_MS);
    return () => clearInterval(id);
    // Keyed on the run, not on the checks array: a reload of the same result (new language) must not replay it.
  }, [run, ready]); // eslint-disable-line react-hooks/exhaustive-deps
  const visible = checking ? 0 : revealed;

  if (loadError && !checking) {
    return (
      <div className="ms-syscheck-error">
        <p role="alert">{w.serverUnreachable({ detail: loadError })}</p>
        <Button variant="outline" onClick={onRecheck}><Icon name="refresh" size={14} />{w.checkAgain}</Button>
      </div>
    );
  }
  if (!checks) {
    return (
      <ul className="ms-syschecks" aria-label={w.checksList} aria-busy="true">
        <li className="ms-syscheck"><Spinner decorative size={16} /><span className="ms-syscheck-label ms-muted">{w.checking}</span></li>
      </ul>
    );
  }
  return (
    <ul className="ms-syschecks" aria-label={w.checksList} aria-busy={visible < checks.length || undefined}>
      {checks.map((c, i) => (i < visible ? <CheckRow key={c.id} check={c} onRecheck={onRecheck} /> : (
        <li key={c.id} className="ms-syscheck">
          <Spinner decorative size={16} />
          <span className="ms-syscheck-label ms-muted">{c.label}</span>
          <span className="ms-syscheck-value">{w.checkingRow}</span>
        </li>
      )))}
    </ul>
  );
}

function CheckRow({ check: c, onRecheck }: { check: DoctorCheck; onRecheck(): void }) {
  const t = useT();
  const w = t.web.welcome;
  const mark = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => { void pop(mark.current); }, []);
  if (c.ok) {
    return (
      <li className="ms-syscheck">
        <span ref={mark} className="ms-syscheck-mark ms-ok" aria-hidden="true"><Icon name="check" size={10} strokeWidth={2.4} /></span>
        <span className="ms-syscheck-label">{c.label}</span>
        <span className="ms-syscheck-value">{c.version ?? c.message}</span>
      </li>
    );
  }
  return (
    <li className={cx('ms-syscheck', 'ms-fail', c.required && 'ms-required')}>
      <div className="ms-syscheck-line">
        <span ref={mark} className={cx('ms-syscheck-mark', c.required ? 'ms-warn' : 'ms-note')} aria-hidden="true">
          <Icon name={c.required ? 'close' : 'minus'} size={10} strokeWidth={2.4} />
        </span>
        <span className="ms-syscheck-label">{c.label}</span>
        <Pill tone={c.required ? 'warn' : 'neutral'}>{c.required ? w.missing : w.recommended}</Pill>
      </div>
      <p className="ms-syscheck-message">{c.message}</p>
      {c.fix || c.required ? (
        <div className="ms-remedy">
          {c.fix ? (
            <div className="ms-remedy-text">
              <span className="ms-welcome-cap ms-plain">{w.remedy}</span>
              <code>{c.fix}</code>
            </div>
          ) : <div className="ms-grow" />}
          <Button size="sm" variant="outline" onClick={onRecheck}><Icon name="refresh" size={12} />{w.checkAgain}</Button>
        </div>
      ) : null}
    </li>
  );
}

/* ---------- step 2: workspace ---------- */

function WorkspaceStep({ workspace, checks, onRecheck, onBack, onSaved, primary }: WelcomeProps & { onBack(): void; onSaved(r: { path: string; settings: WorkspaceSettings }): void; primary: PrimaryRef }) {
  const t = useT();
  const w = t.web.welcome;
  const serverPath = workspace?.path ?? null;
  const [path, setPath] = useState(serverPath ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The configured path usually arrives after mount: prefill it unless the user already typed something.
  useEffect(() => { if (serverPath) setPath((p) => p || serverPath); }, [serverPath]);
  const trimmed = path.trim();
  const current = Boolean(serverPath) && trimmed === serverPath;

  // Real contents of the configured workspace: its projects (no endpoint lists arbitrary folders).
  const [projects, setProjects] = useState<string[] | null>(null);
  const inUse = current && Boolean(workspace?.settings) && !workspace?.error;
  useEffect(() => {
    if (!inUse) { setProjects(null); return; }
    let stale = false;
    api.listProjects().then((list) => { if (!stale) setProjects(list.map((p) => p.slug)); }).catch(() => { if (!stale) setProjects(null); });
    return () => { stale = true; };
  }, [inUse]);

  const bridge = desktop();
  const choose = async () => {
    try {
      const picked = await bridge?.pickFolder(w.pickFolderTitle, trimmed || undefined);
      if (picked) { setPath(picked); setError(null); }
    } catch (e) { setError(message(e)); }
  };
  // A ref, not the `busy` state: two submits in the same frame (click and ↵) must save once.
  const saving = useRef(false);
  const save = async () => {
    if (!trimmed || saving.current) return;
    saving.current = true;
    setBusy(true); setError(null);
    try {
      const r = await api.setWorkspace(trimmed);
      onSaved(r);
    } catch (e) {
      setError(w.saveFailed({ detail: message(e) }));
      setBusy(false);
      saving.current = false;
    }
  };
  useEffect(() => { primary.current = trimmed && !busy ? () => void save() : null; });

  let status: ReactNode;
  if (error) status = <p role="alert" className="ms-ws-status ms-warn"><Icon name="warn" size={12} />{error}</p>;
  else if (current && workspace?.error) status = <p role="alert" className="ms-ws-status ms-warn"><Icon name="warn" size={12} />{problemText(workspace.error, serverPath!, w)}</p>;
  else if (inUse) status = <p className="ms-ws-status ms-ok"><Icon name="check" size={12} strokeWidth={2} />{projects ? w.statusCurrent({ count: projects.length }) : w.statusChecking}</p>;
  else status = <p className="ms-ws-status">{w.statusNew}</p>;

  const shownProjects = (projects ?? []).slice(0, PREVIEW_PROJECTS);
  return (
    <Panel
      title={w.workspaceTitle}
      intro={w.workspaceIntro}
      footer={(
        <Footer onBack={onBack}>
          <Button variant="ink" size="lg" loading={busy} disabled={!trimmed} onClick={() => void save()}>{w.continue}</Button>
        </Footer>
      )}
    >
      <div className="ms-ws-field">
        <label className="ms-welcome-label" htmlFor="ms-ws-path">{w.folder}</label>
        <div className="ms-ws-row">
          <div className="ms-ws-input">
            <Icon name="folder" size={15} />
            <Input id="ms-ws-path" className="ms-mono" value={path} spellCheck={false} autoComplete="off"
              placeholder={w.pathPlaceholder} aria-invalid={error ? true : undefined}
              onChange={(e) => { setPath(e.target.value); setError(null); }} />
          </div>
          {bridge ? <Button variant="outline" size="lg" disabled={busy} onClick={() => void choose()}>{t.web.common.chooseFolder}</Button> : null}
        </div>
        {status}
      </div>
      {trimmed ? (
        <div className="ms-ws-preview" aria-label={w.preview} role="group">
          <div className="ms-ws-root">{trimmed.replace(/\/+$/, '')}/</div>
          {shownProjects.map((slug) => (
            <div key={slug}>├─ <span className="ms-ws-name">{slug}/</span> <span className="ms-faint">· {PROJECT_DIRS}</span></div>
          ))}
          {projects && projects.length > PREVIEW_PROJECTS ? <div>├─ …</div> : null}
          <div>└─ <span className="ms-faint">{w.previewProject} · {PROJECT_DIRS}</span></div>
        </div>
      ) : null}
      {checks ? <ChecksSummary checks={checks} onRecheck={onRecheck} /> : null}
    </Panel>
  );
}

/** "Your computer is ready · N checks passed", unfolding to the list (board Welcome, step 2). */
function ChecksSummary({ checks, onRecheck }: { checks: DoctorCheck[]; onRecheck(): void }) {
  const t = useT();
  const w = t.web.welcome;
  const [open, setOpen] = useState(false);
  const passed = checks.filter((c) => c.ok).length;
  const notes = passed < checks.length;
  return (
    <div className="ms-ws-checks">
      <div className="ms-ws-checks-head">
        <button type="button" className="ms-ws-checks-toggle" aria-expanded={open} aria-controls="ms-ws-checks-list" onClick={() => setOpen((o) => !o)}>
          <span className={cx('ms-syscheck-mark', notes ? 'ms-note' : 'ms-ok')} aria-hidden="true"><Icon name={notes ? 'minus' : 'check'} size={10} strokeWidth={2.4} /></span>
          <b>{notes ? w.systemNotes : w.systemReady}</b>
          <span className="ms-muted">· {w.checksPassed({ ok: passed, total: checks.length })}</span>
          <Icon name="chevron" size={12} className={cx('ms-ws-chev', open && 'ms-open')} />
        </button>
        <Button size="sm" variant="ghost" onClick={onRecheck}>{w.recheck}</Button>
      </div>
      {open ? (
        <ul id="ms-ws-checks-list" className="ms-ws-checks-list">
          {checks.map((c) => (
            <li key={c.id}>
              <span className={cx('ms-ws-dot', c.ok ? 'ms-ok' : 'ms-note')} aria-hidden="true" />
              <span className="ms-syscheck-label">{c.label}</span>
              <span className="ms-syscheck-value">{c.ok ? (c.version ?? c.message) : w.recommended}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/* ---------- step 3: first project ---------- */

function ProjectStep({ onBack, onFinish, primary }: { onBack(): void; onFinish(hash: string): void; primary: PrimaryRef }) {
  const t = useT();
  const w = t.web.welcome;
  const [name, setName] = useState('');
  const [site, setSite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [siteError, setSiteError] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { nameRef.current?.focus({ preventScroll: true }); }, []);

  // A ref, not the `busy` state: two submits in the same frame (click and ↵) must create one project.
  const creating = useRef(false);
  const create = async () => {
    const title = name.trim();
    if (!title || creating.current) return;
    const url = site.trim() ? normalizeSite(site) : null;
    if (site.trim() && !url) { setSiteError(true); return; }
    creating.current = true;
    setBusy(true); setError(null); setSiteError(false);
    let slug: string;
    try { slug = (await api.createProject(title)).slug; }
    catch (e) { setError(w.createFailed({ detail: message(e) })); setBusy(false); creating.current = false; return; }
    // From here the project exists: whatever happens next, the user lands on its Brand tab.
    if (url) {
      let step: 'source' | 'analysis' = 'source';
      try {
        const source = await api.addBrandSource(slug, { kind: 'website', url });
        step = 'analysis';
        await api.analyzeBrand(slug, [source.id]);
        toast.show(w.createdLearning({ name: title, site: new URL(url).host }), { tone: 'ok' });
      } catch (e) {
        const detail = message(e);
        toast.show(step === 'source' ? w.sourceFailed({ detail }) : w.analysisFailed({ detail }), { sticky: true });
      }
    } else {
      toast.show(w.created({ name: title }), { tone: 'ok' });
    }
    onFinish(href.project(slug, 'brand'));
  };
  useEffect(() => { primary.current = name.trim() && !busy ? () => void create() : null; });

  return (
    <Panel
      title={w.projectTitle}
      intro={w.projectIntro}
      footer={(
        <Footer onBack={onBack}>
          <Button variant="ghost" disabled={busy} onClick={() => onFinish(href.projects())}>{w.skip}</Button>
          <Button variant="ink" size="lg" loading={busy} disabled={!name.trim()} onClick={() => void create()}>{w.create}</Button>
        </Footer>
      )}
    >
      <div className="ms-ws-field">
        <label className="ms-welcome-label" htmlFor="ms-project-name">{w.projectName}</label>
        <Input id="ms-project-name" ref={nameRef} value={name} placeholder={w.projectNamePlaceholder} autoComplete="off"
          onChange={(e) => { setName(e.target.value); setError(null); }} />
      </div>
      <div className="ms-ws-field">
        <label className="ms-welcome-label" htmlFor="ms-project-site">{w.website} <span className="ms-faint">· {w.optional}</span></label>
        <Input id="ms-project-site" value={site} placeholder={w.websitePlaceholder} inputMode="url" autoComplete="url" spellCheck={false}
          aria-invalid={siteError || undefined} aria-describedby={siteError ? 'ms-project-site-error' : undefined}
          onChange={(e) => { setSite(e.target.value); setSiteError(false); }} />
        {siteError ? <p id="ms-project-site-error" role="alert" className="ms-ws-status ms-warn"><Icon name="warn" size={12} />{w.websiteInvalid}</p> : null}
      </div>
      {error ? <p role="alert" className="ms-ws-status ms-warn"><Icon name="warn" size={12} />{error}</p> : null}
    </Panel>
  );
}
