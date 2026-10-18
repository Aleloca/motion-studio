// The "…" of a bar (user report 17): the object's rare actions (Duplicate format, the version history), out of the row of
// buttons. A ghost icon button, as tall as every other control of the bar, with a menu below it.
import { useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useT } from '../i18n.tsx';
import { Button, Icon, NavItem, Popover } from '../ui/index.ts';
import type { IconName } from '../ui/icons.ts';

export function BarMenu({ children, buttonRef }: {
  /** The items, given the function that closes the menu. */
  children(close: () => void): ReactNode;
  /** The "…" button, for a popover that opens from it after the menu closes (the version history). */
  buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  const label = useT().web.shell.moreActions;
  const own = useRef<HTMLButtonElement>(null);
  const anchor = buttonRef ?? own;
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <>
      <Button ref={anchor} variant="ghost" icon className="ms-bar-more" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="more" size={16} />
      </Button>
      <Popover open={open} onClose={close} anchor={anchor} placement="bottom-end" width={280}>
        <div role="menu" aria-label={label}>{children(close)}</div>
      </Popover>
    </>
  );
}

/** One item of the menu: closes it and runs; `disabled` (the reason) keeps it in the list, unavailable, with the reason under it. */
export function BarMenuItem({ icon, close, run, disabled = null, hint, children }: {
  icon: IconName; close(): void; run(): void; disabled?: string | null; hint?: string; children: ReactNode;
}) {
  const why = useId();
  const off = disabled !== null;
  return (
    <>
      <NavItem data-row="" role="menuitem" icon={icon} title={hint} aria-disabled={off || undefined} aria-describedby={off ? why : undefined}
        onClick={off ? undefined : () => { close(); run(); }}>{children}</NavItem>
      {off ? <p id={why} className="ms-bar-menu-why" role="note">{disabled}</p> : null}
    </>
  );
}
