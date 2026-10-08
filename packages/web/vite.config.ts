import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The version shown in Settings → Updates: the one of the published CLI (the desktop app ships the same number).
const { version } = JSON.parse(readFileSync(new URL('../../apps/cli/package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: { port: 5173, proxy: { '/api': { target: 'http://127.0.0.1:4317', ws: true } } },
  build: { outDir: 'dist', emptyOutDir: true },
  test: { environment: 'jsdom', setupFiles: ['./test/setup-locale.ts', './test/setup.ts'], testTimeout: 20_000 },
});
