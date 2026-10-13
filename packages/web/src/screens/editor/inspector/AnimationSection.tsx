// The IN and OUT animations of a clip: a preset and its duration. A slot holding a custom animation (a tween or keyframes
// the agent wrote) is shown as such and left alone: only the agent changes it.
import { ANIMATION_PRESETS, type AnimationPreset, type Clip } from '@motion-studio/shared';
import { useT } from '../../../i18n.tsx';
import { NumberField, Select } from '../../../ui/index.ts';
import { Row, Section, type Ctl } from './common.tsx';

type Anim = NonNullable<Extract<Clip, { animations?: unknown }>['animations']>[number];
const EPS = 1e-4;
const DEFAULT_DURATION = 0.4;

/** The animation in a slot: `in` starts with the clip, `out` ends with it (the same rule as `applyEdit`). */
export function slotOf(clip: Exclude<Clip, { type: 'audio' }>, slot: 'in' | 'out'): { preset: Extract<Anim, { preset: string }> | null; custom: boolean } {
  const list = clip.animations ?? [];
  const inSlot = (a: Anim) => (slot === 'in' ? (a.start ?? 0) <= EPS : (a.start ?? 0) > EPS && Math.abs((a.start ?? 0) + a.duration - clip.duration) <= EPS);
  const occupying = list.filter(inSlot);
  const preset = occupying.find((a): a is Extract<Anim, { preset: string }> => 'preset' in a) ?? null;
  return { preset, custom: !preset && occupying.length > 0 };
}

export function AnimationSection({ ctl }: { ctl: Ctl }) {
  const e = useT().web.editor;
  const clip = ctl.clip as Exclude<Clip, { type: 'audio' }>;
  const names: Record<AnimationPreset, string> = {
    fadeIn: e.presetFadeIn, fadeOut: e.presetFadeOut, slideUp: e.presetSlideUp, slideDown: e.presetSlideDown, slideLeft: e.presetSlideLeft,
    slideRight: e.presetSlideRight, popIn: e.presetPopIn, scaleIn: e.presetScaleIn, wipe: e.presetWipe,
  };
  const options = [{ value: 'none', label: e.animNone }, ...ANIMATION_PRESETS.map((p) => ({ value: p, label: names[p] }))];
  const slots = [{ slot: 'in' as const, label: e.animIn }, { slot: 'out' as const, label: e.animOut }];
  const set = (slot: 'in' | 'out', preset: AnimationPreset | null, duration: number, coalesce?: string) =>
    ctl.run(`anim-${slot}`, { kind: 'animationPreset', clipId: clip.id, slot, preset, duration }, coalesce);
  return (
    <Section title={e.secAnimation} name="animation">
      {slots.map(({ slot, label }) => {
        const { preset, custom } = slotOf(clip, slot);
        const field = `anim-${slot}`;
        if (custom) {
          return <Row key={slot} ctl={ctl} field={field}><div className="ms-insp-slot"><b>{label}</b><p className="ms-insp-note">{e.animCustom}</p></div></Row>;
        }
        return (
          <Row key={slot} ctl={ctl} field={field}>
            <div className="ms-insp-slot">
              <b className="ms-insp-slot-name">{label}</b>
              <Select label={`${e.secAnimation} · ${label}`} value={preset?.preset ?? 'none'} options={options} disabled={ctl.locked}
                onChange={(v) => { set(slot, v === 'none' ? null : (v as AnimationPreset), preset?.duration ?? Math.min(DEFAULT_DURATION, clip.duration)); ctl.end(); }} />
              <NumberField label={`${e.animDuration} · ${label}`} prefix="s" value={preset?.duration ?? null} startAt={DEFAULT_DURATION} min={0.05} max={clip.duration} step={0.05} decimals={2}
                disabled={ctl.locked || !preset} onChange={(v) => { if (preset) set(slot, preset.preset, v, `insp:${clip.id}:${field}`); }} onEnd={ctl.end} />
            </div>
          </Row>
        );
      })}
    </Section>
  );
}
