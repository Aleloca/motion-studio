import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { D, enter, exit } from './motion';

interface Entry<R> {
  /** Unique per mount: a page that returns to an earlier key is a new entry, never a revived one. */
  id: number;
  key: string;
  route: R;
  dir: 1 | -1;
  leaving: boolean;
}

export interface PageHostProps<R> {
  route: R;
  keyOf(r: R): string;
  depthOf?(r: R): number;
  /** Same-level swaps (tabs): fade and lift instead of sliding. */
  soft?: boolean;
  render(r: R): ReactNode;
}

/**
 * Keeps at most one leaving and one entering page. A new navigation during a transition drops the
 * previous leaving page at once, so there is never more than two pages nor an invisible one.
 */
export function PageHost<R>({ route, keyOf, depthOf, soft, render }: PageHostProps<R>) {
  const key = keyOf(route);
  const seq = useRef(0);
  const prev = useRef({ key, depth: depthOf?.(route) ?? 0 });
  const [pages, setPages] = useState<Entry<R>[]>(() => [{ id: 0, key, route, dir: 1, leaving: false }]);

  useLayoutEffect(() => {
    if (prev.current.key === key) {
      // Same page, new route object (e.g. params): refresh content without re-animating.
      setPages((ps) => ps.map((p) => (!p.leaving && p.key === key ? { ...p, route } : p)));
      return;
    }
    const depth = depthOf?.(route) ?? 0;
    const dir: 1 | -1 = depth >= prev.current.depth ? 1 : -1;
    prev.current = { key, depth };
    const id = ++seq.current;
    setPages((ps) => [
      ...ps.filter((p) => !p.leaving).map((p) => ({ ...p, dir, leaving: true })),
      { id, key, route, dir, leaving: false },
    ]);
  }, [key, route]); // eslint-disable-line react-hooks/exhaustive-deps

  const gone = (id: number) => setPages((ps) => ps.filter((p) => p.id !== id));

  return (
    <div className="main">
      {pages.map((p) => (
        <Page key={p.id} leaving={p.leaving} dir={p.dir} soft={soft} onGone={() => gone(p.id)}>
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
  onGone,
  children,
}: {
  leaving: boolean;
  dir: 1 | -1;
  soft?: boolean;
  onGone(): void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const goneRef = useRef(onGone);
  goneRef.current = onGone;
  useLayoutEffect(() => {
    if (leaving) void exit(ref.current, { x: soft ? 0 : -dir * 16, ms: D.s }).then(() => goneRef.current());
    else void enter(ref.current, { x: soft ? 0 : dir * 24, y: soft ? 6 : 0, ms: D.m });
  }, [leaving]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div
      className="page"
      ref={ref}
      data-page-active={leaving ? undefined : ''}
      style={{ pointerEvents: leaving ? 'none' : 'auto', zIndex: leaving ? 0 : 1 }}
    >
      {children}
    </div>
  );
}
