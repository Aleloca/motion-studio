// Archive and delete of a creative (decision 915): the menu items, with the reason when the core refuses now (a turn, a
// queued request or a render), the confirmations (a whole group, and every delete, which names the creative and says it
// goes to the Trash), and the toasts (archive offers Undo). The core decides what a creative is acted on as (`removal`):
// a single creative, variant A of a group (the whole group), or a variant B..E alone (it leaves its group).
import type { CreativeRemovalInfo } from '@motion-studio/shared';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { api } from '../../api.ts';
import { useT } from '../../i18n.tsx';
import { Button, Icon, Modal, NavItem, Popover, toast } from '../../ui/index.ts';
import { message } from '../common.tsx';
import '../variants/variants.css';

export type RemovalDone = 'archived' | 'deleted' | 'restored';

export interface CreativeRemoval {
  info: CreativeRemovalInfo | null;
  /** The info could not be read (the reason). */
  failed: string | null;
  load(): void;
  archive(): void;
  askDelete(): void;
  restore(): void;
  busy: boolean;
  /** The confirmation dialogs: render them outside any popover. */
  dialogs: ReactNode;
}

/** `slug`: the project; `creative`: the creative acted on (variant A of a group acts on the whole group). */
export function useCreativeRemoval(slug: string, creative: string, onDone?: (kind: RemovalDone) => void): CreativeRemoval {
  const t = useT();
  const r = t.web.removal;
  const [info, setInfo] = useState<CreativeRemovalInfo | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<'delete' | 'archive' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(onDone);
  done.current = onDone;
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(() => {
    setInfo(null);
    setFailed(null);
    Promise.resolve().then(() => api.creativeRemoval(slug, creative))
      .then((i) => { if (alive.current) setInfo(i); })
      .catch((e: unknown) => { if (alive.current) setFailed(message(e)); });
  }, [slug, creative]);

  const group = info?.role === 'host';
  const title = info?.title ?? creative;

  const doArchive = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.archiveCreative(slug, creative, group);
      setDialog(null);
      // A variant archived alone left its group: restoring it would not put it back, so no Undo (decision 949).
      toast.show(r.archived({ title }), {
        tone: 'ok',
        ...(info?.role === 'sister' ? {} : { action: { label: r.undo, run: () => { void restoreNow(); } } }),
      });
      done.current?.('archived');
    } catch (e) {
      if (dialog) setError(message(e)); else toast.show(r.archiveFailed({ detail: message(e) }), { tone: 'neutral' });
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const restoreNow = async () => {
    try {
      await api.unarchiveCreative(slug, creative);
      toast.show(r.restored({ title }), { tone: 'ok' });
      done.current?.('restored');
    } catch (e) {
      toast.show(r.restoreFailed({ detail: message(e) }), { tone: 'neutral' });
    }
  };
  const doDelete = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteCreative(slug, creative, group);
      setDialog(null);
      toast.show(r.deleted({ title }), { tone: 'ok' });
      done.current?.('deleted');
    } catch (e) {
      setError(message(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const close = () => { if (!busy) { setDialog(null); setError(null); } };
  const count = info?.members ?? 1;
  const letter = info?.letter?.toUpperCase() ?? '';
  const body = dialog === 'archive' ? r.archiveGroupBody({ count })
    : group ? r.deleteGroupBody({ count }) : info?.role === 'sister' ? r.deleteVariantBody({ letter }) : r.deleteBody;
  const dialogs = (
    <Modal open={dialog !== null} onClose={close} label={dialog === 'archive' ? r.archiveGroupTitle({ title }) : r.deleteTitle({ title })} width={460} dismissible={!busy}>
      <div className="ms-vdlg" data-testid="removal-dialog">
        <h2>{dialog === 'archive' ? r.archiveGroupTitle({ title }) : r.deleteTitle({ title })}</h2>
        <p className="ms-vdlg-hint">{body}</p>
        {error ? <p role="alert" className="ms-vdlg-err">{error}</p> : null}
        <div className="ms-vdlg-actions">
          <Button type="button" variant="ghost" onClick={close} disabled={busy}>{r.cancel}</Button>
          {dialog === 'archive'
            ? <Button type="button" variant="ink" loading={busy} onClick={() => void doArchive()}>{r.archiveConfirm}</Button>
            : <Button type="button" variant="danger" loading={busy} onClick={() => void doDelete()}>{r.deleteConfirm}</Button>}
        </div>
      </div>
    </Modal>
  );

  return {
    info, failed, load, busy, dialogs,
    // A whole group is asked first (decision 948); a single creative or a variant is archived at once, with Undo.
    archive: () => { if (group) { setError(null); setDialog('archive'); } else void doArchive(); },
    askDelete: () => { setError(null); setDialog('delete'); },
    restore: () => { void restoreNow(); },
  };
}

/** The two menu items (Archive, Delete…), disabled with the core's reason while the creative cannot be removed. */
export function RemovalMenuItems({ removal, close }: { removal: CreativeRemoval; close(): void }) {
  const r = useT().web.removal;
  const why = useId();
  const { info, failed } = removal;
  const reason = failed ?? (info ? info.blocked?.message ?? null : r.checking);
  const count = info?.members ?? 1;
  const letter = info?.letter?.toUpperCase() ?? '';
  const labels = info?.role === 'host' ? [r.archiveGroup({ count }), r.deleteGroup({ count })]
    : info?.role === 'sister' ? [r.archiveVariant({ letter }), r.deleteVariant({ letter })] : [r.archive, r.delete];
  const off = reason !== null;
  const pick = (run: () => void) => (off ? undefined : () => { close(); run(); });
  return (
    <>
      <NavItem data-row="" role="menuitem" icon="folder" aria-disabled={off || undefined} aria-describedby={off ? why : undefined} onClick={pick(removal.archive)}>{labels[0]}</NavItem>
      <NavItem data-row="" role="menuitem" icon="trash" aria-disabled={off || undefined} aria-describedby={off ? why : undefined} onClick={pick(removal.askDelete)}>{labels[1]}</NavItem>
      {off ? <p id={why} className="ms-vmenu-why" role="note">{reason}</p> : null}
    </>
  );
}

/**
 * A creative's "…" button with its menu: `extra` items first (given the close function), then Archive and Delete. The
 * removal info is read each time the menu opens (a job may have started or ended since).
 */
export function CreativeActionsMenu({ slug, creative, label, onDone, extra, className, variant = 'outline', size, buttonRef }: {
  slug: string; creative: string; label: string; onDone?: (kind: RemovalDone) => void;
  extra?: (close: () => void) => ReactNode; className?: string; variant?: 'outline' | 'ghost'; size?: 'sm';
  /** The "…" button, for a popover that opens from it once the menu is closed (the version history of the creative bar). */
  buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const own = useRef<HTMLButtonElement>(null);
  const more = buttonRef ?? own;
  const removal = useCreativeRemoval(slug, creative, onDone);
  const { load } = removal;
  useEffect(() => { if (open) load(); }, [open, load]);
  const close = () => setOpen(false);
  return (
    <>
      <Button ref={more} variant={variant} icon {...(size ? { size } : {})} className={className} aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="more" size={14} />
      </Button>
      <Popover open={open} onClose={close} anchor={more} placement="bottom-end" width={260}>
        <div role="menu" aria-label={label}>
          {extra?.(close)}
          <RemovalMenuItems removal={removal} close={close} />
        </div>
      </Popover>
      {removal.dialogs}
    </>
  );
}
