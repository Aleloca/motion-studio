import { defineConfig } from 'tsup';

// Electron main and preload are CommonJS; the core is bundled in, `electron` and the native keyring stay external.
export default defineConfig({
  entry: { main: 'src/main.ts', preload: 'src/preload.ts' },
  format: ['cjs'],
  outExtension: () => ({ js: '.cjs' }),
  platform: 'node',
  target: 'node22',
  clean: true,
  shims: true,
  noExternal: [/^@motion-studio\//],
  external: ['electron', '@napi-rs/keyring'],
});
