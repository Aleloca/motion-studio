import { LOCALES, shownTotal, type DoctorCheck, type LanguageSetting, type Locale, type ProviderId, type SecretStatus, type UsageReport, type WorkspaceSettings, type WorkspaceSettingsView } from '@motion-studio/shared';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { api } from '../api.ts';
import { formatDate, useLocale, useT, type LanguageState } from '../i18n.tsx';
import { anim, D, E, enter } from '../motion/index.ts';
import { href, type SettingsSection } from '../routes.ts';
import { notificationStatus, notifyApprovalsEnabled, notifyReadyEnabled, notifySoundEnabled, sendNotification, setNotifyApprovals, setNotifyReady, setNotifySound, type NotificationStatus } from '../shell/notify.ts';
import { go } from '../shell/ShellContext.tsx';
import { billingNote, costText, formatTokens } from '../shell/Tokens.tsx';
import type { Theme } from '../theme.ts';
import { desktop } from '../desktop.ts';
import { Button, Card, Empty, Icon, Input, Select, Spinner, Toggle, cx, toast } from '../ui/index.ts';
import { rovingIndex } from '../ui/roving.ts';
import { Alert, Head, Row, SectionMain, message } from './common.tsx';
import { SystemChecks } from './Welcome.tsx';
import './settings.css';

const SECTIONS: readonly SettingsSection[] = ['general', 'system', 'paid', 'usage', 'notifications', 'updates'];
/** Provider, display name, the environment variable that overrides the Keychain, and the mark's letters. */
const PROVIDERS: ReadonlyArray<[ProviderId, string, string, string]> = [
  ['openai', 'OpenAI', 'OPENAI_API_KEY', 'AI'],
  ['elevenlabs', 'ElevenLabs', 'ELEVENLABS_API_KEY', '11'],
  ['pexels', 'Pexels', 'PEXELS_API_KEY', 'Px'],
  ['unsplash', 'Unsplash', 'UNSPLASH_ACCESS_KEY', 'Un'],
];
const THEMES: readonly Theme[] = ['system', 'light', 'dark'];

export interface AppSettingsProps {
  section: SettingsSection;
  settings: WorkspaceSettingsView;
  checks: DoctorCheck[] | null;
  checking: boolean;
  /** Completed doctor runs: a recheck reveals the rows again. */
  checksRun: number;
  loadError: string | null;
  onRecheck(): void;
  language: LanguageSetting;
  systemLocale: Locale;
  onLanguage(next: LanguageState): void;
  onSettings(next: WorkspaceSettings): void;
}

/**
 * App settings (spec §6.2 #13, visual test point 1), ported from the prototype's AppSettingsPage and the AppSettings
 * boards: General (language, theme with previews), System check (the full doctor with "Check again"), Paid services
 * (keys in the Keychain, "Save"), Usage (Phase 8, spec §5.4), Notifications and Updates. The old expert mode is gone
 * (spec §3.2).
 */
export function AppSettings(props: AppSettingsProps) {
  const { section, checks, checking } = props;
  const t = useT();
  const s = t.web.appSettings;
  const [secrets, setSecrets] = useState<SecretStatus[] | null>(null);
  const [secretsError, setSecretsError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api.getSecrets().then((x) => { if (alive) setSecrets(x); }).catch((e: unknown) => { if (alive) setSecretsError(s.paid.loadFailed({ detail: message(e) })); });
    return () => { alive = false; };
  }, [s]);
  const configured = secrets?.filter((x) => x.configured).length;
  const failing = checks?.filter((c) => !c.ok && c.required).length ?? 0;
  const dot = checking || !checks ? 'ms-busy' : failing ? 'ms-warn' : '';

  const trailing: Partial<Record<SettingsSection, ReactNode>> = {
    system: <span className={cx('ms-set-dot', dot)} aria-hidden="true" />,
    paid: configured !== undefined ? <span className="ms-n">{s.configured({ n: configured, total: PROVIDERS.length })}</span> : null,
    updates: <span className="ms-n ms-set-mono">{__APP_VERSION__}</span>,
  };
  return (
    <div className="ms-settings">
      <nav className="ms-set-nav" aria-label={s.sections}>
        <span className="ms-set-cap">{s.appName}</span>
        {SECTIONS.map((id) => (
          <button key={id} type="button" className={cx('ms-navitem', section === id && 'ms-on')} aria-current={section === id ? 'page' : undefined} onClick={() => go(href.settings(id))}>
            <span className="ms-navitem-label">{s.nav[id]}</span>
            {trailing[id] ?? null}
          </button>
        ))}
      </nav>
      <SectionMain section={section}>
        {section === 'general' ? <General {...props} />
          : section === 'system' ? <System {...props} />
          : section === 'paid' ? <Paid secrets={secrets} error={secretsError} onChange={(next) => setSecrets((all) => (all ?? []).map((x) => (x.provider === next.provider ? next : x)))} reload={setSecrets} />
          : section === 'usage' ? <Usage />
          : section === 'notifications' ? <Notifications />
          : <Updates />}
      </SectionMain>
    </div>
  );
}

