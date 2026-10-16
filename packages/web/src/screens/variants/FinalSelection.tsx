// "Selezione finale" (Phase 15, spec §5): a popover from the variant toolbar that lists, format by format, which variant and
// version the group export takes ("Formato · Variante B · v3"), or "regola predefinita" when the format has no ★.
import { useRef, useState } from 'react';
import { Button, Icon, Popover } from '../../ui/index.ts';
import { useT } from '../../i18n.tsx';
import { upper, type SelectionRow } from './variantModel.ts';

export function FinalSelection({ rows, label }: { rows: SelectionRow[]; label(format: string): string }) {
  const vg = useT().web.variantGroup;
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const text = (r: SelectionRow): string => {
    const format = label(r.format);
    if (r.source === 'pick') return vg.finalPick({ format, variant: upper(r.variant), n: r.n });
    return r.variant !== null && r.n !== null ? vg.finalDefaultFrom({ format, variant: upper(r.variant), n: r.n }) : vg.finalDefault({ format });
  };
  return (
    <>
      <Button ref={anchor} size="sm" variant="outline" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="star" size={13} />{vg.finalSelection}
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} placement="bottom-start" width={340} label={vg.finalSelection}>
        <div className="ms-vfinal">
          <b>{vg.finalSelection}</b>
          <p className="ms-vfinal-hint">{vg.finalHint}</p>
          {rows.length === 0 ? <p className="ms-vfinal-empty">{vg.finalEmpty}</p> : (
            <ul className="ms-vfinal-list" aria-label={vg.finalSelection}>
              {rows.map((r) => <li key={r.format} data-source={r.source}>{text(r)}</li>)}
            </ul>
          )}
        </div>
      </Popover>
    </>
  );
}
