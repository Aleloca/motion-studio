import type { LinkedCodebase } from '@motion-studio/shared';
import { useState, type KeyboardEvent } from 'react';
import type { CodebaseCheck } from '../api.ts';
import { desktop } from '../desktop.ts';
import { useT } from '../i18n.tsx';
import { Button, Icon, Input, Pill } from '../ui/index.ts';
import './codebase.css';

/** Linked code folders inside a form (New creative, Brief): read-only folders the agent can read. */
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
    <div className="ms-cbl">
      <p className="ms-cbl-hint">{c.hint}</p>
      {value.map((cb, i) => (
        <div key={cb.path} className="ms-cbl-item">
          <span className="ms-cbl-icon" aria-hidden="true"><Icon name="code" size={13} /></span>
          <span className="ms-cbl-path">{cb.path}</span>
          {checks?.find((x) => x.path === cb.path)?.exists === false ? <Pill tone="warn">{c.notFound}</Pill> : null}
          <Input className="ms-cbl-note" aria-label={c.noteFor({ path: cb.path })} value={cb.note ?? ''} disabled={disabled}
            onChange={(e) => onChange(value.map((x, k) => (k === i ? { path: x.path, ...(e.target.value ? { note: e.target.value } : {}) } : x)))} />
          <Button size="sm" variant="ghost" icon disabled={disabled} aria-label={c.remove({ path: cb.path })} title={c.remove({ path: cb.path })}
            onClick={() => onChange(value.filter((_, k) => k !== i))}><Icon name="close" size={11} /></Button>
        </div>
      ))}
      <div className="ms-cbl-add">
        <Input className="ms-cbl-input ms-cbl-mono" aria-label={c.pathAria} placeholder={c.pathPlaceholder} value={path} disabled={disabled} onChange={(e) => setPath(e.target.value)} onKeyDown={onEnter} />
        <Input className="ms-cbl-input" aria-label={c.noteAria} placeholder={c.notePlaceholder} value={note} disabled={disabled} onChange={(e) => setNote(e.target.value)} onKeyDown={onEnter} />
        {bridge ? <Button size="sm" variant="outline" disabled={disabled} onClick={() => void choose()}><Icon name="folder" size={12} />{t.web.common.chooseFolder}</Button> : null}
        <Button size="sm" variant="ink" disabled={disabled} onClick={add}>{c.link}</Button>
      </div>
      {error ? <p role="alert" className="ms-cbl-error">{error}</p> : null}
    </div>
  );
}
