import type { ProjectListItem } from '@motion-studio/shared';
import { useEffect, useRef, useState } from 'react';
import { flash } from '../motion/index.ts';
import { useNewProjectIntent } from '../shell/intents.ts';
import { api, ApiError } from '../api.ts';
import { formatDate, useLocale, useT } from '../i18n.tsx';

export function ProjectList() {
  const t = useT();
  const locale = useLocale();
  const [items, setItems] = useState<ProjectListItem[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const nameField = useRef<HTMLInputElement>(null);
  // "New project" from the project switcher: bring the name field forward (prototype focusNew + flash).
  useNewProjectIntent(() => { nameField.current?.focus(); void flash(nameField.current); });

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
      <div className="row"><h1 style={{ margin: 0, fontSize: 24 }}>{t.web.projects.title}</h1></div>
      <form className="card row" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <label htmlFor="new-project" className="muted">{t.web.projects.newProject}</label>
        <input id="new-project" ref={nameField} value={name} onChange={(e) => setName(e.target.value)} placeholder={t.web.projects.namePlaceholder} style={{ flex: '1 1 240px', width: 'auto' }} />
        <button type="submit" className="primary" disabled={!name.trim()}>{t.web.projects.create}</button>
      </form>
      {error && <p role="alert" className="error">{error}</p>}
      {items?.length === 0 && <p className="muted">{t.web.projects.empty}</p>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
        {items?.map((it) =>
          it.ok ? (
            <a key={it.slug} href={`#/p/${it.slug}`} className="card stack" style={{ textDecoration: 'none', color: 'inherit', gap: 4 }}>
              <strong>{it.project.name}</strong>
              <span className="muted">{it.project.description || t.web.projects.noDescription}</span>
              <span className="muted" style={{ fontSize: 12 }}>{t.web.projects.updated({ date: formatDate(locale, it.project.updatedAt) })}</span>
            </a>
          ) : (
            <div key={it.slug} className="card stack" style={{ gap: 4 }}>
              <strong>{it.slug}</strong>
              <span className="badge err" style={{ alignSelf: 'flex-start' }}>{t.web.common.unreadable}</span>
              <span className="mono" style={{ overflowWrap: 'anywhere' }}>{it.error}</span>
            </div>
          ),
        )}
      </div>
    </main>
  );
}
