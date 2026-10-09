import { domainSchema, type DoctorCheck, type LinkedCodebase, type PermissionsFile, type WorkspaceSettings, type WorkspaceSettingsView } from '@motion-studio/shared';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api, type CodebaseCheck } from '../api.ts';
import { desktop } from '../desktop.ts';
import type { EventsState } from '../eventsReducer.ts';
import { formatDate, useLocale, useT } from '../i18n.tsx';
import { collapse, enter, useEnter } from '../motion/index.ts';
import { Button, Card, Empty, Icon, Input, NavItem, Pill, Select, Spinner, Tag, Textarea, Toggle, cx, toast, type IconName } from '../ui/index.ts';
import { Alert, Head, Row, SectionMain, UNDO_MS, message } from './common.tsx';
import { deferRemoval } from './deferred.ts';
import './settings.css';

type Section = 'general' | 'agent' | 'internet' | 'code';
const SECTIONS: Array<[Section, IconName]> = [['general', 'gear'], ['agent', 'shield'], ['internet', 'globe'], ['code', 'code']];
type Rule = PermissionsFile['allow'][number];
const MIN_JOBS = 1;
const MAX_JOBS = 8;

/** `https://Media.Acme.example/path` → `media.acme.example`; null when it is not a domain the sandbox accepts. */
export function normalizeDomain(raw: string): string | null {
  const host = raw.trim().replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0] ?? '';
  const r = domainSchema.safeParse(host);
  return r.success ? r.data : null;
}

/** The icon of an "always allowed" rule, from the tool it names. */
function ruleIcon(rule: string): IconName {
  if (/^Bash\b/.test(rule)) return 'terminal';
  if (/^(Edit|Write|MultiEdit|NotebookEdit)\b/.test(rule)) return 'edit';
  if (/^(WebFetch|WebSearch)\b/.test(rule)) return 'globe';
  if (/^Read\b/.test(rule)) return 'eye';
  if (/^(provider|mcp)/i.test(rule)) return 'key';
  return 'shield';
}

interface Props {
  slug: string; live: EventsState; settings: WorkspaceSettingsView; onSettings(next: WorkspaceSettings): void;
  /** The doctor's checks: the isolation row says whether the sandbox actually works here. */
  checks?: DoctorCheck[] | null;
}

/**
 * Project · Settings (spec §6.2 #12), ported from the prototype's ProjectSettingsPage and the ProjectSettings boards:
 * General, Agent and approvals (paid-service confirmation, parallel jobs, "Always allowed" with the plain label and the
 * rule below, revoked with T15 and Undo), Internet access and Linked code. The automatic approval of sandboxed
 * commands arrives with Phase 8; there is no Delete section because the API cannot delete a project.
 * Paid confirmation, parallel jobs, websites, isolation and model are workspace settings, shared by every project.
 */
