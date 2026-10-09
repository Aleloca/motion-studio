import { LOCALES, type DoctorCheck, type LanguageSetting, type Locale, type ProviderId, type SecretStatus, type WorkspaceSettings, type WorkspaceSettingsView } from '@motion-studio/shared';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { api } from '../api.ts';
import { useT, type LanguageState } from '../i18n.tsx';
import { enter } from '../motion/index.ts';
import { href, type SettingsSection } from '../routes.ts';
import { notifyApprovalsEnabled, notifyReadyEnabled, setNotifyApprovals, setNotifyReady } from '../shell/notify.ts';
import { go } from '../shell/ShellContext.tsx';
import type { Theme } from '../theme.ts';
import { desktop } from '../desktop.ts';
import { Button, Card, Icon, Input, Select, Spinner, Toggle, cx, toast } from '../ui/index.ts';
import { rovingIndex } from '../ui/roving.ts';
import { Alert, Head, Row, SectionMain, message } from './common.tsx';
import { SystemChecks } from './Welcome.tsx';
import './settings.css';

const SECTIONS: readonly SettingsSection[] = ['general', 'system', 'paid', 'notifications', 'updates'];
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
 * (keys in the Keychain, "Save"), Notifications and Updates. Usage arrives with Phase 8; the old expert mode
 * is gone (spec §3.2).
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
      </Card>
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
