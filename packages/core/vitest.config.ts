import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { setupFiles: ['../../test-support/isolate-user-data.ts', './test/setup-locale.ts'], testTimeout: 20_000, hookTimeout: 30_000 },
});
