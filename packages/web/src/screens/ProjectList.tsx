import type { ProjectListItem } from '@motion-studio/shared';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.ts';

export function ProjectList() {
  const [items, setItems] = useState<ProjectListItem[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = () => api.listProjects().then(setItems).catch((e) => setError(String(e.message)));
  useEffect(() => { void load(); }, []);

  const create = async () => {
    setError(null);
    try {
      const { slug } = await api.createProject(name);
      location.hash = `#/p/${slug}`;
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
  };

  return (
    <main className="page stack">
      <div className="row"><h1 style={{ margin: 0, fontSize: 24 }}>Progetti</h1></div>
      <form className="card row" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <label htmlFor="new-project" className="muted">Nuovo progetto</label>
        <input id="new-project" value={name} onChange={(e) => setName(e.target.value)} placeholder="Es. Acme" style={{ flex: '1 1 240px', width: 'auto' }} />
        <button type="submit" className="primary" disabled={!name.trim()}>Crea</button>
      </form>
      {error && <p role="alert" className="error">{error}</p>}
      {items?.length === 0 && <p className="muted">Nessun progetto ancora: creane uno per iniziare.</p>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
        {items?.map((it) =>
          it.ok ? (
            <a key={it.slug} href={`#/p/${it.slug}`} className="card stack" style={{ textDecoration: 'none', color: 'inherit', gap: 4 }}>
              <strong>{it.project.name}</strong>
              <span className="muted">{it.project.description || 'Nessuna descrizione'}</span>
              <span className="muted" style={{ fontSize: 12 }}>Aggiornato {new Date(it.project.updatedAt).toLocaleDateString('it-IT')}</span>
            </a>
          ) : (
            <div key={it.slug} className="card stack" style={{ gap: 4 }}>
              <strong>{it.slug}</strong>
              <span className="badge err" style={{ alignSelf: 'flex-start' }}>Non leggibile</span>
              <span className="mono" style={{ overflowWrap: 'anywhere' }}>{it.error}</span>
            </div>
          ),
        )}
      </div>
    </main>
  );
}
