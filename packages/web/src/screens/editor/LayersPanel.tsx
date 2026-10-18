// The image editor's layers panel (Phase 10b, Task 9): the tracks of the still composition in stacking order (the schema's
// LAST track is on top, as in the timeline lanes, so the list is reversed), a 44 px row per layer with an eye, the kind icon
// (the thumbnail), the name, the kind and a lock. A track with one clip is one row and its eye and lock are the track's flags
// (`trackFlags`); a track with several clips is a header row with the track's flags and the clips nested under it, each with
// its own (`clipFlags`). A flag the agent wrote on the clip itself of a one-clip layer shows too, and turning it off clears it.
// A click selects the clip; a locked layer can be selected (its handles say it is locked). No "+": new layers stay with the agent.
// A vector-image (svg) layer opens like a design tool's tree (user test item 12): its elements are rows nested under it, each
// with its eye (an edit of the SVG, staged by the clip's session: svgSessions.tsx), and a click on one shows its own inspector.
import { setHidden, type Clip, type Composition, type EditOp, type SvgElement, type Track, editProblemText } from '@motion-studio/shared';
import { useState } from 'react';
import { useLocale, useT } from '../../i18n.tsx';
import { Button, Icon, cx, type IconName } from '../../ui/index.ts';
import { useEditor } from './editorContext.ts';
import { svgElementName } from './inspector/SvgContentSection.tsx';
import { useSvgSession, useSvgTree } from './svgSessions.tsx';

const CLIP_ICON: Record<Clip['type'], IconName> = { text: 'text', shape: 'grid', image: 'image', svg: 'image', video: 'video', html: 'code', audio: 'music' };

type Flag = 'hidden' | 'locked';

/**
 * The name a clip shows in the editor: its own, else its id; the hidden versions of an identity logo (the `small` and `dark`
 * svg clips of a still) get readable names (SVG inner editor, spec 4.3).
 */
export function clipLabel(clip: Clip, c: Composition, e: { layerSmall: string; layerDark: string }): string {
  if (clip.name) return clip.name;
  if (c.duration === 0 && clip.type === 'svg' && clip.id === 'small') return e.layerSmall;
  if (c.duration === 0 && clip.type === 'svg' && clip.id === 'dark') return e.layerDark;
  return clip.id;
}

interface RowProps {
  name: string;
  kind: string;
  icon: IconName;
  hidden: boolean;
  locked: boolean;
  selected?: boolean;
  nested?: boolean;
  /** Null: a track header, which does not select. */
  onSelect: (() => void) | null;
  onFlag(flag: Flag, value: boolean): void;
  /** An svg layer: the chevron that shows or hides its elements. */
  twisty?: { open: boolean; onToggle(): void } | undefined;
}

function LayerRow({ name, kind, icon, hidden, locked, selected, nested, onSelect, onFlag, twisty }: RowProps) {
  const e = useT().web.editor;
  const eye = hidden ? e.showTrack({ name }) : e.hideTrack({ name });
  const lock = locked ? e.unlockTrack({ name }) : e.lockTrack({ name });
  const label = (
    <>
      <span className="ms-layer-name" title={name}>{name}</span>
      <span className="ms-layer-kind">{kind}</span>
    </>
  );
  return (
    <div className={cx('ms-layer', nested && 'ms-nested', hidden && 'ms-dim', selected && 'ms-sel')} data-layer-name={name}
      aria-current={selected ? 'true' : undefined}>
      {twisty ? (
        <button type="button" className={cx('ms-layer-twisty', twisty.open && 'ms-open')} aria-expanded={twisty.open}
          aria-label={twisty.open ? e.layerCollapse({ name }) : e.layerExpand({ name })} title={twisty.open ? e.layerCollapse({ name }) : e.layerExpand({ name })}
          onClick={twisty.onToggle}><Icon name="chevron" size={12} /></button>
      ) : <span className="ms-layer-twisty" aria-hidden="true" />}
      <Button size="sm" variant="ghost" icon aria-label={eye} title={eye} onClick={() => onFlag('hidden', !hidden)}>
        <Icon name={hidden ? 'eyeOff' : 'eye'} size={14} />
      </Button>
      <span className="ms-layer-thumb" aria-hidden="true"><Icon name={icon} size={15} /></span>
      {onSelect ? (
        <button type="button" className="ms-layer-main" onClick={onSelect}>{label}</button>
      ) : (
        <span className="ms-layer-main ms-static">{label}</span>
      )}
      <Button size="sm" variant="ghost" icon aria-label={lock} title={lock} onClick={() => onFlag('locked', !locked)}>
        <Icon name={locked ? 'lock' : 'unlock'} size={14} />
      </Button>
    </div>
  );
}

