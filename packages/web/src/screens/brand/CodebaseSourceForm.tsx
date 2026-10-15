import { useState, type FormEvent } from 'react';
import { desktop } from '../../desktop.ts';
import { useT } from '../../i18n.tsx';
import { Button, Chip, Icon, Input } from '../../ui/index.ts';
import '../../components/codebase.css';
import { message } from '../common.tsx';
import { folderName } from '../brandModel.ts';

/**
 * Adds a codebase as a brand source (Phase 14): the desktop folder picker or a path input, the project's linked
 * codebases as one-click suggestions (a click fills the path), an optional note and the read-only hint. A refusal of the
 * core (overlap, root, missing…) arrives already localized and is shown under the field.
 */
export function CodebaseSourceForm({ suggestions, taken, submitLabel, onSubmit, autoFocus }: {
  suggestions: string[]; taken: string[]; submitLabel: string; autoFocus?: boolean; onSubmit(path: string, note: string): Promise<void>;
}) {
  const t = useT();
  const c = t.web.brand.codebase;
  const [path, setPath] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bridge = desktop();
  const offered = suggestions.filter((p) => !taken.includes(p));
  const choose = async () => {
    try { const picked = await bridge?.pickFolder(t.web.codebase.pickTitle, path.trim() || undefined); if (picked) { setPath(picked); setError(null); } }
    catch (e) { setError(message(e)); }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const p = path.trim();
    if (!p) { setError(c.needPath); return; }
    setBusy(true); setError(null);
    try { await onSubmit(p, note.trim()); setPath(''); setNote(''); }
    catch (err) { setError(message(err)); }
    finally { setBusy(false); }
  };
  return (
    <form className="ms-cbl" onSubmit={(e) => void submit(e)}>
      {offered.length ? (
        <div className="ms-bcb-sugg" role="group" aria-label={c.suggestions}>
          <span className="ms-bsmall-text ms-muted">{c.suggestions}</span>
          {offered.map((p) => <Chip key={p} icon="folder" on={path.trim() === p} title={c.suggestionTitle({ path: p })} onClick={() => { setPath(p); setError(null); }}>{folderName(p)}</Chip>)}
        </div>
      ) : null}
      <div className="ms-cbl-add">
        <Input className="ms-cbl-input ms-cbl-mono" aria-label={c.pathAria} placeholder={c.pathPlaceholder} value={path} autoFocus={autoFocus} onChange={(e) => { setPath(e.target.value); setError(null); }} />
        {bridge ? <Button size="sm" variant="outline" onClick={() => void choose()}><Icon name="folder" size={12} />{t.web.common.chooseFolder}</Button> : null}
      </div>
      <Input className="ms-cbl-input" aria-label={c.noteAria} placeholder={c.notePlaceholder} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      <p className="ms-cbl-hint">{c.hint}</p>
      {error ? <p role="alert" className="ms-cbl-error">{error}</p> : null}
      <Button type="submit" variant="ink" size="sm" className="ms-bstart" loading={busy} disabled={!path.trim()}>{submitLabel}</Button>
    </form>
  );
}
