import { configDefaults, defineConfig } from 'vitest/config';

// The core's real-Chrome suites (`*.chrome.test.ts`) run in their own project, one file at a time: several browsers
// starting at once on a loaded machine made Chrome's start time out (Task 5b review). Every other suite keeps running in
// parallel, and the two core projects run side by side.
const CHROME = '**/*.chrome.test.ts';

export default defineConfig({
  test: {
    projects: [
      'packages/shared', 'packages/composition-runtime', 'packages/mcp-studio', 'packages/web', 'apps/*',
      { extends: './packages/core/vitest.config.ts', test: { name: '@motion-studio/core', root: './packages/core', exclude: [...configDefaults.exclude, CHROME] } },
      { extends: './packages/core/vitest.config.ts', test: { name: '@motion-studio/core (chrome, serial)', root: './packages/core', include: ['test/**/*.chrome.test.ts'], fileParallelism: false } },
    ],
  },
});
