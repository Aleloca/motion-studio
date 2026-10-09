export type ProjectTab = 'creatives' | 'brand' | 'assets' | 'references' | 'settings';
const TABS: ProjectTab[] = ['brand', 'assets', 'references', 'settings'];
export type SettingsSection = 'general' | 'system' | 'paid' | 'notifications' | 'updates';
export const SETTINGS_SECTIONS: readonly SettingsSection[] = ['general', 'system', 'paid', 'notifications', 'updates'];
export type WelcomeStep = 1 | 2 | 3;

export type Route =
  | { name: 'welcome'; step?: WelcomeStep }
  | { name: 'projects' }
  | { name: 'settings'; section: SettingsSection }
  | { name: 'project'; slug: string; tab: ProjectTab }
  | { name: 'new-creative'; slug: string }
  | { name: 'creative'; slug: string; creative: string }
  | { name: 'format'; slug: string; creative: string; format: string };

const SLUG = '[a-z0-9][a-z0-9-]*';
/** The old project "Agent console" tab: its technical events now live in the conversation's Activity details. */
const LEGACY_CONSOLE = new RegExp(`^#/p/(${SLUG})/console$`);

/** An old link that now lives elsewhere: the hash to show instead (the console opens the project's creatives). */
export function redirectOf(hash: string): string | null {
  const m = hash.match(LEGACY_CONSOLE);
  return m ? `#/p/${m[1]}` : null;
}

export function parseRoute(hash: string): Route {
  if (hash === '#/settings') return { name: 'settings', section: 'general' };
  let m = hash.match(/^#\/settings\/([a-z]+)$/);
  if (m) {
    const section = m[1] as SettingsSection;
    return SETTINGS_SECTIONS.includes(section) ? { name: 'settings', section } : { name: 'projects' };
  }
  if (hash === '#/welcome') return { name: 'welcome' };
  m = hash.match(/^#\/welcome\/([123])$/);
  if (m) return { name: 'welcome', step: Number(m[1]) as WelcomeStep };
  m = hash.match(new RegExp(`^#/p/(${SLUG})/c/(${SLUG})/f/(${SLUG})$`));
  if (m) return { name: 'format', slug: m[1]!, creative: m[2]!, format: m[3]! };
  m = hash.match(new RegExp(`^#/p/(${SLUG})/c/(${SLUG})$`));
  if (m) return { name: 'creative', slug: m[1]!, creative: m[2]! };
  m = hash.match(new RegExp(`^#/p/(${SLUG})/new$`));
  if (m) return { name: 'new-creative', slug: m[1]! };
  m = hash.match(LEGACY_CONSOLE);
  if (m) return { name: 'project', slug: m[1]!, tab: 'creatives' };
  m = hash.match(new RegExp(`^#/p/(${SLUG})(?:/([a-z]+))?$`));
  if (m) {
    const tab = (m[2] ?? 'creatives') as ProjectTab;
    if (tab === 'creatives' || TABS.includes(tab)) return { name: 'project', slug: m[1]!, tab };
  }
  return { name: 'projects' };
}

export const href = {
  welcome: (step?: WelcomeStep) => (step ? `#/welcome/${step}` : '#/welcome'),
  projects: () => '#/',
  settings: (section: SettingsSection = 'general') => `#/settings/${section}`,
  project: (slug: string, tab: ProjectTab = 'creatives') => (tab === 'creatives' ? `#/p/${slug}` : `#/p/${slug}/${tab}`),
  newCreative: (slug: string) => `#/p/${slug}/new`,
  creative: (slug: string, c: string) => `#/p/${slug}/c/${c}`,
  format: (slug: string, c: string, format: string) => `#/p/${slug}/c/${c}/f/${format}`,
};

/** Route depth: drives the direction of the page transition (T1): deeper slides in from the right. */
export function depthOf(r: Route): number {
  switch (r.name) {
    case 'welcome': return 0;
    case 'projects': return 1;
    case 'settings': case 'project': return 2;
    case 'new-creative': case 'creative': return 3;
    case 'format': return 4;
  }
}

/** Page identity for the page host: tabs of a project and sections of the settings stay on the same page. */
export function routeKey(r: Route): string {
  switch (r.name) {
    case 'welcome': case 'projects': case 'settings': return r.name;
    case 'project': return `project:${r.slug}`;
    case 'new-creative': return `new:${r.slug}`;
    case 'creative': return `creative:${r.slug}/${r.creative}`;
    case 'format': return `format:${r.slug}/${r.creative}/${r.format}`;
  }
}

/** The project a route belongs to, if any. */
export function projectOf(r: Route): string | null {
  return r.name === 'project' || r.name === 'new-creative' || r.name === 'creative' || r.name === 'format' ? r.slug : null;
}
