import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, type Options } from 'tsup';

/**
 * The runtime bundle: three self-contained classic scripts (IIFE, no imports, no chunks) plus the page.
 * - `runtime.js`: the page's runtime (dist/index.html loads it);
 * - `layer.js`: the html layer bootstrap (the core injects it first in each layer);
 * - `clock.js`: the virtual clock alone (for CDP `Page.addScriptToEvaluateOnNewDocument`).
 * Exported as a function so the integration tests build the same bundle into a temporary folder.
 */
export function runtimeBuildOptions(outDir: string): Options {
  const here = import.meta.dirname;
  return {
    entry: { runtime: join(here, 'src/entry/runtime.ts'), layer: join(here, 'src/entry/layer.ts'), clock: join(here, 'src/entry/clock.ts') },
    outDir,
    format: ['iife'],
    platform: 'browser',
    target: 'chrome120',
    minify: true,
    sourcemap: false,
    clean: true,
    splitting: false,
    dts: false,
    silent: true,
    outExtension: () => ({ js: '.js' }),
    async onSuccess() {
      mkdirSync(outDir, { recursive: true });
      copyFileSync(join(here, 'src/index.html'), join(outDir, 'index.html'));
    },
  };
}

export default defineConfig(runtimeBuildOptions(join(import.meta.dirname, 'dist')));
