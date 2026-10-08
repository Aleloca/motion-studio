import { useRef, useState } from 'react';
import { useT } from '../i18n.tsx';
import { href } from '../routes.ts';
import { Icon, NavItem, Popover, initials } from '../ui/index.ts';
import { go, useShell } from './ShellContext.tsx';

/** Project monogram tile (no brand colours yet: the kit arrives with the Brand screen). */
export function ProjectMark({ name, size = 'sm' }: { name: string; size?: 'sm' | 'md' }) {
  return <span className={`ms-projmark ms-${size}`} aria-hidden="true">{initials(name) || '·'}</span>;
}

/** Project bar: the current project's name opens a popover with every project and "New project" (spec §6.1). */
export function ProjectSwitcher({ slug }: { slug: string }) {
  const t = useT();
  const s = t.web.shell;
  const { catalog } = useShell();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const projects = catalog.projects ?? [];
  const name = projects.find((p) => p.slug === slug)?.name ?? slug;
  const pick = (hash: string) => { setOpen(false); go(hash); };

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="ms-switcher"
        aria-label={s.switchProject({ name })}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { if (!open) catalog.refresh(); setOpen((o) => !o); }}
      >
        <ProjectMark name={name} />
        <span className="ms-switcher-name">{name}</span>
        <Icon name="chevron" size={12} className="ms-faint" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} width={260}>
        <span className="ms-cap ms-pop-cap">{s.projects}</span>
        {projects.map((p) => (
          <NavItem key={p.slug} data-row="" on={p.slug === slug} onClick={() => pick(href.project(p.slug))}>
            <span className="ms-switcher-row"><ProjectMark name={p.name} />{p.name}{p.slug === slug ? <Icon name="check" size={13} className="ms-switcher-check" /> : null}</span>
          </NavItem>
        ))}
        <div className="ms-pop-sep" role="separator" />
        <NavItem data-row="" icon="plus" onClick={() => pick(href.projects())}>{s.newProject}</NavItem>
      </Popover>
    </>
  );
}
