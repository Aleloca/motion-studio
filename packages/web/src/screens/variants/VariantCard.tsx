// A variant's card (decision 973; Phase 15, spec §5): the letter and a short name (the full direction on a second line and in the
// tooltip), ONE state of its work (waiting reasons included), "Riprova" after a failure or a stop, the ⋯ menu (use for all
// formats, export this variant, edit the direction, discard: disabled with its reason while it works or when it is the last
// active one), and its formats inside it. A discarded card offers "Ripristina". The name opens the variant in the chat.
import type { VariantMember } from '@motion-studio/shared';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useT } from '../../i18n.tsx';
import { Button, Icon, NavItem, Pill, Popover, cx } from '../../ui/index.ts';
import { rovingIndex } from '../../ui/roving.ts';
import { shortName, type RowState } from './variantModel.ts';
import { RemovalMenuItems, useCreativeRemoval, type RemovalDone } from '../creative/CreativeRemoval.tsx';

export interface VariantRowActions {
  onFocus(): void;
  onUseForAll(): void;
  onDiscard(): void;
  onRestore(): void;
  onExport(): void;
  onEditDirection(): void;
  onRetry(): void;
}

export interface VariantCardProps {
  member: VariantMember;
  state: RowState;
  /** The variant whose conversation and tools the page shows. */
  focused: boolean;
  /** Why it cannot be discarded now, or null. */
  discardBlock: 'running' | 'last-active' | null;
  /** The member has at least one version (use-for-all and export need one). */
  hasVersions: boolean;
  /** Which busy action is in flight. */
  busy?: boolean;
  actions: VariantRowActions;
  /** Decision 915: archive and delete of this variant alone (B..E: it leaves the group); `project` is the project's slug. */
  removal?: { project: string; onDone(kind: RemovalDone): void };
  /** The card's width on screen (the grid of cards follows the zoom). */
  width: number;
  /** One format: its thumbnail is the card's hero. */
  hero: boolean;
  /** The formats' thumbnails. */
  children?: ReactNode;
}

/** The words of a row state (the waiting reasons are the core's stable codes). */
export function useStateText(): (s: RowState) => string {
  const t = useT();
  const vg = t.web.variantGroup;
  const c = t.web.canvas.state;
  return (s) => {
    switch (s.kind) {
      case 'discarded': return vg.discarded;
      case 'missing': return vg.missing;
      case 'needs': return c.needs;
      case 'waiting': return s.reason ? vg.waitReasons[s.reason] : t.web.creatives.queued;
      case 'working': return c.working;
      case 'failed': return t.web.status.error;
      case 'stopped': return t.web.status.interrupted;
      case 'ready': return t.web.status.ready;
      case 'incomplete': return t.web.status.incomplete;
      case 'draft': return t.web.status.draft;
    }
  };
}

