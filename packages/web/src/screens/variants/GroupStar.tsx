// The ★ of a board in a variant group (Phase 15, spec §5): chooses, for that format, the variant and version the group export
// takes. One ★ per format in the whole group: starring a board moves the group's ★ to it; a second click clears it. Decision 973:
// a labelled control ("★ Scegli" / "★ Scelta"), not a bare star, so the choice is found where the variants are compared.
import { useT } from '../../i18n.tsx';
import { Icon, cx } from '../../ui/index.ts';

export function GroupStar({ label, variant, n, picked, pending, onToggle }: { label: string; variant: string; n: number; picked: boolean; pending?: boolean; onToggle(): void }) {
  const vg = useT().web.variantGroup;
  const text = picked ? vg.starUsed({ label, variant, n }) : vg.starUse({ label, variant, n });
  return (
    <button type="button" className={cx('ms-vstar', picked && 'ms-on')} aria-pressed={picked} aria-label={text} title={text} disabled={pending}
      onClick={(e) => { e.stopPropagation(); onToggle(); }} onDoubleClick={(e) => e.stopPropagation()}>
      <Icon name="star" size={12} fill={picked} /><span className="ms-vstar-text" aria-hidden="true">{picked ? vg.chosen : vg.choose}</span>
    </button>
  );
}