export function ProjectSettings({ slug, live, settings, onSettings, checks: doctor = null }: Props) {
  const t = useT();
  const s = t.web.projectSettings;
  const tick = live.projectTicks[slug] ?? 0;
  const [nonce, setNonce] = useState(0);
  const [project, setProject] = useState<{ name: string; description: string; linkedCodebases: LinkedCodebase[] } | null>(null);
  const [checks, setChecks] = useState<CodebaseCheck[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [section, setSection] = useState<Section>('agent');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => api.getProject(slug))
      .then((p) => { if (alive) { setProject(p.project); setLoadError(null); } })
      .catch((e: unknown) => { if (alive) setLoadError(message(e)); });
    Promise.resolve().then(() => api.getCodebases(slug)).then((c) => { if (alive) setChecks(c); }).catch(() => { /* no "Not found" marks */ });
    return () => { alive = false; };
  }, [slug, tick, nonce]);

  const save = useCallback(async (patch: Partial<WorkspaceSettings>) => {
    setError(null);
    try { onSettings(await api.updateSettings(patch)); return true; }
    catch (e) { setError(t.web.app.settingsSaveFailed({ detail: message(e) })); return false; }
  }, [onSettings, t]);

  if (!project && loadError) {
    return (
      <div className="ms-set-center">
        <Empty icon="warn" title={t.web.project.loadFailed({ detail: loadError })} action={<Button onClick={() => { setLoadError(null); setNonce((n) => n + 1); }}>{s.retry}</Button>} />
      </div>
    );
  }
  if (!project) return <div className="ms-set-center"><Spinner size={20} /></div>;

  const code = <CodeCard slug={slug} linked={project.linkedCodebases} checks={checks} onLinked={(linkedCodebases) => setProject((p) => (p ? { ...p, linkedCodebases } : p))} />;
  const internet = <InternetCard settings={settings} save={save} />;
  return (
    <div className="ms-settings">
      <nav className="ms-set-nav" aria-label={s.sections}>
        <span className="ms-set-cap" title={project.name}>{project.name}</span>
        {SECTIONS.map(([id, icon]) => (
          <NavItem key={id} icon={icon} on={section === id} count={id === 'code' ? project.linkedCodebases.length : undefined} onClick={() => setSection(id)}>{s.nav[id]}</NavItem>
        ))}
      </nav>
      <SectionMain section={section}>
        {error ? <Alert>{error}</Alert> : null}
        {section === 'general' ? (
          <GeneralSection slug={slug} project={project} onSaved={(p) => setProject((x) => (x ? { ...x, ...p } : x))} />
        ) : section === 'agent' ? (
          <>
            <Head title={s.agent.title} sub={s.agent.sub} />
            <div className="ms-set-cols">
              <div className="ms-set-col">
                <AgentCard settings={settings} save={save} />
                <AllowedCard slug={slug} tick={tick} />
                <AdvancedCard settings={settings} save={save} sandbox={doctor?.find((c) => c.id === 'sandbox') ?? null} />
              </div>
              <div className="ms-set-col ms-set-side">{internet}{code}</div>
            </div>
          </>
        ) : section === 'internet' ? (
          <><Head title={s.nav.internet} /><div className="ms-set-narrow">{internet}</div></>
        ) : (
          <><Head title={s.nav.code} /><div className="ms-set-narrow">{code}</div></>
        )}
      </SectionMain>
    </div>
  );
}

function GeneralSection({ slug, project, onSaved }: { slug: string; project: { name: string; description: string }; onSaved(p: { name: string; description: string }): void }) {
  const t = useT();
  const g = t.web.projectSettings.general;
  // Seeded once (and after a save): live reloads never overwrite what is being typed.
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setStatus({ ok: false, text: g.nameRequired }); return; }
    setSaving(true);
    setStatus(null);
    try {
      const next = { name: name.trim(), description: description.trim() };
      await api.updateProject(slug, next);
      setName(next.name);
      setDescription(next.description);
      onSaved(next);
      setStatus({ ok: true, text: g.saved });
    } catch (err) {
      setStatus({ ok: false, text: g.saveFailed({ detail: message(err) }) });
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <Head title={g.title} sub={g.sub} />
      <form className="ms-set-narrow" onSubmit={(e) => void submit(e)} data-enter>
        <Card className="ms-set-form">
          <label className="ms-set-field"><span>{g.name}</span><Input value={name} maxLength={120} onChange={(e) => { setName(e.target.value); setStatus(null); }} /></label>
          <label className="ms-set-field"><span>{g.description}</span>
            <Textarea rows={4} value={description} placeholder={g.descriptionPlaceholder} onChange={(e) => { setDescription(e.target.value); setStatus(null); }} />
          </label>
          {status && !status.ok ? <p className="ms-set-error" role="alert">{status.text}</p> : null}
          <div className="ms-set-actions">
            {status?.ok ? <span className="ms-set-saved" role="status">{status.text}</span> : null}
            <Button type="submit" variant="ink" loading={saving}>{g.save}</Button>
          </div>
        </Card>
      </form>
    </>
  );
}

type Save = (patch: Partial<WorkspaceSettings>) => Promise<boolean>;

function AgentCard({ settings, save }: { settings: WorkspaceSettingsView; save: Save }) {
  const t = useT();
  const s = t.web.projectSettings;
  const n = settings.maxConcurrentJobs;
  // One save at a time: two fast clicks must not both save "n + 1" from the same n.
  const [stepping, setStepping] = useState(false);
  const step = async (next: number) => {
    setStepping(true);
    try { await save({ maxConcurrentJobs: next }); } finally { setStepping(false); }
  };
  return (
    <Card className="ms-set-card" data-enter>
      <Row title={s.agent.confirmPaid} sub={<>{s.agent.confirmPaidSub} <span className="ms-set-shared">{s.everyProject}</span></>}>
        <Toggle on={settings.confirmPaidProviders} onChange={(on) => void save({ confirmPaidProviders: on })} label={s.agent.confirmPaid} />
      </Row>
      <Row title={s.agent.jobs} sub={<>{s.agent.jobsSub} <span className="ms-set-shared">{s.everyProject}</span></>}>
        <div className="ms-stepper">
          <button type="button" aria-label={s.agent.fewer} disabled={stepping || n <= MIN_JOBS} onClick={() => void step(n - 1)}><Icon name="minus" size={12} /></button>
          <span aria-live="polite">{n}</span>
          <button type="button" aria-label={s.agent.more} disabled={stepping || n >= MAX_JOBS} onClick={() => void step(n + 1)}><Icon name="plus" size={12} /></button>
        </div>
      </Row>
    </Card>
  );
}

