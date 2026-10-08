import type { DoctorCheck, ProviderId, SecretStatus, WorkspaceSettings } from '@motion-studio/shared';
import { useEffect, useState } from 'react';
import { api } from '../api.ts';

const PROVIDERS: Array<[ProviderId, string, string]> = [['openai', 'OpenAI', 'OPENAI_API_KEY'], ['elevenlabs', 'ElevenLabs', 'ELEVENLABS_API_KEY'], ['pexels', 'Pexels', 'PEXELS_API_KEY'], ['unsplash', 'Unsplash', 'UNSPLASH_ACCESS_KEY']];
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function KeyRow({ id, label, env, status, onChange }: { id: ProviderId; label: string; env: string; status?: SecretStatus; onChange(s: SecretStatus): void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fromEnv = status?.source === 'env';
  const run = async (fn: () => Promise<SecretStatus>) => { setError(null); try { onChange(await fn()); setValue(''); } catch (e) { setError(msg(e)); } };
  return (
    <div className="row" style={{ gap: 8 }}>
      <strong style={{ width: 110 }}>{label}</strong>
      <span className={`badge ${status?.configured ? 'ok' : ''}`}>{fromEnv ? 'Da variabile d\'ambiente' : status?.configured ? 'Configurata nel portachiavi' : 'Non configurata'}</span>
      <input type="password" autoComplete="off" aria-label={`Nuova chiave ${label}`} value={value} disabled={fromEnv} onChange={(e) => setValue(e.target.value)} style={{ flex: '1 1 220px', width: 'auto' }} />
      <button type="button" aria-label={`Salva chiave ${label}`} disabled={fromEnv || !value.trim()} onClick={() => void run(() => api.setSecret(id, value))}>Salva</button>
      {status?.source === 'keychain' && <button type="button" aria-label={`Rimuovi chiave ${label}`} onClick={() => void run(() => api.deleteSecret(id))}>Rimuovi</button>}
      {fromEnv && <span className="muted" style={{ fontSize: 12 }}>Gestita da {env}</span>}
      {error && <p role="alert" className="error" style={{ margin: 0, flexBasis: '100%' }}>{error}</p>}
    </div>
  );
}

export function SettingsPage({ settings, checks, onSaved }: { settings: WorkspaceSettings; checks: DoctorCheck[] | null; onSaved(next: WorkspaceSettings): void }) {
  const [secrets, setSecrets] = useState<SecretStatus[]>([]);
  const [domain, setDomain] = useState('');
  const [model, setModel] = useState(settings.model ?? '');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.getSecrets().then(setSecrets).catch((e: unknown) => setError(msg(e))); }, []);
  const save = async (patch: Partial<WorkspaceSettings>): Promise<boolean> => { setError(null); try { onSaved(await api.updateSettings(patch)); return true; } catch (e) { setError(msg(e)); return false; } };
  const sandbox = checks?.find((c) => c.id === 'sandbox');
  return (
    <main className="page stack" style={{ maxWidth: 900 }}>
      <h1 style={{ margin: 0, fontSize: 24 }}>Impostazioni</h1>
      {error && <p role="alert" className="error">{error}</p>}
      <section className="card stack" aria-label="Chiavi dei provider">
        <h2 style={{ margin: 0, fontSize: 17 }}>Chiavi dei provider</h2>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>Le chiavi restano nel portachiavi del sistema: l'agente non le vede mai.</p>
        {PROVIDERS.map(([id, label, env]) => (
          <KeyRow key={id} id={id} label={label} env={env} status={secrets.find((s) => s.provider === id)} onChange={(s) => setSecrets((all) => all.map((x) => (x.provider === s.provider ? s : x)))} />
        ))}
        <div className="row" style={{ gap: 8 }}><strong style={{ width: 110 }}>Google Fonts</strong><span className="muted">Non serve una chiave</span></div>
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" checked={settings.confirmPaidProviders} onChange={(e) => void save({ confirmPaidProviders: e.target.checked })} style={{ width: 16, height: 16 }} />
          Chiedi conferma prima di usare provider a pagamento
        </label>
      </section>
      <section className="card stack" aria-label="Sicurezza">
        <h2 style={{ margin: 0, fontSize: 17 }}>Sicurezza</h2>
        {sandbox?.ok ? <p style={{ margin: 0 }}>Sandbox attiva: l'agente lavora isolato nella cartella del progetto</p> : <p className="warn" style={{ margin: 0 }}>{sandbox?.message ?? 'Stato della sandbox non disponibile'}</p>}
        <label className="row" style={{ gap: 6 }}>Isolamento dell'agente
          <select aria-label="Isolamento dell'agente" value={settings.sandboxMode} onChange={(e) => void save({ sandboxMode: e.target.value as WorkspaceSettings['sandboxMode'] })}>
            <option value="auto">Automatico (consigliato)</option>
            <option value="off">Disattivato</option>
          </select>
        </label>
        {settings.sandboxMode === 'off' && <p className="warn" style={{ margin: 0 }}>Senza isolamento l'agente può scrivere ovunque con i comandi consentiti.</p>}
      </section>
      <section className="card stack" aria-label="Rete">
        <h2 style={{ margin: 0, fontSize: 17 }}>Rete consentita all'agente</h2>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>Sempre consentiti: registri di pacchetti (npm, PyPI), GitHub, CDN e Google Fonts.</p>
        {settings.extraAllowedDomains.map((d) => (
          <div key={d} className="row" style={{ gap: 8 }}>
            <span className="mono" style={{ flex: 1 }}>{d}</span>
            <button type="button" aria-label={`Rimuovi dominio ${d}`} onClick={() => void save({ extraAllowedDomains: settings.extraAllowedDomains.filter((x) => x !== d) })}>Rimuovi</button>
          </div>
        ))}
        <form className="row" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); void save({ extraAllowedDomains: [...settings.extraAllowedDomains, domain.trim()] }).then((ok) => { if (ok) setDomain(''); }); }}>
          <input aria-label="Dominio da consentire" placeholder="api.esempio.it o *.esempio.it" value={domain} onChange={(e) => setDomain(e.target.value)} style={{ flex: 1, width: 'auto' }} />
          <button type="submit" disabled={!domain.trim()}>Aggiungi dominio</button>
        </form>
      </section>
      <section className="card stack" aria-label="Agente">
        <h2 style={{ margin: 0, fontSize: 17 }}>Agente</h2>
        <label className="row" style={{ gap: 6 }}>Modello
          <input value={model} placeholder="predefinito di Claude Code" onChange={(e) => setModel(e.target.value)} onBlur={() => { const next = model.trim() || null; if (next !== settings.model) void save({ model: next }); }} style={{ width: 240 }} />
        </label>
        <label className="row" style={{ gap: 6 }}>Lavori in parallelo
          <input type="number" min={1} max={8} value={settings.maxConcurrentJobs} onChange={(e) => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 1 && n <= 8) void save({ maxConcurrentJobs: n }); }} style={{ width: 80 }} />
        </label>
      </section>
    </main>
  );
}
