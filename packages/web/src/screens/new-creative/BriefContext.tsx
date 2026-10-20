import type { BriefContext } from '@motion-studio/shared';
import { useRef, useState, type KeyboardEvent } from 'react';
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

/**
 * The composer's "+" (decision 1414): a menu to link a folder, pick assets from the library or upload from the Mac. Picking an
 * item does what it says; the menu itself does nothing. Esc closes it (the focus goes back to the "+").
 */
export function AddContextMenu({ onFolder, onLibrary, onUpload, disabled }: { onFolder(): void; onLibrary(anchor: HTMLElement): void; onUpload(): void; disabled?: boolean }) {
  const b = useT().web.briefSession;
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
  const item = (icon: IconName, title: string, hint: string, run: () => void) => (
    <button type="button" role="menuitem" data-row="" className="ms-brief-mi" onClick={() => { setOpen(false); run(); }}>
      <Icon name={icon} size={16} />
      <span><b>{title}</b><small>{hint}</small></span>
    </button>
  );
  return (
    <>
      <Button ref={plus} type="button" variant="ghost" icon className="ms-brief-plus" aria-label={b.add} title={b.add} aria-haspopup="menu" aria-expanded={open}
        disabled={disabled} onClick={() => setOpen((o) => !o)}>
        <Icon name="plus" size={18} />
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={plus} placement="top-start" width={300}>
        <div ref={menu} role="menu" aria-label={b.addMenu} className="ms-brief-menu" onKeyDown={onKeyDown}>
          {item('folder', b.folder.title, b.folder.hint, onFolder)}
          {item('image', b.library.title, b.library.hint, () => onLibrary(plus.current!))}
          {item('upload', b.upload.title, b.upload.hint, onUpload)}
        </div>
      </Popover>
    </>
  );
}

/** The items added in the composer, each removable; folders in mono (decision 1414). */
export function ContextPins({ pins, onRemove, thumb }: { pins: readonly ContextPin[]; onRemove(pin: ContextPin): void; thumb(path: string): string | null }) {
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