function General({ settings, checks, checking, loadError, onRecheck, language, systemLocale, onLanguage, onSettings }: AppSettingsProps) {
  const t = useT();
  const s = t.web.appSettings;
  const [error, setError] = useState<string | null>(null);
  const choose = async (setting: LanguageSetting) => {
    setError(null);
    try { const r = await api.setLanguage(setting); onLanguage({ locale: r.locale, setting: r.languageSetting, systemLocale: r.systemLocale }); }
    catch (e) { setError(t.web.settings.languageFailed({ detail: message(e) })); }
  };
  const theme = async (next: Theme) => {
    setError(null);
    try { onSettings(await api.updateSettings({ theme: next })); }
    catch (e) { setError(t.web.app.settingsSaveFailed({ detail: message(e) })); }
  };
  const options = [
    { value: 'system' as LanguageSetting, label: t.web.settings.languageSystem({ detected: t.web.settings.languageNames[systemLocale] }) },
    ...LOCALES.map((l) => ({ value: l as LanguageSetting, label: t.web.settings.languageNames[l] })),
  ];
  return (
    <>
      {error ? <Alert>{error}</Alert> : null}
      <div className="ms-set-cols ms-wide-side">
        <div className="ms-set-col">
          <Head title={s.general.title} sub={s.appliesAll} />
          <Card className="ms-set-card" data-enter>
            <Row title={s.general.language} sub={s.general.languageSub}>
              <Select label={s.general.language} value={language} options={options} onChange={(v) => void choose(v)} />
            </Row>
            <Row title={s.general.theme} sub={s.general.themeSub}>
              <ThemePicker value={settings.theme} onChange={(v) => void theme(v)} />
            </Row>
          </Card>
          <p className="ms-set-faint ms-set-small ms-set-pointer" data-enter><Icon name="gear" size={12} />{s.general.agentPointer}</p>
        </div>
        <div className="ms-set-col ms-set-side-top">
          <StatusCard checks={checks} checking={checking} loadError={loadError} onRecheck={onRecheck} />
        </div>
      </div>
    </>
  );
}

/** System / Light / Dark with previews: a radio group with roving focus (arrows choose, as in a native group). */
function ThemePicker({ value, onChange }: { value: Theme; onChange(v: Theme): void }) {
  const t = useT();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const current = Math.max(0, THEMES.indexOf(value));
  const onKey = (e: KeyboardEvent) => {
    const next = rovingIndex(e.key, current, THEMES.length);
    if (next === null) return;
    e.preventDefault();
    refs.current[next]?.focus();
    onChange(THEMES[next]!);
  };
  return (
    <div role="radiogroup" aria-label={t.web.theme.aria} className="ms-theme-group" onKeyDown={onKey}>
      {THEMES.map((id, i) => (
        <button key={id} ref={(el) => { refs.current[i] = el; }} type="button" role="radio" aria-checked={value === id} tabIndex={value === id ? 0 : -1}
          className="ms-theme-opt" onClick={() => { if (value !== id) onChange(id); }}>
          <span className="ms-theme-preview" aria-hidden="true">
            {id === 'system' ? <><span className="ms-theme-light" /><span className="ms-theme-dark" /></> : <span className={id === 'light' ? 'ms-theme-light' : 'ms-theme-dark'} />}
          </span>
          {t.web.theme[id]}
        </button>
      ))}
    </div>
  );
}

