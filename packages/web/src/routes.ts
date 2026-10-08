export type ProjectTab = 'creatives' | 'brand' | 'assets' | 'references' | 'settings' | 'console';
const TABS: ProjectTab[] = ['brand', 'assets', 'references', 'settings', 'console'];
export type Route =
  | { name: 'projects' }
  | { name: 'settings' }
  | { name: 'project'; slug: string; tab: ProjectTab }
  | { name: 'new-creative'; slug: string }
  | { name: 'creative'; slug: string; creative: string };

const SLUG = '[a-z0-9][a-z0-9-]*';

export function parseRoute(hash: string): Route {
  if (hash === '#/settings') return { name: 'settings' };
  let m = hash.match(new RegExp(`^#/p/(${SLUG})/c/(${SLUG})$`));
  if (m) return { name: 'creative', slug: m[1]!, creative: m[2]! };
  m = hash.match(new RegExp(`^#/p/(${SLUG})/new$`));
  if (m) return { name: 'new-creative', slug: m[1]! };
  m = hash.match(new RegExp(`^#/p/(${SLUG})(?:/([a-z]+))?$`));
  if (m) {
    const tab = (m[2] ?? 'creatives') as ProjectTab;
    if (tab === 'creatives' || TABS.includes(tab)) return { name: 'project', slug: m[1]!, tab };
  }
  return { name: 'projects' };
}

export const href = {
  projects: () => '#/',
  settings: () => '#/settings',
  project: (slug: string, tab: ProjectTab = 'creatives') => (tab === 'creatives' ? `#/p/${slug}` : `#/p/${slug}/${tab}`),
  newCreative: (slug: string) => `#/p/${slug}/new`,
  creative: (slug: string, c: string) => `#/p/${slug}/c/${c}`,
};
