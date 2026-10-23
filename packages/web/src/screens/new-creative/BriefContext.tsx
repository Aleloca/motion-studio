import type { BriefContext } from '@motion-studio/shared';
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useT } from '../../i18n.tsx';
import { Button, Icon, Popover, cx, type IconName } from '../../ui/index.ts';
import { rovingIndex } from '../../ui/roving.ts';

/** A folder or an asset added in the composer, sent with the next message (decision 1414). */
export type ContextPin = { kind: 'folder'; path: string } | { kind: 'asset'; path: string };

/** The characters the agent's file rules cannot match safely (the core refuses such a folder: `codebaseGlobChars`). */
const GLOB_CHARS = /[()[\]{}*?\\]/;
const nameOf = (path: string) => path.split('/').filter(Boolean).pop() ?? path;

/** Why a folder path typed or picked cannot be linked (null: it can; the core checks it again when the message is sent). */
export function folderProblem(path: string, t: ReturnType<typeof useT>): string | null {
  if (!(path.startsWith('/') || path.startsWith('~'))) return t.web.codebase.needAbsolute;
  if (GLOB_CHARS.test(path)) return t.errors.codebaseGlobChars({ path });
  return null;
}

/** One row of a composer "+" menu: what it does, said in a title and an optional hint. */
export interface PlusMenuItem { key: string; icon: IconName; title: string; hint?: string; run(anchor: HTMLElement): void }

/**
 * A composer's "+" and its menu (decision 1414; report 79: the creative chat's attach menu too). Picking an item does what it
 * says; the menu itself does nothing. Esc closes it (the focus goes back to the "+").
 */
export function PlusMenu({ label, menuLabel, items, disabled, className, size }: { label: string; menuLabel: string; items: readonly PlusMenuItem[]; disabled?: boolean; className?: string; /** `sm`: the 28 px of a composer row's buttons. */ size?: 'sm' }) {
  const [open, setOpen] = useState(false);
  const plus = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const rows = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const to = e.key === 'ArrowLeft' || e.key === 'ArrowRight' ? null : rovingIndex(e.key, at < 0 ? 0 : at, rows.length);
    if (to === null) return;
    e.preventDefault();
    rows[to]?.focus();
  };
  return (
    <>
      <Button ref={plus} type="button" variant="ghost" icon {...(size ? { size } : {})} className={cx('ms-plus', className)} aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open}
        disabled={disabled} onClick={() => setOpen((o) => !o)}>
        <Icon name="plus" size={size === 'sm' ? 16 : 18} />
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={plus} placement="top-start" width={300}>
        <div ref={menu} role="menu" aria-label={menuLabel} className="ms-brief-menu" onKeyDown={onKeyDown}>
          {items.map((it) => (
            <button key={it.key} type="button" role="menuitem" data-row="" className="ms-brief-mi" onClick={() => { setOpen(false); it.run(plus.current!); }}>
              <Icon name={it.icon} size={16} />
              <span><b>{it.title}</b>{it.hint ? <small>{it.hint}</small> : null}</span>
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}

/** The brief session's "+" (decision 1414): link a folder, pick assets from the library or upload from the Mac. */
export function AddContextMenu({ onFolder, onLibrary, onUpload, disabled }: { onFolder(): void; onLibrary(anchor: HTMLElement): void; onUpload(): void; disabled?: boolean }) {
  const b = useT().web.briefSession;
  return (
    <PlusMenu label={b.add} menuLabel={b.addMenu} disabled={disabled} className="ms-brief-plus" items={[
      { key: 'folder', icon: 'folder', title: b.folder.title, hint: b.folder.hint, run: onFolder },
      { key: 'library', icon: 'image', title: b.library.title, hint: b.library.hint, run: onLibrary },
      { key: 'upload', icon: 'upload', title: b.upload.title, hint: b.upload.hint, run: onUpload },
    ]} />
  );
}

/** The items added in the composer, each removable; folders in mono (decision 1414). */
export function ContextPins({ pins, onRemove, thumb, mark }: { pins: readonly ContextPin[]; onRemove(pin: ContextPin): void; thumb(path: string): string | null; /** Report 62: where an uploaded file is kept. */ mark?(path: string): ReactNode }) {
  const b = useT().web.briefSession;
  if (pins.length === 0) return null;
  return (
    <div className="ms-composer-pins ms-brief-pins">
      {pins.map((p) => {
        const name = p.kind === 'folder' ? p.path : nameOf(p.path);
        const url = p.kind === 'asset' ? thumb(p.path) : null;
        return (
          <span key={`${p.kind}:${p.path}`} className={cx('ms-chip ms-on ms-composer-pin ms-brief-pin', p.kind === 'folder' && 'ms-brief-folder')} title={p.path}>
            {p.kind === 'asset' ? <span className="ms-brief-swatch" aria-hidden="true" style={url ? { backgroundImage: `url("${url}")` } : undefined} /> : null}
            <span className="ms-brief-pin-name">{name}</span>
            {p.kind === 'asset' ? mark?.(p.path) : null}
            <button type="button" className="ms-x" aria-label={b.removePin({ name })} onClick={() => onRemove(p)}><Icon name="close" size={10} /></button>
          </span>
        );
      })}
    </div>
  );
}

/** The session's context under the composer: "2 cartelle ▾ · 3 asset ▾", each a list with its items removable (decision 1414). */
export function ContextRow({ context, onChange, disabled }: { context: BriefContext; onChange(next: BriefContext): void; disabled?: boolean }) {
  const b = useT().web.briefSession;
  const folders = context.codebases.length;
  const assets = context.assets.length;
  return (
    <div className="ms-brief-ctx">
      <ContextList icon="folder" label={folders ? b.folders({ count: folders }) : b.noFolders} title={b.foldersTitle} disabled={disabled}
        items={context.codebases.map((c) => ({ key: c.path, text: c.path, mono: true }))}
        onRemove={(key) => onChange({ ...context, codebases: context.codebases.filter((c) => c.path !== key) })} />
      <ContextList icon="image" label={assets ? b.assets({ count: assets }) : b.noAssets} title={b.assetsTitle} disabled={disabled}
        items={context.assets.map((a) => ({ key: a, text: nameOf(a), mono: false }))}
        onRemove={(key) => onChange({ ...context, assets: context.assets.filter((a) => a !== key) })} />
    </div>
  );
}

function ContextList({ icon, label, title, items, onRemove, disabled }: {
  icon: IconName; label: string; title: string; items: Array<{ key: string; text: string; mono: boolean }>; onRemove(key: string): void; disabled?: boolean;
}) {
  const b = useT().web.briefSession;
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button ref={anchor} size="sm" variant="ghost" aria-haspopup="dialog" aria-expanded={open} disabled={disabled || items.length === 0} onClick={() => setOpen((o) => !o)}>
        <Icon name={icon} size={14} />{label}<Icon name="chevron" size={12} />
      </Button>
      <Popover open={open && items.length > 0} onClose={() => setOpen(false)} anchor={anchor} placement="top-start" width={300} label={title}>
        <ul className="ms-brief-ctx-list">
          {items.map((it) => (
            <li key={it.key}>
              <span className={cx('ms-brief-ctx-item', it.mono && 'ms-mono')} title={it.key}>{it.text}</span>
              <Button size="sm" variant="ghost" icon aria-label={b.removeContext({ name: it.text })} title={b.removeContext({ name: it.text })} onClick={() => onRemove(it.key)}>
                <Icon name="close" size={11} />
              </Button>
            </li>
          ))}
        </ul>
      </Popover>
    </>
  );
}
