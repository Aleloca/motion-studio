import type { LinkedCodebase } from '@motion-studio/shared';
import { useState, type KeyboardEvent } from 'react';
import type { CodebaseCheck } from '../api.ts';
import { desktop } from '../desktop.ts';

export function CodebaseList({ value, checks, onChange, disabled }: { value: LinkedCodebase[]; checks?: CodebaseCheck[]; onChange: (next: LinkedCodebase[]) => void; disabled?: boolean }) {
  const [path, setPath] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    const p = path.trim();
    if (!p || !(p.startsWith('/') || p.startsWith('~'))) { setError('Indica un percorso assoluto'); return; }
    if (value.some((c) => c.path === p)) { setError('Cartella già collegata'); return; }
    setError(null);
    onChange([...value, { path: p, ...(note.trim() ? { note: note.trim() } : {}) }]);
    setPath(''); setNote('');
  };
  const bridge = desktop();
  const choose = async () => {
    try { const picked = await bridge?.pickFolder('Scegli la cartella da collegare', path.trim() || undefined); if (picked) { setPath(picked); setError(null); } }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const onEnter = (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
  return (
    <div className="stack" style={{ gap: 8 }}>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>Le cartelle collegate sono in sola lettura. L'agente può leggerle; gli strumenti di modifica sono bloccati e le modifiche nei repository git vengono segnalate.</p>
      {value.map((c, i) => (
        <div key={c.path} className="row" style={{ gap: 8 }}>
          <span className="mono" style={{ overflowWrap: 'anywhere', flex: '1 1 240px' }}>{c.path}</span>
          {checks?.find((x) => x.path === c.path)?.exists === false && <span className="badge err">Non trovata</span>}
          <input aria-label={`Nota per ${c.path}`} value={c.note ?? ''} disabled={disabled} style={{ flex: '1 1 160px', width: 'auto' }}
            onChange={(e) => onChange(value.map((x, k) => (k === i ? { path: x.path, ...(e.target.value ? { note: e.target.value } : {}) } : x)))} />
          <button type="button" disabled={disabled} aria-label={`Rimuovi ${c.path}`} onClick={() => onChange(value.filter((_, k) => k !== i))}>Rimuovi</button>
        </div>
      ))}
      <div className="row" style={{ gap: 8 }}>
        <input aria-label="Percorso assoluto della cartella" placeholder="/Users/tuonome/dev/app" value={path} disabled={disabled} onChange={(e) => setPath(e.target.value)} onKeyDown={onEnter} style={{ flex: '2 1 240px', width: 'auto' }} />
        <input aria-label="Nota (facoltativa)" placeholder="Es. app iOS, schermate in /Screens" value={note} disabled={disabled} onChange={(e) => setNote(e.target.value)} onKeyDown={onEnter} style={{ flex: '1 1 160px', width: 'auto' }} />
        {bridge && <button type="button" disabled={disabled} onClick={choose}>Scegli cartella…</button>}
        <button type="button" disabled={disabled} onClick={add}>Collega</button>
      </div>
      {error && <p role="alert" className="error" style={{ margin: 0 }}>{error}</p>}
    </div>
  );
}
