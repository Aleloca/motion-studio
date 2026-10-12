import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The composition runtime next to the CLI's bundle (`dist/runtime`, copied by the build and published with `dist`). The
 * core bundled into `dist/main.js` cannot find it by itself: its `RUNTIME_DIST_DIR` resolves next to the bundle
 * (`dist/`). Undefined when not there (running from the sources: the core's own default is then right).
 */
export function runtimeDirFor(here: string): string | undefined {
  const dir = join(here, 'runtime');
  return existsSync(join(dir, 'index.html')) ? dir : undefined;
}
