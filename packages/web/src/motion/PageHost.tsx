import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { D, enter, exit, recede } from './motion';

interface Entry<R> {
  /** Unique per mount: a page that returns to an earlier key is a new entry, never a revived one. */
  id: number;
  key: string;
  route: R;
  dir: 1 | -1;
  leaving: boolean;
  /** How this page arrived or leaves: 'shared' for a shared-element pair (T3/T4), otherwise T1. */
  mode?: PageMode;
}

/** 'shared': a shared element carries the eye (T3/T4); the pages only fade and recede, they do not slide. */
export type PageMode = 'shared' | undefined;

export interface PageHostProps<R> {
  route: R;
  keyOf(r: R): string;
  depthOf?(r: R): number;
  /** Same-level swaps (tabs): fade and lift instead of sliding. */
  soft?: boolean;
  /** Transition of a route pair; 'shared' (T3/T4): the incoming page fades in without moving, the outgoing recedes. */
  modeOf?(prev: R, next: R): PageMode;
  render(r: R): ReactNode;
}

/**
 * Keeps at most one leaving and one entering page. A new navigation during a transition drops the
 * previous leaving page at once, so there is never more than two pages nor an invisible one.
 */
export function PageHost<R>({ route, keyOf, depthOf, soft, modeOf, render }: PageHostProps<R>) {
  const key = keyOf(route);
  const seq = useRef(0);
  const prev = useRef({ key, depth: depthOf?.(route) ?? 0, route });
  const [pages, setPages] = useState<Entry<R>[]>(() => [{ id: 0, key, route, dir: 1, leaving: false }]);

  useLayoutEffect(() => {
    if (prev.current.key === key) {
      // Same page, new route object (e.g. params): refresh content without re-animating.
      setPages((ps) => ps.map((p) => (!p.leaving && p.key === key ? { ...p, route } : p)));
      return;
    }
    const depth = depthOf?.(route) ?? 0;
    const dir: 1 | -1 = depth >= prev.current.depth ? 1 : -1;
    const mode = modeOf?.(prev.current.route, route);
    prev.current = { key, depth, route };
    const id = ++seq.current;
    setPages((ps) => [
      ...ps.filter((p) => !p.leaving).map((p) => ({ ...p, dir, mode, leaving: true })),
      { id, key, route, dir, mode, leaving: false },
    ]);
  }, [key, route]); // eslint-disable-line react-hooks/exhaustive-deps

  const gone = (id: number) => setPages((ps) => ps.filter((p) => p.id !== id));

  return (
    <div className="ms-stage">
      {pages.map((p) => (
        <Page key={p.id} leaving={p.leaving} dir={p.dir} soft={soft} mode={p.mode} onGone={() => gone(p.id)}>
          {render(p.route)}
        </Page>
      ))}
    </div>
  );
}

function Page({
  leaving,
  dir,
  soft,
  mode,
  onGone,
  children,
}: {
  leaving: boolean;
  dir: 1 | -1;
  soft?: boolean;
  mode?: PageMode;
  onGone(): void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const goneRef = useRef(onGone);
  goneRef.current = onGone;
  useLayoutEffect(() => {
    // Shared (T3 forward, T4 back and faster): no slide, the shared element moves; the page left behind recedes.
    const shared = mode === 'shared';
    if (leaving) {
      const out = shared ? recede(ref.current, dir > 0 ? D.m : D.s) : exit(ref.current, { x: soft ? 0 : -dir * 16, ms: D.s });
      void out.then((finished) => {
        if (finished) goneRef.current();
      });
    } else if (shared) {
      void enter(ref.current, { x: 0, y: 0, ms: dir > 0 ? D.m : D.s });
    } else {
      void enter(ref.current, { x: soft ? 0 : dir * 24, y: soft ? 6 : 0, ms: D.m });
    }
  }, [leaving]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div
      className="ms-page"
      ref={ref}
      data-page-active={leaving ? undefined : ''}
      style={{ pointerEvents: leaving ? 'none' : 'auto', zIndex: leaving ? 0 : 1 }}
    >
      {children}
    </div>
  );
}
