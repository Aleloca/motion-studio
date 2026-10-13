/**
 * Vitest global setup (root config): builds the composition runtime into `packages/composition-runtime/dist` when it is
 * missing or older than its sources, so `pnpm test` works on a fresh clone and in CI, where `pnpm build` runs after the
 * tests. The core serves that folder by default (`RUNTIME_DIST_DIR`): a server built without a `distDir` (the live preview
 * sessions of composition-turns.test.ts) answered 404 for the runtime page without it. Tests that render build their own
 * copy into a temporary folder and do not depend on this.
 */
import { readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PKG = join(import.meta.dirname, '..', 'packages', 'composition-runtime');
const DIST = join(PKG, 'dist');
/** The shared composition schema is bundled into runtime.js and preview.js (the zod parser): a change there makes them stale too. */
const SHARED = join(import.meta.dirname, '..', 'packages', 'shared', 'src', 'composition');
/** What the core serves and the packaged apps copy (the CLI and desktop builds check the same list). */
const OUTPUTS = ['index.html', 'runtime.js', 'layer.js', 'clock.js', 'preview.js'];

function newestSource(dir: string): number {
  let newest = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    newest = Math.max(newest, e.isDirectory() ? newestSource(p) : statSync(p).mtimeMs);
  }
  return newest;
}

function upToDate(): boolean {
  let oldest = Infinity;
  for (const f of OUTPUTS) {
    try { oldest = Math.min(oldest, statSync(join(DIST, f)).mtimeMs); } catch { return false; }
  }
  return oldest >= Math.max(newestSource(join(PKG, 'src')), newestSource(SHARED), statSync(join(PKG, 'tsup.config.ts')).mtimeMs);
}

export default async function setup(): Promise<void> {
  if (upToDate()) return;
  // tsup is the runtime package's own dev dependency: resolve it from there, and build with its config.
  const { build } = await import(pathToFileURL(createRequire(join(PKG, 'package.json')).resolve('tsup')).href) as { build(o: unknown): Promise<void> };
  const { runtimeBuildOptions } = await import(pathToFileURL(join(PKG, 'tsup.config.ts')).href) as { runtimeBuildOptions(outDir: string): object };
  await build({ ...runtimeBuildOptions(DIST), config: false });
  if (!upToDate()) throw new Error(`the composition runtime build did not produce ${OUTPUTS.join(', ')} in ${DIST}`);
}
