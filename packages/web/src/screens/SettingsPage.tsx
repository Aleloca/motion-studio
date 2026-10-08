import { LOCALES, type DoctorCheck, type LanguageSetting, type Locale, type ProviderId, type SecretStatus, type WorkspaceSettings, type WorkspaceSettingsView } from '@motion-studio/shared';
import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { useT, type LanguageState } from '../i18n.tsx';

const PROVIDERS: Array<[ProviderId, string, string]> = [['openai', 'OpenAI', 'OPENAI_API_KEY'], ['elevenlabs', 'ElevenLabs', 'ELEVENLABS_API_KEY'], ['pexels', 'Pexels', 'PEXELS_API_KEY'], ['unsplash', 'Unsplash', 'UNSPLASH_ACCESS_KEY']];
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function KeyRow({ id, label, env, status, onChange }: { id: ProviderId; label: string; env: string; status?: SecretStatus; onChange(s: SecretStatus): void }) {
  const t = useT();
  const s = t.web.settingsUi;
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fromEnv = status?.source === 'env';
  const run = async (fn: () => Promise<SecretStatus>) => { setError(null); try { onChange(await fn()); setValue(''); } catch (e) { setError(msg(e)); } };
  return (
    <div className="row" style={{ gap: 8 }}>
      <strong style={{ width: 110 }}>{label}</strong>
      <span className={`badge ${status?.configured ? 'ok' : ''}`}>{fromEnv ? s.fromEnv : status?.configured ? s.inKeychain : s.notConfigured}</span>
      <input type="password" autoComplete="off" aria-label={s.newKey({ label })} value={value} disabled={fromEnv} onChange={(e) => setValue(e.target.value)} style={{ flex: '1 1 220px', width: 'auto' }} />
      <button type="button" aria-label={s.saveKey({ label })} disabled={fromEnv || !value.trim()} onClick={() => void run(() => api.setSecret(id, value))}>{t.common.save}</button>
      {status?.source === 'keychain' && <button type="button" aria-label={s.removeKey({ label })} onClick={() => void run(() => api.deleteSecret(id))}>{t.web.common.remove}</button>}
      {fromEnv && <span className="muted" style={{ fontSize: 12 }}>{s.managedBy({ env })}</span>}
      {error && <p role="alert" className="error" style={{ margin: 0, flexBasis: '100%' }}>{error}</p>}
    </div>
  );
}

function LanguageSelector({ value, systemLocale, onChange }: { value: LanguageSetting; systemLocale: Locale; onChange(next: LanguageState): void }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const options: Array<[LanguageSetting, string]> = [['system', t.web.settings.languageSystem({ detected: t.web.settings.languageNames[systemLocale] })], ...LOCALES.map((l): [LanguageSetting, string] => [l, t.web.settings.languageNames[l]])];
  const choose = async (setting: LanguageSetting) => {
    setError(null);
    try { const r = await api.setLanguage(setting); onChange({ locale: r.locale, setting: r.languageSetting, systemLocale: r.systemLocale }); }
    catch (e) { setError(t.web.settings.languageFailed({ detail: msg(e) })); }
  };
  return (
    <section className="card stack" aria-label={t.web.settings.language}>
      <h2 style={{ margin: 0, fontSize: 17 }}>{t.web.settings.language}</h2>
      <div role="radiogroup" aria-label={t.web.settings.language} className="row" style={{ gap: 4 }}>
        {options.map(([id, label]) => (
          <button key={id} type="button" role="radio" aria-checked={value === id} className={value === id ? 'primary' : ''} onClick={() => void choose(id)}>{label}</button>
        ))}
      </div>
      {error && <p role="alert" className="error" style={{ margin: 0 }}>{error}</p>}
    </section>
  );
}

