import { useT } from '../../../i18n.tsx';
import { NumberField } from '../../../ui/index.ts';
import { useEditor } from '../editorContext.ts';
import { Row, Section, type Ctl } from './common.tsx';

/** IN, DUR and OUT of a clip (video compositions only; a still image has no timeline). */
export function TimingSection({ ctl }: { ctl: Ctl }) {
  const e = useT().web.editor;
  const { draft } = useEditor();
  const { clip } = ctl;
  const total = draft.composition.duration;
  const step = Math.round((1 / draft.composition.fps) * 1e4) / 1e4;
  const key = `insp:${clip.id}:timing`;
  const apply = (start: number, duration: number) => ctl.run('timing', { kind: 'clipTiming', clipId: clip.id, start, duration, ripple: false }, key);
  const out = Math.round((clip.start + clip.duration) * 1e6) / 1e6;
  const bad = ctl.problems('timing', ['start', 'duration']).length > 0;
  const common = { step, decimals: 3, disabled: ctl.locked, invalid: bad, describedBy: ctl.errId('timing'), onEnd: ctl.end, unit: 's' } as const;
  return (
    <Section title={e.secTiming} name="timing">
      <Row ctl={ctl} field="timing" fields={['start', 'duration']}>
        <div className="ms-insp-grid3">
          <NumberField {...common} prefix={e.tagIn} label={e.fIn} value={clip.start} min={0} max={total} onChange={(v) => apply(v, clip.duration)} />
          <NumberField {...common} prefix={e.tagDur} label={e.fDur} value={clip.duration} min={0} max={total} onChange={(v) => apply(clip.start, v)} />
          <NumberField {...common} prefix={e.tagOut} label={e.fOut} value={out} min={0} max={total} onChange={(v) => apply(clip.start, v - clip.start)} />
        </div>
      </Row>
    </Section>
  );
}