/** The doctor in one line (General): everything works, or how many problems, with "Check again". */
function StatusCard({ checks, checking, loadError, onRecheck }: Pick<AppSettingsProps, 'checks' | 'checking' | 'loadError' | 'onRecheck'>) {
  const t = useT();
  const st = t.web.appSettings.status;
  const problems = checks?.filter((c) => !c.ok && c.required) ?? [];
  const notes = checks?.filter((c) => !c.ok && !c.required) ?? [];
  const busy = checking || (!checks && !loadError);
  const title = busy ? st.checking : loadError ? t.web.welcome.serverUnreachable({ detail: loadError }) : problems.length ? st.problems({ count: problems.length }) : notes.length ? st.notes({ count: notes.length }) : st.ok;
  const line = (checks ?? []).map((c) => (c.ok ? `${c.label}${c.version ? ` ${c.version}` : ''}` : null)).filter(Boolean).join(' · ');
  return (
    <Card className="ms-status" data-enter>
      <div className="ms-status-head">
        <span className={cx('ms-status-mark', busy ? 'ms-busy' : (problems.length > 0 || Boolean(loadError)) && 'ms-warn')} aria-hidden="true">
          {busy ? <Spinner decorative size={12} /> : <Icon name={problems.length > 0 || loadError ? 'warn' : 'check'} size={10} strokeWidth={2.4} />}
        </span>
        <b>{title}</b>
        <Button size="sm" variant="ghost" disabled={checking} onClick={onRecheck}>{st.checkAgain}</Button>
      </div>
      {problems[0] ? <span className="ms-status-line">{problems[0].label}: {problems[0].message}</span> : null}
      {line ? <span className="ms-status-line">{line}</span> : null}
      <button type="button" className="ms-blink" onClick={() => go(href.settings('system'))}>{st.details}</button>
    </Card>
  );
}

function System({ checks, checking, checksRun, loadError, onRecheck }: AppSettingsProps) {
  const t = useT();
  const s = t.web.appSettings;
  // The rows on screen at the first visit show at once; a recheck reveals them one by one (as in the setup).
  const revealedRun = useRef<number | null>(checksRun);
  return (
    <div className="ms-set-narrow">
      <Head title={s.system.title} sub={s.system.sub}>
        <Button variant="outline" disabled={checking} onClick={onRecheck}>
          {checking ? <Spinner decorative size={14} /> : <Icon name="refresh" size={14} />}{s.status.checkAgain}
        </Button>
      </Head>
      <Card className="ms-syscard" data-enter>
        <SystemChecks checks={checks} checking={checking} run={checksRun} revealedRun={revealedRun} loadError={loadError} onRecheck={onRecheck} />
      </Card>
    </div>
  );
}

function Paid({ secrets, error, onChange, reload }: { secrets: SecretStatus[] | null; error: string | null; onChange(next: SecretStatus): void; reload(all: SecretStatus[]): void }) {
  const t = useT();
  const p = t.web.appSettings.paid;
  return (
    <div className="ms-set-narrow">
      <Head title={p.title} sub={p.sub} />
      {error ? <Alert>{error}</Alert> : null}
      <Card className="ms-set-card" data-enter>
        {!secrets && !error ? <div className="ms-set-pad"><Spinner size={16} /></div> : null}
        {secrets ? PROVIDERS.map(([id, name, env, mark]) => (
          <KeyRow key={id} id={id} name={name} env={env} mark={mark} status={secrets.find((x) => x.provider === id)} onChange={onChange} reload={reload} />
        )) : null}
      </Card>
    </div>
  );
}

