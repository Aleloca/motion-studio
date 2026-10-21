import { isCreativeReference, type AssetEntry } from '@motion-studio/shared';
import { useCallback, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { api } from '../../api.ts';
import { message as errText } from '../../errors.ts';
import { useT } from '../../i18n.tsx';
import { Icon, Popover, cx, toast, type IconName, type PopoverPlacement } from '../../ui/index.ts';
import { rovingIndex } from '../../ui/roving.ts';

/**
 * Report 62: files added from the computer straight into a brief. They are "only for this creative" by default (the core
 * keeps them out of the library), and one click on their mark saves them in Assets (and back, while only in this brief).
 */

const nameOf = (path: string) => path.split('/').pop() ?? path;

/** "Add assets": from the computer, or from the library. */
export function AddAssetMenu({ open, onClose, anchor, placement = 'bottom-start', onComputer, onLibrary }: {
  open: boolean; onClose(): void; anchor: RefObject<HTMLElement | null>; placement?: PopoverPlacement; onComputer(): void; onLibrary(): void;
}) {
  const n = useT().web.newCreative;
  const menu = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const rows = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const to = e.key === 'ArrowLeft' || e.key === 'ArrowRight' ? null : rovingIndex(e.key, at < 0 ? 0 : at, rows.length);
    if (to === null) return;
    e.preventDefault();
    rows[to]?.focus();
  };
  const item = (icon: IconName, title: string, hint: string, run: () => void) => (
    <button type="button" role="menuitem" data-row="" className="ms-brief-mi" onClick={() => { onClose(); run(); }}>
      <Icon name={icon} size={16} />
      <span><b>{title}</b><small>{hint}</small></span>
    </button>
  );
  return (
    <Popover open={open} onClose={onClose} anchor={anchor} placement={placement} width={300}>
      <div ref={menu} role="menu" aria-label={n.addAssets} className="ms-brief-menu" onKeyDown={onKeyDown}>
        {item('upload', n.fromComputer, n.fromComputerHint, onComputer)}
        {item('image', n.fromLibrary, n.fromLibraryHint, onLibrary)}
      </div>
    </Popover>
  );
}

/** The mark of a file added in this brief: "Solo per questa creatività" or "Salvato negli Assets"; a click switches it. */
export function ReferenceToggle({ path, reference, busy, onToggle, className }: { path: string; reference: boolean; busy: boolean; onToggle(): void; className?: string }) {
  const n = useT().web.newCreative;
  const name = nameOf(path);
  const hint = reference ? n.referenceOnlyHint({ name }) : n.referenceSavedHint({ name });
  return (
    <button type="button" className={cx('ms-nc-refmark', !reference && 'ms-saved', className)} aria-label={hint} title={hint} aria-pressed={!reference}
      aria-busy={busy || undefined} disabled={busy} onClick={onToggle}>
      <Icon name={reference ? 'pin' : 'check'} size={10} strokeWidth={2} />
      <span>{reference ? n.referenceOnly : n.referenceSaved}</span>
    </button>
  );
}

export interface PendingUpload { id: number; names: string[]; error: string | null }

/**
 * The brief's files from the computer: the references the project has (from the listing), the paths added in this brief,
 * the uploads under way or failed, and the switch between "only for this creative" and Assets.
 */
export function useBriefReferences(slug: string, o: { onLibraryChanged(): void }) {
  const n = useT().web.newCreative;
  const [refs, setRefs] = useState<AssetEntry[]>([]);
  const [here, setHere] = useState<ReadonlySet<string>>(() => new Set());
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  // The entries this brief changed (uploaded, saved, made only for it again), newest first: the lists may still be older.
  const [latest, setLatest] = useState<ReadonlyMap<string, AssetEntry>>(() => new Map());
  const remember = (entries: readonly AssetEntry[]) => setLatest((m) => new Map([...m, ...entries.map((e) => [`assets/${e.file}`, e] as const)]));
  const seq = useRef(0);
  const onChanged = useRef(o.onLibraryChanged);
  onChanged.current = o.onLibraryChanged;

  /**
   * Uploads `files` as references of this brief; answers their project paths, or the error. With `tiles` (the form) the
   * upload shows as tiles in the section, a failure staying there until dismissed; without (the chat) the caller says it.
   */
  const upload = useCallback(async (files: File[], o: { tiles?: boolean } = {}): Promise<{ paths: string[]; error: string | null }> => {
    if (files.length === 0) return { paths: [], error: null };
    const id = ++seq.current;
    const names = files.map((f) => f.name);
    const tiles = o.tiles !== false;
    if (tiles) setPending((p) => [...p, { id, names, error: null }]);
    try {
      const added = (await api.uploadFiles(slug, 'assets', files, { reference: true })).assets ?? [];
      setPending((p) => p.filter((x) => x.id !== id));
      setRefs((r) => [...r.filter((x) => !added.some((a) => a.file === x.file)), ...added]);
      remember(added);
      const paths = added.map((a) => `assets/${a.file}`);
      setHere((h) => new Set([...h, ...paths]));
      return { paths, error: null };
    } catch (e) {
      if (tiles) setPending((p) => p.map((x) => (x.id === id ? { ...x, error: errText(e) } : x)));
      return { paths: [], error: errText(e) };
    }
  }, [slug]);
  const dismiss = useCallback((id: number) => setPending((p) => p.filter((x) => x.id !== id)), []);

  /** One click on a file's mark: saved in Assets, or back to only this creative. */
  const toggle = useCallback(async (entry: AssetEntry) => {
    const toReference = !isCreativeReference(entry);
    setBusy((b) => new Set([...b, entry.file]));
    try {
      const next = await api.setAssetReference(slug, entry.file, toReference);
      setRefs((r) => (toReference ? [...r.filter((x) => x.file !== next.file), next] : r.filter((x) => x.file !== next.file)));
      remember([next]);
      onChanged.current();
      return next;
    } catch (e) {
      toast.show(n.referenceFailed({ detail: errText(e) }));
      return null;
    } finally {
      setBusy((b) => new Set([...b].filter((f) => f !== entry.file)));
    }
  }, [slug, n]);

  /** The entry of project path `path`: as this brief last changed it, else from the library, else from the references. */
  const entryOf = (path: string, library: readonly AssetEntry[] | null): AssetEntry | null =>
    latest.get(path) ?? library?.find((a) => `assets/${a.file}` === path) ?? refs.find((a) => `assets/${a.file}` === path) ?? null;

  return { refs, setRefs, here, pending, busy, upload, dismiss, toggle, entryOf };
}
export type BriefReferences = ReturnType<typeof useBriefReferences>;
