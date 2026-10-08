import { useState } from 'react';
import { api } from '../api.ts';
import { useProjectData } from '../useProjectData.ts';

export function PermissionsList({ slug }: { slug: string }) {
  const { data, error, reload } = useProjectData(() => api.getPermissions(slug), [slug]);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const revoke = async (rule: string) => {
    setRevokeError(null);
    try { await api.deletePermission(slug, rule); reload(); }
    catch (e) { setRevokeError(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <section className="card stack" aria-label="Permessi sempre consentiti" style={{ maxWidth: 820 }}>
      <h2 style={{ margin: 0, fontSize: 17 }}>Permessi sempre consentiti</h2>
      {error && <p role="alert" className="error" style={{ margin: 0 }}>{error}</p>}
      {revokeError && <p role="alert" className="error" style={{ margin: 0 }}>{revokeError}</p>}
      {!data && !error && <p className="muted" style={{ margin: 0 }}>Caricamento…</p>}
      {data && data.length === 0 && <p className="muted" style={{ margin: 0 }}>Nessun permesso salvato: le richieste dell'agente arrivano come approvazioni.</p>}
      {data?.map((p) => (
        <div key={p.rule} className="row" style={{ gap: 8 }}>
          <span>{p.label}</span>
          <span className="mono muted" style={{ flex: 1 }}>{p.rule}</span>
          <button type="button" aria-label={`Revoca ${p.label}`} onClick={() => void revoke(p.rule)}>Revoca</button>
        </div>
      ))}
    </section>
  );
}
