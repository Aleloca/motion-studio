// The fill and the stroke of one element of an svg clip (user test item 14): two labelled rows, each a free picker and a hex
// field when it has a colour (and a way to remove it), or what it is instead ("No stroke", "No fill", from its group, a
// gradient) with a button that gives it a colour. The swatches (brand palette, composition) are shown once, for the row in
// use: the last one focused or clicked, the fill to start with (the stroke when the fill has no colour and the stroke has).
import { parseColor } from '@motion-studio/shared';
import { useState } from 'react';
import { useT } from '../../../i18n.tsx';
import { Button, ColorField, ColorSwatches, Icon, cx, type ColorSwatchGroup } from '../../../ui/index.ts';

type Prop = 'fill' | 'stroke';

/** What a paint value is: a colour, `none`, unset (the fill comes from the group; a stroke is none), or anything else. */
function kindOf(v: string | undefined): 'colour' | 'none' | 'unset' | 'other' {
  if (v === undefined) return 'unset';
  if (v.trim().toLowerCase() === 'none') return 'none';
  return parseColor(v) ? 'colour' : 'other';
}

export function PaintFields({ fill, stroke, groups, disabled, onChange }: {
  fill: string | undefined; stroke: string | undefined; groups: readonly ColorSwatchGroup[]; disabled: boolean;
  /** A colour (`#rrggbb`…) or `none`. */
  onChange(prop: Prop, value: string): void;
}) {
  const e = useT().web.editor;
  const kinds: Record<Prop, ReturnType<typeof kindOf>> = { fill: kindOf(fill), stroke: kindOf(stroke) };
  const values: Record<Prop, string | undefined> = { fill, stroke };
  const [chosen, setChosen] = useState<Prop | null>(null);
  const active: Prop = chosen ?? (kinds.fill !== 'colour' && kinds.stroke === 'colour' ? 'stroke' : 'fill');
  const firstSwatch = groups.flatMap((g) => g.colors)[0] ?? '#000000'; // color-data: the colour a new fill or stroke starts from
  const labels: Record<Prop, string> = { fill: e.svgFill, stroke: e.svgStroke };

  const row = (prop: Prop) => {
    const kind = kinds[prop];
    const name = labels[prop];
    const none = prop === 'fill' ? (kind === 'unset' ? e.svgFillInherited : e.svgNoFill) : e.svgNoStroke;
    const add = prop === 'fill' ? (kind === 'none' ? e.svgAddFill : e.svgSetColour) : e.svgAddStroke;
    return (
      <div key={prop} className={cx('ms-paint-row', active === prop && 'ms-on')} data-paint={prop}
        onFocusCapture={() => setChosen(prop)} onPointerDownCapture={() => setChosen(prop)}>
        <span className="ms-insp-cap ms-paint-cap" aria-hidden="true">{name}</span>
        {kind === 'colour' ? (
          <>
            <ColorField className="ms-paint-field" label={name} value={values[prop]} disabled={disabled} onChange={(hex) => onChange(prop, hex)} />
            <Button size="sm" variant="ghost" icon aria-label={prop === 'fill' ? e.svgRemoveFill : e.svgRemoveStroke} title={prop === 'fill' ? e.svgRemoveFill : e.svgRemoveStroke}
              disabled={disabled} onClick={() => onChange(prop, 'none')}><Icon name="close" size={13} /></Button>
          </>
        ) : (
          <>
            <span className="ms-paint-none" role="status" aria-label={`${name}: ${kind === 'other' ? e.svgPaintOther : none}`}>
              <span className={cx('ms-paint-chip', kind === 'other' ? 'ms-other' : 'ms-empty')} aria-hidden="true" />
              {kind === 'other' ? e.svgPaintOther : none}
            </span>
            <Button size="sm" variant="outline" disabled={disabled} onClick={() => { setChosen(prop); onChange(prop, firstSwatch); }}>
              <Icon name="plus" size={12} />{kind === 'other' ? e.svgSetColour : add}
            </Button>
          </>
        )}
      </div>
    );
  };

  return (
    <div className="ms-paint" role="group" aria-label={e.svgPaint}>
      {row('fill')}
      {row('stroke')}
      {groups.some((g) => g.colors.length > 0) ? (
        <div className="ms-paint-swatches">
          <span className="ms-paint-for">{e.svgPaletteFor({ field: labels[active] })}</span>
          <ColorSwatches groups={groups} value={kinds[active] === 'colour' ? values[active] : undefined} disabled={disabled}
            onPick={(hex) => { if (values[active]?.toLowerCase() !== hex.toLowerCase()) onChange(active, hex); }} />
        </div>
      ) : null}
    </div>
  );
}
