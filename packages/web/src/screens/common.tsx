// Small pieces shared by the library and settings screens (Assets, References, Project settings, App settings).
import type { ReactNode } from 'react';
import { useEnter } from '../motion/index.ts';
import { Icon } from '../ui/index.ts';
import './common.css';

/** Time the Undo of a delete, removal or revoke stays offered before it is sent (brief: 5 s). */
export const UNDO_MS = 5000;

/** The one error-text helper of the screens (see errors.ts). */
export { message } from '../errors.ts';

/** A warning explained in place, with an optional action (the remedy). */
export function Alert({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="ms-alert" role="alert">
      <Icon name="warn" size={14} />
      <span>{children}</span>
      {action}
    </div>
  );
}

/** A settings row of the prototype: title and explanation on the left, the control on the right. */
export function Row({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="ms-set-row">
      <div className="ms-set-row-text"><b>{title}</b>{sub ? <span>{sub}</span> : null}</div>
      {children !== undefined ? <div className="ms-set-row-ctl">{children}</div> : null}
    </div>
  );
}

/** A section title with its explanation and optional actions on the right. */
export function Head({ title, sub, children }: { title: string; sub?: string; children?: ReactNode }) {
  return (
    <div className="ms-set-head" data-enter>
      <div className="ms-set-head-text"><h1>{title}</h1>{sub ? <span>{sub}</span> : null}</div>
      {children}
    </div>
  );
}

/** The section column of a settings page: its content enters in cascade (data-enter) at each section change. */
export function SectionMain({ section, children }: { section: string; children: ReactNode }) {
  const root = useEnter<HTMLElement>([section]);
  return <main ref={root} className="ms-set-main">{children}</main>;
}
