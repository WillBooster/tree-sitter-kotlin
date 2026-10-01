import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

const browserTests = 'test/unit/browser.test.ts';

export default defineConfig({
  test: {
    // tsconfig.json declares the `vitest/globals` types, so the runner must provide those globals.
    globals: true,
    projects: [
      {
        test: {
          name: 'node',
          include: ['test/unit/**/*.test.ts'],
          exclude: [browserTests],
          globalSetup: ['test/unit/forkCli.setup.ts'],
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