function KeyRow({ id, name, env, mark, status, onChange, reload }: { id: ProviderId; name: string; env: string; mark: string; status?: SecretStatus; onChange(s: SecretStatus): void; reload(all: SecretStatus[]): void }) {
  const t = useT();
  const p = t.web.appSettings.paid;
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => { if (open) void enter(form.current, { y: -6 }); }, [open]);
  // Removing a key cannot be undone (the Keychain keeps no copy): it asks first, inline.
  const [confirming, setConfirming] = useState(false);
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (confirming) keep.current?.focus(); }, [confirming]);
  const fromEnv = status?.source === 'env';
  const inKeychain = status?.source === 'keychain';

  // Save: the key goes to the Keychain, then the status is read back to check it is really stored there (the core has
  // no way to test a key against the provider).
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      onChange(await api.setSecret(id, value.trim()));
      const all = await api.getSecrets();
      reload(all);
      if (!all.find((x) => x.provider === id)?.configured) { setError(p.notStored); return; }
      setValue('');
      setOpen(false);
      toast.show(p.saved({ name }), { tone: 'ok' });
    } catch (err) {
      setError(p.failed({ detail: message(err) }));
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    setConfirming(false);
    setError(null);
    try { onChange(await api.deleteSecret(id)); toast.show(p.removed({ name })); }
    catch (err) { setError(p.removeFailed({ detail: message(err) })); }
  };

  return (
    <div className="ms-key">
      <div className="ms-key-row">
        <span className={cx('ms-key-mark', !status?.configured && 'ms-off')} aria-hidden="true">{mark}</span>
        <div className="ms-key-text">
          <b><span>{name}</span> <span className="ms-set-faint">· {p.uses[id]}</span></b>
          {fromEnv ? <span>{p.fromEnv({ env })}</span> : inKeychain ? <span className="ms-ok">{p.inKeychain}</span> : <span>{p.notConnected}</span>}
        </div>
        {fromEnv ? null : (
          <div className="ms-key-actions">
            {inKeychain && confirming ? (
              <span className="ms-key-confirm" role="group" aria-label={p.removeConfirm({ name })}>
                <span>{p.removeConfirm({ name })}</span>
                <Button size="sm" variant="danger" onClick={() => void remove()}>{p.remove}</Button>
                <Button ref={keep} size="sm" variant="ghost" onClick={() => setConfirming(false)}>{p.cancel}</Button>
              </span>
            ) : inKeychain ? (
              <>
                <Button size="sm" aria-label={p.replaceLabel({ name })} onClick={() => { setOpen(true); setValue(''); }}>{p.replace}</Button>
                <Button size="sm" variant="ghost" aria-label={p.removeLabel({ name })} onClick={() => { setOpen(false); setConfirming(true); }}>{p.remove}</Button>
              </>
            ) : open ? null : (
              <Button size="sm" variant="ink" onClick={() => { setOpen(true); setValue(''); }}>{p.addKey}</Button>
            )}
          </div>
        )}
      </div>
      {open && !fromEnv ? (
        <form ref={form} className="ms-key-form" onSubmit={(e) => void save(e)}>
          <Input type="password" autoFocus autoComplete="off" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)}
            placeholder={p.keyPlaceholder} aria-label={p.keyLabel({ name })} />
          <Button size="sm" variant="ghost" onClick={() => { setOpen(false); setValue(''); setError(null); }}>{p.cancel}</Button>
          <Button type="submit" size="sm" variant="ink" loading={saving} disabled={!value.trim() || saving}>{saving ? p.saving : p.save}</Button>
        </form>
      ) : null}
      {error ? <p className="ms-set-error" role="alert">{error}</p> : null}
    </div>
  );
}

