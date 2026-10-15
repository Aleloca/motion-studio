/** The app's real stylesheets and fonts, shared by the Chrome layout tests: the base first, then every other stylesheet. */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const src = (p: string): string => readFileSync(join(import.meta.dirname, '../../src', p), 'utf8');
const cssFiles = (dir: string): string[] => readdirSync(join(import.meta.dirname, '../../src', dir), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? cssFiles(join(dir, e.name)) : e.name.endsWith('.css') ? [join(dir, e.name)] : []));
export const ALL_CSS = (): string => {
  const rest = cssFiles('').filter((f) => f !== 'theme.css' && f !== join('ui', 'ui.css')).sort();
  return ['theme.css', join('ui', 'ui.css'), ...rest].map(src).join('\n');
};
/** The app's fonts (fontsource), with their files loaded from disk. */
export const FONTS = (): string => ['schibsted-grotesk/400.css', 'schibsted-grotesk/500.css', 'schibsted-grotesk/600.css', 'schibsted-grotesk/700.css', 'jetbrains-mono/400.css', 'jetbrains-mono/500.css']
  .map((f) => {
    const file = join(import.meta.dirname, '../../node_modules/@fontsource', f);
    return readFileSync(file, 'utf8').replaceAll('url(./', `url(file://${dirname(file)}/`);
  }).join('\n');
