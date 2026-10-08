import type { BrandChange, BrandField, BrandProposal, Messages } from '@motion-studio/shared';
import { useState } from 'react';
import { api } from '../api.ts';
import { formatDateTime, useLocale, useT } from '../i18n.tsx';

const FIELDS: BrandField[] = ['colors', 'fonts', 'logos', 'tone', 'dos', 'donts', 'photoStyle'];
type Item = { name?: string; hex?: string; family?: string; file?: string; text?: string };

export function describeChange(c: BrandChange, t: Messages): string {
  const item = ((c.op === 'remove' ? c.before : c.after) ?? {}) as Item;
  const what = (() => {
    switch (c.field) {
      case 'colors': return t.web.proposal.color(item);
      case 'fonts': return t.web.proposal.font(item);
      case 'logos': return t.web.proposal.logo(item);
      case 'tone': return t.web.proposal.tone;
      case 'photoStyle': return t.web.proposal.photoStyle;
      case 'dos': return t.web.proposal.doRule(item);
      case 'donts': return t.web.proposal.avoidRule(item);
    }
  })();
  return `${t.web.proposal.verbs[c.op]} ${what}`;
}

function Preview({ value, field }: { value: unknown; field: BrandField }) {
  if (!value) return <span className="muted">—</span>;
  const v = value as Item;
  if (field === 'colors') return <span className="row" style={{ gap: 6 }}><span style={{ width: 18, height: 18, borderRadius: 4, background: v.hex, border: '1px solid var(--border)' }} />{v.name}</span>;
  return <span style={{ whiteSpace: 'pre-wrap' }}>{v.text ?? v.family ?? v.file ?? ''}</span>;
}

export function ProposalReview(props: { slug: string; proposal: BrandProposal; onDone: () => void }) {
  return <ProposalReviewBody key={props.proposal.id} {...props} />;
}

function ProposalReviewBody({ slug, proposal, onDone }: { slug: string; proposal: BrandProposal; onDone: () => void }) {
  const t = useT();
  const locale = useLocale();
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
    <section className="card stack" aria-label={t.web.proposal.aria}>
      <strong>{t.web.proposal.title({ date: formatDateTime(locale, proposal.createdAt) })}</strong>
      {proposal.summary && <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{proposal.summary}</p>}
      {proposal.assetsAdded.length > 0 && <p className="muted" style={{ margin: 0 }}>{t.web.proposal.assetsAdded({ count: proposal.assetsAdded.length })}</p>}
      {empty && <p className="muted" style={{ margin: 0 }}>{t.web.proposal.noChanges}</p>}
      {FIELDS.map((field) => {
        const changes = proposal.changes.filter((c) => c.field === field);
        if (!changes.length) return null;
        return (
          <fieldset key={field} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
            <legend style={{ fontWeight: 800, marginBottom: 4 }}>{t.web.proposal.headings[field]}</legend>
            {changes.map((c) => (
              <div key={c.id} className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                <label className="row" style={{ gap: 6, flex: '1 1 260px' }}>
                  <input type="checkbox" checked={checked.has(c.id)} onChange={() => toggle(c.id)} style={{ width: 16, height: 16 }} />
                  {describeChange(c, t)}
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
            {t.web.proposal.applyGuidelines}
          </label>
          <div className="row" style={{ alignItems: 'stretch', gap: 10 }}>
            {[[t.web.proposal.current, proposal.guidelines.current], [t.web.proposal.proposed, proposal.guidelines.proposed]].map(([t, text]) => (
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
        <button type="button" disabled={busy} onClick={() => void act(() => api.discardProposal(slug, proposal.id))}>{empty ? t.common.close : t.web.proposal.discard}</button>
        {!empty && <button type="button" className="primary" disabled={busy} onClick={() => void act(() => api.applyProposal(slug, proposal.id, proposal.changes.filter((c) => checked.has(c.id)).map((c) => c.id), guidelines))}>{t.web.proposal.applySelected}</button>}
      </div>
    </section>
  );
}
