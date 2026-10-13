// Media of a clip: image, vector image and video take Replace…; a video also trims and sets its volume. A replacement video
// shorter than `trimStart + clip duration` shows a warning and offers "Fit clip to video" (a timing edit): the clip is never cut silently.
import type { Clip, StagedAsset } from '@motion-studio/shared';
import { useT } from '../../../i18n.tsx';
import { Button, NumberField, Slider } from '../../../ui/index.ts';
import { useEditor } from '../editorContext.ts';
import { Row, Section, type Ctl } from './common.tsx';
import { ReplaceFile } from './ReplaceFile.tsx';

type MediaClip = Extract<Clip, { type: 'image' | 'svg' | 'video' }>;
const KINDS = { image: ['image'], svg: ['svg'], video: ['video'] } as const;
const r3 = (n: number) => Math.round(n * 1e3) / 1e3;

export function MediaSection({ ctl }: { ctl: Ctl }) {
  const e = useT().web.editor;
  const { draft } = useEditor();
  const clip = ctl.clip as MediaClip;
  const video = clip.type === 'video';
  const trim = video ? clip.trimStart ?? 0 : 0;
  const volume = video ? clip.volume ?? 1 : 1;
  const put = (field: string, patch: { trimStart?: number; volume?: number }) => ctl.run(field, { kind: 'clipMedia', clipId: clip.id, ...patch }, `insp:${clip.id}:${field}`);

  // The staged file this clip points to knows its length: warn when the clip would outrun it.
  const staged = video ? draft.staged.find((s) => s.path === clip.src) : undefined;
  const needed = trim + clip.duration;
  const short = staged?.durationSec != null && staged.durationSec + 1e-3 < needed ? staged.durationSec : null;
  const fit = () => {
    if (short === null) return;
    ctl.run('timing', { kind: 'clipTiming', clipId: clip.id, start: clip.start, duration: Math.max(r3(short - trim), 0), ripple: false });
    ctl.end();
  };
  const replaced = (s: StagedAsset) => { ctl.run('src', { kind: 'clipMedia', clipId: clip.id, src: s.path }); ctl.end(); };
  return (
    <Section title={e.secMedia} name="media">
      <Row ctl={ctl} field="src">
        <ReplaceFile kinds={KINDS[clip.type]} current={clip.src} disabled={ctl.locked} describedBy={ctl.errId('src')} onStaged={replaced} />
      </Row>
      {short !== null ? (
        <div className="ms-insp-warn" role="alert">
          <p>{e.shortVideo({ video: String(r3(short)), needed: String(r3(needed)) })}</p>
          <Button size="sm" variant="outline" disabled={ctl.locked} onClick={fit}>{e.fitClip}</Button>
        </div>
      ) : null}
      {video ? (
        <>
          <Row ctl={ctl} field="trimStart">
            <NumberField label={e.fTrimStart} prefix={e.tagIn} unit="s" value={trim} min={0} max={36_000} step={0.1} decimals={3} disabled={ctl.locked}
              invalid={ctl.problems('trimStart', ['trimStart']).length > 0} describedBy={ctl.errId('trimStart')} onChange={(v) => put('trimStart', { trimStart: v })} onEnd={ctl.end} />
          </Row>
          <Row ctl={ctl} field="volume">
            <div className="ms-insp-vol">
              <NumberField label={e.fVolume} prefix="VOL" value={volume} min={0} max={2} step={0.05} decimals={2} disabled={ctl.locked}
                invalid={ctl.problems('volume', ['volume']).length > 0} describedBy={ctl.errId('volume')} onChange={(v) => put('volume', { volume: v })} onEnd={ctl.end} />
              <Slider label={e.fVolume} value={volume} min={0} max={2} step={0.05} disabled={ctl.locked} valueText={`${Math.round(volume * 100)}%`} className="ms-insp-slider" onChange={(v) => put('volume', { volume: v })} />
            </div>
          </Row>
        </>
      ) : null}
    </Section>
  );
}
