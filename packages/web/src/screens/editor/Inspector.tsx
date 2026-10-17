// The inspector (Phase 10b, Task 8): the sections of the selected clip, only those the spec's editable list allows (§6).
// Every field edits through the draft's `apply` (one rule set with the core); numbers are clamped to the schema bounds by the
// controls and again by `applyEdit`; a refusal is shown, translated, under the field that caused it, together with the
// problems `validateComposition` finds about that field. Edits of one gesture (typing, arrows, a slider) share a coalesce key,
// so a burst is one undo step.
import { editProblemText, type Clip, type EditOp, type EditResult } from '@motion-studio/shared';
import { useCallback, useMemo, useState } from 'react';
import { useLocale, useT } from '../../i18n.tsx';
import { Empty, Icon } from '../../ui/index.ts';
import { useEditor } from './editorContext.ts';
import { clipLabel } from './LayersPanel.tsx';
import { findClip } from './Stage.tsx';
import { AnimationSection } from './inspector/AnimationSection.tsx';
import { AudioSection } from './inspector/AudioSection.tsx';
import { BoxSection } from './inspector/BoxSection.tsx';
import { compositionColors } from './inspector/colors.ts';
import type { Ctl } from './inspector/common.tsx';
import { MediaSection } from './inspector/MediaSection.tsx';
import { ParamsSection } from './inspector/ParamsSection.tsx';
import { fieldProblems } from './inspector/problems.ts';
import { ShapeSection } from './inspector/ShapeSection.tsx';
import { SvgContentSection } from './inspector/SvgContentSection.tsx';
import { TextSection } from './inspector/TextSection.tsx';
import { TimingSection } from './inspector/TimingSection.tsx';
import { useBrand } from './inspector/useBrand.ts';

function InspectorBody({ clip, locked }: { clip: Clip; locked: boolean }) {
  const t = useT();
  const e = t.web.editor;
  const locale = useLocale();
  const { slug, draft, actions } = useEditor();
  const brand = useBrand(slug);
  const comp = draft.composition;
  const [refused, setRefused] = useState<Record<string, string>>({});

  const run = useCallback((field: string, op: EditOp, coalesce?: string): EditResult => {
    const r = actions.apply(op, coalesce !== undefined ? { coalesce } : undefined);
    setRefused((prev) => {
      const next = { ...prev };
      if (r.ok) delete next[field]; else next[field] = editProblemText(r.problem, locale);
      return next;
    });
    return r;
  }, [actions, locale]);

  const palette = useMemo(() => compositionColors(comp), [comp]);
  const problems = useCallback((field: string, names: readonly string[]): string[] => {
    const out: string[] = [];
    if (refused[field]) out.push(refused[field]!);
    for (const text of fieldProblems(draft.problems, comp, clip.id, names, locale)) if (!out.includes(text)) out.push(text);
    return out;
  }, [refused, draft.problems, comp, clip.id, locale]);

  const ctl: Ctl = {
    clip, locked, run, end: actions.endRun, problems,
    refuse: (field, text) => setRefused((prev) => ({ ...prev, [field]: text })),
    errId: (field) => `insp-${clip.id}-${field}-err`.replace(/[^A-Za-z0-9_-]/g, '_'),
    brandColors: brand.colors, compositionColors: palette, problemsOf: draft.problems,
  };
  const video = comp.duration > 0;
  const kinds: Record<Clip['type'], string> = {
    text: e.clipText, shape: e.clipShape, image: e.clipImage, svg: e.clipSvg, video: e.clipVideo, html: e.clipHtml, audio: e.clipAudio,
  };
  return (
    <div className="ms-insp" data-clip-type={clip.type}>
      <header className="ms-insp-head">
        <b className="ms-insp-name">{clipLabel(clip, comp, e)}</b>
        <span className="ms-insp-kind">{kinds[clip.type]}</span>
      </header>
      {locked ? <p className="ms-insp-locked" role="status"><Icon name="lock" size={13} />{e.inspLocked}</p> : null}
      {video ? <TimingSection ctl={ctl} /> : null}
      {clip.type !== 'audio' ? <BoxSection ctl={ctl} /> : null}
      {clip.type === 'text' ? <TextSection ctl={ctl} brand={brand} /> : null}
      {clip.type === 'shape' ? <ShapeSection ctl={ctl} /> : null}
      {clip.type === 'image' || clip.type === 'svg' || clip.type === 'video' ? <MediaSection ctl={ctl} /> : null}
      {clip.type === 'svg' ? <SvgContentSection ctl={ctl} /> : null}
      {clip.type === 'audio' ? <AudioSection ctl={ctl} /> : null}
      {clip.type === 'html' ? <ParamsSection ctl={ctl} /> : null}
      {video && clip.type !== 'audio' ? <AnimationSection ctl={ctl} /> : null}
    </div>
  );
}

export function Inspector() {
  const e = useT().web.editor;
  const { draft, selection } = useEditor();
  const found = findClip(draft.composition.tracks, selection);
  if (!found) {
    return (
      <div className="ms-insp-empty" data-slot="inspector">
        <Empty icon="cursor" title={e.inspEmptyTitle} sub={e.inspEmptySub} />
      </div>
    );
  }
  // A new clip is a new inspector: no refusal or half-typed value carries over.
  return <div data-slot="inspector" className="ms-insp-wrap"><InspectorBody key={found.clip.id} clip={found.clip} locked={found.locked} /></div>;
}
