import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useT } from '../i18n.tsx';
import { D, enter, pop } from '../motion/index.ts';
import { href, type ProjectTab, type Route } from '../routes.ts';
import { Button, Icon, NavItem, Popover, Spinner, cx, initials } from '../ui/index.ts';
import { ActivityCenter } from './ActivityCenter.tsx';
import { ProjectSwitcher } from './ProjectSwitcher.tsx';
import { go, useShell } from './ShellContext.tsx';

/** Bar tabs (spec §6.1). The agent console stays reachable (palette, or shown while on it) until Task 16 folds it in. */
const BAR_TABS: ProjectTab[] = ['creatives', 'brand', 'assets', 'references', 'settings'];

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function Logo() {
  const t = useT();
  return (
    <a className="ms-logo" href={href.projects()} aria-label={t.web.shell.home}>
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 2.5v7l6-3.5-6-3.5Z" /></svg>
    </a>
  );
}

/** Central search field: opens the command palette (⌘K / Ctrl+K). */
function SearchButton() {
  const t = useT();
  const { openPalette } = useShell();
  return (
    <button type="button" className="ms-search" onClick={openPalette} aria-keyshortcuts={isMac() ? 'Meta+K' : 'Control+K'}>
      <Icon name="search" size={14} />
      <span className="ms-search-text">{t.web.shell.search}</span>
      <kbd className="ms-kbd">{isMac() ? '⌘K' : 'Ctrl K'}</kbd>
    </button>
  );
}

/** "N running": queued and running jobs; opens the activity center on Running. */
function RunningBadge() {
  const t = useT();
  const { live, activity } = useShell();
  const n = Object.values(live.jobs).filter((j) => j.state === 'queued' || j.state === 'running').length;
  if (!n) return null;
  return (
    <Button variant="ghost" className="ms-running" onClick={() => activity.show('running')}>
      <Spinner decorative />{t.web.shell.running({ count: n })}
    </Button>
  );
}

/** Bell with the pending approvals; the badge bounces when the count grows (T8). Owns the activity popover. */
function Bell() {
  const t = useT();
  const { live, activity, catalog } = useShell();
  const anchor = useRef<HTMLButtonElement>(null);
  const badge = useRef<HTMLSpanElement>(null);
  const n = Object.keys(live.approvals).length;
  const prev = useRef(n);
  useLayoutEffect(() => {
    if (n > prev.current) void pop(badge.current ?? anchor.current);
    prev.current = n;
  }, [n]);
  const where = (project: string, creative: string | null) => {
    const name = catalog.projects?.find((p) => p.slug === project)?.name ?? project;
    if (!creative) return name;
    const title = catalog.creatives[project]?.find((c) => c.slug === creative)?.title || creative;
    return `${name} · ${title}`;
  };
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={cx('ms-btn ms-icon ms-bell', !activity.open && 'ms-ghost')}
        aria-label={t.web.shell.bell({ count: n })}
        aria-haspopup="dialog"
        aria-expanded={activity.open}
        onClick={activity.toggle}
      >
        <Icon name="bell" size={16} />
        {n ? <span ref={badge} className="ms-count ms-bell-count" aria-hidden="true">{n > 99 ? '99+' : n}</span> : null}
      </button>
      <Popover open={activity.open} onClose={activity.hide} anchor={anchor} placement="bottom-end" width={440}>
        <ActivityCenter live={live} initialTab={activity.tab} where={where} />
      </Popover>
    </>
  );
}

/** Account menu (spec §6.1): Settings, System check, Replay setup. No token counter until Phase 8. */
function AccountMenu() {
  const t = useT();
  const s = t.web.shell;
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const pick = (hash: string) => { setOpen(false); go(hash); };
  return (
    <>
      <button ref={anchor} type="button" className="ms-avatar" aria-label={s.account} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {initials('Motion Studio')}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} placement="bottom-end" width={220}>
        <NavItem data-row="" icon="gear" onClick={() => pick(href.settings('general'))}>{s.settings}</NavItem>
        <NavItem data-row="" icon="shield" onClick={() => pick(href.settings('system'))}>{s.systemCheck}</NavItem>
        <div className="ms-pop-sep" role="separator" />
        <NavItem data-row="" icon="sparkle" onClick={() => pick(href.welcome())}>{s.replaySetup}</NavItem>
      </Popover>
    </>
  );
}

/** Right side shared by every bar. */
function Status({ running = true }: { running?: boolean }) {
  return (
    <div className="ms-topbar-end">
      {running ? <RunningBadge /> : null}
      <Bell />
      <AccountMenu />
    </div>
  );
}

