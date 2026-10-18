// "+ Variante" and "Modifica direzione" (Phase 15, spec §3, §5): two small dialogs. A new variant has an optional direction and
// starts from the brief or from the last version of a chosen variant (which becomes its base).
import type { VariantId, VariantPick } from '@motion-studio/shared';
import { useState } from 'react';
import { useT } from '../../i18n.tsx';
import { Button, Input, Modal, Select } from '../../ui/index.ts';
import { DIRECTION_MAX, upper } from './variantModel.ts';

/** A variant a new one can start from: its latest version. */
export interface BaseChoice { letter: VariantId; slug: string; version: number }

export interface AddVariantDialogProps {
  open: boolean;
  onClose(): void;
  bases: BaseChoice[];
  /** Resolves when the variant is added and started; a rejection keeps the dialog open with the message. */
  onAdd(direction: string | null, baseFrom: VariantPick | null): Promise<void>;
}

export function AddVariantDialog({ open, onClose, bases, onAdd }: AddVariantDialogProps) {
  const t = useT();
  const vg = t.web.variantGroup;
  const [direction, setDirection] = useState('');
  const [base, setBase] = useState('brief');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = [
    { value: 'brief', label: vg.addBaseBrief },
    ...bases.map((b) => ({ value: b.slug, label: vg.addBaseOf({ letter: upper(b.letter), n: b.version }) })),
  ];
  const submit = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    const chosen = bases.find((b) => b.slug === base);
    try {
      await onAdd(direction.trim() || null, chosen ? { slug: chosen.slug, version: chosen.version } : null);
      setDirection(''); setBase('brief');
    } catch (e) {
      setError(vg.addFailed({ detail: e instanceof Error ? e.message : String(e) }));
    } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} label={vg.addTitle} width={460} dismissible={!busy}>
      <form className="ms-vdlg" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <h2>{vg.addTitle}</h2>
        <label htmlFor="ms-vadd-dir">{vg.addDirection}</label>
        <Input id="ms-vadd-dir" value={direction} maxLength={DIRECTION_MAX} placeholder={vg.directionPlaceholder} onChange={(e) => setDirection(e.target.value)} />
        <p className="ms-vdlg-hint">{vg.directionAuto}</p>
        {bases.length > 0 ? (
          <>
            <span className="ms-vdlg-lbl">{vg.addBase}</span>
            <Select<string> label={vg.addBase} value={base} options={options} onChange={setBase} />
          </>
        ) : null}
        {error ? <p role="alert" className="ms-vdlg-err">{error}</p> : null}
        <div className="ms-vdlg-actions">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>{t.common.cancel}</Button>
          <Button type="submit" variant="ink" loading={busy}>{vg.addSubmit}</Button>
        </div>
      </form>
    </Modal>
  );
}

export interface EditDirectionDialogProps {
  open: boolean;
  onClose(): void;
  letter: VariantId;
  initial: string;
  onSave(direction: string): Promise<void>;
}

export function EditDirectionDialog({ open, onClose, letter, initial, onSave }: EditDirectionDialogProps) {
  const t = useT();
  const vg = t.web.variantGroup;
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await onSave(text.trim()); } catch (e) { setError(vg.directionFailed({ detail: e instanceof Error ? e.message : String(e) })); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} label={`${vg.editDirection} · ${upper(letter)}`} width={460} dismissible={!busy}>
      <form className="ms-vdlg" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <h2>{vg.editDirection} · {upper(letter)}</h2>
        <label htmlFor="ms-vdir">{vg.directionOf({ letter: upper(letter) })}</label>
        <Input id="ms-vdir" value={text} maxLength={DIRECTION_MAX} placeholder={vg.directionPlaceholder} onChange={(e) => setText(e.target.value)} />
        <p className="ms-vdlg-hint">{vg.directionLimit({ max: DIRECTION_MAX })}</p>
        {error ? <p role="alert" className="ms-vdlg-err">{error}</p> : null}
        <div className="ms-vdlg-actions">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>{t.common.cancel}</Button>
          <Button type="submit" variant="ink" loading={busy}>{vg.directionSave}</Button>
        </div>
      </form>
    </Modal>
  );
}
