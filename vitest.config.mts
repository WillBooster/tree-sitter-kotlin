import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

const browserTests = 'test/unit/browser.test.ts';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'node', include: ['test/unit/**/*.test.ts'], exclude: [browserTests] } },
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