function Notifications() {
  const t = useT();
  const s = t.web.appSettings;
  const n = s.notifications;
  const [approvals, setApprovals] = useState(notifyApprovalsEnabled);
  const [ready, setReady] = useState(notifyReadyEnabled);
  const [sound, setSound] = useState(notifySoundEnabled);
  const [status, setStatus] = useState<NotificationStatus | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: true } | { ok: false; detail: string } | null>(null);
  const refresh = () => { void notificationStatus().then(setStatus); };
  useEffect(() => { refresh(); }, []);
  const askWeb = () => {
    const done = () => refresh();
    void Promise.resolve(Notification.requestPermission(done)).then(done, () => {});
  };
  const sendTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      await sendNotification({ title: t.web.app.approvalNotificationTitle, body: n.testButton });
      setTest({ ok: true });
    } catch (e) {
      const m = e instanceof Error ? e.message : '';
      setTest({ ok: false, detail: m === 'denied' ? n.webDenied : m === 'default' ? n.webDefault : m === 'unsupported' ? n.webUnsupported : m || n.unsupported });
    } finally { setTesting(false); refresh(); }
  };
  const problem = status === 'unsupported' ? (desktop() ? n.unsupported : n.webUnsupported) : status === 'denied' ? n.webDenied : status === 'default' ? n.webDefault : null;
  return (
    <div className="ms-set-narrow">
      <Head title={n.title} sub={s.appliesAll} />
      <Card className="ms-set-card" data-enter>
        <Row title={n.approvals} sub={n.approvalsSub}>
          <Toggle on={approvals} label={n.approvalsLabel} onChange={(on) => { setNotifyApprovals(on); setApprovals(on); }} />
        </Row>
        <Row title={n.ready} sub={n.readySub}>
          <Toggle on={ready} label={n.readyLabel} onChange={(on) => { setNotifyReady(on); setReady(on); }} />
        </Row>
        <Row title={n.sound} sub={n.soundSub}>
          <Toggle on={sound} label={n.soundLabel} onChange={(on) => { setNotifySound(on); setSound(on); }} />
        </Row>
        <Row title={n.test} sub={n.testSub}>
          <Button variant="outline" disabled={testing} onClick={() => { void sendTest(); }}>{n.testButton}</Button>
        </Row>
      </Card>
      {problem ? (
        <Alert action={status === 'default' && !desktop() ? <Button size="sm" variant="outline" onClick={askWeb}>{n.webAllow}</Button> : undefined}>{problem}</Alert>
      ) : null}
      {test?.ok === false ? <p className="ms-set-error" role="alert">{n.testFailed({ detail: test.detail })}</p> : null}
      {test?.ok === true ? <p className="ms-set-sub ms-set-small" role="status">{n.testSent}</p> : null}
      {desktop() ? <p className="ms-set-faint">{n.howTo}</p> : null}
    </div>
  );
}

/**
 * The version and how updates arrive: the desktop bridge exposes no updater status, so this page neither claims the app
 * is up to date nor offers a check it cannot run.
 */
function Updates() {
  const t = useT();
  const u = t.web.appSettings.updates;
  return (
    <div className="ms-set-narrow">
      <Head title={u.title} />
      <Card className="ms-set-card" data-enter>
        {/* How updates arrive is a desktop fact; in a browser the page shows only the version. */}
        <Row title={u.version({ version: __APP_VERSION__ })} sub={desktop() ? u.automatic : undefined} />
      </Card>
    </div>
  );
}

/** "2026-10-09" (a local day of the core) as a date at noon UTC, formatted in UTC: the weekday never shifts. */
const dayDate = (day: string) => `${day}T12:00:00.000Z`;

/**
 * Settings → Usage (spec §5.4, prototype `UsageCard`): the last 7 days of the core as bars (today in accent, scaled to
 * the busiest day, an empty day as a hairline) with a table for screen readers, the week total, the rows by project and
 * by kind of work (tokens first, cost second, "≥" when part of the cost is unknown), the billing note and the start of
 * tracking. Nothing is invented: before the first record there is only the empty state, and rows with no tokens are
 * left out.
 */
function Usage() {
  const t = useT();
  const s = t.web.appSettings.usage;
  const [state, setState] = useState<{ report: UsageReport | null; error: string | null }>({ report: null, error: null });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    api.getUsage()
      .then((report) => { if (alive) setState({ report, error: null }); })
      .catch((e: unknown) => { if (alive) setState({ report: null, error: message(e) }); });
    return () => { alive = false; };
  }, [nonce]);
  const { report, error } = state;
  return (
    <div className="ms-set-narrow ms-usage">
      <Head title={s.title} sub={s.sub} />
      {error ? (
        <Alert action={<Button size="sm" variant="outline" onClick={() => { setState({ report: null, error: null }); setNonce((n) => n + 1); }}>{s.tryAgain}</Button>}>
          {s.loadFailed({ detail: error })}
        </Alert>
      ) : !report ? (
        <Card className="ms-set-card" data-enter><div className="ms-set-pad ms-set-inline" role="status"><Spinner decorative size={14} />{s.loading}</div></Card>
      ) : report.trackedSince === null ? (
        <Card className="ms-set-card" data-enter><Empty icon="sparkle" title={s.empty} sub={s.emptySub} /></Card>
      ) : (
        <UsageCard report={report} />
      )}
    </div>
  );
}

