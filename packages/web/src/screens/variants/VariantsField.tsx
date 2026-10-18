// New creative · "Varianti" (Phase 15, spec §3): how many variants the first generation makes (1 to 5) and, from 2 up, an
// optional direction for each one. A direction left empty is proposed by the agent in a short turn before the generation (the
// user's words always win). There is no cap on a group (decision 978): more variants are added later from the variants page;
// 1 to 5 is only the size of the first generation, like an identity's concepts (decision 1154).
import { variantIdAt } from '@motion-studio/shared';
import { useT } from '../../i18n.tsx';
import { Input, Segmented } from '../../ui/index.ts';
import { DIRECTION_MAX, upper } from './variantModel.ts';

type Count = '1' | '2' | '3' | '4' | '5';
const COUNTS: readonly Count[] = ['1', '2', '3', '4', '5'];
const FIRST_MAX = COUNTS.length;

export interface VariantsFieldProps {
  count: number;
  /** Absent: the count is asked elsewhere (a logo from scratch asks it inside "Partenza"); only the directions show here. */
  onCount?(n: number): void;
  directions: string[];
  onDirections(next: string[]): void;
  /** The directions cannot be applied (the creative was made from a brand logo, ...): never the case today. */
  disabled?: boolean;
}

export function VariantsField({ count, onCount, directions, onDirections, disabled }: VariantsFieldProps) {
  const vg = useT().web.variantGroup;
  const set = (i: number, text: string) => {
    const next = [...directions];
    while (next.length <= i) next.push('');
    next[i] = text;
    onDirections(next);
  };
  return (
    <div className="ms-nc-variants" role="group" aria-label={vg.variants}>
      {onCount ? (
        <>
          <span className="ms-nc-lbl">{vg.variants} <span className="ms-nc-faint">{vg.fieldHint}</span></span>
          <Segmented<Count> label={vg.variants} value={String(Math.min(FIRST_MAX, Math.max(1, count))) as Count} disabled={disabled}
            onChange={(v) => onCount(Number(v))} options={COUNTS.map((n) => ({ value: n, label: n }))} />
        </>
      ) : null}
      {count >= 2 ? (
        <div className="ms-nc-vdirs">
          {Array.from({ length: count }, (_, i) => variantIdAt(i)).map((letter, i) => (
            <div key={letter} className="ms-nc-vdir">
              <label htmlFor={`ms-nc-dir-${letter}`}>{vg.directionOf({ letter: upper(letter) })}</label>
              <Input id={`ms-nc-dir-${letter}`} value={directions[i] ?? ''} maxLength={DIRECTION_MAX} disabled={disabled} placeholder={vg.directionPlaceholder}
                onChange={(e) => set(i, e.target.value)} />
            </div>
          ))}
          <span className="ms-nc-faint ms-nc-small">{vg.directionAuto}</span>
        </div>
      ) : null}
    </div>
  );
}
