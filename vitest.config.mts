import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

const browserTests = 'test/unit/browser.test.ts';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['test/unit/**/*.test.ts'],
          exclude: [browserTests],
          // test/unit/performance.test.ts times parses in process CPU time, which counts only that test file while
          // each worker is a process of its own; threads would share it with the test files running alongside.
          pool: 'forks',
        },
      },
      // Vite resolves the runtime package with the `browser` export condition, as bundlers do for web apps.
      {
        test: {
          name: 'browser',
          include: [browserTests],
          browser: { enabled: true, provider: playwright(), headless: true, instances: [{ browser: 'chromium' }] },
        },
      },
    ],
  },
});