const ELEMENT_ICON: Record<string, IconName> = { g: 'grid', text: 'text', image: 'image', use: 'link' };

/** The elements of an open svg layer, nested under its row: the eye hides or shows one, a click shows its inspector. */
function SvgElementRows({ clip, layerName, nested }: { clip: Extract<Clip, { type: 'svg' }>; layerName: string; nested: boolean }) {
  const e = useT().web.editor;
  const { selection, svgElement, selectSvgElement } = useEditor();
  const session = useSvgSession(clip.id);
  if (!session || session.status === 'loading') return <p className={cx('ms-layer-el-note', nested && 'ms-nested')} role="status">{e.svgLoading}</p>;
  if (session.status === 'failed') return <p className={cx('ms-layer-el-note', nested && 'ms-nested')} role="status">{e.svgCannot}</p>;
  if (session.elements.length === 0) return <p className={cx('ms-layer-el-note', nested && 'ms-nested')}>{e.svgNoElements}</p>;
  const row = (el: SvgElement) => {
    const name = svgElementName(el, e);
    const eye = el.hidden ? e.svgShow({ name }) : e.svgHide({ name });
    const picked = selection === clip.id && svgElement === el.path;
    return (
      <li key={el.path}>
        <div className={cx('ms-layer', 'ms-layer-el', el.hidden && 'ms-dim', picked && 'ms-sel')} data-svg-element={el.path}
          style={{ paddingInlineStart: (nested ? 40 : 24) + el.depth * 12 }} aria-current={picked ? 'true' : undefined}>
          <Button size="sm" variant="ghost" icon aria-label={eye} title={eye} disabled={session.disabled}
            onClick={() => session.edit('hidden', (d) => setHidden(d, el.path, !el.hidden))}>
            <Icon name={el.hidden ? 'eyeOff' : 'eye'} size={13} />
          </Button>
          <span className="ms-layer-thumb" aria-hidden="true"><Icon name={ELEMENT_ICON[el.tag] ?? 'edit'} size={13} /></span>
          <button type="button" className="ms-layer-main" onClick={() => selectSvgElement(el.path, clip.id)}>
            <span className="ms-layer-name" title={name}>{name}</span>
          </button>
        </div>
      </li>
    );
  };
  return <ol className="ms-layers-sub ms-layers-svg" aria-label={e.layerElements({ name: layerName })}>{session.elements.map(row)}</ol>;
}