/** Global bar (Projects, Settings): logo, central search, "N running", bell, avatar. */
export function GlobalTop({ title }: { title?: string }) {
  return (
    <>
      <Logo />
      <span className="ms-brand">Motion Studio</span>
      {title ? <><span className="ms-faint" aria-hidden="true">/</span><b className="ms-topbar-title">{title}</b></> : null}
      <div className="ms-topbar-center"><SearchButton /></div>
      <Status />
    </>
  );
}

/** Project bar: logo, project switcher, section tabs, "N running", bell, avatar. */
export function ProjectTop({ slug, tab }: { slug: string; tab: ProjectTab }) {
  const t = useT();
  const tabs = tab === 'console' ? [...BAR_TABS, 'console' as const] : BAR_TABS;
  return (
    <>
      <Logo />
      <ProjectSwitcher slug={slug} />
      <nav className="ms-tabs ms-bar ms-topbar-tabs" aria-label={t.web.project.sections}>
        {tabs.map((id) => (
          <a key={id} href={href.project(slug, id)} className={cx('ms-tab', tab === id && 'ms-on')} aria-current={tab === id ? 'page' : undefined}>
            {t.web.project.tabs[id]}
          </a>
        ))}
      </nav>
      <div className="ms-grow" />
      <Status />
    </>
  );
}

/** Creative / editor bar: back, breadcrumb, bell, avatar (+ a slot for the creative's own actions). */
export function CreativeTop({ back, crumbs, right }: { back: { label: string; hash: string }; crumbs: ReactNode[]; right?: ReactNode }) {
  const t = useT();
  return (
    <>
      <Button className="ms-back" onClick={() => go(back.hash)}><Icon name="back" size={16} strokeWidth={1.5} />{back.label}</Button>
      <nav className="ms-crumbs" aria-label={t.web.shell.breadcrumb}>
        {crumbs.map((c, i) => (
          <span key={i} className={cx('ms-crumb', i === crumbs.length - 1 && 'ms-last')}>
            {i > 0 ? <span className="ms-faint" aria-hidden="true">/</span> : null}
            {i === crumbs.length - 1 ? <b aria-current="page">{c}</b> : <span>{c}</span>}
          </span>
        ))}
      </nav>
      <div className="ms-grow" />
      {right}
      <Status running={false} />
    </>
  );
}

/** Kind of bar for a route: switching kind fades the new bar in. */
function barKey(r: Route): string {
  switch (r.name) {
    case 'project': return `project:${r.slug}`;
    case 'new-creative': case 'creative': case 'format': return `creative:${r.slug}`;
    default: return 'global';
  }
}

/** The top bar of the current route (spec §6.1). */
export function TopBar() {
  const t = useT();
  const { route: r, catalog } = useShell();
  const ref = useRef<HTMLElement>(null);
  const key = barKey(r);
  const prev = useRef(key);
  useLayoutEffect(() => {
    if (prev.current === key) return;
    prev.current = key;
    void enter(ref.current, { y: 0, ms: D.s });
  }, [key]);

  const projectName = (slug: string) => catalog.projects?.find((p) => p.slug === slug)?.name ?? slug;
  const creativeTitle = (slug: string, c: string) => catalog.creatives[slug]?.find((x) => x.slug === c)?.title || c;
  let content: ReactNode;
  switch (r.name) {
    case 'project':
      content = <ProjectTop slug={r.slug} tab={r.tab} />;
      break;
    case 'new-creative':
      content = <CreativeTop back={{ label: t.web.shell.backCreatives, hash: href.project(r.slug) }} crumbs={[projectName(r.slug), t.web.shell.newCreative]} />;
      break;
    case 'creative':
      content = <CreativeTop back={{ label: t.web.shell.backCreatives, hash: href.project(r.slug) }} crumbs={[projectName(r.slug), creativeTitle(r.slug, r.creative)]} />;
      break;
    case 'format':
      content = <CreativeTop back={{ label: t.web.shell.backAllFormats, hash: href.creative(r.slug, r.creative) }} crumbs={[projectName(r.slug), creativeTitle(r.slug, r.creative), <span className="ms-mono">{r.format}</span>]} />;
      break;
    case 'settings':
      content = <GlobalTop title={t.web.shell.settings} />;
      break;
    default:
      content = <GlobalTop />;
  }
  return <header ref={ref} className="ms-topbar">{content}</header>;
}
