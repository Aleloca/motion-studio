// Report 42: "Applies to" of the composer as one menu button instead of a row of chips per format (a store pack has 19). The
// menu lists the primaries grouped as in the formats column, a checkbox per format and one per group, and "All formats".
// The choice keeps the chips' meaning: null is "All formats" (no formats sent), else the chosen primaries in the brief's order.
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { useT } from '../i18n.tsx';
import { Icon, Popover, cx } from '../ui/index.ts';
import { ICONS } from '../ui/icons.ts';
import { rovingIndex } from '../ui/roving.ts';
import type { AppliesTo } from './Conversation.tsx';

/** The menu's groups: the caller's, or one group without a header. */
function groupsOf(a: AppliesTo): Array<{ label: string | null; items: Array<{ id: string; name: string }> }> {
  const primaries = new Set(a.primaries.map((p) => p.id));
  const groups = a.groups?.map((g) => ({ label: g.label as string | null, items: g.items.filter((it) => primaries.has(it.id)) })).filter((g) => g.items.length);
  if (groups?.length && groups.reduce((n, g) => n + g.items.length, 0) === primaries.size) return groups;
  return [{ label: null, items: a.primaries.map((p) => ({ id: p.id, name: p.label })) }];
}

/**
 * What the button says: "All formats", the one format's name, "App Store · 3 formats" when the chosen ones are all of one group,
 * else "5 formats".
 */
export function appliesSummary(a: AppliesTo, targets: string[] | null, t: ReturnType<typeof useT>): string {
  const c = t.web.chat;
  if (targets === null) return c.appliesAll;
  if (targets.length === 1) return a.primaries.find((p) => p.id === targets[0])?.label ?? targets[0]!;
  const groups = groupsOf(a);
  const one = groups.length > 1 ? groups.find((g) => targets.every((id) => g.items.some((it) => it.id === id))) : undefined;
  return one?.label ? c.appliesInGroup({ group: one.label, count: targets.length }) : c.appliesCount({ count: targets.length });
}

function Box({ state }: { state: boolean | 'mixed' }) {
  return (
    <span className={cx('ms-check', state !== false && 'ms-on')} aria-hidden="true">
      <svg width={11} height={11} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d={state === 'mixed' ? ICONS.minus : ICONS.check} />
      </svg>
    </span>
  );
}

export function AppliesMenu({ appliesTo, targets, onChange }: { appliesTo: AppliesTo; targets: string[] | null; onChange(next: string[] | null): void }) {
  const t = useT();
  const c = t.web.chat;
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const ids = appliesTo.primaries.map((p) => p.id);
  const chosen = new Set(targets ?? []);
  // Every primary chosen, or none left, is "All formats" again (as the chips did).
  const set = (next: Set<string>) => {
    const list = ids.filter((id) => next.has(id));
    onChange(list.length === 0 || list.length === ids.length ? null : list);
  };
  const toggle = (some: string[]) => {
    const next = new Set(chosen);
    const all = some.every((id) => next.has(id));
    for (const id of some) if (all) next.delete(id); else next.add(id);
    set(next);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const rows = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]') ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const to = e.key === 'ArrowLeft' || e.key === 'ArrowRight' ? null : rovingIndex(e.key, at < 0 ? 0 : at, rows.length);
    if (to === null) return;
    e.preventDefault();
    rows[to]?.focus();
  };
  const groups = groupsOf(appliesTo);
  const summary = appliesSummary(appliesTo, targets, t);
  const item = (key: string, state: boolean | 'mixed', label: string, onClick: () => void, extra?: { text: string; title: string }, className?: string) => (
    <button key={key} type="button" role="menuitemcheckbox" aria-checked={state} data-row="" className={cx('ms-navitem ms-applies-item', className)} onClick={onClick}>
      <Box state={state} />
      <span className="ms-applies-name">{label}</span>
      {extra ? <span className="ms-applies-follows" title={extra.title}><Icon name="link" size={11} />{extra.text}</span> : null}
    </button>
  );
  return (
    <div className="ms-composer-applies">
      <button ref={button} type="button" className="ms-applies-btn" aria-haspopup="menu" aria-expanded={open} aria-describedby={hintId}
        aria-label={c.appliesButton({ choice: summary })} onClick={() => setOpen((o) => !o)}>
        <span className="ms-applies-label">{c.appliesTo}:</span>
        <b className="ms-applies-choice">{summary}</b>
        <Icon name="chevron" size={12} />
      </button>
      <span id={hintId} hidden>{c.appliesHint}</span>
      <Popover open={open} onClose={() => setOpen(false)} anchor={button} placement="top-start" width={300}>
        <div ref={menu} role="menu" aria-label={c.appliesTo} className="ms-applies-menu" onKeyDown={onKeyDown}>
          {item('all', targets === null, c.appliesAll, () => onChange(null), undefined, 'ms-applies-all')}
          {groups.map((g, gi) => {
            const inGroup = g.items.map((it) => it.id);
            const n = inGroup.filter((id) => chosen.has(id)).length;
            return (
              // Keyed by place: two groups may share a name (a hand-picked App Store format and the pack's App Store).
              <div key={gi} role="group" aria-label={g.label ?? c.appliesTo} className="ms-applies-group">
                {g.label ? (
                  <>
                    <div className="ms-cap ms-applies-head" aria-hidden="true">{g.label}</div>
                    {groups.length > 1 && g.items.length > 1
                      ? item(`g:${gi}`, n === 0 ? false : n === inGroup.length ? true : 'mixed', c.appliesWholeGroup({ group: g.label }), () => toggle(inGroup), undefined, 'ms-applies-whole')
                      : null}
                  </>
                ) : null}
                {g.items.map((it) => {
                  const p = appliesTo.primaries.find((x) => x.id === it.id)!;
                  const follows = p.followers.length ? { text: p.followers.join(', '), title: p.followers.map((f) => c.followsBoth({ follower: f, primary: p.label })).join('\n') } : undefined;
                  return item(it.id, chosen.has(it.id), it.name, () => toggle([it.id]), follows);
                })}
              </div>
            );
          })}
        </div>
      </Popover>
    </div>
  );
}
