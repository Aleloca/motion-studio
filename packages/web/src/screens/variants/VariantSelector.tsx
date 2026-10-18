// The chat's "Invia a · A · B · C · Tutte" selector (Phase 15, spec §4): a letter sends to that variant alone; "Tutte" sends the
// same request to every active variant. Discarded variants are not listed. Since decision 980 (phase 2 of the single agent) the
// chat itself is the group's, the same whatever is chosen: the selector only picks where a message goes, until the single
// agent (phase 3) replaces it.
import type { VariantGroup, VariantId } from '@motion-studio/shared';
import { useT } from '../../i18n.tsx';
import { Segmented } from '../../ui/index.ts';
import { upper } from './variantModel.ts';

export type ChatTarget = VariantId | 'all';

export interface VariantSelectorProps {
  group: VariantGroup;
  /** The variant a message goes to (this page's). */
  current: VariantId;
  /** "Tutte" is on: the composer sends to every active variant. */
  all: boolean;
  /** Letters whose folder is missing: listed in the group but not choosable. */
  missing?: readonly VariantId[];
  onSelect(target: ChatTarget): void;
}

export function VariantSelector({ group, current, all, missing = [], onSelect }: VariantSelectorProps) {
  const vg = useT().web.variantGroup;
  const active = group.members.filter((m) => m.status === 'active');
  // "Tutte" needs two variants that can really work: a member whose folder is missing does not count.
  const working = active.filter((m) => !missing.includes(m.letter));
  const options = [
    ...active.map((m) => ({ value: m.letter as ChatTarget, label: upper(m.letter), disabled: missing.includes(m.letter), ...(missing.includes(m.letter) ? { title: vg.missingFolder } : {}) })),
    ...(working.length > 1 ? [{ value: 'all' as ChatTarget, label: vg.selectorAll, title: vg.allHint }] : []),
  ];
  return (
    <div className="ms-vsel" data-variant-selector>
      <Segmented<ChatTarget> label={vg.selectorLabel} value={all ? 'all' : current} options={options} onChange={onSelect} />
      <p className="ms-vsel-hint" role="note">{all ? vg.allHint : vg.sendToHint({ letter: upper(current) })}</p>
    </div>
  );
}
