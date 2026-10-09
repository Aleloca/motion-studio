import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The version shown in Settings → Updates: the one of the published CLI (the desktop app ships the same number).
const { version } = JSON.parse(readFileSync(new URL('../../apps/cli/package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: { port: 5173, proxy: { '/api': { target: 'http://127.0.0.1:4317', ws: true } } },
  build: {
    outDir: 'dist', emptyOutDir: true,
    // Local app served from disk: split the libraries and the shared catalogs/schemas from the app code so no chunk
    // crosses Vite's 500 kB warning (the build must stay warning-free).
    rollupOptions: {
      // zod ships `/*#__PURE__*/` comments Rollup cannot place; harmless, and not ours to fix.
      onwarn(warning, warn) {
        if (warning.code === 'INVALID_ANNOTATION' && warning.id?.includes('node_modules')) return;
        warn(warning);
      },
      output: {
        manualChunks(id) {
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react';
          if (id.includes('node_modules')) return 'vendor';
          if (/[\\/]packages[\\/]shared[\\/]/.test(id)) return 'shared';
          return undefined;
        },
      },
    },
  },
  test: { environment: 'jsdom', setupFiles: ['./test/setup-locale.ts', './test/setup.ts'], testTimeout: 20_000 },
});
