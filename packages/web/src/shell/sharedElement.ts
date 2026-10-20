import type { PageMode } from '../motion/index.ts';
import type { Route } from '../routes.ts';
import { peekFrameOrigin } from './intents.ts';

/**
 * Which page changes share an element (the pages fade and recede instead of sliding): a board of the canvas and its format view
 * (T3/T4), and New creative → its new creative when Genera left the brief session's panel there (decision 1419: the chat moves
 * to the canvas's panel). Anything else slides.
 */
export function sharedElement(a: Route, b: Route): PageMode {
  const pair = (x: Route, y: Route) => x.name === 'creative' && y.name === 'format' && x.slug === y.slug && x.creative === y.creative;
  if (pair(a, b) || pair(b, a)) return 'shared';
  if (a.name === 'new-creative' && b.name === 'creative' && a.slug === b.slug && peekFrameOrigin(`brief-panel:${b.slug}/${b.creative}`)) return 'shared';
  return undefined;
}
