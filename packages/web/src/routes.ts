export type Route =
  | { name: 'projects' }
  | { name: 'project'; slug: string; tab: 'creatives' | 'console' }
  | { name: 'new-creative'; slug: string }
  | { name: 'creative'; slug: string; creative: string };

const SLUG = '[a-z0-9][a-z0-9-]*';

export function parseRoute(hash: string): Route {
  let m = hash.match(new RegExp(`^#/p/(${SLUG})/c/(${SLUG})$`));
  if (m) return { name: 'creative', slug: m[1]!, creative: m[2]! };
  m = hash.match(new RegExp(`^#/p/(${SLUG})/new$`));
  if (m) return { name: 'new-creative', slug: m[1]! };
  m = hash.match(new RegExp(`^#/p/(${SLUG})(/console)?$`));
  if (m) return { name: 'project', slug: m[1]!, tab: m[2] ? 'console' : 'creatives' };
  return { name: 'projects' };
}

export const href = {
  projects: () => '#/',
  project: (slug: string, tab: 'creatives' | 'console' = 'creatives') => (tab === 'console' ? `#/p/${slug}/console` : `#/p/${slug}`),
  newCreative: (slug: string) => `#/p/${slug}/new`,
  creative: (slug: string, c: string) => `#/p/${slug}/c/${c}`,
};
