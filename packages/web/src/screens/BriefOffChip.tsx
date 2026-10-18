// The bar's warning when the version on screen lasts far from the brief's duration (decisions log 262, user reports 6 and
// 23): "Il brief dice 6 s", a warning chip instead of plain text next to the facts. It opens the explanation and the fix:
// "Usa 60 s nel brief" saves the version's duration (rounded to a whole second, the brief's unit) as the brief's, and the
// core checks the latest version again with it (no new turn). The rest of the brief is sent as stored; the store pack only
// ever changes through its own entry, so it is left out.
import type { Brief } from '@motion-studio/shared';
import { useRef, useState } from 'react';
import { api } from '../api.ts';
import { formatNumber, useLocale, useT } from '../i18n.tsx';
import { Button, Icon, Popover, toast } from '../ui/index.ts';
import { message } from './common.tsx';

export function BriefOffChip({ slug, creative, brief, actual, edited, disabled, onChanged }: {
  slug: string; creative: string; brief: Brief;
  /** The version's duration, seconds. */
  actual: number;
  /** The version comes from a direct edit. */
  edited: boolean;
  /** Why the brief cannot change now (the agent is working, a discarded variant): the fix is disabled with it. */
  disabled: string | null;
  onChanged(): void;
}) {
  const t = useT();
  const f = t.web.formatView;
  const locale = useLocale();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const fix = Math.min(600, Math.max(1, Math.round(actual)));
  const n = formatNumber(locale, brief.durationSec ?? 0, { maximumFractionDigits: 1 });
  const label = f.briefOff({ n });
  const save = async () => {
    setBusy(true);
    try {
      const { storePack: _pack, ...rest } = brief;
      await api.updateCreative(slug, creative, { brief: { ...rest, durationSec: fix } });
      setOpen(false);
      toast.show(f.briefOffFixed({ n: formatNumber(locale, fix) }), { tone: 'ok' });
      onChanged();
    } catch (e) {
      toast.show(f.briefOffFailed({ detail: message(e) }), { tone: 'neutral' });
    }
    setBusy(false);
  };
  return (
    <>
      <button ref={anchor} type="button" className="ms-pill ms-warn ms-brief-off" aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="warn" size={12} /><span className="ms-brief-off-text">{label}</span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} placement="bottom-start" width={300} label={label}>
        <div className="ms-brief-off-pop">
          <b>{label}</b>
          <p>{f.briefOffBody({ n, actual: formatNumber(locale, actual, { maximumFractionDigits: 1 }) })}</p>
          {edited ? <p>{f.briefOffEdited}</p> : null}
          {disabled !== null ? <p className="ms-brief-off-why" role="note">{disabled}</p> : null}
          <Button size="sm" variant="outline" loading={busy} disabled={disabled !== null} onClick={() => void save()}>{f.briefOffFix({ n: formatNumber(locale, fix) })}</Button>
        </div>
      </Popover>
    </>
  );
}
