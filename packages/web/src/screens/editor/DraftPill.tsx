// The draft pill at the top of the stage (Phase 10b): "● Draft · N edits", Save as vN and Discard (with a confirmation).
// After a save: "✓ Saved as Reel vN" for 1.8 s. Save is disabled with the reason as its description: the first problem of
// the draft, a base that moved, or an agent / render at work.
import { useLayoutEffect, useRef, useState } from 'react';
import { useT } from '../../i18n.tsx';
import { D, E, anim, enter } from '../../motion/index.ts';
import { Button, Icon, Modal } from '../../ui/index.ts';

/** How long "Saved as …" stays. */
export const SAVED_MS = 1800;

export interface DraftPillProps {
  edits: number;
  /** The version Save makes. */
  nextN: number;
  /** Why Save is disabled (already translated), or null when it can run. */
  blocked: string | null;
  saving: boolean;
  saved: { name: string; n: number } | null;
  onSave(): void;
  /** Called after the user confirmed the discard. */
  onDiscard(): void;
}

export function DraftPill({ edits, nextN, blocked, saving, saved, onSave, onDiscard }: DraftPillProps) {
  const e = useT().web.editor;
  const ref = useRef<HTMLDivElement>(null);
  const [asking, setAsking] = useState(false);
  useLayoutEffect(() => { void enter(ref.current, { y: -10 }); }, []);
  useLayoutEffect(() => {
    if (saved && ref.current) void anim(ref.current, [{ transform: 'translateX(-50%) scale(1.04)' }, { transform: 'translateX(-50%) scale(1)' }], D.m, E.spring);
  }, [saved]);
  return (
    <div ref={ref} className="ms-ed-pill" role="group" aria-label={e.draft({ n: edits })} data-saved={saved ? '' : undefined}>
      {saved ? (
        <b className="ms-ed-pill-ok" role="status"><Icon name="check" size={13} strokeWidth={2} />{e.saved(saved)}</b>
      ) : (
        <>
          <span className="ms-ed-dot" aria-hidden="true" />
          <span className="ms-ed-pill-text" role="status">{e.draft({ n: edits })}</span>
          <Button size="sm" variant="ink" disabled={blocked !== null || saving} loading={saving} aria-describedby={blocked !== null ? 'ms-ed-save-why' : undefined}
            title={blocked ?? undefined} onClick={onSave}>{saving ? e.saving : e.saveAs({ n: nextN })}</Button>
          {blocked !== null ? <span id="ms-ed-save-why" className="ms-sr">{blocked}</span> : null}
          <Button size="sm" variant="ghost" disabled={saving} onClick={() => setAsking(true)}>{e.discard}</Button>
        </>
      )}
      <Modal open={asking} onClose={() => setAsking(false)} label={e.discardTitle} width={440}>
        <div className="ms-ed-dialog">
          <h2>{e.discardTitle}</h2>
          <p>{e.discardBody({ n: edits })}</p>
          <div className="ms-ed-dialog-foot">
            <Button variant="ghost" onClick={() => setAsking(false)}>{e.keepEditing}</Button>
            <Button variant="danger" onClick={() => { setAsking(false); onDiscard(); }}>{e.discardConfirm}</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
