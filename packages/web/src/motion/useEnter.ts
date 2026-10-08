import { useLayoutEffect, useRef, type RefObject } from 'react';
import { enter } from './motion';

/** Animates [data-enter] descendants in a cascade (data-x / data-y / data-delay override per element). */
export function useEnter<T extends HTMLElement>(deps: unknown[] = []): RefObject<T> {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    root.querySelectorAll<HTMLElement>('[data-enter]').forEach((el, i) => {
      void enter(el, {
        y: Number(el.dataset.y ?? 8),
        x: Number(el.dataset.x ?? 0),
        delay: Number(el.dataset.delay ?? i * 30),
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref as RefObject<T>;
}
