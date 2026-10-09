import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useT } from '../i18n.tsx';
import { D, enter, pop } from '../motion/index.ts';
import { href, routeKey, type ProjectTab, type Route } from '../routes.ts';
import { Button, Icon, NavItem, Popover, Spinner, cx, initials } from '../ui/index.ts';
import { ActivityCenter } from './ActivityCenter.tsx';
import { setBarSlot, useBarSlots } from './barSlots.ts';
import { ProjectSwitcher } from './ProjectSwitcher.tsx';
import { go, useShell } from './ShellContext.tsx';
import { TokensButton } from './Tokens.tsx';
import { todayTokens } from '../usageLive.ts';
import { isMac } from '../platform.ts';

/** Bar tabs (spec §6.1). */
const BAR_TABS: ProjectTab[] = ['creatives', 'brand', 'assets', 'references', 'settings'];

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
        <ActivityCenter live={live} initialTab={activity.tab} request={activity.seq} where={where} />
      </Popover>
    </>
  );
}

/** Today's tokens of the workspace, live (spec §5.4): "—" until the ledger's day total arrives (and after midnight until the new day's does). */
function Tokens() {
  const { live } = useShell();
  return <TokensButton tokens={todayTokens(live)} />;
}

/** Account menu (spec §6.1): Settings, System check, Replay setup. */
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
      <Tokens />
      <AccountMenu />
    </div>
  );
}

/** Global bar (Projects, Settings): logo, central search, "N running", bell, tokens, avatar. */
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

/** Project bar: logo, project switcher, section tabs, "N running", bell, tokens, avatar. */
export function ProjectTop({ slug, tab }: { slug: string; tab: ProjectTab }) {
  const t = useT();
  return (
    <>
      <Logo />
      <ProjectSwitcher slug={slug} />
      <nav className="ms-tabs ms-bar ms-topbar-tabs" aria-label={t.web.project.sections}>
        {BAR_TABS.map((id) => (
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

// Stable ref callbacks: a new function each render would empty and refill the slots (and re-render the bar) every time.
const startSlotRef = (el: HTMLElement | null) => setBarSlot('start', el);
const titleSlotRef = (el: HTMLElement | null) => setBarSlot('title', el);
const endSlotRef = (el: HTMLElement | null) => setBarSlot('end', el);

/**
 * Creative / editor bar: back, breadcrumb, bell, avatar. With `slots`, the page of the route fills the title slot
 * (after the breadcrumb: editable title and state) and the end slot (version menu, Export); `claimed` says it did, so
 * the last crumb is the page's own title and not the bar's. Without `back` the page puts its own back button in the
 * start slot (the format view, whose way back is a transition).
 */
export function CreativeTop({ back, crumbs, right, slots, claimed }: { back: { label: string; hash: string } | null; crumbs: ReactNode[]; right?: ReactNode; slots?: boolean; claimed?: boolean }) {
  const t = useT();
  const current = (i: number) => i === crumbs.length - 1 && !claimed;
  return (
    <>
      {slots ? <span className="ms-bar-slot ms-bar-start" ref={startSlotRef} /> : null}
      {back ? <Button className="ms-back" onClick={() => go(back.hash)}><Icon name="back" size={16} strokeWidth={1.5} />{back.label}</Button> : null}
      <nav className="ms-crumbs" aria-label={t.web.shell.breadcrumb}>
        {crumbs.map((c, i) => (
          <span key={i} className={cx('ms-crumb', current(i) && 'ms-last')}>
            {i > 0 ? <span className="ms-faint" aria-hidden="true">/</span> : null}
            {current(i) ? <b aria-current="page">{c}</b> : <span>{c}</span>}
          </span>
        ))}
        {slots ? <span className="ms-bar-slot ms-bar-title" ref={titleSlotRef} /> : null}
      </nav>
      <div className="ms-grow" />
      {right}
      {slots ? <span className="ms-bar-slot ms-bar-end" ref={endSlotRef} /> : null}
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
  const { owner } = useBarSlots();
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
    case 'creative': {
      // The creative page puts its editable title in the bar; until it does, the crumb shows the known title.
      const claimed = owner === routeKey(r);
      content = <CreativeTop back={{ label: t.web.shell.backCreatives, hash: href.project(r.slug) }} slots claimed={claimed}
        crumbs={claimed ? [projectName(r.slug)] : [projectName(r.slug), creativeTitle(r.slug, r.creative)]} />;
      break;
    }
    case 'format': {
      // The format view puts "← All formats" (T4), the format and the version controls in the bar; until it does, the
      // bar's own back button and the format id.
      const claimed = owner === routeKey(r);
      content = <CreativeTop back={claimed ? null : { label: t.web.shell.backAllFormats, hash: href.creative(r.slug, r.creative) }} slots claimed={claimed}
        crumbs={claimed ? [projectName(r.slug), creativeTitle(r.slug, r.creative)] : [projectName(r.slug), creativeTitle(r.slug, r.creative), <span className="ms-mono">{r.format}</span>]} />;
      break;
    }
    case 'settings':
      content = <GlobalTop title={t.web.shell.settings} />;
      break;
    default:
      content = <GlobalTop />;
  }
  return <header ref={ref} className="ms-topbar">{content}</header>;
}
