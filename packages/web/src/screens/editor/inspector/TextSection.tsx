import { COMPOSITION_LIMITS, type Clip } from '@motion-studio/shared';
import { useState } from 'react';
import { useT } from '../../../i18n.tsx';
import { ColorField, NumberField, Segmented, Select, Textarea, type SelectOption } from '../../../ui/index.ts';
import { useEditor } from '../editorContext.ts';
import { Row, Section, type Ctl } from './common.tsx';
import type { BrandInfo } from './useBrand.ts';
import { colorGroups } from './colors.ts';

type TextClip = Extract<Clip, { type: 'text' }>;
const weightOf = (w: number | 'normal' | 'bold' | undefined): number => (w === 'bold' ? 700 : typeof w === 'number' ? w : 400);
const nearest = (w: number, list: readonly number[]): number => list.reduce((best, x) => (Math.abs(x - w) < Math.abs(best - w) ? x : best), list[0] ?? 400);

/** Content, font (the composition's and the brand kit's, grouped), weight (only the font's), size, colour and alignment. */
export function TextSection({ ctl, brand }: { ctl: Ctl; brand: BrandInfo }) {
  const e = useT().web.editor;
  const { draft, stageAsset } = useEditor();
  const clip = ctl.clip as TextClip;
  const comp = draft.composition;
  const [adding, setAdding] = useState<string | null>(null);
  const props = clip.props;
  const current = props.fontFamily ?? comp.fonts[0]?.family ?? '';
  const put = (field: string, patch: Record<string, unknown>, coalesce?: string) => ctl.run(field, { kind: 'clipProps', clipId: clip.id, props: patch }, coalesce);

  // The composition's families first, then the brand kit's not declared yet (their file is staged when chosen).
  const families = [...new Map(comp.fonts.map((f) => [f.family.toLowerCase(), f.family])).values()];
  // A family the clip names without declaring it is still shown (the problem under the field says so).
  if (current && !families.some((f) => f.toLowerCase() === current.toLowerCase())) families.unshift(current);
  const brandOnly = draft.fonts.filter((f) => f.source === 'brand' && !families.some((x) => x.toLowerCase() === f.family.toLowerCase()));
  const options: SelectOption<string>[] = [
    ...families.map((f) => ({ value: `c:${f}`, label: f, group: e.fontsComposition })),
    ...brandOnly.map((f) => {
      const noFile = brand.fonts?.find((b) => b.id === f.brandFontId)?.file === null;
      return { value: `b:${f.brandFontId ?? f.family}`, label: f.family, group: e.fontsBrand, disabled: noFile, hint: noFile ? e.fontNoFile : undefined };
    }),
  ];
  const selected = `c:${families.find((f) => f.toLowerCase() === current.toLowerCase()) ?? current}`;

  // Weights: only those the font declares (a brand font just added keeps the weights the kit lists for it).
  const weightsOf = (family: string): number[] => {
    const lower = family.toLowerCase();
    const kit = draft.fonts.find((f) => f.source === 'brand' && f.family.toLowerCase() === lower && f.weights.length > 0);
    const list = kit ? kit.weights : comp.fonts.filter((f) => f.family.toLowerCase() === lower).map((f) => weightOf(f.weight));
    return [...new Set(list.length > 0 ? list : [400])].sort((a, b) => a - b);
  };
  const weights = weightsOf(current);
  const weight = weightOf(props.fontWeight);

  const useFamily = (family: string) => {
    const list = weightsOf(family);
    const w = weightOf(props.fontWeight);
    put('fontFamily', list.includes(w) ? { fontFamily: family } : { fontFamily: family, fontWeight: nearest(w, list) });
    ctl.end();
  };
  const chooseFont = async (value: string) => {
    if (value.startsWith('c:')) { useFamily(value.slice(2)); return; }
    const option = brandOnly.find((f) => `b:${f.brandFontId ?? f.family}` === value);
    if (!option?.brandFontId) return;
    setAdding(option.family);
    try {
      const staged = await stageAsset({ kind: 'brandFont', id: option.brandFontId });
      if (!staged) return;
      const added = ctl.run('fontFamily', { kind: 'addFont', font: { family: option.family, src: staged.path } });
      if (!added.ok && added.problem.key !== 'editor.fontExists') return;
      useFamily(option.family);
    } finally {
      setAdding(null);
    }
  };

  const off = ctl.locked;
  const bad = (f: string) => ctl.problems(f, [f]).length > 0;
  return (
    <Section title={e.secText} name="text">
      <Row ctl={ctl} field="text">
        <Textarea aria-label={e.fContent} rows={3} maxLength={COMPOSITION_LIMITS.text} value={props.text} disabled={off} aria-describedby={ctl.errId('text')}
          onChange={(ev) => put('text', { text: ev.target.value }, `insp:${clip.id}:text`)} onBlur={ctl.end} />
      </Row>
      <Row ctl={ctl} field="fontFamily">
        <Select label={e.fFont} value={selected} options={options.length > 0 ? options : [{ value: selected, label: current }]} disabled={off || adding !== null} onChange={(v) => void chooseFont(v)} />
        {adding ? <p className="ms-insp-note" role="status">{e.fontAdding({ family: adding })}</p> : null}
      </Row>
      <div className="ms-insp-grid2">
        <Row ctl={ctl} field="fontWeight">
          <Select label={e.fWeight} value={String(weight)} display={String(weight)} options={weights.map((w) => ({ value: String(w), label: String(w) }))} disabled={off}
            onChange={(v) => { put('fontWeight', { fontWeight: Number(v) }); ctl.end(); }} />
        </Row>
        <Row ctl={ctl} field="fontSize">
          <NumberField label={e.fSize} prefix="PX" value={props.fontSize ?? null} startAt={48} min={1} max={2000} step={1} disabled={off} invalid={bad('fontSize')} describedBy={ctl.errId('fontSize')}
            onChange={(v) => put('fontSize', { fontSize: v }, `insp:${clip.id}:fontSize`)} onEnd={ctl.end} />
        </Row>
      </div>
      <Row ctl={ctl} field="color">
        <ColorField label={e.fColorHex} value={props.color} disabled={off} invalid={bad('color')} describedBy={ctl.errId('color')}
          groups={colorGroups(e, ctl)} onChange={(hex) => put('color', { color: hex }, `insp:${clip.id}:color`)} onEnd={ctl.end} />
      </Row>
      <Row ctl={ctl} field="align">
        <Segmented label={e.fAlign} value={props.align ?? 'left'} disabled={off}
          options={[{ value: 'left', label: e.alignLeft }, { value: 'center', label: e.alignCenter }, { value: 'right', label: e.alignRight }]}
          onChange={(v) => { put('align', { align: v }); ctl.end(); }} />
      </Row>
    </Section>
  );
}
