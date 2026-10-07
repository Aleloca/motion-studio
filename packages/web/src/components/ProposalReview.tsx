import type { BrandChange, BrandField, BrandProposal } from '@motion-studio/shared';
import { useState } from 'react';
import { api } from '../api.ts';

const VERB = { add: 'Aggiungi', update: 'Aggiorna', remove: 'Rimuovi' } as const;
const HEADINGS: Array<[BrandField, string]> = [['colors', 'Colori'], ['fonts', 'Font'], ['logos', 'Loghi'], ['tone', 'Tono'], ['dos', 'Fare'], ['donts', 'Evitare'], ['photoStyle', 'Stile fotografico']];
type Item = { name?: string; hex?: string; family?: string; file?: string; text?: string };

export function describeChange(c: BrandChange): string {
  const item = ((c.op === 'remove' ? c.before : c.after) ?? {}) as Item;
  const what = (() => {
    switch (c.field) {
      case 'colors': return `colore ${item.name} ${item.hex}`;
      case 'fonts': return `font ${item.family}`;
      case 'logos': return `logo ${item.file}`;
      case 'tone': return 'tono';
      case 'photoStyle': return 'stile fotografico';
      case 'dos': return `regola da fare: "${item.text}"`;
      case 'donts': return `regola da evitare: "${item.text}"`;
    }
  })();
  return `${VERB[c.op]} ${what}`;
}

function Preview({ value, field }: { value: unknown; field: BrandField }) {
  if (!value) return <span className="muted">—</span>;
  const v = value as Item;
  if (field === 'colors') return <span className="row" style={{ gap: 6 }}><span style={{ width: 18, height: 18, borderRadius: 4, background: v.hex, border: '1px solid var(--border)' }} />{v.name}</span>;
  return <span style={{ whiteSpace: 'pre-wrap' }}>{v.text ?? v.family ?? v.file ?? ''}</span>;
}

export function ProposalReview({ slug, proposal, onDone }: { slug: string; proposal: BrandProposal; onDone: () => void }) {
  const [checked, setChecked] = useState<Set<string>>(() => new Set(proposal.changes.map((c) => c.id)));
  const [guidelines, setGuidelines] = useState(Boolean(proposal.guidelines));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); onDone(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const toggle = (id: string) => setChecked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const empty = proposal.changes.length === 0 && !proposal.guidelines;

  return (
    <section className="card stack" aria-label="Proposta di brand">
      <strong>Proposta dall'analisi del {new Date(proposal.createdAt).toLocaleString('it-IT')}</strong>
      {proposal.summary && <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{proposal.summary}</p>}
      {proposal.assetsAdded.length > 0 && <p className="muted" style={{ margin: 0 }}>{proposal.assetsAdded.length} asset scaricati e aggiunti alla libreria</p>}
      {empty && <p className="muted" style={{ margin: 0 }}>Nessuna modifica proposta.</p>}
      {HEADINGS.map(([field, heading]) => {
        const changes = proposal.changes.filter((c) => c.field === field);
        if (!changes.length) return null;
        return (
          <fieldset key={field} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
            <legend style={{ fontWeight: 800, marginBottom: 4 }}>{heading}</legend>
            {changes.map((c) => (
              <div key={c.id} className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                <label className="row" style={{ gap: 6, flex: '1 1 260px' }}>
                  <input type="checkbox" checked={checked.has(c.id)} onChange={() => toggle(c.id)} style={{ width: 16, height: 16 }} />
                  {describeChange(c)}
                </label>
                <span className="row muted" style={{ gap: 6, fontSize: 13, flex: '1 1 260px' }}>
                  <Preview value={c.before} field={field} /> → <Preview value={c.after} field={field} />
                </span>
              </div>
            ))}
          </fieldset>
        );
      })}
      {proposal.guidelines && (
        <div className="stack">
          <label className="row" style={{ gap: 6 }}>
            <input type="checkbox" checked={guidelines} onChange={(e) => setGuidelines(e.target.checked)} style={{ width: 16, height: 16 }} />
            Applica le linee guida proposte
          </label>
          <div className="row" style={{ alignItems: 'stretch', gap: 10 }}>
            {[['Attuali', proposal.guidelines.current], ['Proposte', proposal.guidelines.proposed]].map(([t, text]) => (
              <div key={t} className="stack" style={{ flex: '1 1 300px', gap: 4 }}>
                <span className="muted" style={{ fontSize: 12, fontWeight: 700 }}>{t}</span>
                <pre className="mono" style={{ margin: 0, padding: 10, background: 'var(--surface-2)', borderRadius: 8, whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto' }}>{text || '—'}</pre>
              </div>
            ))}
          </div>
        </div>
      )}
      {error && <p role="alert" className="error" style={{ margin: 0 }}>{error}</p>}
      <div className="row">
        <div style={{ flex: 1 }} />
        <button type="button" disabled={busy} onClick={() => void act(() => api.discardProposal(slug, proposal.id))}>{empty ? 'Chiudi' : 'Scarta proposta'}</button>
        {!empty && <button type="button" className="primary" disabled={busy} onClick={() => void act(() => api.applyProposal(slug, proposal.id, proposal.changes.filter((c) => checked.has(c.id)).map((c) => c.id), guidelines))}>Applica selezionate</button>}
      </div>
    </section>
  );
}
