import { useT } from '../i18n.tsx';

/** Three bouncing dots shown before an agent step (T9). */
export function Typing({ label }: { label?: string }) {
  const t = useT();
  return <span className="ms-typing" role="status" aria-label={label ?? t.web.ui.typing}><i /><i /><i /></span>;
}
