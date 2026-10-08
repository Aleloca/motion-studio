import { createContext, useContext } from 'react';
import type { EventsState } from '../eventsReducer.ts';
import type { Route } from '../routes.ts';
import type { Catalog } from './catalog.ts';

export type ActivityTab = 'needs' | 'running' | 'done';

export interface Shell {
  route: Route;
  live: EventsState;
  catalog: Catalog;
  /** The activity center popover (anchored to the bell); `tab` picks the section it opens on. */
  activity: { open: boolean; tab: ActivityTab | null; show(tab?: ActivityTab): void; hide(): void; toggle(): void };
  openPalette(): void;
}

export const ShellContext = createContext<Shell | null>(null);

export function useShell(): Shell {
  const s = useContext(ShellContext);
  if (!s) throw new Error('useShell outside the shell');
  return s;
}

/** Hash navigation (the router listens to hashchange). */
export function go(hash: string): void {
  if (location.hash !== hash) location.hash = hash;
}
