import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useT } from '../i18n.tsx';
import { href, projectOf, type ProjectTab, type Route } from '../routes.ts';
import { Icon, Modal, cx, type IconName } from '../ui/index.ts';
import type { Catalog } from './catalog.ts';
import { go } from './ShellContext.tsx';

/** Rows shown at most (the list scrolls; typing narrows it). */
export const PALETTE_MAX = 50;

type Group = 'pages' | 'projects' | 'creatives';
export interface PaletteItem { id: string; group: Group; label: string; sub?: string; icon: IconName; hash: string }

const PROJECT_TABS: Array<[ProjectTab, IconName]> = [['creatives', 'grid'], ['brand', 'drop'], ['assets', 'image'], ['references', 'link'], ['settings', 'gear']];

/** Case- and accent-insensitive. */
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Every query word must appear in the label or the sub line. */
export function matches(item: PaletteItem, query: string): boolean {
  const hay = fold(`${item.label} ${item.sub ?? ''}`);
  return fold(query).split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

/**
 * Command palette (spec §6.1): navigation only, never a destructive action. Searches pages, projects
 * (`listProjects`) and the creatives of the projects visited in this session (`listCreatives`).
 */
export function CommandPalette({ open, onClose, catalog, route }: { open: boolean; onClose(): void; catalog: Catalog; route: Route }) {
  const t = useT();
  const s = t.web.shell;
  const uid = useId();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    catalog.refresh();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const name = (slug: string) => catalog.projects?.find((p) => p.slug === slug)?.name ?? slug;
  const current = projectOf(route);
  const items = useMemo((): PaletteItem[] => {
    const pages: PaletteItem[] = [
      { id: 'p:projects', group: 'pages', label: s.projects, icon: 'grid', hash: href.projects() },
      { id: 'p:settings', group: 'pages', label: s.settings, icon: 'gear', hash: href.settings('general') },
      { id: 'p:system', group: 'pages', label: s.systemCheck, icon: 'shield', hash: href.settings('system') },
      { id: 'p:welcome', group: 'pages', label: s.replaySetup, icon: 'sparkle', hash: href.welcome() },
    ];
    if (current) {
      const sub = s.palette.inProject({ project: name(current) });
      for (const [tab, icon] of PROJECT_TABS) pages.push({ id: `p:${current}:${tab}`, group: 'pages', label: t.web.project.tabs[tab], sub, icon, hash: href.project(current, tab) });
      pages.push({ id: `p:${current}:new`, group: 'pages', label: s.newCreative, sub, icon: 'plus', hash: href.newCreative(current) });
    }
    const projects: PaletteItem[] = (catalog.projects ?? []).map((p) => ({ id: `pr:${p.slug}`, group: 'projects', label: p.name, sub: p.slug, icon: 'folder', hash: href.project(p.slug) }));
    const creatives: PaletteItem[] = Object.entries(catalog.creatives).flatMap(([slug, list]) =>
      list.map((c) => ({ id: `c:${slug}/${c.slug}`, group: 'creatives' as const, label: c.title || c.slug, sub: s.palette.inProject({ project: name(slug) }), icon: 'video' as const, hash: href.creative(slug, c.slug) })));
    return [...pages, ...projects, ...creatives];
  }, [catalog.projects, catalog.creatives, current, t]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => items.filter((i) => matches(i, query)).slice(0, PALETTE_MAX), [items, query]);
  const index = Math.min(active, Math.max(0, shown.length - 1));
  const optId = (i: number) => `${uid}-o${i}`;
  useEffect(() => { setActive(0); }, [query]);
  useLayoutEffect(() => {
    const el = list.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [index]);

  const choose = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    go(item.hash);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!shown.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((index + step + shown.length) % shown.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(shown[index]);
    }
  };

  const groups: Array<[Group, string]> = [['pages', s.palette.pages], ['projects', s.palette.projects], ['creatives', s.palette.creatives]];
  return (
    <Modal open={open} onClose={onClose} label={s.palette.label} width={600}>
      <div className="ms-palette">
        <label className="ms-palette-field">
          <Icon name="search" size={16} />
          <input
            className="ms-palette-input"
            role="combobox"
            aria-label={s.palette.label}
            aria-expanded={shown.length > 0}
            aria-controls={`${uid}-list`}
            aria-autocomplete="list"
            aria-activedescendant={shown.length ? optId(index) : undefined}
            placeholder={s.palette.placeholder}
            value={query}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd className="ms-kbd">esc</kbd>
        </label>
        <div ref={list} id={`${uid}-list`} role="listbox" aria-label={s.palette.label} className="ms-palette-list">
          {shown.length === 0 ? (
            <div className="ms-palette-empty" role="presentation">{s.palette.empty({ query: query.trim() })}</div>
          ) : groups.map(([g, label]) => {
            const rows = shown.map((item, i) => ({ item, i })).filter(({ item }) => item.group === g);
            if (!rows.length) return null;
            return (
              <div key={g} role="presentation" className="ms-palette-group">
                <span className="ms-cap ms-palette-cap" role="presentation">{label}</span>
                {rows.map(({ item, i }) => (
                  <div
                    key={item.id}
                    id={optId(i)}
                    data-index={i}
                    role="option"
                    aria-selected={i === index}
                    className={cx('ms-option', 'ms-palette-row', i === index && 'ms-active')}
                    onMouseMove={() => { if (i !== index) setActive(i); }}
                    onClick={() => choose(item)}
                  >
                    <Icon name={item.icon} size={14} />
                    <span className="ms-option-label">{item.label}</span>
                    {item.sub ? <span className="ms-palette-sub">{item.sub}</span> : null}
                    {i === index ? <Icon name="forward" size={12} className="ms-palette-go" /> : null}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        <div className="ms-palette-foot" aria-hidden="true">{s.palette.hint}</div>
      </div>
    </Modal>
  );
}
