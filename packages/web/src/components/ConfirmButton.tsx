import { useEffect, useState } from 'react';
import { useT } from '../i18n.tsx';

/** A destructive action asked twice: the first click arms it ("Confirm delete") for 5 seconds. */
export function ConfirmButton({ label, confirmLabel, ariaLabel, confirmAriaLabel, onConfirm }: {
  label: string; confirmLabel?: string; ariaLabel?: string; confirmAriaLabel?: string; onConfirm(): void;
}) {
  const t = useT();
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(t);
  }, [armed]);
  return armed
    ? <button type="button" className="danger" aria-label={confirmAriaLabel} onClick={() => { setArmed(false); onConfirm(); }}>{confirmLabel ?? t.web.common.confirmDelete}</button>
    : <button type="button" aria-label={ariaLabel} onClick={() => setArmed(true)}>{label}</button>;
}
