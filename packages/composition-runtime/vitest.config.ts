import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['../../test-support/isolate-user-data.ts'],
    testTimeout: 30_000,
    hookTimeout: 240_000,
  },
});
