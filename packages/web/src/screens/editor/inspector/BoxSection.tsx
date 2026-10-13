import { COMPOSITION_BOUNDS } from '@motion-studio/shared';
import { useT } from '../../../i18n.tsx';
import { NumberField, Slider } from '../../../ui/index.ts';
import { useEditor } from '../editorContext.ts';
import { Row, Section, type Ctl } from './common.tsx';

const BOX_BOUNDS = COMPOSITION_BOUNDS;

/**
 * X, Y, W, H, rotation and opacity: the keyboard path for every boxed clip (↑ ↓ step, Shift ×10, Enter / Escape). There is no
 * scale here (spec §6). A text clip has no width or height of its own until one is typed.
 */
export function BoxSection({ ctl }: { ctl: Ctl }) {
  const e = useT().web.editor;
  const { draft } = useEditor();
  const { clip } = ctl;
  const props = ((clip as { props?: Record<string, number | undefined> }).props ?? {});
  const comp = draft.composition;
  const text = clip.type === 'text';
  const put = (field: string, v: number) => ctl.run(field, { kind: 'clipProps', clipId: clip.id, props: { [field]: v } }, `insp:${clip.id}:${field}`);
  const common = (field: string) => ({ disabled: ctl.locked, invalid: ctl.problems(field, [field]).length > 0, describedBy: ctl.errId(field), onEnd: ctl.end }) as const;
  return (
    <Section title={e.secBox} name="box">
      <div className="ms-insp-grid2">
        <Row ctl={ctl} field="x"><NumberField {...common('x')} prefix={e.tagX} label={e.fX} value={props.x ?? 0} min={-BOX_BOUNDS.coord} max={BOX_BOUNDS.coord} step={1} onChange={(v) => put('x', v)} /></Row>
        <Row ctl={ctl} field="y"><NumberField {...common('y')} prefix={e.tagY} label={e.fY} value={props.y ?? 0} min={-BOX_BOUNDS.coord} max={BOX_BOUNDS.coord} step={1} onChange={(v) => put('y', v)} /></Row>
        <Row ctl={ctl} field="width"><NumberField {...common('width')} prefix={e.tagW} label={e.fW} value={props.width ?? (text ? null : comp.width)} startAt={comp.width} min={0} max={BOX_BOUNDS.size} step={1} onChange={(v) => put('width', v)} /></Row>
        <Row ctl={ctl} field="height"><NumberField {...common('height')} prefix={e.tagH} label={e.fH} value={props.height ?? (text ? null : comp.height)} startAt={comp.height} min={0} max={BOX_BOUNDS.size} step={1} onChange={(v) => put('height', v)} /></Row>
        <Row ctl={ctl} field="rotation"><NumberField {...common('rotation')} prefix={e.tagRot} label={e.fRotation} unit="°" value={props.rotation ?? 0} min={-BOX_BOUNDS.rotation} max={BOX_BOUNDS.rotation} step={1} onChange={(v) => put('rotation', v)} /></Row>
        <Row ctl={ctl} field="opacity"><NumberField {...common('opacity')} prefix="%" label={e.fOpacityField} value={props.opacity ?? 1} min={0} max={1} step={0.01} decimals={2} onChange={(v) => put('opacity', v)} /></Row>
      </div>
      <Slider label={e.fOpacity} value={props.opacity ?? 1} min={0} max={1} step={0.01} valueText={`${Math.round((props.opacity ?? 1) * 100)}%`} disabled={ctl.locked}
        className="ms-insp-slider" onChange={(v) => { put('opacity', v); }} />
    </Section>
  );
}
