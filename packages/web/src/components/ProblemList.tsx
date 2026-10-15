// A list of composition problems where the user reads them (Phase 14, decision 767): SVG refusals as one translated summary
// per file with the English reasons behind "Details"; every other problem as the core wrote it.
import { useId, useMemo, useState } from 'react';
import { useT } from '../i18n.tsx';
import { groupProblems } from '../screens/svgRefusals.ts';
import { Button } from '../ui/index.ts';

export function ProblemList({ problems, className }: { problems: readonly string[]; className?: string }) {
  const items = useMemo(() => groupProblems(problems), [problems]);
  return (
    <ul className={className}>
      {items.map((it, i) => (it.kind === 'plain' ? <li key={`p${i}`}>{it.text}</li> : <SvgRefusal key={`s${i}`} file={it.file} reasons={it.reasons} />))}
    </ul>
  );
}

function SvgRefusal({ file, reasons }: { file: string; reasons: string[] }) {
  const t = useT();
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <li>
      <span>{t.composition.svgRefusedSummary({ file, count: reasons.length })}</span>{' '}
      <Button size="sm" variant="ghost" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>{t.composition.svgRefusedDetails}</Button>
      {open ? <ul id={id} lang="en">{reasons.map((r) => <li key={r}>{r}</li>)}</ul> : null}
    </li>
  );
}