/** Isolation and model (from the old Security and Agent sections), with the doctor's sandbox result as before. */
function AdvancedCard({ settings, save, sandbox }: { settings: WorkspaceSettingsView; save: Save; sandbox: DoctorCheck | null }) {
  const t = useT();
  const a = t.web.projectSettings.agent;
  const [model, setModel] = useState(settings.model ?? '');
  useEffect(() => { setModel(settings.model ?? ''); }, [settings.model]);
  const commitModel = () => { const next = model.trim() || null; if (next !== settings.model) void save({ model: next }); };
  return (
    <Card className="ms-set-card" data-enter>
      <div className="ms-set-cardhead"><b>{a.advanced}</b><span className="ms-set-shared">{t.web.projectSettings.everyProject}</span></div>
      <Row title={a.isolation} sub={(
        <>
          {a.isolationSub}
          {settings.sandboxMode === 'off' ? <span className="ms-set-status ms-set-warn">{a.isolationWarning}</span>
            : sandbox?.ok ? <span className="ms-set-status ms-set-ok">{a.sandboxOn}</span>
            : <span className="ms-set-status ms-set-warn">{sandbox?.message ?? a.sandboxUnknown}</span>}
        </>
      )}>
        <Select label={a.isolation} value={settings.sandboxMode} onChange={(v) => void save({ sandboxMode: v })}
          options={[{ value: 'auto', label: a.isolationAuto }, { value: 'off', label: a.isolationOff }]} />
      </Row>
      <Row title={a.model} sub={a.modelSub}>
        <Input className="ms-set-model" value={model} placeholder={a.modelPlaceholder} aria-label={a.model}
          onChange={(e) => setModel(e.target.value)} onBlur={commitModel} onKeyDown={(e) => { if (e.key === 'Enter') commitModel(); }} />
      </Row>
    </Card>
  );
}

/** "Always allowed": the rules saved from approval cards; revoke (or revoke all) collapses with T15 and offers Undo. */
function AllowedCard({ slug, tick }: { slug: string; tick: number }) {
  const t = useT();
  const locale = useLocale();
  const a = t.web.projectSettings.allowed;
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [nonce, setNonce] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => api.getPermissions(slug))
      .then((r) => { if (alive) { setRules(r); setError(null); } })
      .catch((e: unknown) => { if (alive) setError(a.loadFailed({ detail: message(e) })); });
    return () => { alive = false; };
  }, [slug, tick, nonce, a]);
  const shown = (rules ?? []).filter((r) => !hidden.has(r.rule));

  const revoke = async (targets: Rule[]) => {
    if (!targets.length) return;
    const rows = [...(list.current?.querySelectorAll<HTMLElement>('[data-rule]') ?? [])].filter((el) => targets.some((r) => r.rule === el.dataset.rule));
    const finished = await Promise.all(rows.map((el) => collapse(el)));
    if (finished.includes(false)) return;
    const ids = targets.map((r) => r.rule);
    setHidden((h) => new Set([...h, ...ids]));
    const unhide = () => setHidden((h) => new Set([...h].filter((x) => !ids.includes(x))));
    deferRemoval({
      text: targets.length === 1 ? a.revoked({ label: targets[0]!.label || targets[0]!.rule }) : a.revokedAll({ count: targets.length }),
      undoLabel: t.web.projectSettings.undo,
      ms: UNDO_MS,
      commit: async () => {
        for (const id of ids) await api.deletePermission(slug, id);
        setRules((r) => (r ? r.filter((x) => !ids.includes(x.rule)) : r));
        unhide();
        setNonce((n) => n + 1);
      },
      restore: unhide,
      onError: (e) => { toast.show(a.revokeFailed({ detail: message(e) })); setNonce((n) => n + 1); },
    });
  };

  return (
    <Card className="ms-set-card" data-enter>
      <div className="ms-set-cardhead">
        <b>{a.title}</b>
        {shown.length ? <span className="ms-set-faint">{a.count({ count: shown.length })}</span> : null}
        {shown.length ? <Button size="sm" variant="ghost" className="ms-set-link" onClick={() => void revoke(shown)}>{a.revokeAll}</Button> : null}
      </div>
      {error ? <div className="ms-set-pad"><p className="ms-set-error" role="alert">{error}</p></div> : null}
      {!rules && !error ? <div className="ms-set-pad"><Spinner size={16} /></div> : null}
      {rules && shown.length === 0 ? <Empty icon="shield" title={a.emptyTitle} sub={a.emptySub} /> : null}
      <div ref={list}>
        {shown.map((r) => <RuleRow key={r.rule} rule={r} date={formatDate(locale, r.addedAt, { day: 'numeric', month: 'short' })} onRevoke={() => void revoke([r])} />)}
      </div>
    </Card>
  );
}

