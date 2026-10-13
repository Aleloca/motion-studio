// The editor's scenes column (Phase 10b, Task 6): a card per scene (storyboard thumbnail of the opened version, name,
// duration), a click seeks to the scene's start, "In this scene" lists the clips that overlap the scene under the playhead
// (a click selects one), and the cards reorder - by dragging the grip or with ↑ ↓ on it - through `sceneOrder` when
// `sceneOrderAllowed` says every clip lies in one scene; otherwise the grip is disabled and says why.
import { compositionProblem, editProblemText, sceneOrderAllowed, type Clip, type Scene } from '@motion-studio/shared';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useStoryboard } from '../../components/compositionPreview.ts';
import { formatNumber, useLocale, useT } from '../../i18n.tsx';
import { Icon, cx } from '../../ui/index.ts';
import { useClock } from '../../ui/clock.ts';
import { timecode } from '../Transport.tsx';
import { useEditor } from './editorContext.ts';

const EPS = 1e-6;

/** The clips whose time overlaps `scene` (audio included), in track order. */
export function clipsOverlapping(tracks: Array<{ clips: Clip[] }>, scene: Scene): Clip[] {
  return tracks.flatMap((t) => t.clips).filter((c) => c.start < scene.start + scene.duration - EPS && c.start + c.duration > scene.start + EPS);
}

/** The scene under time `t` (the last one at the very end). */
export function sceneAt(scenes: Scene[], t: number): Scene | undefined {
  return scenes.find((s) => t >= s.start - EPS && t < s.start + s.duration - EPS) ?? scenes.at(-1);
}

