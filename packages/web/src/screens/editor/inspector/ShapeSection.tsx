import { COMPOSITION_BOUNDS, type Clip } from '@motion-studio/shared';
import { useT } from '../../../i18n.tsx';
import { ColorField, NumberField } from '../../../ui/index.ts';
import { Row, Section, type Ctl } from './common.tsx';
import { colorGroups } from './colors.ts';

export function ShapeSection({ ctl }: { ctl: Ctl }) {
  const e = useT().web.editor;
  const clip = ctl.clip as Extract<Clip, { type: 'shape' }>;
  const put = (field: string, patch: Record<string, unknown>) => ctl.run(field, { kind: 'clipProps', clipId: clip.id, props: patch }, `insp:${clip.id}:${field}`);
  return (
    <Section title={e.secShape} name="shape">
      <Row ctl={ctl} field="fill">
        <ColorField label={e.fColorHex} value={clip.props.fill} disabled={ctl.locked} invalid={ctl.problems('fill', ['fill']).length > 0} describedBy={ctl.errId('fill')}
          groups={colorGroups(e, ctl)} onChange={(hex) => put('fill', { fill: hex })} onEnd={ctl.end} />
      </Row>
      <Row ctl={ctl} field="radius">
        <NumberField label={e.fRadius} prefix="R" value={clip.props.radius ?? 0} min={0} max={COMPOSITION_BOUNDS.coord} step={1} disabled={ctl.locked} invalid={ctl.problems('radius', ['radius']).length > 0}
          describedBy={ctl.errId('radius')} onChange={(v) => put('radius', { radius: v })} onEnd={ctl.end} />
      </Row>
    </Section>
  );
}
