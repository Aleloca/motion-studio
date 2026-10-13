import { COMPOSITION_BOUNDS, type Clip } from '@motion-studio/shared';
import { useT } from '../../../i18n.tsx';
import { NumberField, Slider } from '../../../ui/index.ts';
import { Row, Section, type Ctl } from './common.tsx';
import { ReplaceFile } from './ReplaceFile.tsx';

export function AudioSection({ ctl }: { ctl: Ctl }) {
  const e = useT().web.editor;
  const clip = ctl.clip as Extract<Clip, { type: 'audio' }>;
  const volume = clip.volume ?? 1;
  const put = (field: string, patch: { volume?: number; fadeIn?: number; fadeOut?: number }) => ctl.run(field, { kind: 'clipMedia', clipId: clip.id, ...patch }, `insp:${clip.id}:${field}`);
  const bad = (f: string) => ctl.problems(f, [f]).length > 0;
  return (
    <Section title={e.secAudio} name="audio">
      <Row ctl={ctl} field="src">
        <ReplaceFile kinds={['audio']} current={clip.src} disabled={ctl.locked} describedBy={ctl.errId('src')}
          onStaged={(s) => { ctl.run('src', { kind: 'clipMedia', clipId: clip.id, src: s.path }); ctl.end(); }} />
      </Row>
      <Row ctl={ctl} field="volume">
        <div className="ms-insp-vol">
          <NumberField label={e.fVolume} prefix="VOL" value={volume} min={0} max={COMPOSITION_BOUNDS.volume} step={0.05} decimals={2} disabled={ctl.locked} invalid={bad('volume')} describedBy={ctl.errId('volume')}
            onChange={(v) => put('volume', { volume: v })} onEnd={ctl.end} />
          <Slider label={e.fVolume} value={volume} min={0} max={COMPOSITION_BOUNDS.volume} step={0.05} disabled={ctl.locked} valueText={`${Math.round(volume * 100)}%`} className="ms-insp-slider" onChange={(v) => put('volume', { volume: v })} />
        </div>
      </Row>
      <div className="ms-insp-grid2">
        <Row ctl={ctl} field="fadeIn">
          <NumberField label={e.fFadeIn} prefix={e.tagIn} unit="s" value={clip.fadeIn ?? 0} min={0} max={clip.duration} step={0.1} decimals={2} disabled={ctl.locked} invalid={bad('fadeIn')}
            describedBy={ctl.errId('fadeIn')} onChange={(v) => put('fadeIn', { fadeIn: v })} onEnd={ctl.end} />
        </Row>
        <Row ctl={ctl} field="fadeOut">
          <NumberField label={e.fFadeOut} prefix={e.tagOut} unit="s" value={clip.fadeOut ?? 0} min={0} max={clip.duration} step={0.1} decimals={2} disabled={ctl.locked} invalid={bad('fadeOut')}
            describedBy={ctl.errId('fadeOut')} onChange={(v) => put('fadeOut', { fadeOut: v })} onEnd={ctl.end} />
        </Row>
      </div>
    </Section>
  );
}