function RuleRow({ rule: r, date, onRevoke }: { rule: Rule; date: string; onRevoke(): void }) {
  const t = useT();
  const a = t.web.projectSettings.allowed;
  const ref = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  // Back from an Undo (or new): the row enters again.
  useLayoutEffect(() => { if (first.current) { first.current = false; void enter(ref.current, { y: 6 }); } }, []);
  const label = r.label || r.rule;
  return (
    <div ref={ref} className="ms-perm" data-rule={r.rule}>
      <span className="ms-perm-icon" aria-hidden="true"><Icon name={ruleIcon(r.rule)} size={13} /></span>
      <div className="ms-perm-text">
        <b>{label}</b>
        <span className="ms-perm-rule" title={r.rule}>{r.rule}</span>
      </div>
      <span className="ms-set-faint ms-perm-date">{date}</span>
      <Button size="sm" aria-label={a.revokeLabel({ label })} onClick={onRevoke}>{a.revoke}</Button>
    </div>
  );
}

function InternetCard({ settings, save }: { settings: WorkspaceSettingsView; save: Save }) {
  const t = useT();
  const s = t.web.projectSettings;
  const n = s.internet;
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const domains = settings.extraAllowedDomains;
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    const d = normalizeDomain(text);
    if (!d) { setError(n.invalid); return; }
    if (domains.includes(d)) { setError(n.exists); return; }
    setError(null);
    if (await save({ extraAllowedDomains: [...domains, d] })) setText('');
  };
  return (
    <Card className="ms-set-card ms-set-pad ms-set-stack" data-enter>
      <div className="ms-set-cardhead ms-set-flat"><b>{n.title}</b><span className="ms-set-shared">{s.everyProject}</span></div>
      <span className="ms-set-sub">{n.sub}</span>
      <span className="ms-set-faint ms-set-small">{n.defaults}</span>
      {settings.droppedDomains?.length ? <p className="ms-set-warn" role="status">{n.dropped({ list: settings.droppedDomains.join(', ') })}</p> : null}
      <div className="ms-set-domains">
        {domains.length === 0 ? <span className="ms-set-faint ms-set-small">{n.none}</span> : null}
        {domains.map((d) => (
          <span key={d} className="ms-domain">
            <span className="ms-domain-name" title={d}>{d}</span>
            <button type="button" aria-label={n.remove({ domain: d })} onClick={() => void save({ extraAllowedDomains: domains.filter((x) => x !== d) })}><Icon name="close" size={9} /></button>
          </span>
        ))}
      </div>
      <form className="ms-set-inline" onSubmit={(e) => void add(e)}>
        <Input value={text} onChange={(e) => { setText(e.target.value); setError(null); }} placeholder={n.placeholder} aria-label={n.addLabel} aria-invalid={error ? true : undefined} />
        <Button type="submit" size="sm" variant="ink" disabled={!text.trim()}>{n.add}</Button>
      </form>
      {error ? <p className="ms-set-error" role="alert">{error}</p> : null}
    </Card>
  );
}