export function ScenesColumn() {
  const t = useT();
  const e = t.web.editor;
  const r = t.web.render;
  const locale = useLocale();
  const { slug, creative, primary, draft, actions, controls, selection, select } = useEditor();
  const comp = draft.composition;
  const scenes = useMemo(() => [...comp.scenes].sort((a, b) => a.start - b.start), [comp.scenes]);
  const { time } = useClock(controls.clock);
  const current = sceneAt(scenes, time);
  const allowed = useMemo(() => sceneOrderAllowed(comp), [comp]);
  // The problem's own sentence, naming the clip as the editor does (its name, else its id).
  const blocking = allowed.ok ? null : comp.tracks.flatMap((tr) => tr.clips).find((c) => c.id === allowed.clipId);
  const reason = allowed.ok ? null : editProblemText(compositionProblem('editor.sceneOrderBlocked', { clip: blocking?.name ?? allowed.clipId }), locale);

  // Thumbnails: the opened version's storyboard (edits are not rendered into it; the card follows the scene by id).
  const { storyboard, state } = useStoryboard({ slug, creative, n: draft.base.n, format: primary, hash: draft.base.hash, enabled: true });
  const frameOf = (s: Scene) => {
    const frames = storyboard?.frames ?? [];
    return frames.find((f) => f.kind === 'scene' && (f.scene === s.id || f.scene === s.name)) ?? null;
  };

  const nameOf = (s: Scene) => s.name ?? r.scene({ n: scenes.indexOf(s) + 1 });
  const [said, setSaid] = useState('');
  const [over, setOver] = useState<number | null>(null);
  const list = useRef<HTMLOListElement>(null);

  const reorder = (from: number, to: number): boolean => {
    if (!allowed.ok || from === to || to < 0 || to >= scenes.length) return false;
    const order = scenes.map((s) => s.id);
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved!);
    const res = actions.apply({ kind: 'sceneOrder', order });
    if (res.ok) setSaid(e.reorderedTo({ name: nameOf(scenes[from]!), n: to + 1, total: scenes.length }));
    return res.ok;
  };

  // Dragging the grip: the card under the pointer is the drop place.
  const drag = useRef<{ from: number; to: number } | null>(null);
  const cleanup = useRef<() => void>(() => {});
  useEffect(() => () => cleanup.current(), []);
  /** Where the scene dragged from `from` lands with the pointer at `y`: the number of the other cards above it. */
  const indexAt = (y: number, from: number): number => {
    let n = 0;
    ([...(list.current?.children ?? [])] as HTMLElement[]).forEach((el, i) => {
      if (i === from) return;
      const b = el.getBoundingClientRect();
      if (y >= b.top + b.height / 2) n += 1;
    });
    return n;
  };
  const begin = (from: number) => (ev: ReactPointerEvent<HTMLElement>) => {
    if (!allowed.ok || ev.button !== 0) return;
    ev.preventDefault();
    try { ev.currentTarget.setPointerCapture?.(ev.pointerId); } catch { /* the window listeners still get it */ }
    drag.current = { from, to: from };
    setOver(from);
    const move = (m: PointerEvent) => {
      if (!drag.current) return;
      drag.current.to = indexAt(m.clientY, drag.current.from);
      setOver(drag.current.to);
    };
    const end = (m: PointerEvent) => {
      const d = drag.current;
      cleanup.current();
      if (d && m.type === 'pointerup') reorder(d.from, indexAt(m.clientY, d.from));
    };
    cleanup.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      drag.current = null;
      setOver(null);
      cleanup.current = () => {};
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };
  const key = (i: number) => (ev: ReactKeyboardEvent<HTMLElement>) => {
    if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
    ev.preventDefault();
    ev.stopPropagation();
    reorder(i, i + (ev.key === 'ArrowUp' ? -1 : 1));
    // The card moved: the grip of the moved scene keeps focus.
    const id = scenes[i]!.id;
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-scene="${CSS.escape(id)}"] .ms-sc-grip`)?.focus());
  };

  const inScene = current ? clipsOverlapping(comp.tracks, current) : [];
  return (
    <div className="ms-sc">
      {scenes.length === 0 ? (
        <p className="ms-fv-sb-note" role="status">{state === 'loading' || state === 'busy' ? r.storyboardLoading : e.scenesSoon}</p>
      ) : (
        <ol ref={list} className="ms-fv-sb ms-sc-list" aria-label={e.scenesAria}>
          {scenes.map((s, i) => {
            const f = frameOf(s);
            const name = nameOf(s);
            return (
              <li key={s.id} className={cx('ms-sc-card', over === i && 'ms-over', s.id === current?.id && 'ms-on')} data-scene={s.id}>
                <button type="button" className={cx('ms-fv-sb-item', s.id === current?.id && 'ms-on')} aria-current={s.id === current?.id || undefined}
                  disabled={!controls.ready} aria-label={r.sceneAt({ name, time: timecode(s.start) })} onClick={() => controls.seek(s.start)}>
                  {f ? <img src={f.url} alt="" draggable={false} style={{ aspectRatio: `${f.width} / ${f.height}` }} /> : <span className="ms-sc-thumb" aria-hidden="true" />}
                  <span className="ms-fv-sb-text"><b>{name}</b><span>{e.sceneLength({ seconds: formatNumber(locale, s.duration, { maximumFractionDigits: 2 }) })}</span></span>
                </button>
                <span className="ms-sc-grip-wrap" title={reason ?? undefined}>
                  <button type="button" className="ms-sc-grip" disabled={!allowed.ok} aria-label={e.reorderScene({ name })} title={reason ?? undefined}
                    onPointerDown={begin(i)} onKeyDown={key(i)}><Icon name="menu" size={13} /></button>
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {reason ? <p className="ms-sc-why" role="note">{reason}</p> : null}
      <span className="ms-sr" role="status" aria-live="polite">{said}</span>
      {current ? (
        <section className="ms-sc-in" aria-label={e.inThisScene}>
          <h3>{e.inThisScene}</h3>
          {inScene.length === 0 ? <p className="ms-fv-sb-note">{e.inSceneNone}</p> : (
            <ul>
              {inScene.map((c) => (
                <li key={c.id}>
                  <button type="button" className={cx('ms-sc-clip', c.id === selection && 'ms-on')} aria-pressed={c.id === selection} onClick={() => select(c.id)}>
                    <b>{c.name ?? c.id}</b>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}
