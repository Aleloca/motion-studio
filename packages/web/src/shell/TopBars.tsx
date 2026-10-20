import { BrandLogo } from '../components/BrandLogo.tsx';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { hostOf } from '@motion-studio/shared';
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
import { useTitleBarClass } from '../titleBar.ts';

/** Bar tabs (spec §6.1). */
const BAR_TABS: ProjectTab[] = ['creatives', 'brand', 'assets', 'references', 'settings'];

function Logo() {
  const t = useT();
  // Room decides which one shows (shell.css): the whole logo on a wide window, the mark alone on a narrow one.
  return (
    <a className="ms-logo-link" href={href.projects()} aria-label={t.web.shell.home}>
      <BrandLogo variant="horizontal" height={22} className="ms-logo-full" decorative />
      <BrandLogo variant="mark" height={24} className="ms-logo-mark" decorative />
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
      <a className="ms-brand-logo" href={href.projects()}><BrandLogo variant="horizontal" height={22} /></a>
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
const titleSlotRef = (el: HTMLElement | null) => setBarSlot('title', el);
const endSlotRef = (el: HTMLElement | null) => setBarSlot('end', el);

/**
 * A creative's folder name as a title, when nothing better is known (user report 23): without the date and a variant's
 * `~b` or `~aa`, dashes as spaces, the first letter upper case ("2026-10-17-create-a-60-second~b" → "Create a 60 second").
 */
export function slugTitle(slug: string): string {
  const words = hostOf(slug).replace(/^\d{4}-\d{2}-\d{2}-?/, '').replace(/-+/g, ' ').trim();
  return words ? words[0]!.toLocaleUpperCase() + words.slice(1) : slug;
}

/** An ancestor crumb: a link back to that page, its whole text in the tooltip when it is cut. */
export interface CrumbLink { label: string; hash: string; title?: string; tag?: string | null; onOpen?: (() => void) | null; className?: string }

const plainClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

/**
 * Creative / format bar (user reports 17 and 23): the app's mark, then the breadcrumb whose ancestors are links (project,
 * creative: they are the way back, there is no back button), then the current item: `current` (a plain name), or what the
 * page portals into the title slot (`slots`: its title and state, or the format's name and facts). Right: the object's
 * actions the page portals into the end slot, a separator, and the app's controls.
 */
export function CreativeTop({ links, current, slots }: { links: CrumbLink[]; current?: ReactNode; slots?: boolean }) {
  const t = useT();
  return (
    <>
      <nav className="ms-crumbs" aria-label={t.web.shell.breadcrumb}>
        <a className="ms-logo-link ms-bar-home" href={href.projects()} aria-label={t.web.shell.home} title={t.web.shell.home}>
          <BrandLogo variant="mark" height={22} decorative />
        </a>
        {links.map((l, i) => (
          <span key={i} className={cx('ms-crumb', l.className)}>
            {i > 0 ? <span className="ms-crumb-sep" aria-hidden="true">/</span> : null}
            <a className="ms-crumb-link" href={l.hash} title={l.title ?? l.label}
              onClick={l.onOpen ? (e) => { if (plainClick(e.nativeEvent)) { e.preventDefault(); l.onOpen!(); } } : undefined}>
              <span className="ms-crumb-text">{l.label}</span>
              {l.tag ? <span className="ms-crumb-tag">{l.tag}</span> : null}
            </a>
          </span>
        ))}
        {current !== undefined ? (
          <span className="ms-crumb ms-last">
            <span className="ms-crumb-sep" aria-hidden="true">/</span>
            <b aria-current="page">{current}</b>
          </span>
        ) : null}
        {slots ? <span className="ms-bar-slot ms-bar-title" ref={titleSlotRef} /> : null}
      </nav>
      <div className="ms-grow" />
      {slots ? <span className="ms-bar-slot ms-bar-end" ref={endSlotRef} /> : null}
      {slots ? <span className="ms-bar-sep" aria-hidden="true" /> : null}
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
  const { owner, crumb } = useBarSlots();
  const titleBar = useTitleBarClass();
  const ref = useRef<HTMLElement>(null);
  const key = barKey(r);
  const prev = useRef(key);
  useLayoutEffect(() => {
    if (prev.current === key) return;
    prev.current = key;
    void enter(ref.current, { y: 0, ms: D.s });
  }, [key]);

  const projectName = (slug: string) => catalog.projects?.find((p) => p.slug === slug)?.name ?? slug;
  // A variant sister (`<slug>~b`, `~aa`…) is not in the catalog: its group shares the host's title (spec §2).
  const catalogTitle = (slug: string, c: string) => {
    const list = catalog.creatives[slug];
    return list?.find((x) => x.slug === c)?.title || list?.find((x) => x.slug === hostOf(c))?.title || null;
  };
  let content: ReactNode;
  /** The format page claimed the bar: only that bar folds its actions by its width (format.css, decision 713). */
  let formatBar = false;
  const projectLink = (slug: string): CrumbLink => ({ label: projectName(slug), hash: href.project(slug), className: 'ms-crumb-project' });
  const creativeLink = (slug: string, c: string): CrumbLink => {
    const said = crumb && crumb.key === owner ? crumb : null;
    const label = said?.title || catalogTitle(slug, c) || slugTitle(c);
    const letter = said?.variant ?? (/~([a-z])$/.exec(c)?.[1]?.toUpperCase() ?? null);
    return { label, title: letter ? `${label} · ${letter}` : label, tag: letter, hash: href.creative(slug, c), onOpen: said?.open ?? null, className: 'ms-crumb-creative' };
  };
  switch (r.name) {
    case 'project':
      content = <ProjectTop slug={r.slug} tab={r.tab} />;
      break;
    case 'new-creative':
      // Decision 1410: the page puts "Compila tu / Con l'agente" in the bar's end slot; its title stays the bar's.
      content = <CreativeTop links={[projectLink(r.slug)]} current={t.web.shell.newCreative} slots />;
      break;
    case 'creative': {
      // The creative page puts its editable title in the bar; until it does, the crumb shows the known title.
      const claimed = owner === routeKey(r);
      content = <CreativeTop links={[projectLink(r.slug)]} slots current={claimed ? undefined : creativeLink(r.slug, r.creative).label} />;
      break;
    }
    case 'format': {
      // The format page (the editor) puts the format's name, its facts and its actions in the bar; until it does, the id.
      const claimed = owner === routeKey(r);
      formatBar = claimed;
      content = <CreativeTop links={[projectLink(r.slug), creativeLink(r.slug, r.creative)]} slots current={claimed ? undefined : <span className="ms-mono">{r.format}</span>} />;
      break;
    }
    case 'settings':
      content = <GlobalTop title={t.web.shell.settings} />;
      break;
    default:
      content = <GlobalTop />;
  }
  // Desktop: the bar is the window's title bar (drag region, room for the window controls); no change in a browser.
  return <header ref={ref} className={cx('ms-topbar', formatBar && 'ms-bar-fv', titleBar)}>{content}</header>;
}