/** Linked code: read-only folders the agent can read. Linking and unlinking save at once; unlinking offers Undo. */
function CodeCard({ slug, linked, checks, onLinked }: { slug: string; linked: LinkedCodebase[]; checks: CodebaseCheck[]; onLinked(next: LinkedCodebase[]): void }) {
  const t = useT();
  const c = t.web.projectSettings.code;
  const bridge = desktop();
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const current = useRef(linked);
  current.current = linked;
  const form = useRef<HTMLFormElement>(null);
  useLayoutEffect(() => { if (adding) void enter(form.current, { y: -6 }); }, [adding]);

  const store = async (next: LinkedCodebase[]): Promise<boolean> => {
    try { await api.updateProject(slug, { linkedCodebases: next }); onLinked(next); return true; }
    catch (e) { setError(c.saveFailed({ detail: message(e) })); return false; }
  };
  const link = async (raw: string, rawNote = '') => {
    const p = raw.trim();
    if (!p || !(p.startsWith('/') || p.startsWith('~'))) { setError(c.needAbsolute); return; }
    if (current.current.some((x) => x.path === p)) { setError(c.alreadyLinked); return; }
    setError(null);
    const entry: LinkedCodebase = rawNote.trim() ? { path: p, note: rawNote.trim() } : { path: p };
    if (await store([...current.current, entry])) { setPath(''); setNote(''); setAdding(false); }
  };
  const start = async () => {
    if (!bridge) { setAdding(true); return; }
    try { const picked = await bridge.pickFolder(c.pickTitle); if (picked) await link(picked); }
    catch (e) { setError(message(e)); }
  };
  const unlink = async (cb: LinkedCodebase) => {
    const before = current.current;
    if (!(await store(before.filter((x) => x.path !== cb.path)))) return;
    toast.show(c.unlinked({ name: cb.path.split('/').filter(Boolean).pop() ?? cb.path }), {
      action: { label: t.web.projectSettings.undo, run: () => { void store(before); } },
    });
  };
  const saveNote = (cb: LinkedCodebase, value: string) => {
    const v = value.trim();
    if ((cb.note ?? '') === v) return;
    void store(current.current.map((x) => (x.path === cb.path ? (v ? { path: x.path, note: v } : { path: x.path }) : x)));
  };

  return (
    <Card className="ms-set-card ms-set-pad ms-set-stack" data-enter>
      <div className="ms-set-cardhead ms-set-flat"><b>{c.title}</b></div>
      <span className="ms-set-sub">{c.sub}</span>
      {linked.length === 0 ? <span className="ms-set-faint ms-set-small">{c.empty}</span> : null}
      {linked.map((cb) => {
        const missing = checks.find((x) => x.path === cb.path)?.exists === false;
        return (
          <div key={cb.path} className="ms-code">
            <span className="ms-code-icon" aria-hidden="true"><Icon name="code" size={13} /></span>
            <div className="ms-code-text">
              <b title={cb.path}>{cb.path.split('/').filter(Boolean).pop() ?? cb.path}</b>
              <span className="ms-code-path">{cb.path}</span>
              <NoteInput note={cb.note ?? ''} placeholder={c.notePlaceholder} label={c.noteFor({ path: cb.path })} onSave={(v) => saveNote(cb, v)} />
            </div>
            {missing ? <Pill tone="warn">{c.notFound}</Pill> : <Tag>{c.readOnly}</Tag>}
            <Button size="sm" variant="ghost" icon aria-label={c.unlink({ path: cb.path })} title={c.unlink({ path: cb.path })} onClick={() => void unlink(cb)}><Icon name="close" size={11} /></Button>
          </div>
        );
      })}
      {adding ? (
        <form ref={form} className="ms-code-form" onSubmit={(e) => { e.preventDefault(); void link(path, note); }}>
          <Input autoFocus value={path} onChange={(e) => { setPath(e.target.value); setError(null); }} placeholder={c.pathPlaceholder} aria-label={c.pathLabel} className="ms-set-mono" />
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={c.notePlaceholder} aria-label={c.notePlaceholder} />
          <div className="ms-set-inline">
            <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setError(null); }}>{c.cancel}</Button>
            <Button type="submit" size="sm" variant="ink" disabled={!path.trim()}>{c.add}</Button>
          </div>
        </form>
      ) : (
        <Button size="sm" variant="outline" className={cx('ms-code-add')} onClick={() => void start()}><Icon name="plus" size={12} />{c.link}</Button>
      )}
      {error ? <p className="ms-set-error" role="alert">{error}</p> : null}
    </Card>
  );
}

/** A linked folder's note: follows live changes, except while it is being edited (the draft wins until it is saved). */
function NoteInput({ note, placeholder, label, onSave }: { note: string; placeholder: string; label: string; onSave(value: string): void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input className="ms-code-note" value={draft ?? note} placeholder={placeholder} aria-label={label}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (draft !== null) onSave(draft); setDraft(null); }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setDraft(null); e.currentTarget.blur(); } }} />
  );
}