export function VariantCard({ member, state, focused, discardBlock, hasVersions, busy, actions, removal, width, hero, children }: VariantCardProps) {
  const t = useT();
  const vg = t.web.variantGroup;
  const text = useStateText();
  const [open, setOpen] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const removable = removal !== undefined && member.letter !== 'a';
  const removing = useCreativeRemoval(removal?.project ?? '', member.slug, removal?.onDone);
  const { load } = removing;
  useEffect(() => { if (open && removable) load(); }, [open, removable, load]);
  const why = useId();
  const letter = member.letter.toUpperCase();
  const reason = discardBlock === 'running' ? vg.discardRefused.running : discardBlock === 'last-active' ? vg.discardRefused.lastActive : null;
  const discarded = member.status === 'discarded';
  const missing = state.kind === 'missing';
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const rows = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const to = e.key === 'ArrowLeft' || e.key === 'ArrowRight' ? null : rovingIndex(e.key, at < 0 ? 0 : at, rows.length);
    if (to === null) return;
    e.preventDefault();
    rows[to]?.focus();
  };
  const pick = (run: () => void) => () => { setOpen(false); run(); };
  const tone = state.kind === 'needs' || state.kind === 'failed' || state.kind === 'stopped' || state.kind === 'missing' ? 'warn' : state.kind === 'ready' ? 'ok' : 'neutral';
  const name = shortName(member.direction);
  return (
    <section className={cx('ms-vcard', focused && 'ms-on', discarded && 'ms-discarded', missing && 'ms-missing')} aria-label={vg.letterLabel({ letter })} data-variant={member.letter} style={{ width }}>
      <div className="ms-vcard-head">
        <button type="button" className={cx('ms-vrow-title', focused && 'ms-on')} aria-pressed={focused} aria-label={`${vg.letterLabel({ letter })}${member.direction ? ` · ${member.direction}` : ''}`}
          title={member.direction ?? vg.noDirection} disabled={missing} onClick={actions.onFocus}>
          <span className="ms-vcard-letter" aria-hidden="true">{letter}</span>
          <span className="ms-vrow-dir">{name ?? vg.letterLabel({ letter })}</span>
        </button>
        {discarded ? (
          <Button size="sm" variant="outline" className="ms-vrow-restore" disabled={busy} onClick={actions.onRestore}>{vg.restore}</Button>
        ) : missing ? null : (
          <>
            <Button ref={more} size="sm" variant="ghost" icon className="ms-vrow-more" aria-label={vg.rowMenu({ letter })} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              <Icon name="more" size={14} />
            </Button>
            <Popover open={open} onClose={() => setOpen(false)} anchor={more} placement="bottom-end" width={290}>
              <div ref={menu} role="menu" aria-label={vg.rowMenu({ letter })} onKeyDown={onKeyDown}>
                <NavItem data-row="" role="menuitem" icon="star" aria-disabled={!hasVersions || undefined} onClick={hasVersions ? pick(actions.onUseForAll) : undefined}>{vg.useForAllFormats}</NavItem>
                <NavItem data-row="" role="menuitem" icon="download" aria-disabled={!hasVersions || undefined} onClick={hasVersions ? pick(actions.onExport) : undefined}>{vg.exportVariant}</NavItem>
                <NavItem data-row="" role="menuitem" icon="edit" onClick={pick(actions.onEditDirection)}>{vg.editDirection}</NavItem>
                <NavItem data-row="" role="menuitem" icon="trash" aria-disabled={reason ? true : undefined} aria-describedby={reason ? why : undefined} onClick={reason ? undefined : pick(actions.onDiscard)}>{vg.discard}</NavItem>
                {reason ? <p id={why} className="ms-vmenu-why" role="note">{reason}</p> : null}
                {removable ? <RemovalMenuItems removal={removing} close={() => setOpen(false)} /> : null}
              </div>
            </Popover>
            {removable ? removing.dialogs : null}
          </>
        )}
      </div>
      <div className="ms-vcard-status">
        <Pill tone={tone} spinner={state.kind === 'working'} className="ms-vrow-state"><span aria-label={vg.stateLabel({ letter })}>{text(state)}</span></Pill>
        {focused ? <span className="ms-vcard-chat" title={vg.inChatHint}><Icon name="comment" size={11} />{vg.inChat}</span> : null}
        {state.kind === 'failed' || state.kind === 'stopped' ? (
          <Button size="sm" variant="outline" className="ms-vrow-retry" disabled={busy} onClick={actions.onRetry}><Icon name="refresh" size={12} />{t.web.creatives.tryAgain}</Button>
        ) : null}
      </div>
      {member.direction && name !== member.direction ? <p className="ms-vcard-dir" title={member.direction}>{member.direction}</p> : null}
      {children ? <div className={cx('ms-vcard-formats', hero && 'ms-hero')} role="group" aria-label={vg.cardFormats({ letter })}>{children}</div> : null}
    </section>
  );
}