export function SettingsPage({ settings, checks, language, systemLocale, onLanguage, onSaved }: { settings: WorkspaceSettingsView; checks: DoctorCheck[] | null; language: LanguageSetting; systemLocale: Locale; onLanguage(next: LanguageState): void; onSaved(next: WorkspaceSettings): void }) {
  const t = useT();
  const s = t.web.settingsUi;
  const [secrets, setSecrets] = useState<SecretStatus[]>([]);
  const [domain, setDomain] = useState('');
  const [model, setModel] = useState(settings.model ?? '');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.getSecrets().then(setSecrets).catch((e: unknown) => setError(msg(e))); }, []);
  const save = async (patch: Partial<WorkspaceSettings>): Promise<boolean> => { setError(null); try { onSaved(await api.updateSettings(patch)); return true; } catch (e) { setError(msg(e)); return false; } };
  const sandbox = checks?.find((c) => c.id === 'sandbox');
  return (
    <main className="page stack" style={{ maxWidth: 900 }}>
      <h1 style={{ margin: 0, fontSize: 24 }}>{s.title}</h1>
      {error && <p role="alert" className="error">{error}</p>}
      <LanguageSelector value={language} systemLocale={systemLocale} onChange={onLanguage} />
      <section className="card stack" aria-label={s.providerKeys}>
        <h2 style={{ margin: 0, fontSize: 17 }}>{s.providerKeys}</h2>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>{s.keysNote}</p>
        {PROVIDERS.map(([id, label, env]) => (
          <KeyRow key={id} id={id} label={label} env={env} status={secrets.find((s) => s.provider === id)} onChange={(s) => setSecrets((all) => all.map((x) => (x.provider === s.provider ? s : x)))} />
        ))}
        <div className="row" style={{ gap: 8 }}><strong style={{ width: 110 }}>Google Fonts</strong><span className="muted">{s.noKeyNeeded}</span></div>
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" checked={settings.confirmPaidProviders} onChange={(e) => void save({ confirmPaidProviders: e.target.checked })} style={{ width: 16, height: 16 }} />
          {s.confirmPaid}
        </label>
      </section>
      <section className="card stack" aria-label={s.security}>
        <h2 style={{ margin: 0, fontSize: 17 }}>{s.security}</h2>
        {settings.sandboxMode === 'auto' && sandbox?.ok ? <p style={{ margin: 0 }}>{s.sandboxOn}</p> : <p className="warn" style={{ margin: 0 }}>{sandbox?.message ?? s.sandboxUnknown}</p>}
        <label className="row" style={{ gap: 6 }}>{s.isolation}
          <select aria-label={s.isolation} value={settings.sandboxMode} onChange={(e) => void save({ sandboxMode: e.target.value as WorkspaceSettings['sandboxMode'] })}>
            <option value="auto">{s.isolationAuto}</option>
            <option value="off">{s.isolationOff}</option>
          </select>
        </label>
        {settings.sandboxMode === 'off' && <p className="warn" style={{ margin: 0 }}>{s.isolationWarning}</p>}
      </section>
      <section className="card stack" aria-label={s.network}>
        <h2 style={{ margin: 0, fontSize: 17 }}>{s.networkTitle}</h2>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>{s.alwaysAllowed}</p>
        {settings.droppedDomains?.length ? <p role="status" className="warn" style={{ margin: 0 }}>{s.droppedDomains({ list: settings.droppedDomains.join(', ') })}</p> : null}
        {settings.extraAllowedDomains.map((d) => (
          <div key={d} className="row" style={{ gap: 8 }}>
            <span className="mono" style={{ flex: 1 }}>{d}</span>
            <button type="button" aria-label={s.removeDomain({ domain: d })} onClick={() => void save({ extraAllowedDomains: settings.extraAllowedDomains.filter((x) => x !== d) })}>{t.web.common.remove}</button>
          </div>
        ))}
        <form className="row" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); void save({ extraAllowedDomains: [...settings.extraAllowedDomains, domain.trim()] }).then((ok) => { if (ok) setDomain(''); }); }}>
          <input aria-label={s.allowDomain} placeholder={s.domainPlaceholder} value={domain} onChange={(e) => setDomain(e.target.value)} style={{ flex: 1, width: 'auto' }} />
          <button type="submit" disabled={!domain.trim()}>{s.addDomain}</button>
        </form>
      </section>
      <section className="card stack" aria-label={s.agent}>
        <h2 style={{ margin: 0, fontSize: 17 }}>{s.agent}</h2>
        <label className="row" style={{ gap: 6 }}>{s.model}
          <input value={model} placeholder={s.modelPlaceholder} onChange={(e) => setModel(e.target.value)} onBlur={() => { const next = model.trim() || null; if (next !== settings.model) void save({ model: next }); }} style={{ width: 240 }} />
        </label>
        <label className="row" style={{ gap: 6 }}>{s.parallelJobs}
          <input type="number" min={1} max={8} value={settings.maxConcurrentJobs} onChange={(e) => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 1 && n <= 8) void save({ maxConcurrentJobs: n }); }} style={{ width: 80 }} />
        </label>
      </section>
    </main>
  );
}
