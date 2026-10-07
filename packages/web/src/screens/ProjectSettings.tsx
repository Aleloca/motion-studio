import type { LinkedCodebase } from '@motion-studio/shared';
import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { CodebaseList } from '../components/CodebaseList.tsx';
import { useProjectData } from '../useProjectData.ts';

export function ProjectSettings({ slug, tick }: { slug: string; tick: number }) {
  const { data, error, reload } = useProjectData(() => Promise.all([api.getProject(slug), api.getCodebases(slug)]), [slug, tick]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [codebases, setCodebases] = useState<LinkedCodebase[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => {
    if (!data) return;
    setName(data[0].project.name); setDescription(data[0].project.description); setCodebases(data[0].project.linkedCodebases);
  }, [data]);
  const save = async () => {
    setStatus(null);
    try { await api.updateProject(slug, { name, description, linkedCodebases: codebases }); setStatus('Salvato'); reload(); }
    catch (e) { setStatus(e instanceof Error ? e.message : String(e)); }
  };
  if (error) return <p role="alert" className="error">{error}</p>;
  if (!data) return <p className="muted">Caricamento…</p>;
  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); void save(); }} style={{ maxWidth: 820 }}>
      <label htmlFor="ps-name"><strong>Nome</strong></label>
      <input id="ps-name" value={name} onChange={(e) => setName(e.target.value)} />
      <label htmlFor="ps-desc"><strong>Descrizione</strong></label>
      <textarea id="ps-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      <strong>Codebase collegate al progetto</strong>
      <CodebaseList value={codebases} checks={data[1]} onChange={setCodebases} />
      <div className="row"><div style={{ flex: 1 }} />{status && <span role="status" className="muted">{status}</span>}<button type="submit" className="primary">Salva</button></div>
    </form>
  );
}
