import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SITE = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
export const REPO = join(SITE, '..');

export const tempDir = (prefix = 'ms-site-') => mkdtempSync(join(tmpdir(), prefix));

/** Every file under `dir`, as paths relative to it. */
export function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push(p.slice(base.length + 1));
  }
  return out;
}