export function LayersPanel() {
  const t = useT();
  const e = t.web.editor;
  const locale = useLocale();
  const { draft, actions, selection, select, svgElement } = useEditor();
  const tree = useSvgTree();
  const [notice, setNotice] = useState('');
  const tracks = draft.composition.tracks;
  const layers = [...tracks].reverse().filter((track) => track.clips.length > 0);

  const kinds: Record<Clip['type'], string> = {
    text: e.clipText, shape: e.clipShape, image: e.clipImage, svg: e.clipSvg, video: e.clipVideo, html: e.clipHtml, audio: e.clipAudio,
  };
  const trackKinds: Record<Track['kind'], string> = { visual: e.kindVisual, video: e.kindVideo, text: e.kindText, audio: e.kindAudio };

  const run = (op: EditOp) => {
    const res = actions.apply(op);
    setNotice(res.ok ? '' : editProblemText(res.problem, locale));
  };
  const trackFlag = (track: Track, flag: Flag, value: boolean) => run({ kind: 'trackFlags', trackId: track.id, [flag]: value });
  const clipFlag = (clip: Clip, flag: Flag, value: boolean) => run({ kind: 'clipFlags', clipId: clip.id, [flag]: value });
  // A one-clip layer: on sets the track's flag; off clears the track's and, if the agent set it, the clip's.
  const layerFlag = (track: Track, clip: Clip, flag: Flag, value: boolean) => {
    if (value) { trackFlag(track, flag, true); return; }
    if (track[flag]) trackFlag(track, flag, false);
    if (clip[flag]) clipFlag(clip, flag, false);
  };
  /** The chevron of an svg layer, and its elements under it when open. */
  const svgTree = (clip: Clip) => (clip.type === 'svg' ? { open: tree.expanded.has(clip.id), onToggle: () => tree.setExpanded(clip.id, !tree.expanded.has(clip.id)) } : undefined);
  const elementsOf = (clip: Clip, nested: boolean) => (clip.type === 'svg' && tree.expanded.has(clip.id)
    ? <SvgElementRows clip={clip} layerName={clipLabel(clip, draft.composition, e)} nested={nested} /> : null);
  // The layer row is the selection while no element of it is picked.
  const layerSelected = (clip: Clip) => selection === clip.id && !(clip.type === 'svg' && svgElement !== null);

  return (
    <div className="ms-layers" data-slot="layers">
      {notice ? <p className="ms-layers-notice" role="alert">{notice}</p> : null}
      {layers.length === 0 ? <p className="ms-layers-empty">{e.layersEmpty}</p> : (
        <ol className="ms-layers-list" aria-label={e.layersList}>
          {layers.map((track) => {
            const trackName = track.name ?? e.trackName({ kind: trackKinds[track.kind], n: tracks.filter((x) => x.kind === track.kind).indexOf(track) + 1 });
            if (track.clips.length === 1) {
              const clip = track.clips[0]!;
              return (
                <li key={track.id}>
                  <LayerRow name={clipLabel(clip, draft.composition, e)} kind={kinds[clip.type]} icon={CLIP_ICON[clip.type]} selected={layerSelected(clip)}
                    hidden={Boolean(track.hidden || clip.hidden)} locked={Boolean(track.locked || clip.locked)} twisty={svgTree(clip)}
                    onSelect={() => select(clip.id)} onFlag={(flag, value) => layerFlag(track, clip, flag, value)} />
                  {elementsOf(clip, false)}
                </li>
              );
            }
            return (
              <li key={track.id}>
                <LayerRow name={trackName} kind={trackKinds[track.kind]} icon={CLIP_ICON[track.clips[0]!.type]} hidden={Boolean(track.hidden)} locked={Boolean(track.locked)}
                  onSelect={null} onFlag={(flag, value) => trackFlag(track, flag, value)} />
                <ol className="ms-layers-sub">
                  {[...track.clips].reverse().map((clip) => (
                    <li key={clip.id}>
                      <LayerRow nested name={clipLabel(clip, draft.composition, e)} kind={kinds[clip.type]} icon={CLIP_ICON[clip.type]} selected={layerSelected(clip)}
                        hidden={Boolean(clip.hidden)} locked={Boolean(clip.locked)} twisty={svgTree(clip)}
                        onSelect={() => select(clip.id)} onFlag={(flag, value) => clipFlag(clip, flag, value)} />
                      {elementsOf(clip, true)}
                    </li>
                  ))}
                </ol>
              </li>
            );
          })}
        </ol>
      )}
      <p className="ms-layers-foot">{e.layersAsk}</p>
    </div>
  );
}
