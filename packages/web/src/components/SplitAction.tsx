import { useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { Button, Icon, NavItem, Popover, cx, type ButtonSize, type ButtonVariant, type IconName } from '../ui/index.ts';
import { rovingIndex } from '../ui/roving.ts';

export interface SplitItem {
  key: string;
  label: string;
  icon?: IconName;
  onSelect(): void;
}

export interface SplitActionProps {
  /** The main action: a Button the caller renders (it can be a submit button). */
  primary: ReactNode;
  items: SplitItem[];
  /** Accessible name of the chevron button. */
  menuLabel: string;
  /** Accessible name of the whole group (the main action and its chevron). */
  groupLabel: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  className?: string;
  /** The element the menu (and anything the caller anchors beside it) is placed against. */
  groupRef?: RefObject<HTMLSpanElement | null>;
}

/**
 * A split button (Phase 13): the main action and a chevron that opens a menu of the others. The menu is a Popover with
 * `menu`/`menuitem` roles: it opens on the first item, arrows move, Enter or Space picks, Esc closes (and gives the focus
 * back to the chevron). Picking an item does what it says; nothing is ever done by merely opening the menu.
 */
export function SplitAction({ primary, items, menuLabel, groupLabel, variant = 'outline', size = 'sm', disabled, className, groupRef }: SplitActionProps) {
  const [open, setOpen] = useState(false);
  const own = useRef<HTMLSpanElement>(null);
  const group = groupRef ?? own;
  const chevron = useRef<HTMLButtonElement>(null);
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
    <span ref={group} className={cx('ms-split', className)} role="group" aria-label={groupLabel}>
      {primary}
      <Button ref={chevron} variant={variant} size={size} icon className="ms-split-more" aria-label={menuLabel} aria-haspopup="menu" aria-expanded={open}
        disabled={disabled} onClick={() => setOpen((o) => !o)}>
        <Icon name="chevron" size={12} />
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={chevron} placement="bottom-end" width={220}>
        <div ref={menu} role="menu" aria-label={menuLabel} onKeyDown={onKeyDown}>
          {items.map((it) => (
            <NavItem key={it.key} data-row="" role="menuitem" icon={it.icon} onClick={() => { setOpen(false); it.onSelect(); }}>{it.label}</NavItem>
          ))}
        </div>
      </Popover>
    </span>
  );
}
