import type { LinkedCodebase } from '@motion-studio/shared';
import { useState, type KeyboardEvent } from 'react';
import type { CodebaseCheck } from '../api.ts';
import { desktop } from '../desktop.ts';
import { useT } from '../i18n.tsx';

export function CodebaseList({ value, checks, onChange, disabled }: { value: LinkedCodebase[]; checks?: CodebaseCheck[]; onChange: (next: LinkedCodebase[]) => void; disabled?: boolean }) {
  const t = useT();
  const c = t.web.codebase;
  const [path, setPath] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    const p = path.trim();
    if (!p || !(p.startsWith('/') || p.startsWith('~'))) { setError(c.needAbsolute); return; }
    if (value.some((c) => c.path === p)) { setError(c.alreadyLinked); return; }
    setError(null);
    onChange([...value, { path: p, ...(note.trim() ? { note: note.trim() } : {}) }]);
    setPath(''); setNote('');
  };
  const bridge = desktop();
  const choose = async () => {
    try { const picked = await bridge?.pickFolder(c.pickTitle, path.trim() || undefined); if (picked) { setPath(picked); setError(null); } }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const onEnter = (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
  return (
    <div className="stack" style={{ gap: 8 }}>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>{c.hint}</p>
      {value.map((cb, i) => (
        <div key={cb.path} className="row" style={{ gap: 8 }}>
          <span className="mono" style={{ overflowWrap: 'anywhere', flex: '1 1 240px' }}>{cb.path}</span>
          {checks?.find((x) => x.path === cb.path)?.exists === false && <span className="badge err">{c.notFound}</span>}
          <input aria-label={c.noteFor({ path: cb.path })} value={cb.note ?? ''} disabled={disabled} style={{ flex: '1 1 160px', width: 'auto' }}
            onChange={(e) => onChange(value.map((x, k) => (k === i ? { path: x.path, ...(e.target.value ? { note: e.target.value } : {}) } : x)))} />
          <button type="button" disabled={disabled} aria-label={c.remove({ path: cb.path })} onClick={() => onChange(value.filter((_, k) => k !== i))}>{t.web.common.remove}</button>
        </div>
      ))}
      <div className="row" style={{ gap: 8 }}>
        <input aria-label={c.pathAria} placeholder={c.pathPlaceholder} value={path} disabled={disabled} onChange={(e) => setPath(e.target.value)} onKeyDown={onEnter} style={{ flex: '2 1 240px', width: 'auto' }} />
        <input aria-label={c.noteAria} placeholder={c.notePlaceholder} value={note} disabled={disabled} onChange={(e) => setNote(e.target.value)} onKeyDown={onEnter} style={{ flex: '1 1 160px', width: 'auto' }} />
        {bridge && <button type="button" disabled={disabled} onClick={choose}>{t.web.common.chooseFolder}</button>}
        <button type="button" disabled={disabled} onClick={add}>{c.link}</button>
      </div>
      {error && <p role="alert" className="error" style={{ margin: 0 }}>{error}</p>}
    </div>
  );
}
