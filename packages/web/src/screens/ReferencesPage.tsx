import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { ConfirmButton } from '../components/ConfirmButton.tsx';
import { UploadZone } from '../components/UploadZone.tsx';
import type { EventsState } from '../eventsReducer.ts';
import { useT } from '../i18n.tsx';
import { useProjectData } from '../useProjectData.ts';

export function ReferencesPage({ slug, live }: { slug: string; live: EventsState }) {
  const t = useT();
  const { data, error, reload } = useProjectData(() => api.listReferences(slug), [slug, live.projectTicks[slug] ?? 0]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => { setActionError(null); try { await fn(); reload(); } catch (e) { setActionError(e instanceof Error ? e.message : String(e)); } };
  // Drop drafts once the server value matches them, so later external changes show up again.
  useEffect(() => {
    if (!data) return;
    setNotes((n) => {
      const kept = Object.entries(n).filter(([f, v]) => { const r = data.references.find((x) => x.file === f); return r && r.note !== v; });
      return kept.length === Object.keys(n).length ? n : Object.fromEntries(kept);
    });
  }, [data]);
  if (error) return <p role="alert" className="error">{error}</p>;
  if (!data) return <p className="muted">{t.common.loading}</p>;
  return (
    <div className="stack">
      {data.error && <p role="alert" className="error">{data.error}</p>}
      {actionError && <p role="alert" className="error">{actionError}</p>}
      <UploadZone label={t.web.references.upload} disabled={Boolean(data.error)} onFiles={async (files) => { await api.uploadFiles(slug, 'references', files); reload(); }} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
        {data.references.map((r) => (
          <div key={r.file} className="card stack" style={{ padding: 10, gap: 6 }}>
            <img src={api.projectFileUrl(slug, `references/${r.file}`)} alt={r.file} style={{ width: '100%', height: 150, objectFit: 'cover', borderRadius: 8 }} />
            <span className="mono" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{r.file}</span>
            <textarea aria-label={t.web.references.noteFor({ file: r.file })} rows={2} value={notes[r.file] ?? r.note}
              onChange={(e) => setNotes((n) => ({ ...n, [r.file]: e.target.value }))}
              onBlur={() => { const v = notes[r.file]; if (v !== undefined && v !== r.note) void act(() => api.updateReference(slug, r.file, { note: v })); }} />
            <label className="row" style={{ gap: 6 }}>
              <input type="checkbox" checked={r.useForBrand} onChange={(e) => void act(() => api.updateReference(slug, r.file, { useForBrand: e.target.checked }))} style={{ width: 16, height: 16 }} />
              {t.web.references.useForBrand}
            </label>
            <ConfirmButton label={t.web.common.delete} ariaLabel={t.web.references.deleteFile({ file: r.file })} confirmAriaLabel={t.web.references.confirmDeleteFile({ file: r.file })} onConfirm={() => void act(() => api.deleteReference(slug, r.file))} />
          </div>
        ))}
      </div>
      {data.references.length === 0 && <p className="muted">{t.web.references.none}</p>}
    </div>
  );
}