function UsageCard({ report }: { report: UsageReport }) {
  const t = useT();
  const s = t.web.appSettings.usage;
  const u = t.web.usage;
  const locale = useLocale();
  const tokens = (n: number) => u.tokens({ count: formatTokens(locale, n) });
  // Today in the core's time zone, which buckets the days.
  const today = new Date(Date.now() + report.utcOffsetMinutes * 60_000).toISOString().slice(0, 10);
  const max = Math.max(0, ...report.byDay.map((d) => d.tokens));
  const short = (day: string) => (day === today ? s.today : formatDate(locale, dayDate(day), { weekday: 'short', timeZone: 'UTC' }));
  const long = (day: string) => (day === today ? s.today : formatDate(locale, dayDate(day), { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }));
  const bars = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bars.current?.querySelectorAll('.ms-usage-bar').forEach((el, i) => { void anim(el, [{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }], D.l, E.out, i * 40); });
  }, []);
  const total = report.total;
  const estimated = total.estimated === true;
  const note = billingNote(t, locale, report.billing, total.costUsd, estimated);
  const projects = report.byProject.filter((p) => p.tokens > 0);
  const kinds = report.byKind.filter((k) => k.tokens > 0);
  const row = (key: string, label: string, n: number, cost: number | null, est?: boolean) => {
    const c = costText(t, locale, cost, est === true);
    return (
      <li key={key} className="ms-usage-row">
        <span className="ms-usage-name">{label}</span>
        <span className="ms-usage-num">{tokens(n)}</span>
        {c ? <span className="ms-usage-cost">{c}</span> : null}
      </li>
    );
  };
  return (
    <Card className="ms-usage-card" data-enter>
      <div className="ms-usage-head">
        <b>{s.week}</b>
        <span className="ms-usage-total">{tokens(shownTotal(total.tokens))}</span>
      </div>
      <div ref={bars} className="ms-usage-bars" aria-hidden="true">
        {report.byDay.map((d) => (
          <div key={d.day} className="ms-usage-col" title={s.barTitle({ day: long(d.day), count: formatTokens(locale, d.tokens) })}>
            {d.day === today && d.tokens > 0 ? <span className="ms-usage-val">{formatTokens(locale, d.tokens)}</span> : null}
            <span data-day={d.day} className={cx('ms-usage-bar', d.tokens === 0 && 'ms-zero', d.day === today && 'ms-today')}
              style={d.tokens > 0 && max > 0 ? { height: `${(d.tokens / max) * 100}%` } : undefined} />
          </div>
        ))}
      </div>
      <div className="ms-usage-days" aria-hidden="true">
        {report.byDay.map((d) => <span key={d.day} className={cx(d.day === today && 'ms-today')}>{short(d.day)}</span>)}
      </div>
      <table className="ms-sr" aria-label={s.chart}>
        <thead><tr><th scope="col">{s.day}</th><th scope="col">{s.tokens}</th></tr></thead>
        <tbody>
          {report.byDay.map((d) => <tr key={d.day}><th scope="row">{long(d.day)}</th><td>{formatTokens(locale, d.tokens)}</td></tr>)}
        </tbody>
      </table>
      {projects.length || kinds.length ? (
        <div className="ms-usage-groups">
          {projects.length ? (
            <div className="ms-usage-group">
              <span className="ms-usage-cap" id="ms-usage-projects">{s.byProject}</span>
              <ul aria-labelledby="ms-usage-projects">{projects.map((p) => row(p.slug, p.name, p.tokens, p.costUsd, p.estimated))}</ul>
            </div>
          ) : null}
          {kinds.length ? (
            <div className="ms-usage-group">
              <span className="ms-usage-cap" id="ms-usage-kinds">{s.byKind}</span>
              <ul aria-labelledby="ms-usage-kinds">{kinds.map((k) => row(k.kind, s.kinds[k.kind], k.tokens, k.costUsd, k.estimated))}</ul>
            </div>
          ) : null}
        </div>
      ) : <p className="ms-usage-note">{s.none}</p>}
      {note ? <p className="ms-usage-billing">{note}</p> : null}
      {estimated && total.costUsd !== null ? <p className="ms-usage-note">{u.costUnknown}</p> : null}
      <p className="ms-usage-note">{s.trackedSince({ date: formatDate(locale, report.trackedSince!, { dateStyle: 'medium' }) })}</p>
    </Card>
  );
}
